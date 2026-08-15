const DEFAULT_NOTIFICATION_TITLE = "Salchi";
const DEFAULT_NOTIFICATION_URL = "/";
const SERVICE_WORKER_DIAGNOSTICS_PATH = "/diagnostics/web-resume";
// Mirrored in src/push/notificationNavigation.ts. The service worker is a
// public plain JS asset, so it cannot import the TypeScript helper directly.
const NOTIFICATION_CLICK_MESSAGE_TYPE = "salchi.notification-click";
const NOTIFICATION_CLICK_DIAGNOSTIC_MESSAGE_TYPE = "salchi.notification-click-diagnostic";
const NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME = "salchi-notification-click";
const NOTIFICATION_TITLE_SOURCE_SUFFIX = /(?:^|\s+)from\s+Salchi\s*$/i;
// Mirrored in src/push/pendingNotificationClick.ts. The service worker is a
// public plain JS asset, so it cannot import the TypeScript helper directly.
const PENDING_NOTIFICATION_CLICK_CACHE_NAME = "salchi-notification-click-v1";
const PENDING_NOTIFICATION_CLICK_REQUEST_PATH = "/__salchi-notification-click/pending";
// Matches turn-completion notification tags (thread:{threadId}:turn:{turnId}).
// The app icon badge counts only completed turns, so approval/input request
// notifications and the default "salchi" tag must be excluded.
const TURN_NOTIFICATION_TAG_PATTERN = /^thread:(.+):turn:[^:]+$/;
const THREAD_NOTIFICATION_TAG_PREFIX = /^thread:(.+?):/;
const SYNC_BADGE_MESSAGE_TYPE = "salchi.sync-displayed-notification-badge";
const CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE =
  "salchi.clear-turn-completion-notifications";

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  const title = notificationTitle(payload.title);
  const tag = payload.tag || "salchi";
  const notification = {
    body: payload.body || undefined,
    icon: "/salchi-pwa-192.png",
    badge: "/salchi-pwa-192.png",
    tag,
    data: {
      url: payload.url || DEFAULT_NOTIFICATION_URL,
    },
  };

  event.waitUntil(
    (async () => {
      // Chrome displays a generic fallback notification if this push settles
      // without a visible notification. Show Salchi's data-bearing notification
      // before querying or closing older notifications; those platform calls can
      // be slow or fail independently on desktop notification centers.
      const display = await showPushNotification(title, notification);
      await ignoreNotificationMaintenanceFailure(() =>
        recordServiceWorkerDiagnostic("push-service-worker", "notification-shown", {
          display,
          tag,
          url: notification.data.url,
        }),
      );

      // A completed turn supersedes the thread's earlier prompts (older turns,
      // approval/input requests). Non-turn pushes (approval/input) must not
      // close a prior completed-turn notification, which still owns the badge.
      if (TURN_NOTIFICATION_TAG_PATTERN.test(tag)) {
        await ignoreNotificationMaintenanceFailure(() => closeSupersededThreadNotifications(tag));
      }
      await ignoreNotificationMaintenanceFailure(syncDisplayedNotificationBadge);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = resolveNotificationUrl(event.notification.data?.url);

  event.waitUntil(
    openNotificationUrl(url).then(async (client) => {
      await ignoreNotificationMaintenanceFailure(clearTurnCompletionNotificationsAndBadge);
      return client;
    }),
  );
});

self.addEventListener("notificationclose", (event) => {
  event.waitUntil(syncDisplayedNotificationBadge());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(syncDisplayedNotificationBadge());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === SYNC_BADGE_MESSAGE_TYPE) {
    event.waitUntil(syncDisplayedNotificationBadge());
    return;
  }
  if (event.data?.type === CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE) {
    event.waitUntil(clearTurnCompletionNotificationsAndBadge());
  }
});

function readPushPayload(event) {
  if (!event.data) {
    return {};
  }

  try {
    return event.data.json();
  } catch {
    return {};
  }
}

function notificationTitle(rawTitle) {
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  const strippedTitle = title.replace(NOTIFICATION_TITLE_SOURCE_SUFFIX, "").trim();
  return strippedTitle || DEFAULT_NOTIFICATION_TITLE;
}

async function showPushNotification(title, notification) {
  try {
    await self.registration.showNotification(title, notification);
    return { mode: "full" };
  } catch (fullError) {
    // Icon decoding/platform integration must not turn a useful push into
    // Chrome's generic fallback. Retry with only essential, validated fields.
    try {
      await self.registration.showNotification(title, {
        body: notification.body,
        tag: notification.tag,
        data: notification.data,
      });
      return {
        mode: "minimal-fallback",
        fullError: describeNotificationError(fullError),
      };
    } catch (fallbackError) {
      await recordServiceWorkerDiagnostic("push-service-worker", "notification-show-failed", {
        fallbackError: describeNotificationError(fallbackError),
        fullError: describeNotificationError(fullError),
        tag: notification.tag,
        url: notification.data.url,
      });
      throw fallbackError;
    }
  }
}

async function ignoreNotificationMaintenanceFailure(operation) {
  try {
    await operation();
  } catch {
    // The notification is already visible. Badge and supersession maintenance
    // are best-effort and must never invalidate the push event's primary work.
  }
}

function resolveNotificationUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || DEFAULT_NOTIFICATION_URL, self.location.origin);
    return url.origin === self.location.origin
      ? url.href
      : new URL(DEFAULT_NOTIFICATION_URL, self.location.origin).href;
  } catch {
    return new URL(DEFAULT_NOTIFICATION_URL, self.location.origin).href;
  }
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function clientMatchesNotificationUrl(clientUrl, notificationUrl) {
  try {
    const client = new URL(clientUrl);
    const target = new URL(notificationUrl);
    return (
      client.origin === target.origin &&
      normalizePathname(client.pathname) === normalizePathname(target.pathname) &&
      client.search === target.search &&
      client.hash === target.hash
    );
  } catch {
    return false;
  }
}

async function openNotificationUrl(url) {
  const click = {
    url,
    openedAt: Date.now(),
  };

  // Chrome grants a notification click only one window-interaction token.
  // Perform the single focus-or-open operation before any CacheStorage,
  // BroadcastChannel, badge, or notification maintenance work. In particular,
  // an openWindow fallback after focus() cannot work because focus() consumes
  // the token even when its promise rejects.
  const client = await openNotificationClickTarget(click);
  const diagnostic = recordServiceWorkerDiagnostic(
    "notification-click-service-worker-direct",
    "window-interaction-complete",
    {
      client: describeNotificationClient(client),
      url: click.url,
    },
  );
  broadcastNotificationClick(click);
  await Promise.all([diagnostic, persistPendingNotificationClick(click)]);

  return client;
}

async function openNotificationClickTarget(click) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const sameOriginClients = clients.filter((client) => isSameOriginUrl(client.url));
  if (sameOriginClients.length === 0) {
    return openWindowAndPostNotificationClick(click);
  }

  const targetClient = selectNotificationClient(sameOriginClients, click.url);
  const selectionDiagnostic = {
    candidateCount: sameOriginClients.length,
    candidates: sameOriginClients.map(describeNotificationClient),
    selected: describeNotificationClient(targetClient),
    selectionReason: notificationClientSelectionReason(targetClient, click.url),
  };
  const result = await focusClientAndPostNotificationClick(targetClient, click);
  postNotificationClickDiagnostic(targetClient, click, "client-selected", selectionDiagnostic);
  return result;
}

function canSetAppBadge() {
  return typeof self.navigator?.setAppBadge === "function";
}

function countUnseenTurnCompletionThreads(notifications) {
  const threadIds = new Set();
  for (const notification of notifications) {
    const tag = typeof notification.tag === "string" ? notification.tag : "";
    const match = TURN_NOTIFICATION_TAG_PATTERN.exec(tag);
    if (match) {
      threadIds.add(match[1]);
    }
  }
  return threadIds.size;
}

async function syncDisplayedNotificationBadge() {
  if (!canSetAppBadge() || typeof self.registration?.getNotifications !== "function") {
    return false;
  }

  const notifications = await self.registration.getNotifications();
  return writeServiceWorkerAppBadge(countUnseenTurnCompletionThreads(notifications));
}

async function clearTurnCompletionNotificationsAndBadge() {
  if (typeof self.registration?.getNotifications !== "function") {
    return writeServiceWorkerAppBadge(0);
  }

  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    const tag = typeof notification.tag === "string" ? notification.tag : "";
    if (TURN_NOTIFICATION_TAG_PATTERN.test(tag) && typeof notification.close === "function") {
      notification.close();
    }
  }
  return writeServiceWorkerAppBadge(0);
}

async function closeSupersededThreadNotifications(tag) {
  if (typeof tag !== "string" || typeof self.registration?.getNotifications !== "function") {
    return;
  }
  const match = THREAD_NOTIFICATION_TAG_PREFIX.exec(tag);
  if (match === null) {
    return;
  }
  const prefix = `thread:${match[1]}:`;
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    if (
      typeof notification.tag === "string" &&
      notification.tag !== tag &&
      notification.tag.startsWith(prefix) &&
      typeof notification.close === "function"
    ) {
      notification.close();
    }
  }
}

async function writeServiceWorkerAppBadge(count) {
  const badgeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  try {
    if (badgeCount > 0) {
      await self.navigator.setAppBadge(badgeCount);
      return true;
    }

    if (typeof self.navigator.clearAppBadge === "function") {
      await self.navigator.clearAppBadge();
      return true;
    }

    await self.navigator.setAppBadge(0);
    return true;
  } catch {
    return false;
  }
}

async function focusClientAndPostNotificationClick(client, click) {
  const focusedClient = await focusNotificationClient(client, click);
  postNotificationClickMessage(focusedClient || client, click);
  return focusedClient;
}

async function focusNotificationClient(client, click) {
  if (!client || !("focus" in client)) {
    postNotificationClickDiagnostic(client, click, "client-focus", {
      client: describeNotificationClient(client),
      outcome: "unavailable",
    });
    return null;
  }

  try {
    const focusedClient = await client.focus();
    if (!focusedClient) {
      postNotificationClickDiagnostic(client, click, "client-focus", {
        client: describeNotificationClient(client),
        outcome: "empty-result",
      });
      return null;
    }
    postNotificationClickDiagnostic(focusedClient, click, "client-focus", {
      client: describeNotificationClient(focusedClient),
      outcome: "succeeded",
    });
    return focusedClient;
  } catch (error) {
    postNotificationClickDiagnostic(client, click, "client-focus", {
      client: describeNotificationClient(client),
      error: describeNotificationError(error),
      outcome: "rejected",
    });
    return null;
  }
}

async function openWindowAndPostNotificationClick(click) {
  const client = await openNotificationWindow(click);
  postNotificationClickMessage(client, click);
  return client;
}

async function openNotificationWindow(click) {
  try {
    const client = await self.clients.openWindow(click.url);
    postNotificationClickDiagnostic(client, click, "open-window", {
      client: describeNotificationClient(client),
      outcome: client ? "succeeded" : "empty-result",
    });
    return client || null;
  } catch {
    // With no window client there is nowhere to deliver diagnostics. Pending
    // click persistence still records the intended destination for recovery.
    return null;
  }
}

function postNotificationClickMessage(client, click) {
  if (!client || !("postMessage" in client)) {
    return false;
  }

  const message = {
    type: NOTIFICATION_CLICK_MESSAGE_TYPE,
    url: click.url,
    openedAt: click.openedAt,
  };

  try {
    // Client.postMessage from a service worker does not accept a target origin.
    // oxlint-disable-next-line require-post-message-target-origin
    client.postMessage(message);
    return true;
  } catch {
    // The broadcast and pending-click cache remain available when a matched
    // client becomes inactive before delivery.
    return false;
  }
}

function postNotificationClickDiagnostic(client, click, reason, data) {
  if (!client || !("postMessage" in client)) {
    return;
  }

  const message = {
    type: NOTIFICATION_CLICK_DIAGNOSTIC_MESSAGE_TYPE,
    url: click.url,
    openedAt: click.openedAt,
    reason,
    data,
  };

  try {
    // Client.postMessage from a service worker does not accept a target origin.
    // oxlint-disable-next-line require-post-message-target-origin
    client.postMessage(message);
  } catch {
    // Diagnostics must never interfere with notification navigation.
  }
}

function describeNotificationClient(client) {
  if (!client) {
    return null;
  }

  return {
    id: typeof client.id === "string" ? client.id : null,
    url: typeof client.url === "string" ? client.url : null,
    focused: client.focused === true,
    visibilityState:
      typeof client.visibilityState === "string" ? client.visibilityState : "unknown",
  };
}

function describeNotificationError(error) {
  if (typeof error === "object" && error !== null) {
    return {
      name: typeof error.name === "string" ? error.name : "UnknownError",
      message: typeof error.message === "string" ? error.message : String(error),
    };
  }
  return {
    name: "UnknownError",
    message: String(error),
  };
}

async function recordServiceWorkerDiagnostic(kind, reason, data) {
  try {
    await fetch(new URL(SERVICE_WORKER_DIAGNOSTICS_PATH, self.location.origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          ts: Date.now(),
          kind,
          reason,
          data,
        },
      ]),
    });
  } catch {
    // Direct diagnostics are best-effort and run only after notification
    // display or the click's window interaction has already completed.
  }
}

function broadcastNotificationClick(click) {
  if (!("BroadcastChannel" in self)) {
    return;
  }

  let channel = null;
  try {
    channel = new self.BroadcastChannel(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME);
    const message = {
      type: NOTIFICATION_CLICK_MESSAGE_TYPE,
      url: click.url,
      openedAt: click.openedAt,
    };
    // BroadcastChannel.postMessage does not accept a target origin.
    // oxlint-disable-next-line require-post-message-target-origin
    channel.postMessage(message);
  } catch {
    // Broadcast delivery is best-effort. The pending-click cache remains the
    // fallback for clients that miss this message.
  } finally {
    try {
      channel?.close();
    } catch {
      // Closing a best-effort channel must not block notification handling.
    }
  }
}

async function persistPendingNotificationClick(click) {
  if (!("caches" in self)) {
    return;
  }

  try {
    const cache = await self.caches.open(PENDING_NOTIFICATION_CLICK_CACHE_NAME);
    await cache.put(
      makePendingNotificationClickRequest(),
      new Response(JSON.stringify(click), {
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
  } catch {
    // This persistence is best-effort. Direct navigation/postMessage still runs.
  }
}

function makePendingNotificationClickRequest() {
  return new Request(new URL(PENDING_NOTIFICATION_CLICK_REQUEST_PATH, self.location.origin), {
    method: "GET",
  });
}

function selectNotificationClient(sameOriginClients, url) {
  return (
    sameOriginClients.find((client) => clientMatchesNotificationUrl(client.url, url)) ||
    sameOriginClients.find((client) => client.focused) ||
    sameOriginClients.find((client) => client.visibilityState === "visible") ||
    sameOriginClients[0] ||
    null
  );
}

function notificationClientSelectionReason(client, url) {
  if (!client) {
    return "none";
  }
  if (clientMatchesNotificationUrl(client.url, url)) {
    return "exact-url";
  }
  if (client.focused) {
    return "focused";
  }
  if (client.visibilityState === "visible") {
    return "visible";
  }
  return "first-available";
}

function isSameOriginUrl(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}
