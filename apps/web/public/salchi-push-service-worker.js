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
const TURN_NOTIFICATION_TAG_PATTERN = /^thread:(.+):turn:(.+)$/;
const THREAD_NOTIFICATION_TAG_PREFIX = /^thread:(.+?):/;
const SYNC_BADGE_MESSAGE_TYPE = "salchi.sync-displayed-notification-badge";
const SYNC_UNREAD_COMPLETIONS_MESSAGE_TYPE = "salchi.sync-unread-completions";
const DROP_UNREAD_COMPLETION_ENVIRONMENTS_MESSAGE_TYPE =
  "salchi.drop-unread-completion-environments";
const CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE =
  "salchi.clear-turn-completion-notifications";
const LEGACY_UNREAD_COMPLETION_CACHE_NAME = "salchi-unread-completions-v1";
const UNREAD_COMPLETION_CACHE_NAME = "salchi-unread-completions-v2";
const UNREAD_COMPLETION_REQUEST_PATH = "/__salchi-unread-completions/state";
let unreadCompletionMutation = Promise.resolve();

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  const title = notificationTitle(payload.title);
  const tag = payload.tag || "salchi";
  const completion = readThreadCompletion(payload, tag);
  const unreadCompletionState = readUnreadCompletionState(payload.unreadCompletionState);
  const notification = {
    body: payload.body || undefined,
    icon: "/salchi-pwa-192.png",
    badge: "/salchi-pwa-192.png",
    tag,
    data: {
      url: payload.url || DEFAULT_NOTIFICATION_URL,
      completion,
      completionAttentionVersion: payload.completionAttentionVersion,
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
      // Only the versioned server state can converge after reads, reconnects,
      // and multi-device updates. Legacy completion pushes remain visible but
      // must not recreate an unread count that the old server cannot clear.
      if (unreadCompletionState !== null) {
        await ignoreNotificationMaintenanceFailure(() =>
          applyPushUnreadCompletionState(unreadCompletionState, completion),
        );
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = resolveNotificationUrl(event.notification.data?.url);
  const completion = readThreadCompletion(event.notification.data, event.notification.tag);

  event.waitUntil(
    openNotificationUrl(url).then(async (client) => {
      if (completion !== null) {
        await ignoreNotificationMaintenanceFailure(() => acknowledgeUnreadCompletion(completion));
      } else {
        await ignoreNotificationMaintenanceFailure(syncUnreadCompletionBadge);
      }
      return client;
    }),
  );
});

self.addEventListener("notificationclose", (event) => {
  event.waitUntil(syncUnreadCompletionBadge());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(initializeUnreadCompletionBadge());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === SYNC_BADGE_MESSAGE_TYPE) {
    waitForBadgeMessage(event, syncUnreadCompletionBadge());
    return;
  }
  if (event.data?.type === SYNC_UNREAD_COMPLETIONS_MESSAGE_TYPE) {
    waitForBadgeMessage(
      event,
      replaceUnreadCompletionSnapshots(event.data.snapshots, event.data.removedEnvironmentIds),
    );
    return;
  }
  if (event.data?.type === DROP_UNREAD_COMPLETION_ENVIRONMENTS_MESSAGE_TYPE) {
    waitForBadgeMessage(event, dropUnreadCompletionEnvironments(event.data.environmentIds));
    return;
  }
  if (event.data?.type === CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE) {
    waitForBadgeMessage(event, clearTurnCompletionNotificationsAndBadge());
  }
});

function waitForBadgeMessage(event, operation) {
  const requestId = typeof event.data?.requestId === "string" ? event.data.requestId : null;
  const replyPort = event.ports?.[0];
  const task = Promise.resolve(operation).then(
    (count) => {
      postBadgeMessageReply(replyPort, { requestId, ok: true, count });
    },
    (error) => {
      postBadgeMessageReply(replyPort, {
        requestId,
        ok: false,
        error: describeNotificationError(error),
      });
      throw error;
    },
  );
  event.waitUntil(task);
}

function postBadgeMessageReply(replyPort, message) {
  if (!replyPort || typeof replyPort.postMessage !== "function") {
    return;
  }
  // MessagePort.postMessage does not accept a target origin.
  // oxlint-disable-next-line require-post-message-target-origin
  replyPort.postMessage(message);
}

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

function readThreadCompletion(source, rawTag) {
  const completion = source?.completion;
  if (
    completion &&
    typeof completion.environmentId === "string" &&
    completion.environmentId.length > 0 &&
    typeof completion.threadId === "string" &&
    completion.threadId.length > 0 &&
    typeof completion.completionId === "string" &&
    completion.completionId.length > 0
  ) {
    return {
      environmentId: completion.environmentId,
      threadId: completion.threadId,
      completionId: completion.completionId,
    };
  }

  if (source?.completionAttentionVersion === 2) {
    return null;
  }

  const tag = typeof rawTag === "string" ? rawTag : "";
  const tagMatch = TURN_NOTIFICATION_TAG_PATTERN.exec(tag);
  if (tagMatch === null) {
    return null;
  }
  try {
    const url = new URL(source?.url || DEFAULT_NOTIFICATION_URL, self.location.origin);
    const pathSegments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (pathSegments.length < 2 || pathSegments[1] !== tagMatch[1]) {
      return null;
    }
    return {
      environmentId: pathSegments[0],
      threadId: tagMatch[1],
      completionId: tagMatch[2],
    };
  } catch {
    return null;
  }
}

function readUnreadCompletionState(value) {
  if (
    typeof value?.environmentId !== "string" ||
    value.environmentId.length === 0 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  ) {
    return null;
  }
  return {
    environmentId: value.environmentId,
    sequence: value.sequence,
    count: value.count,
  };
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

function unreadCompletionKey(completion) {
  return `${completion.environmentId}\n${completion.threadId}`;
}

function unreadCompletionIdentity(completion) {
  return `${unreadCompletionKey(completion)}\n${completion.completionId}`;
}

function normalizeUnreadCompletionEntries(value) {
  if (!value || !Array.isArray(value.entries)) {
    return [];
  }
  const entriesByThread = new Map();
  for (const entry of value.entries) {
    if (
      typeof entry?.environmentId !== "string" ||
      entry.environmentId.length === 0 ||
      typeof entry?.threadId !== "string" ||
      entry.threadId.length === 0 ||
      typeof entry?.completionId !== "string" ||
      entry.completionId.length === 0
    ) {
      continue;
    }
    const completion = {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
      completionId: entry.completionId,
    };
    entriesByThread.set(unreadCompletionKey(completion), completion);
  }
  return Array.from(entriesByThread.values());
}

function emptyUnreadCompletionLedger() {
  return { version: 2, entries: [], environments: [] };
}

function normalizeUnreadCompletionLedger(value) {
  if (!value || value.version !== 2) {
    return emptyUnreadCompletionLedger();
  }
  const entries = normalizeUnreadCompletionEntries(value);
  const environmentsById = new Map();
  for (const environment of Array.isArray(value.environments) ? value.environments : []) {
    if (
      typeof environment?.environmentId !== "string" ||
      environment.environmentId.length === 0 ||
      !Number.isSafeInteger(environment.count) ||
      environment.count < 0
    ) {
      continue;
    }
    const sequence =
      Number.isSafeInteger(environment.sequence) && environment.sequence >= 0
        ? environment.sequence
        : null;
    const previous = environmentsById.get(environment.environmentId);
    if (
      previous === undefined ||
      previous.sequence === null ||
      (sequence !== null && sequence >= previous.sequence)
    ) {
      environmentsById.set(environment.environmentId, {
        environmentId: environment.environmentId,
        sequence,
        count: environment.count,
      });
    }
  }
  for (const entry of entries) {
    if (!environmentsById.has(entry.environmentId)) {
      environmentsById.set(entry.environmentId, {
        environmentId: entry.environmentId,
        sequence: null,
        count: entries.filter((candidate) => candidate.environmentId === entry.environmentId)
          .length,
      });
    }
  }
  return {
    version: 2,
    entries,
    environments: Array.from(environmentsById.values()),
  };
}

function unreadCompletionCount(ledger) {
  return ledger.environments.reduce((count, environment) => count + environment.count, 0);
}

async function readUnreadCompletionLedger() {
  if (!("caches" in self)) {
    return { exists: false, ledger: emptyUnreadCompletionLedger() };
  }
  try {
    const cache = await self.caches.open(UNREAD_COMPLETION_CACHE_NAME);
    const response = await cache.match(makeUnreadCompletionRequest());
    if (!response) {
      return { exists: false, ledger: emptyUnreadCompletionLedger() };
    }
    return {
      exists: true,
      ledger: normalizeUnreadCompletionLedger(await response.json()),
    };
  } catch {
    return { exists: false, ledger: emptyUnreadCompletionLedger() };
  }
}

async function writeUnreadCompletionLedger(ledger) {
  if (!("caches" in self)) {
    return;
  }
  const cache = await self.caches.open(UNREAD_COMPLETION_CACHE_NAME);
  await cache.put(
    makeUnreadCompletionRequest(),
    new Response(JSON.stringify(normalizeUnreadCompletionLedger(ledger)), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function makeUnreadCompletionRequest() {
  return new Request(new URL(UNREAD_COMPLETION_REQUEST_PATH, self.location.origin), {
    method: "GET",
  });
}

function mutateUnreadCompletions(update) {
  const mutation = unreadCompletionMutation.then(async () => {
    const { ledger } = await readUnreadCompletionLedger();
    const nextLedger = normalizeUnreadCompletionLedger(update(ledger));
    const count = unreadCompletionCount(nextLedger);
    let persistenceError = null;
    try {
      await writeUnreadCompletionLedger(nextLedger);
    } catch (error) {
      persistenceError = error;
    }
    const badgeApplied = await writeServiceWorkerAppBadge(count);
    if (persistenceError !== null) {
      throw persistenceError;
    }
    if (!badgeApplied) {
      throw new Error("Service worker app badge write failed.");
    }
    return count;
  });
  unreadCompletionMutation = mutation.then(
    () => undefined,
    () => undefined,
  );
  return mutation;
}

function acknowledgeUnreadCompletion(completion) {
  return mutateUnreadCompletions((ledger) => {
    const matched = ledger.entries.some(
      (entry) =>
        unreadCompletionKey(entry) === unreadCompletionKey(completion) &&
        entry.completionId === completion.completionId,
    );
    if (!matched) {
      return ledger;
    }
    return {
      ...ledger,
      entries: ledger.entries.filter(
        (entry) =>
          unreadCompletionKey(entry) !== unreadCompletionKey(completion) ||
          entry.completionId !== completion.completionId,
      ),
      environments: ledger.environments.map((environment) =>
        environment.environmentId === completion.environmentId
          ? { ...environment, count: Math.max(0, environment.count - 1) }
          : environment,
      ),
    };
  });
}

function applyPushUnreadCompletionState(rawState, completion) {
  const incoming = readUnreadCompletionState(rawState);
  if (incoming === null) {
    return syncUnreadCompletionBadge();
  }
  return mutateUnreadCompletions((ledger) => {
    const existing = ledger.environments.find(
      (environment) => environment.environmentId === incoming.environmentId,
    );
    if (
      existing?.sequence !== null &&
      existing?.sequence !== undefined &&
      incoming.sequence < existing.sequence
    ) {
      return ledger;
    }
    const replacementEntries =
      completion !== null &&
      completion.environmentId === incoming.environmentId &&
      incoming.count > 0
        ? [completion]
        : [];
    return {
      ...ledger,
      entries: [
        ...ledger.entries.filter((entry) => entry.environmentId !== incoming.environmentId),
        ...replacementEntries,
      ],
      environments: [
        ...ledger.environments.filter(
          (environment) => environment.environmentId !== incoming.environmentId,
        ),
        incoming,
      ],
    };
  });
}

function applyUnreadCompletionSnapshotsToLedger(ledger, snapshots, removedEnvironmentIds) {
  let entries = ledger.entries.filter((entry) => !removedEnvironmentIds.has(entry.environmentId));
  let environments = ledger.environments.filter(
    (environment) => !removedEnvironmentIds.has(environment.environmentId),
  );
  for (const snapshot of snapshots) {
    if (
      typeof snapshot?.environmentId !== "string" ||
      snapshot.environmentId.length === 0 ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence < 0
    ) {
      continue;
    }
    const completions = Array.isArray(snapshot.completions) ? snapshot.completions : [];
    const replacements = [];
    for (const completion of completions) {
      if (
        typeof completion?.threadId === "string" &&
        completion.threadId.length > 0 &&
        typeof completion?.completionId === "string" &&
        completion.completionId.length > 0
      ) {
        replacements.push({
          environmentId: snapshot.environmentId,
          threadId: completion.threadId,
          completionId: completion.completionId,
        });
      }
    }
    const existing = environments.find(
      (environment) => environment.environmentId === snapshot.environmentId,
    );
    if (
      existing?.sequence !== null &&
      existing?.sequence !== undefined &&
      snapshot.sequence < existing.sequence
    ) {
      continue;
    }
    const normalizedReplacements = normalizeUnreadCompletionEntries({ entries: replacements });
    entries = entries
      .filter((entry) => entry.environmentId !== snapshot.environmentId)
      .concat(normalizedReplacements);
    environments = environments
      .filter((environment) => environment.environmentId !== snapshot.environmentId)
      .concat({
        environmentId: snapshot.environmentId,
        sequence: snapshot.sequence,
        count: normalizedReplacements.length,
      });
  }
  return { ...ledger, entries, environments };
}

async function replaceUnreadCompletionSnapshots(rawSnapshots, rawRemovedEnvironmentIds) {
  const snapshots = Array.isArray(rawSnapshots) ? rawSnapshots : [];
  const removedEnvironmentIds = new Set(
    (Array.isArray(rawRemovedEnvironmentIds) ? rawRemovedEnvironmentIds : []).filter(
      (environmentId) => typeof environmentId === "string" && environmentId.length > 0,
    ),
  );
  let count = 0;
  let mutationError = null;
  try {
    count = await mutateUnreadCompletions((ledger) =>
      applyUnreadCompletionSnapshotsToLedger(ledger, snapshots, removedEnvironmentIds),
    );
  } catch (error) {
    mutationError = error;
  }
  await ignoreNotificationMaintenanceFailure(() =>
    closeReadCompletionNotifications(snapshots, removedEnvironmentIds),
  );
  if (mutationError !== null) {
    throw mutationError;
  }
  return count;
}

function dropUnreadCompletionEnvironments(rawEnvironmentIds) {
  return replaceUnreadCompletionSnapshots([], rawEnvironmentIds);
}

async function closeReadCompletionNotifications(snapshots, removedEnvironmentIds) {
  if (typeof self.registration?.getNotifications !== "function") {
    return;
  }
  const { ledger } = await readUnreadCompletionLedger();
  const appliedEnvironmentIds = new Set();
  for (const snapshot of snapshots) {
    const environment = ledger.environments.find(
      (candidate) => candidate.environmentId === snapshot?.environmentId,
    );
    if (
      environment !== undefined &&
      Number.isSafeInteger(snapshot?.sequence) &&
      environment.sequence === snapshot.sequence
    ) {
      appliedEnvironmentIds.add(environment.environmentId);
    }
  }
  if (appliedEnvironmentIds.size === 0 && removedEnvironmentIds.size === 0) {
    return;
  }

  const unreadCompletionIdentities = new Set(ledger.entries.map(unreadCompletionIdentity));
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    const completion = readThreadCompletion(notification.data, notification.tag);
    if (completion === null) {
      continue;
    }
    if (
      removedEnvironmentIds.has(completion.environmentId) ||
      (appliedEnvironmentIds.has(completion.environmentId) &&
        !unreadCompletionIdentities.has(unreadCompletionIdentity(completion)))
    ) {
      notification.close();
    }
  }
}

function syncUnreadCompletionBadge() {
  const sync = unreadCompletionMutation.then(async () => {
    const { ledger } = await readUnreadCompletionLedger();
    const count = unreadCompletionCount(ledger);
    if (!(await writeServiceWorkerAppBadge(count))) {
      throw new Error("Service worker app badge write failed.");
    }
    return count;
  });
  unreadCompletionMutation = sync.then(
    () => undefined,
    () => undefined,
  );
  return sync;
}

function initializeUnreadCompletionBadge() {
  const initialization = unreadCompletionMutation.then(async () => {
    const ledger = await readUnreadCompletionLedger();
    if (ledger.exists) {
      const count = unreadCompletionCount(ledger.ledger);
      if (!(await writeServiceWorkerAppBadge(count))) {
        throw new Error("Service worker app badge write failed.");
      }
      return count;
    }

    const emptyLedger = emptyUnreadCompletionLedger();
    await ignoreNotificationMaintenanceFailure(() => writeUnreadCompletionLedger(emptyLedger));
    if (!(await writeServiceWorkerAppBadge(0))) {
      throw new Error("Service worker app badge write failed.");
    }
    if (typeof self.caches?.delete === "function") {
      await ignoreNotificationMaintenanceFailure(() =>
        self.caches.delete(LEGACY_UNREAD_COMPLETION_CACHE_NAME),
      );
    }
    return 0;
  });
  unreadCompletionMutation = initialization.then(
    () => undefined,
    () => undefined,
  );
  return initialization;
}

async function clearTurnCompletionNotificationsAndBadge() {
  if (typeof self.registration?.getNotifications === "function") {
    const notifications = await self.registration.getNotifications();
    for (const notification of notifications) {
      const tag = typeof notification.tag === "string" ? notification.tag : "";
      if (TURN_NOTIFICATION_TAG_PATTERN.test(tag) && typeof notification.close === "function") {
        notification.close();
      }
    }
  }
  return mutateUnreadCompletions(() => emptyUnreadCompletionLedger());
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
  if (typeof self.navigator?.setAppBadge !== "function") {
    return true;
  }
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
