const DEFAULT_NOTIFICATION_TITLE = "Salchi";
const DEFAULT_NOTIFICATION_URL = "/";
const NOTIFICATION_CLICK_MESSAGE_TYPE = "salchi.notification-click";
// Mirrored in src/push/notificationNavigation.ts. The service worker is a
// public plain JS asset, so it cannot import the TypeScript helper directly.
const NOTIFICATION_CLICK_ACK_MESSAGE_TYPE = "salchi.notification-click-ack";
// Mirrored in src/push/notificationNavigation.ts. The service worker is a
// public plain JS asset, so it cannot import the TypeScript helper directly.
const NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME = "salchi-notification-click";
const NOTIFICATION_CLICK_ACK_TIMEOUT_MS = 2000;
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
const notificationClickAckWaiters = new Map();

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
      // A completed turn supersedes the thread's earlier prompts (older turns,
      // approval/input requests). Non-turn pushes (approval/input) must not
      // close a prior completed-turn notification, which still owns the badge.
      if (TURN_NOTIFICATION_TAG_PATTERN.test(tag)) {
        await closeSupersededThreadNotifications(tag);
      }
      await self.registration.showNotification(title, notification);
      await syncDisplayedNotificationBadge();
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = resolveNotificationUrl(event.notification.data?.url);

  event.waitUntil(
    (async () => {
      await clearTurnCompletionNotificationsAndBadge();
      await openNotificationUrl(url);
    })(),
  );
});

self.addEventListener("notificationclose", (event) => {
  event.waitUntil(syncDisplayedNotificationBadge());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(syncDisplayedNotificationBadge());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === NOTIFICATION_CLICK_ACK_MESSAGE_TYPE) {
    resolveNotificationClickAck(event.data);
    return;
  }
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
  await persistPendingNotificationClick(click);
  broadcastNotificationClick(click);

  return openNotificationClickTarget(click);
}

async function openNotificationClickTarget(click) {
  const [clients, controlledClients] = await Promise.all([
    self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    }),
    self.clients.matchAll({
      type: "window",
    }),
  ]);
  const sameOriginClients = clients.filter((client) => isSameOriginUrl(client.url));
  if (sameOriginClients.length === 0) {
    return openWindowAndPostNotificationClick(click);
  }

  const targetClient = selectNotificationClient(sameOriginClients, click.url);
  if (isControlledNotificationClient(targetClient, controlledClients)) {
    return focusPostAndFallbackNavigateOnMissingAck(targetClient, click);
  }

  return navigateFocusAndPostNotificationClick(targetClient, click);
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

async function navigateFocusAndPostNotificationClick(client, click) {
  if (!client) {
    return openWindowAndPostNotificationClick(click);
  }

  if (clientMatchesNotificationUrl(client.url, click.url)) {
    return focusClientAndPostNotificationClick(client, click);
  }

  const navigatedClient = await navigateNotificationClient(client, click.url);
  if (navigatedClient) {
    return focusClientAndPostNotificationClick(navigatedClient, click);
  }

  const focusedClient = await focusClientAndPostNotificationClick(client, click);
  return focusedClient || openWindowAndPostNotificationClick(click);
}

async function navigateNotificationClient(client, url) {
  if (!client || !("navigate" in client)) {
    return null;
  }

  try {
    return await client.navigate(url);
  } catch {
    return null;
  }
}

async function focusClientAndPostNotificationClick(client, click) {
  const focusedClient = await focusNotificationClient(client);
  postNotificationClickMessage(focusedClient || client, click);
  return focusedClient;
}

async function focusPostAndFallbackNavigateOnMissingAck(client, click) {
  const ackPromise = waitForNotificationClickAck(click, NOTIFICATION_CLICK_ACK_TIMEOUT_MS);
  const focusedClient = (await focusClientAndPostNotificationClick(client, click)) || client;
  if (await ackPromise) {
    return focusedClient;
  }

  if (clientMatchesNotificationUrl(focusedClient.url, click.url)) {
    return focusedClient;
  }

  const navigatedClient = await navigateNotificationClient(focusedClient, click.url);
  return focusNotificationClient(navigatedClient || focusedClient);
}

async function focusNotificationClient(client) {
  if (!client || !("focus" in client)) {
    return client;
  }

  try {
    return (await client.focus()) || client;
  } catch {
    return client;
  }
}

async function openWindowAndPostNotificationClick(click) {
  const client = await openNotificationWindow(click.url);
  postNotificationClickMessage(client, click);
  return client;
}

async function openNotificationWindow(url) {
  try {
    return await self.clients.openWindow(url);
  } catch {
    return null;
  }
}

function postNotificationClickMessage(client, click) {
  if (!client || !("postMessage" in client)) {
    return;
  }

  const message = {
    type: NOTIFICATION_CLICK_MESSAGE_TYPE,
    url: click.url,
    openedAt: click.openedAt,
  };

  // Client.postMessage from a service worker does not accept a target origin.
  // oxlint-disable-next-line require-post-message-target-origin
  client.postMessage(message);
}

function waitForNotificationClickAck(click, timeoutMs) {
  const key = notificationClickAckKey(click.url, click.openedAt);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (notificationClickAckWaiters.get(key) === handleAck) {
        notificationClickAckWaiters.delete(key);
      }
      resolve(value);
    };
    const handleAck = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    notificationClickAckWaiters.set(key, handleAck);
  });
}

function resolveNotificationClickAck(data) {
  if (typeof data?.url !== "string" || !Number.isFinite(data.openedAt)) {
    return;
  }

  const waiter = notificationClickAckWaiters.get(notificationClickAckKey(data.url, data.openedAt));
  if (waiter) {
    waiter();
  }
}

function notificationClickAckKey(url, openedAt) {
  return `${url}|${openedAt}`;
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

function isControlledNotificationClient(client, controlledClients) {
  if (!client || !("id" in client) || typeof client.id !== "string") {
    return false;
  }

  return controlledClients.some((controlledClient) => controlledClient.id === client.id);
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

function isSameOriginUrl(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}
