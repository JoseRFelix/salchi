import type { EnvironmentId, OrchestrationLatestTurn, ThreadId, TurnId } from "@salchi/contracts";

export interface ThreadCompletionStatusInput {
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt"> | null;
  seenCompletionTurnId?: TurnId | null | undefined;
}

export interface ScopedThreadCompletionInput extends ThreadCompletionStatusInput {
  environmentId: EnvironmentId;
  id: ThreadId;
  archivedAt?: string | null | undefined;
  hiddenFromThreadList?: boolean | undefined;
}

function unreadEligibleCompletionTurnId(thread: ThreadCompletionStatusInput): TurnId | null {
  if (!thread.latestTurn?.completedAt) return null;
  if (thread.latestTurn.state !== "completed" && thread.latestTurn.state !== "error") return null;
  return thread.latestTurn.turnId;
}

/**
 * Missing means the snapshot came from a server predating completion
 * attention. Treat that legacy completion as read; explicit null is the
 * current protocol's unread value.
 */
export function normalizeSeenCompletionTurnId(thread: ThreadCompletionStatusInput): TurnId | null {
  if (thread.seenCompletionTurnId !== undefined) {
    return thread.seenCompletionTurnId;
  }
  return unreadEligibleCompletionTurnId(thread);
}

export function getUnseenCompletionTurnId(thread: ThreadCompletionStatusInput): TurnId | null {
  const turnId = unreadEligibleCompletionTurnId(thread);
  return turnId !== null && turnId !== normalizeSeenCompletionTurnId(thread) ? turnId : null;
}

export function getAcknowledgedCompletionTurnId(
  thread: ThreadCompletionStatusInput,
): TurnId | null {
  const turnId = unreadEligibleCompletionTurnId(thread);
  return turnId !== null && turnId === normalizeSeenCompletionTurnId(thread) ? turnId : null;
}

export function hasUnseenCompletion(thread: ThreadCompletionStatusInput): boolean {
  return getUnseenCompletionTurnId(thread) !== null;
}

export function countUnseenCompletedThreads(
  threads: readonly ScopedThreadCompletionInput[],
): number {
  let count = 0;
  for (const thread of threads) {
    if (
      (thread.archivedAt !== null && thread.archivedAt !== undefined) ||
      thread.hiddenFromThreadList === true
    ) {
      continue;
    }
    if (hasUnseenCompletion(thread)) {
      count += 1;
    }
  }
  return count;
}
