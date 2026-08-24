import type { ServerPushSendResult, WebPushSubscriptionJson } from "@salchi/contracts";
import type { EnvironmentId, ThreadId } from "@salchi/contracts";

import { isElectron } from "../env";
import { ensureLocalApi } from "../localApi";

const SERVICE_WORKER_URL = "/salchi-service-worker.js";
const TURN_NOTIFICATION_TAG_PATTERN = /^thread:(.+):turn:[^:]+$/;
const SERVICE_WORKER_READY_TIMEOUT_MS = 750;
const SERVICE_WORKER_RESPONSE_TIMEOUT_MS = 3000;
export const SYNC_BADGE_MESSAGE_TYPE = "salchi.sync-displayed-notification-badge";
export const SYNC_UNREAD_COMPLETIONS_MESSAGE_TYPE = "salchi.sync-unread-completions";
export const DROP_UNREAD_COMPLETION_ENVIRONMENTS_MESSAGE_TYPE =
  "salchi.drop-unread-completion-environments";
export const CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE =
  "salchi.clear-turn-completion-notifications";

export interface BrowserPushSupport {
  readonly supported: boolean;
  readonly reason: "supported" | "electron" | "insecure-context" | "missing-browser-api";
}

export interface PreparedPushNotifications {
  readonly applicationServerKey: Uint8Array<ArrayBuffer>;
  readonly registration: ServiceWorkerRegistration;
}

export interface NotificationTagLike {
  readonly tag?: unknown;
}

export function getBrowserPushSupport(): BrowserPushSupport {
  if (isElectron) {
    return { supported: false, reason: "electron" };
  }
  if (typeof window === "undefined" || !window.isSecureContext) {
    return { supported: false, reason: "insecure-context" };
  }
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return { supported: false, reason: "missing-browser-api" };
  }
  return { supported: true, reason: "supported" };
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined") {
    return "unsupported";
  }
  return "Notification" in window ? Notification.permission : "unsupported";
}

export async function ensureSalchiServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const support = getBrowserPushSupport();
  if (!support.supported) {
    throw new Error(pushSupportReasonLabel(support.reason));
  }
  // virtual:pwa-register cannot pass registration options and may re-register
  // this URL without updateViaCache. The cache-busted import and server
  // Cache-Control headers are the primary fix; this only helps transition
  // already-stale installs.
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { updateViaCache: "none" });
}

/**
 * Closes any displayed OS notifications for a thread when it is viewed in-app.
 *
 * Best-effort: never registers the service worker (uses getRegistration) and
 * swallows errors. New notifications carry an environment-scoped completion;
 * route parsing preserves compatibility with notifications created by an older
 * service worker. Callers must pass the raw thread id, not a scoped store key.
 */
export async function closeThreadNotifications(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<void> {
  if (!getBrowserPushSupport().supported || !environmentId || !threadId) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || typeof registration.getNotifications !== "function") {
      return;
    }
    const notifications = await registration.getNotifications();
    for (const notification of notifications) {
      const completion = notification.data?.completion as
        | { readonly environmentId?: unknown; readonly threadId?: unknown }
        | undefined;
      const hasStructuredThreadScope =
        typeof completion?.environmentId === "string" && typeof completion.threadId === "string";
      let matchesThread = hasStructuredThreadScope
        ? completion.environmentId === environmentId && completion.threadId === threadId
        : false;
      if (!hasStructuredThreadScope) {
        try {
          const url = new URL(notification.data?.url ?? "/", window.location.origin);
          const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
          matchesThread = segments[0] === environmentId && segments[1] === threadId;
        } catch {
          matchesThread = false;
        }
      }
      if (matchesThread) {
        notification.close();
      }
    }
  } catch {
    // Closing notifications is best-effort and must never disrupt navigation.
  }
}

export function countTurnCompletionNotificationThreads(
  notifications: readonly NotificationTagLike[],
): number {
  const threadIds = new Set<string>();
  for (const notification of notifications) {
    const tag = typeof notification.tag === "string" ? notification.tag : "";
    const match = TURN_NOTIFICATION_TAG_PATTERN.exec(tag);
    if (match) {
      threadIds.add(match[1]!);
    }
  }
  return threadIds.size;
}

async function getReadyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  const ready = navigator.serviceWorker.ready;
  if (!ready || typeof ready.then !== "function") {
    return null;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS);
    });
    return await Promise.race([ready, timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function getInspectableServiceWorkerRegistration(
  registration?: ServiceWorkerRegistration | null,
): Promise<ServiceWorkerRegistration | null> {
  if (registration) {
    return registration;
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  let directRegistration: ServiceWorkerRegistration | null = null;
  if (typeof navigator.serviceWorker.getRegistration === "function") {
    try {
      directRegistration = (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch {
      directRegistration = null;
    }
  }
  return directRegistration ?? getReadyServiceWorkerRegistration();
}

export async function getDisplayedTurnCompletionThreadCount(): Promise<number | null> {
  if (!getBrowserPushSupport().supported) {
    return null;
  }
  try {
    const registration = await getInspectableServiceWorkerRegistration();
    if (!registration || typeof registration.getNotifications !== "function") {
      return null;
    }
    const notifications = await registration.getNotifications();
    return countTurnCompletionNotificationThreads(notifications);
  } catch {
    return null;
  }
}

export async function closeTurnCompletionNotifications(
  registration?: ServiceWorkerRegistration | null,
): Promise<number | null> {
  if (!getBrowserPushSupport().supported) {
    return null;
  }
  try {
    const resolvedRegistration = await getInspectableServiceWorkerRegistration(registration);
    if (!resolvedRegistration || typeof resolvedRegistration.getNotifications !== "function") {
      return null;
    }
    const notifications = await resolvedRegistration.getNotifications();
    let closedCount = 0;
    for (const notification of notifications) {
      const tag = typeof notification.tag === "string" ? notification.tag : "";
      if (TURN_NOTIFICATION_TAG_PATTERN.test(tag) && typeof notification.close === "function") {
        notification.close();
        closedCount += 1;
      }
    }
    return closedCount;
  } catch {
    return null;
  }
}

function postServiceWorkerMessage(
  registration: ServiceWorkerRegistration,
  message: Readonly<Record<string, unknown>>,
): boolean {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker || typeof worker.postMessage !== "function") {
    return false;
  }
  // ServiceWorker.postMessage does not accept a target origin.
  // oxlint-disable-next-line require-post-message-target-origin
  worker.postMessage(message);
  return true;
}

interface ServiceWorkerBadgeResponse {
  readonly requestId: string | null;
  readonly ok: boolean;
  readonly count?: number;
}

async function postServiceWorkerBadgeRequest(
  registration: ServiceWorkerRegistration,
  message: Readonly<Record<string, unknown>>,
): Promise<ServiceWorkerBadgeResponse | null> {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (
    !worker ||
    typeof worker.postMessage !== "function" ||
    typeof MessageChannel === "undefined"
  ) {
    return null;
  }

  const requestId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const channel = new MessageChannel();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = new Promise<ServiceWorkerBadgeResponse | null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), SERVICE_WORKER_RESPONSE_TIMEOUT_MS);
      channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
        const value = event.data as Partial<ServiceWorkerBadgeResponse> | null;
        if (!value || value.requestId !== requestId || typeof value.ok !== "boolean") {
          return;
        }
        resolve({
          requestId,
          ok: value.ok,
          ...(typeof value.count === "number" ? { count: value.count } : {}),
        });
      });
      channel.port1.start();
    });
    worker.postMessage({ ...message, requestId }, [channel.port2]);
    return await response;
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    channel.port1.close();
  }
}

export async function requestServiceWorkerBadgeSync(
  registration?: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (isElectron || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  try {
    const resolvedRegistration = registration ?? (await getInspectableServiceWorkerRegistration());
    if (!resolvedRegistration) {
      return false;
    }
    const response = await postServiceWorkerBadgeRequest(resolvedRegistration, {
      type: SYNC_BADGE_MESSAGE_TYPE,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

export async function requestServiceWorkerTurnCompletionNotificationClear(
  registration?: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (isElectron || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  try {
    const resolvedRegistration = registration ?? (await getInspectableServiceWorkerRegistration());
    if (!resolvedRegistration) {
      return false;
    }
    return postServiceWorkerMessage(resolvedRegistration, {
      type: CLEAR_TURN_COMPLETION_NOTIFICATIONS_MESSAGE_TYPE,
    });
  } catch {
    return false;
  }
}

export interface UnreadCompletionServiceWorkerSnapshot {
  readonly environmentId: EnvironmentId;
  readonly sequence: number;
  readonly completions: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly completionId: string;
  }>;
}

export async function syncServiceWorkerUnreadCompletions(
  snapshots: ReadonlyArray<UnreadCompletionServiceWorkerSnapshot>,
  removedEnvironmentIds: ReadonlyArray<EnvironmentId> = [],
  registration?: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (isElectron || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  try {
    const resolvedRegistration = registration ?? (await getInspectableServiceWorkerRegistration());
    if (!resolvedRegistration) {
      return false;
    }
    const response = await postServiceWorkerBadgeRequest(resolvedRegistration, {
      type: SYNC_UNREAD_COMPLETIONS_MESSAGE_TYPE,
      snapshots,
      removedEnvironmentIds,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

export async function dropServiceWorkerUnreadCompletionEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
  registration?: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (
    environmentIds.length === 0 ||
    isElectron ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return false;
  }
  try {
    const resolvedRegistration = registration ?? (await getInspectableServiceWorkerRegistration());
    if (!resolvedRegistration) {
      return false;
    }
    const response = await postServiceWorkerBadgeRequest(resolvedRegistration, {
      type: DROP_UNREAD_COMPLETION_ENVIRONMENTS_MESSAGE_TYPE,
      environmentIds,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

export async function clearTurnCompletionAlerts(
  registration?: ServiceWorkerRegistration | null,
): Promise<void> {
  await Promise.allSettled([
    closeTurnCompletionNotifications(registration),
    requestServiceWorkerTurnCompletionNotificationClear(registration),
  ]);
}

export async function getCurrentPushSubscription(
  prepared?: PreparedPushNotifications,
): Promise<PushSubscription | null> {
  const registration = prepared?.registration ?? (await ensureSalchiServiceWorkerRegistration());
  return registration.pushManager.getSubscription();
}

/**
 * Completes async setup before the user sees Salchi's permission pre-prompt.
 * Keeping registration and server configuration out of the final click handler
 * lets the native permission request preserve its direct user-gesture context.
 */
export async function preparePushNotifications(): Promise<PreparedPushNotifications> {
  const [registration, config] = await Promise.all([
    ensureSalchiServiceWorkerRegistration(),
    ensureLocalApi().server.getPushConfig(),
  ]);
  if (!config.supported || !config.publicVapidKey) {
    throw new Error("Push notifications are not available on this server.");
  }
  return {
    registration,
    applicationServerKey: urlBase64ToUint8Array(config.publicVapidKey),
  };
}

async function registerPushSubscription(
  subscription: PushSubscription,
): Promise<WebPushSubscriptionJson> {
  const subscriptionJson = toWebPushSubscriptionJson(subscription);
  await ensureLocalApi().server.registerPushSubscription({
    subscription: subscriptionJson,
    userAgent: navigator.userAgent,
  });
  return subscriptionJson;
}

/**
 * Rebinds a browser-owned subscription to the current authenticated server session.
 *
 * Browser push subscriptions outlive Salchi's auth sessions. Registering the same endpoint is
 * intentionally idempotent server-side and transfers it away from an expired session.
 */
export async function reconcileCurrentPushSubscription(): Promise<WebPushSubscriptionJson | null> {
  const registration = await getInspectableServiceWorkerRegistration();
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  return subscription ? registerPushSubscription(subscription) : null;
}

export async function enablePushNotifications(
  prepared?: PreparedPushNotifications,
): Promise<WebPushSubscriptionJson> {
  const setup = prepared ?? (await preparePushNotifications());
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const existingSubscription = await setup.registration.pushManager.getSubscription();
  if (existingSubscription) {
    await existingSubscription.unsubscribe();
  }

  const subscription = await setup.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: setup.applicationServerKey,
  });
  return registerPushSubscription(subscription);
}

export async function disablePushNotifications(): Promise<void> {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) {
    return;
  }
  const endpoint = subscription.endpoint;
  await Promise.allSettled([
    ensureLocalApi().server.unregisterPushSubscription({ endpoint }),
    subscription.unsubscribe(),
  ]);
}

export async function sendTestPushNotification(): Promise<ServerPushSendResult> {
  const subscription = await reconcileCurrentPushSubscription();
  if (!subscription) {
    throw new Error("Push notifications are not enabled in this browser.");
  }
  const result = await ensureLocalApi().server.sendTestPushNotification({
    endpoint: subscription.endpoint,
  });
  if (result.sentCount === 0) {
    throw new Error(
      result.lastFailureDetail
        ? `Push provider rejected the test notification: ${result.lastFailureDetail}`
        : "Push provider rejected the test notification.",
    );
  }
  return result;
}

export function pushSupportReasonLabel(reason: BrowserPushSupport["reason"]): string {
  switch (reason) {
    case "supported":
      return "Push notifications are available.";
    case "electron":
      return "Browser push notifications are only available in the web app.";
    case "insecure-context":
      return "Push notifications require HTTPS or localhost.";
    case "missing-browser-api":
      return "This browser does not support web push notifications.";
  }
}

function toWebPushSubscriptionJson(subscription: PushSubscription): WebPushSubscriptionJson {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Browser returned an incomplete push subscription.");
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}
