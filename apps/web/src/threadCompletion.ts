import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { EnvironmentId, OrchestrationLatestTurn, ThreadId } from "@salchi/contracts";

export interface ThreadCompletionStatusInput {
  latestTurn: Pick<OrchestrationLatestTurn, "completedAt"> | null;
  lastVisitedAt?: string | null | undefined;
}

export interface ScopedThreadCompletionInput extends ThreadCompletionStatusInput {
  environmentId: EnvironmentId;
  id: ThreadId;
  archivedAt?: string | null | undefined;
}

/** Visit timestamp for a thread the user is actually looking at: never earlier
 * than the latest turn's completedAt, so server/client clock skew cannot leave
 * a viewed thread counting as unseen.
 */
export function viewedThreadVisitedAt(
  completedAt: string | null | undefined,
  now = new Date(),
): string {
  const nowIso = now.toISOString();
  if (!completedAt) {
    return nowIso;
  }

  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) {
    return nowIso;
  }

  const nowMs = Date.parse(nowIso);
  return completedAtMs > nowMs ? completedAt : nowIso;
}

export function hasUnseenCompletion(thread: ThreadCompletionStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function countUnseenCompletedThreads(
  threads: readonly ScopedThreadCompletionInput[],
  threadLastVisitedAtById: Readonly<Record<string, string | undefined>>,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null && thread.archivedAt !== undefined) {
      continue;
    }
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (
      hasUnseenCompletion({
        latestTurn: thread.latestTurn,
        lastVisitedAt: threadLastVisitedAtById[threadKey],
      })
    ) {
      count += 1;
    }
  }
  return count;
}
