import type { EnvironmentId, ThreadId } from "@salchi/contracts";

import { readEnvironmentConnection } from "../environments/runtime";
import {
  requestServiceWorkerBadgeSync,
  syncServiceWorkerUnreadCompletions,
  type UnreadCompletionServiceWorkerSnapshot,
} from "../push/notifications";
import { type AppState, useStore } from "../store";
import { completionAttentionStateChanged } from "../unreadCompletionStore";

export interface AppBadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

interface UnreadCompletionState {
  readonly count: number;
  readonly snapshots: ReadonlyArray<UnreadCompletionServiceWorkerSnapshot>;
  readonly allEnvironmentStateAuthoritative: boolean;
}

export interface PwaAppBadgeSyncOptions {
  readonly isEnvironmentAuthoritative?: (environmentId: EnvironmentId) => boolean;
}

let badgeSyncInstalled = false;
let unsubscribeFromStore: (() => void) | null = null;
let syncScheduled = false;
let forceNextSync = false;
let lastSnapshotFingerprint: string | null = null;
let badgeWriteQueue: Promise<void> = Promise.resolve();
let isEnvironmentAuthoritative = defaultIsEnvironmentAuthoritative;
let observedEnvironmentIds = new Set<string>();
let pendingRemovedEnvironmentIds = new Set<EnvironmentId>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let removeLifecycleListeners: (() => void) | null = null;

function defaultIsEnvironmentAuthoritative(environmentId: EnvironmentId): boolean {
  return readEnvironmentConnection(environmentId)?.client.isHeartbeatFresh() === true;
}

function readBadgeNavigator(): AppBadgeNavigator | null {
  return typeof navigator === "undefined" ? null : (navigator as AppBadgeNavigator);
}

export function canUseAppBadge(navigatorLike: AppBadgeNavigator | null = readBadgeNavigator()) {
  return typeof navigatorLike?.setAppBadge === "function";
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

export function deriveUnreadCompletionState(
  state: AppState,
  environmentIsAuthoritative: (environmentId: EnvironmentId) => boolean = () => true,
): UnreadCompletionState {
  const snapshots: UnreadCompletionServiceWorkerSnapshot[] = [];
  let count = 0;
  let allEnvironmentStateAuthoritative = true;

  for (const [rawEnvironmentId, environmentState] of Object.entries(state.environmentStateById)) {
    if (!environmentState.bootstrapComplete) {
      allEnvironmentStateAuthoritative = false;
      continue;
    }
    const environmentId = rawEnvironmentId as EnvironmentId;
    if (!environmentIsAuthoritative(environmentId)) {
      allEnvironmentStateAuthoritative = false;
    }
    const completions: UnreadCompletionServiceWorkerSnapshot["completions"][number][] = [];
    for (const [rawThreadId, completionId] of Object.entries(
      environmentState.unreadCompletionTurnIdByThreadId ?? {},
    )) {
      completions.push({
        threadId: rawThreadId as ThreadId,
        completionId,
      });
      count += 1;
    }
    snapshots.push({
      environmentId,
      sequence: environmentState.completionAttentionSequence ?? 0,
      completions,
    });
  }

  return { count, snapshots, allEnvironmentStateAuthoritative };
}

function syncAppBadge(): void {
  syncScheduled = false;
  const force = forceNextSync;
  forceNextSync = false;
  const state = useStore.getState();
  const currentEnvironmentIds = new Set(Object.keys(state.environmentStateById));
  for (const environmentId of observedEnvironmentIds) {
    if (!currentEnvironmentIds.has(environmentId)) {
      pendingRemovedEnvironmentIds.add(environmentId as EnvironmentId);
    }
  }
  const removedEnvironmentIds = [...pendingRemovedEnvironmentIds];
  observedEnvironmentIds = currentEnvironmentIds;
  const unreadState = deriveUnreadCompletionState(state, isEnvironmentAuthoritative);
  if (unreadState.snapshots.length === 0 && removedEnvironmentIds.length === 0) {
    if (force) {
      void requestServiceWorkerBadgeSync();
    }
    return;
  }

  const fingerprint = JSON.stringify([unreadState.snapshots, removedEnvironmentIds]);
  if (!force && fingerprint === lastSnapshotFingerprint) {
    return;
  }
  badgeWriteQueue = badgeWriteQueue.then(async () => {
    const workerSynchronized = await syncServiceWorkerUnreadCompletions(
      unreadState.snapshots,
      removedEnvironmentIds,
    );
    if (workerSynchronized) {
      for (const environmentId of removedEnvironmentIds) {
        pendingRemovedEnvironmentIds.delete(environmentId);
      }
      lastSnapshotFingerprint = fingerprint;
      return;
    }

    if (unreadState.allEnvironmentStateAuthoritative) {
      const directlyWritten = await writeAppBadgeCount(unreadState.count);
      if (directlyWritten) {
        lastSnapshotFingerprint = fingerprint;
        if (removedEnvironmentIds.length === 0) {
          return;
        }
      }
    }

    if (retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleAppBadgeSync(true);
      }, 1_000);
    }
  });
}

function scheduleAppBadgeSync(force = false): void {
  forceNextSync ||= force;
  if (syncScheduled) {
    return;
  }
  syncScheduled = true;
  queueMicrotask(syncAppBadge);
}

export function resyncAppBadge(): void {
  scheduleAppBadgeSync(true);
}

export function installPwaAppBadgeSync(options: PwaAppBadgeSyncOptions = {}): void {
  if (badgeSyncInstalled) {
    return;
  }

  isEnvironmentAuthoritative =
    options.isEnvironmentAuthoritative ?? defaultIsEnvironmentAuthoritative;
  badgeSyncInstalled = true;
  observedEnvironmentIds = new Set(Object.keys(useStore.getState().environmentStateById));
  unsubscribeFromStore = useStore.subscribe((state, previousState) => {
    if (
      completionAttentionStateChanged(
        state.environmentStateById,
        previousState.environmentStateById,
      )
    ) {
      scheduleAppBadgeSync();
    }
  });
  if (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof document.addEventListener === "function"
  ) {
    const handleResume = () => scheduleAppBadgeSync(true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleResume();
      }
    };
    window.addEventListener("focus", handleResume);
    window.addEventListener("online", handleResume);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const serviceWorker =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker
        : null;
    serviceWorker?.addEventListener?.("controllerchange", handleResume);
    removeLifecycleListeners = () => {
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("online", handleResume);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      serviceWorker?.removeEventListener?.("controllerchange", handleResume);
    };
  }
  scheduleAppBadgeSync(true);
}

export function __resetPwaAppBadgeSyncForTests(): void {
  unsubscribeFromStore?.();
  unsubscribeFromStore = null;
  removeLifecycleListeners?.();
  removeLifecycleListeners = null;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  badgeSyncInstalled = false;
  syncScheduled = false;
  forceNextSync = false;
  lastSnapshotFingerprint = null;
  badgeWriteQueue = Promise.resolve();
  observedEnvironmentIds = new Set();
  pendingRemovedEnvironmentIds = new Set();
  isEnvironmentAuthoritative = defaultIsEnvironmentAuthoritative;
}
