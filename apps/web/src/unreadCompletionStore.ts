import type { EnvironmentState, AppState } from "./store";
type EnvironmentStateById = AppState["environmentStateById"];

function isAttentionSliceEqual(
  left: EnvironmentState | undefined,
  right: EnvironmentState | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.bootstrapComplete === right.bootstrapComplete &&
      left.unreadCompletionTurnIdByThreadId === right.unreadCompletionTurnIdByThreadId &&
      left.completionAttentionSequence === right.completionAttentionSequence)
  );
}

/**
 * Compares only shell fields that can affect completion attention. Detail
 * streaming can replace an environment state many times per second without
 * making badge consumers scan every thread.
 */
export function completionAttentionStateChanged(
  next: EnvironmentStateById,
  previous: EnvironmentStateById,
): boolean {
  if (next === previous) return false;

  const environmentIds = Object.keys(next);
  if (environmentIds.length !== Object.keys(previous).length) return true;
  for (const environmentId of environmentIds) {
    if (!isAttentionSliceEqual(next[environmentId], previous[environmentId])) {
      return true;
    }
  }
  return false;
}

/** A memoized Zustand selector whose hot path is O(environment count). */
export function createHasUnreadCompletionSelector(): (state: AppState) => boolean {
  let previousEnvironmentStateById: EnvironmentStateById | null = null;
  let previousResult = false;

  return (state) => {
    const nextEnvironmentStateById = state.environmentStateById;
    if (
      previousEnvironmentStateById !== null &&
      !completionAttentionStateChanged(nextEnvironmentStateById, previousEnvironmentStateById)
    ) {
      return previousResult;
    }

    previousEnvironmentStateById = nextEnvironmentStateById;
    previousResult = Object.values(nextEnvironmentStateById).some(
      (environmentState) =>
        environmentState.bootstrapComplete &&
        Object.keys(environmentState.unreadCompletionTurnIdByThreadId ?? {}).length > 0,
    );
    return previousResult;
  };
}
