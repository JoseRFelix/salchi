import type { ThreadId } from "@t3tools/contracts";

import type { CachedThreadDetail } from "./orchestrationStartupCache";
import type { EnvironmentState } from "./store";

type ThreadDetailContentState = Pick<
  EnvironmentState,
  | "messageIdsByThreadId"
  | "queuedTurnIdsByThreadId"
  | "activityIdsByThreadId"
  | "proposedPlanIdsByThreadId"
  | "turnDiffIdsByThreadId"
>;

export function hasEnvironmentThreadDetailContent(
  state: ThreadDetailContentState,
  threadId: ThreadId,
): boolean {
  return (
    (state.messageIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.queuedTurnIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.activityIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.proposedPlanIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.turnDiffIdsByThreadId[threadId]?.length ?? 0) > 0
  );
}

export function hasCachedThreadDetailContent(cached: CachedThreadDetail): boolean {
  return (
    cached.messageIds.length > 0 ||
    cached.queuedTurnIds.length > 0 ||
    cached.activityIds.length > 0 ||
    cached.proposedPlanIds.length > 0 ||
    cached.turnDiffIds.length > 0
  );
}
