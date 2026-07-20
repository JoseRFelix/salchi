import {
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  type OrchestrationThreadDetailPageCursors,
  type OrchestrationThreadDetailSnapshot,
} from "@salchi/contracts";
import { describe, expect, it } from "vitest";
import { type Thread } from "../../types";
import { deriveOlderThreadDetailPageIntegrity } from "./olderThreadDetailPageIntegrity";

function makeThread(input: {
  readonly messages?: readonly { readonly id: string }[];
  readonly proposedPlans?: readonly { readonly id: string }[];
  readonly activities?: readonly { readonly id: string }[];
  readonly turnDiffSummaries?: readonly { readonly turnId: string }[];
}): Thread {
  return {
    messages: input.messages ?? [],
    proposedPlans: input.proposedPlans ?? [],
    activities: input.activities ?? [],
    turnDiffSummaries: input.turnDiffSummaries ?? [],
  } as unknown as Thread;
}

function makeSnapshot(input: {
  readonly messages?: readonly { readonly id: string }[];
  readonly proposedPlans?: readonly { readonly id: string }[];
  readonly activities?: readonly { readonly id: string }[];
  readonly checkpoints?: readonly { readonly turnId: string }[];
  readonly messageCursorId?: string;
  readonly activityCursorId?: string;
}): OrchestrationThreadDetailSnapshot {
  return {
    thread: {
      messages: input.messages ?? [],
      proposedPlans: input.proposedPlans ?? [],
      activities: input.activities ?? [],
      checkpoints: input.checkpoints ?? [],
    },
    pageInfo: {
      ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
      messages: input.messageCursorId
        ? {
            hasMoreBefore: true,
            startCursor: {
              id: input.messageCursorId,
              createdAt: "2026-03-29T00:00:04.000Z",
            },
          }
        : EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.messages,
      activities: input.activityCursorId
        ? {
            hasMoreBefore: true,
            startCursor: {
              id: input.activityCursorId,
              createdAt: "2026-03-29T00:00:05.000Z",
              sequence: 5,
            },
          }
        : EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.activities,
    },
  } as unknown as OrchestrationThreadDetailSnapshot;
}

function makeRequestedBeforeMessage(id: string): OrchestrationThreadDetailPageCursors {
  return {
    messages: {
      id,
      createdAt: "2026-03-29T00:00:04.000Z",
    },
  };
}

describe("deriveOlderThreadDetailPageIntegrity", () => {
  it("detects added rows across page collections", () => {
    const result = deriveOlderThreadDetailPageIntegrity({
      currentThread: makeThread({
        messages: [{ id: "message-2" }],
        proposedPlans: [{ id: "plan-2" }],
        activities: [{ id: "activity-2" }],
        turnDiffSummaries: [{ turnId: "turn-2" }],
      }),
      snapshot: makeSnapshot({
        messages: [{ id: "message-1" }, { id: "message-2" }],
        proposedPlans: [{ id: "plan-1" }],
        activities: [{ id: "activity-1" }],
        checkpoints: [{ turnId: "turn-1" }],
        messageCursorId: "message-1",
      }),
      requestedBefore: makeRequestedBeforeMessage("message-2"),
    });

    expect(result.addedItemCount).toBe(4);
    expect(result.cursorAdvanced).toBe(true);
    expect(result.isNoopPage).toBe(false);
  });

  it("detects no-op duplicate pages with unchanged cursors", () => {
    const cursorKey = "messages:message-2:2026-03-29T00:00:04.000Z::";
    const result = deriveOlderThreadDetailPageIntegrity({
      currentThread: makeThread({ messages: [{ id: "message-2" }] }),
      snapshot: makeSnapshot({
        messages: [{ id: "message-2" }],
        messageCursorId: "message-2",
      }),
      requestedBefore: makeRequestedBeforeMessage("message-2"),
    });

    expect(result).toMatchObject({
      requestedCursorKey: cursorKey,
      returnedCursorKey: cursorKey,
      addedItemCount: 0,
      cursorAdvanced: false,
      isNoopPage: true,
    });
  });

  it("treats cursor advancement as progress for partial collection pages", () => {
    const result = deriveOlderThreadDetailPageIntegrity({
      currentThread: makeThread({ messages: [{ id: "message-2" }] }),
      snapshot: makeSnapshot({
        messages: [{ id: "message-2" }],
        messageCursorId: "message-1",
      }),
      requestedBefore: makeRequestedBeforeMessage("message-2"),
    });

    expect(result.addedItemCount).toBe(0);
    expect(result.cursorAdvanced).toBe(true);
    expect(result.isNoopPage).toBe(false);
  });

  it("builds returned cursor keys only for requested collections", () => {
    const result = deriveOlderThreadDetailPageIntegrity({
      currentThread: makeThread({ messages: [{ id: "message-2" }] }),
      snapshot: makeSnapshot({
        messages: [{ id: "message-2" }],
        messageCursorId: "message-2",
        activityCursorId: "activity-1",
      }),
      requestedBefore: makeRequestedBeforeMessage("message-2"),
    });

    expect(result.returnedCursorKey).toBe("messages:message-2:2026-03-29T00:00:04.000Z::");
    expect(result.cursorAdvanced).toBe(false);
    expect(result.isNoopPage).toBe(true);
  });

  it("treats terminal requested page info as cursor advancement", () => {
    const result = deriveOlderThreadDetailPageIntegrity({
      currentThread: makeThread({ messages: [{ id: "message-2" }] }),
      snapshot: makeSnapshot({
        messages: [{ id: "message-2" }],
      }),
      requestedBefore: makeRequestedBeforeMessage("message-2"),
    });

    expect(result.returnedCursorKey).toBeNull();
    expect(result.cursorAdvanced).toBe(true);
    expect(result.isNoopPage).toBe(false);
  });
});
