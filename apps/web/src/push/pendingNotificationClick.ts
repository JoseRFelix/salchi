export interface PendingNotificationClick {
  readonly url: string;
  readonly openedAt: number;
}

export const PENDING_NOTIFICATION_CLICK_CACHE_NAME = "salchi-notification-click-v1";
export const PENDING_NOTIFICATION_CLICK_REQUEST_PATH = "/__salchi-notification-click/pending";

function getCacheStorage(): CacheStorage | null {
  if (typeof window === "undefined" || !("caches" in window)) {
    return null;
  }
  return window.caches;
}

function makePendingNotificationClickRequest(): Request | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return new Request(
      new URL(PENDING_NOTIFICATION_CLICK_REQUEST_PATH, window.location.origin).href,
      {
        method: "GET",
      },
    );
  } catch {
    return null;
  }
}

function isPendingNotificationClick(value: unknown): value is PendingNotificationClick {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.url === "string" && Number.isFinite(record.openedAt);
}

export async function readPendingNotificationClick(): Promise<PendingNotificationClick | null> {
  const cacheStorage = getCacheStorage();
  const request = makePendingNotificationClickRequest();
  if (!cacheStorage || request === null) {
    return null;
  }

  try {
    const cache = await cacheStorage.open(PENDING_NOTIFICATION_CLICK_CACHE_NAME);
    const response = await cache.match(request);
    if (!response) {
      return null;
    }
    const value: unknown = await response.json();
    return isPendingNotificationClick(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writePendingNotificationClick(
  pending: PendingNotificationClick,
): Promise<void> {
  const cacheStorage = getCacheStorage();
  const request = makePendingNotificationClickRequest();
  if (!cacheStorage || request === null) {
    return;
  }

  try {
    const cache = await cacheStorage.open(PENDING_NOTIFICATION_CLICK_CACHE_NAME);
    await cache.put(
      request,
      new Response(JSON.stringify(pending), {
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
  } catch {
    // Notification click persistence is a recovery aid; failure should not block navigation.
  }
}

export async function clearPendingNotificationClick(): Promise<void> {
  const cacheStorage = getCacheStorage();
  const request = makePendingNotificationClickRequest();
  if (!cacheStorage || request === null) {
    return;
  }

  try {
    const cache = await cacheStorage.open(PENDING_NOTIFICATION_CLICK_CACHE_NAME);
    await cache.delete(request);
  } catch {
    // Best-effort cleanup only.
  }
}
