import {
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  type OrchestrationThreadDetailPageInfo,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadDetailPageCursors,
} from "@salchi/contracts";
import { type Thread } from "../../types";
import { buildOlderThreadDetailPageCursors } from "../ChatView.logic";

export interface OlderThreadDetailPageIntegrityResult {
  readonly requestedCursorKey: string | null;
  readonly returnedCursorKey: string | null;
  readonly addedItemCount: number;
  readonly cursorAdvanced: boolean;
  readonly isNoopPage: boolean;
}

export function deriveOlderThreadDetailPageIntegrity({
  currentThread,
  snapshot,
  requestedBefore,
}: {
  readonly currentThread: Thread;
  readonly snapshot: OrchestrationThreadDetailSnapshot;
  readonly requestedBefore: OrchestrationThreadDetailPageCursors;
}): OlderThreadDetailPageIntegrityResult {
  const requestedCursorKey = buildOlderThreadDetailPageCursorKey(requestedBefore);
  const returnedCursorKey = buildOlderThreadDetailPageCursorKey(
    buildOlderThreadDetailPageCursors(
      pickRequestedThreadDetailPageInfo(snapshot.pageInfo, requestedBefore),
    ),
  );
  const addedItemCount =
    countNewIds(snapshot.thread.messages, currentThread.messages, (message) => message.id) +
    countNewIds(snapshot.thread.proposedPlans, currentThread.proposedPlans, (plan) => plan.id) +
    countNewIds(snapshot.thread.activities, currentThread.activities, (activity) => activity.id) +
    countNewIds(
      snapshot.thread.checkpoints,
      currentThread.turnDiffSummaries,
      (checkpoint) => checkpoint.turnId,
    );
  const cursorAdvanced = requestedCursorKey !== returnedCursorKey;

  return {
    requestedCursorKey,
    returnedCursorKey,
    addedItemCount,
    cursorAdvanced,
    isNoopPage: addedItemCount === 0 && !cursorAdvanced,
  };
}

export function buildOlderThreadDetailPageCursorKey(
  cursors: OrchestrationThreadDetailPageCursors | null | undefined,
): string | null {
  if (!cursors) {
    return null;
  }

  const parts = [
    serializeCursorPart("messages", cursors.messages),
    serializeCursorPart("proposedPlans", cursors.proposedPlans),
    serializeCursorPart("activities", cursors.activities),
    serializeCursorPart("checkpoints", cursors.checkpoints),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join("|") : null;
}

function pickRequestedThreadDetailPageInfo(
  pageInfo: OrchestrationThreadDetailPageInfo,
  requestedBefore: OrchestrationThreadDetailPageCursors,
): OrchestrationThreadDetailPageInfo {
  return {
    messages:
      requestedBefore.messages !== undefined
        ? pageInfo.messages
        : EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.messages,
    proposedPlans:
      requestedBefore.proposedPlans !== undefined
        ? pageInfo.proposedPlans
        : EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.proposedPlans,
    activities:
      requestedBefore.activities !== undefined
        ? pageInfo.activities
        : EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.activities,
    checkpoints:
      requestedBefore.checkpoints !== undefined
        ? pageInfo.checkpoints
        : EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.checkpoints,
  };
}

function countNewIds<TIncoming, TCurrent, TId extends string>(
  incomingItems: readonly TIncoming[],
  currentItems: readonly TCurrent[],
  getId: (item: TIncoming | TCurrent) => TId,
): number {
  const currentIds = new Set(currentItems.map((item) => getId(item)));
  let count = 0;
  for (const item of incomingItems) {
    if (!currentIds.has(getId(item))) {
      count += 1;
    }
  }
  return count;
}

function serializeCursorPart(
  name: keyof OrchestrationThreadDetailPageCursors,
  cursor: OrchestrationThreadDetailPageCursors[keyof OrchestrationThreadDetailPageCursors],
): string | null {
  if (!cursor) {
    return null;
  }

  return [
    name,
    cursor.id,
    cursor.createdAt,
    cursor.sequence ?? "",
    cursor.checkpointTurnCount ?? "",
  ].join(":");
}
