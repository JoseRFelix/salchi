import type { ThreadId } from "@t3tools/contracts";

import type { NotificationNavigationTarget } from "./push/notificationNavigation";

export const STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS = 8 * 60 * 60 * 1000;

export function shouldNavigateToStartupBootstrapThread(input: {
  readonly pathname: string;
  readonly bootstrapThreadId: ThreadId;
  readonly handledBootstrapThreadId: string | null;
  readonly lastNotificationNavigationTarget: NotificationNavigationTarget | null;
  readonly isStandalonePwa: boolean;
}): boolean {
  if (input.lastNotificationNavigationTarget !== null) {
    return false;
  }

  if (input.isStandalonePwa) {
    return false;
  }

  if (input.pathname !== "/") {
    return false;
  }

  return input.handledBootstrapThreadId !== input.bootstrapThreadId;
}

export function isStartupBootstrapThreadStale(input: {
  readonly activityAt: string | null;
  readonly now: number;
}): boolean {
  if (!input.activityAt) {
    return false;
  }

  const activityMs = Date.parse(input.activityAt);
  if (!Number.isFinite(activityMs)) {
    return false;
  }

  return input.now - activityMs > STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS;
}
