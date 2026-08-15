import { selectSidebarThreadsAcrossEnvironments, useStore, type AppState } from "../store";
import {
  clearTurnCompletionAlerts,
  getDisplayedTurnCompletionThreadCount,
} from "../push/notifications";
import { countUnseenCompletedThreads } from "../threadCompletion";
import { useUiStateStore, type UiState } from "../uiStateStore";

export interface AppBadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

let badgeSyncInstalled = false;
let syncScheduled = false;
let lastRequestedBadgeCount: number | null = null;
let badgeSyncGeneration = 0;
let appStoreUnsubscribe: (() => void) | null = null;
let uiStateStoreUnsubscribe: (() => void) | null = null;
let clearRetryTimerIds: Array<ReturnType<typeof setTimeout>> = [];

// Chrome can focus/show a page before it dispatches the service worker's
// notificationclick event. Closing displayed notifications in that window can
// delete the notification Chrome is still trying to activate. Give the click
// handler time to run; it clears the notifications itself once dispatched.
const COMPLETED_TURN_ALERT_CLEAR_RETRY_DELAYS_MS = [5000, 1000, 3000] as const;

function readBadgeNavigator(): AppBadgeNavigator | null {
  return typeof navigator === "undefined" ? null : (navigator as AppBadgeNavigator);
}

export function canUseAppBadge(navigatorLike: AppBadgeNavigator | null = readBadgeNavigator()) {
  return typeof navigatorLike?.setAppBadge === "function";
}

export function selectCompletedConversationBadgeCount(
  appState: AppState,
  uiState: Pick<UiState, "threadLastVisitedAtById">,
): number {
  return countUnseenCompletedThreads(
    selectSidebarThreadsAcrossEnvironments(appState),
    uiState.threadLastVisitedAtById,
  );
}

export async function writeAppBadgeCount(
  count: number,
  navigatorLike: AppBadgeNavigator | null = readBadgeNavigator(),
): Promise<boolean> {
  if (!canUseAppBadge(navigatorLike) || !navigatorLike?.setAppBadge) {
    return false;
  }

  const badgeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

  try {
    if (badgeCount > 0) {
      await navigatorLike.setAppBadge(badgeCount);
      return true;
    }

    if (typeof navigatorLike.clearAppBadge === "function") {
      await navigatorLike.clearAppBadge();
      return true;
    }

    await navigatorLike.setAppBadge(0);
    return true;
  } catch {
    return false;
  }
}

function syncAppBadge(): void {
  syncScheduled = false;
  if (isDocumentVisible()) {
    clearCompletedTurnAlertsAndBadge();
    return;
  }

  const generation = ++badgeSyncGeneration;

  void (async () => {
    const displayedNotificationCount = await getDisplayedTurnCompletionThreadCount();
    if (generation !== badgeSyncGeneration) {
      return;
    }

    const badgeCount = displayedNotificationCount ?? 0;
    if (badgeCount === lastRequestedBadgeCount) {
      return;
    }

    lastRequestedBadgeCount = badgeCount;
    const updated = await writeAppBadgeCount(badgeCount);
    if (!updated && generation === badgeSyncGeneration && lastRequestedBadgeCount === badgeCount) {
      lastRequestedBadgeCount = null;
    }
  })();
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function clearPendingClearRetryTimers(): void {
  for (const timerId of clearRetryTimerIds) {
    clearTimeout(timerId);
  }
  clearRetryTimerIds = [];
}

function removeClearRetryTimer(timerId: ReturnType<typeof setTimeout>): void {
  clearRetryTimerIds = clearRetryTimerIds.filter((candidate) => candidate !== timerId);
}

function scheduleCompletedTurnAlertClearAttempt(generation: number, attemptIndex: number): void {
  const delay = COMPLETED_TURN_ALERT_CLEAR_RETRY_DELAYS_MS[attemptIndex];
  if (delay === undefined) {
    return;
  }

  const runAttempt = () => {
    void (async () => {
      await clearTurnCompletionAlerts();
      if (generation !== badgeSyncGeneration) {
        return;
      }
      lastRequestedBadgeCount = 0;
      const updated = await writeAppBadgeCount(0);
      if (!updated && generation === badgeSyncGeneration && lastRequestedBadgeCount === 0) {
        lastRequestedBadgeCount = null;
      }
      if (generation === badgeSyncGeneration) {
        scheduleCompletedTurnAlertClearAttempt(generation, attemptIndex + 1);
      }
    })();
  };

  const timerId = setTimeout(() => {
    removeClearRetryTimer(timerId);
    runAttempt();
  }, delay);
  clearRetryTimerIds.push(timerId);
}

function clearCompletedTurnAlertsAndBadge(): void {
  clearPendingClearRetryTimers();
  syncScheduled = false;
  const generation = ++badgeSyncGeneration;
  lastRequestedBadgeCount = 0;
  void writeAppBadgeCount(0).then((updated) => {
    if (!updated && generation === badgeSyncGeneration && lastRequestedBadgeCount === 0) {
      lastRequestedBadgeCount = null;
    }
  });
  scheduleCompletedTurnAlertClearAttempt(generation, 0);
}

function scheduleAppBadgeSync(): void {
  if (syncScheduled) {
    return;
  }
  syncScheduled = true;
  queueMicrotask(syncAppBadge);
}

export function resyncAppBadge(): void {
  lastRequestedBadgeCount = null;
  scheduleAppBadgeSync();
}

function handleWindowFocus(): void {
  clearCompletedTurnAlertsAndBadge();
}

function handleDocumentVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    clearCompletedTurnAlertsAndBadge();
  }
}

export function installPwaAppBadgeSync(): void {
  if (badgeSyncInstalled || !canUseAppBadge()) {
    return;
  }

  badgeSyncInstalled = true;
  appStoreUnsubscribe = useStore.subscribe(scheduleAppBadgeSync);
  uiStateStoreUnsubscribe = useUiStateStore.subscribe(scheduleAppBadgeSync);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", handleWindowFocus);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
  }
  clearCompletedTurnAlertsAndBadge();
}

export function __resetPwaAppBadgeSyncForTests(): void {
  appStoreUnsubscribe?.();
  uiStateStoreUnsubscribe?.();
  appStoreUnsubscribe = null;
  uiStateStoreUnsubscribe = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("focus", handleWindowFocus);
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
  }
  clearPendingClearRetryTimers();
  badgeSyncInstalled = false;
  syncScheduled = false;
  lastRequestedBadgeCount = null;
  badgeSyncGeneration += 1;
}
