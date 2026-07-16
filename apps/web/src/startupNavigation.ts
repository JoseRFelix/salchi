import { parseScopedThreadKey } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { NotificationNavigationTarget } from "./push/notificationNavigation";

export const STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS = 8 * 60 * 60 * 1000;
const STARTUP_THREAD_STORAGE_KEY = "t3code:startup-thread:v1";
const STARTUP_THREAD_DOCUMENT_VERSION = 1;

export interface StartupRestoreTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

let primedStartupRestoreTarget: StartupRestoreTarget | null = null;

interface PersistedStartupThreadDocument {
  readonly version: typeof STARTUP_THREAD_DOCUMENT_VERSION;
  readonly target: StartupRestoreTarget;
}

function storage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isStartupRestoreTarget(value: unknown): value is StartupRestoreTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "environmentId" in value &&
    typeof value.environmentId === "string" &&
    value.environmentId.length > 0 &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    value.threadId.length > 0
  );
}

export function readPersistedStartupThreadTarget(): StartupRestoreTarget | null {
  const resolvedStorage = storage();
  if (!resolvedStorage) {
    return null;
  }

  try {
    const raw = resolvedStorage.getItem(STARTUP_THREAD_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedStartupThreadDocument>;
    return parsed.version === STARTUP_THREAD_DOCUMENT_VERSION &&
      isStartupRestoreTarget(parsed.target)
      ? parsed.target
      : null;
  } catch {
    return null;
  }
}

export function writePersistedStartupThreadTarget(target: StartupRestoreTarget): void {
  const resolvedStorage = storage();
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(
      STARTUP_THREAD_STORAGE_KEY,
      JSON.stringify({
        version: STARTUP_THREAD_DOCUMENT_VERSION,
        target: {
          environmentId: target.environmentId,
          threadId: target.threadId,
        },
      } satisfies PersistedStartupThreadDocument),
    );
  } catch {
    // This target only optimizes startup; storage failures must not affect chat navigation.
  }
}

export function clearPersistedStartupThreadTarget(
  expectedTarget?: StartupRestoreTarget | undefined,
): void {
  const resolvedStorage = storage();
  if (!resolvedStorage) {
    return;
  }

  if (expectedTarget) {
    const currentTarget = readPersistedStartupThreadTarget();
    if (
      currentTarget?.environmentId !== expectedTarget.environmentId ||
      currentTarget.threadId !== expectedTarget.threadId
    ) {
      return;
    }
  }

  try {
    resolvedStorage.removeItem(STARTUP_THREAD_STORAGE_KEY);
  } catch {
    // Clearing stale startup state must not affect route recovery.
  }
}

export function clearPersistedStartupThreadTargetForEnvironment(
  environmentId: EnvironmentId,
): void {
  const currentTarget = readPersistedStartupThreadTarget();
  if (currentTarget?.environmentId === environmentId) {
    clearPersistedStartupThreadTarget(currentTarget);
  }
}

export function shouldNavigateToStartupBootstrapThread(input: {
  readonly pathname: string;
  readonly bootstrapThreadId: ThreadId;
  readonly handledBootstrapThreadId: string | null;
  readonly lastNotificationNavigationTarget: NotificationNavigationTarget | null;
}): boolean {
  if (input.lastNotificationNavigationTarget !== null) {
    return false;
  }

  if (input.pathname !== "/") {
    return false;
  }

  return input.handledBootstrapThreadId !== input.bootstrapThreadId;
}

export function resolveStartupRestoreTarget(input: {
  readonly persistedTarget?: StartupRestoreTarget | null | undefined;
  readonly threadLastVisitedAtById: Readonly<Record<string, string | undefined>>;
}): StartupRestoreTarget | null {
  // The startup cache is intentionally bounded and can omit a newly opened or older valid thread.
  // Treat explicit navigation history as authoritative; live route recovery clears genuinely stale
  // targets after the environment snapshot arrives.
  if (input.persistedTarget) {
    return input.persistedTarget;
  }

  const visitCandidates: Array<{
    readonly target: StartupRestoreTarget;
    readonly visitedAtMs: number;
  }> = [];

  for (const [threadKey, visitedAt] of Object.entries(input.threadLastVisitedAtById)) {
    if (!visitedAt) {
      continue;
    }

    const visitedAtMs = Date.parse(visitedAt);
    if (!Number.isFinite(visitedAtMs)) {
      continue;
    }

    const ref = parseScopedThreadKey(threadKey);
    if (!ref) {
      continue;
    }

    visitCandidates.push({ target: ref, visitedAtMs });
  }

  return (
    visitCandidates.toSorted((left, right) => right.visitedAtMs - left.visitedAtMs)[0]?.target ??
    null
  );
}

export function primeStartupThreadRestore(input: {
  readonly pathname: string;
  readonly persistedTarget?: StartupRestoreTarget | null | undefined;
  readonly threadLastVisitedAtById: Readonly<Record<string, string | undefined>>;
}): void {
  primedStartupRestoreTarget =
    input.pathname === "/"
      ? resolveStartupRestoreTarget({
          persistedTarget: input.persistedTarget,
          threadLastVisitedAtById: input.threadLastVisitedAtById,
        })
      : null;
}

export function consumeStartupThreadRestoreTarget(input: {
  readonly lastNotificationNavigationTarget: NotificationNavigationTarget | null;
}): StartupRestoreTarget | null {
  const target = primedStartupRestoreTarget;
  primedStartupRestoreTarget = null;

  if (input.lastNotificationNavigationTarget !== null) {
    return null;
  }

  return target;
}

export function buildStartupRestorePath(target: StartupRestoreTarget): string {
  return `/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`;
}

export function resetStartupThreadRestoreForTests(): void {
  primedStartupRestoreTarget = null;
}

export function clearPersistedStartupThreadTargetForTests(): void {
  clearPersistedStartupThreadTarget();
}

export const STARTUP_THREAD_TARGET_STORAGE_KEY = STARTUP_THREAD_STORAGE_KEY;

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
