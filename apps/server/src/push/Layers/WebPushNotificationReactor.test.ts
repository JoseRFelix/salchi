import {
  CheckpointRef,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  createRuntimeNotificationContentTrackerForTest,
  deriveWebPushPayloadForEvent,
  selectLatestThreadContentForTurnCompletion,
  selectProjectedThreadContentForTurnCompletion,
  shouldNotifyRuntimeTurnCompletion,
  type RuntimeContentTrackingEvent,
} from "./WebPushNotificationReactor.ts";

const now = "2026-01-01T00:00:00.000Z";

function makeTurnDiffCompletedEvent(
  status: "ready" | "missing" | "error",
): Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }> {
  const threadId = ThreadId.make("thread-1");
  const turnId = TurnId.make("turn-1");

  return {
    sequence: 1,
    eventId: EventId.make(`event-turn-diff-${status}`),
    type: "thread.turn-diff-completed",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.make(`cmd-turn-diff-${status}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make(`checkpoint-${status}`),
      status,
      files: [],
      attribution: "unattributed",
      assistantMessageId: MessageId.make("assistant-1"),
      completedAt: now,
    },
  };
}

function makeTurnCompletedEvent(
  state: "completed" | "failed" | "interrupted" | "cancelled" = "completed",
  payload: Partial<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"]> = {},
): Extract<ProviderRuntimeEvent, { type: "turn.completed" }> {
  return {
    eventId: EventId.make(`event-turn-completed-${state}`),
    type: "turn.completed",
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    createdAt: now,
    payload: {
      state,
      ...payload,
    },
  };
}

function makeRuntimeTrackingEvent(input: {
  readonly eventId: string;
  readonly itemId?: string;
  readonly turnId?: string;
}): RuntimeContentTrackingEvent {
  return {
    eventId: EventId.make(input.eventId),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make(input.turnId ?? "turn-1"),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
  };
}

function makeThreadShell(input: {
  readonly id?: ThreadId;
  readonly parentThreadId?: ThreadId | null;
  readonly subagentKind?: string | null;
  readonly latestUserMessageAt?: string | null;
  readonly status?: NonNullable<OrchestrationThreadShell["session"]>["status"];
  readonly activeTurnId?: TurnId | null;
}): OrchestrationThreadShell {
  return {
    id: input.id ?? ThreadId.make("thread-1"),
    title: "Finished thread",
    parentThreadId: input.parentThreadId ?? null,
    subagentKind: input.subagentKind ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    session: {
      status: input.status ?? "ready",
      activeTurnId: input.activeTurnId ?? null,
    },
  } as OrchestrationThreadShell;
}

function makeActivityAppendedEvent(
  kind: "approval.requested" | "user-input.requested" = "approval.requested",
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  const threadId = ThreadId.make("thread-1");
  const activityId = EventId.make(`event-activity-${kind}`);

  return {
    sequence: 1,
    eventId: EventId.make(`event-thread-activity-${kind}`),
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.make(`cmd-thread-activity-${kind}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      activity: {
        id: activityId,
        tone: kind === "approval.requested" ? "approval" : "info",
        kind,
        summary: kind === "approval.requested" ? "Command approval requested" : "Input requested",
        payload: null,
        turnId: null,
        createdAt: now,
      },
    },
  };
}

function makeProjectedMessage(input: {
  readonly id: string;
  readonly text: string;
  readonly turnId?: string | null;
  readonly streaming?: boolean;
  readonly createdAt?: string;
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: "assistant",
    text: input.text,
    attachments: [],
    turnId:
      input.turnId === undefined
        ? TurnId.make("turn-1")
        : input.turnId === null
          ? null
          : TurnId.make(input.turnId),
    streaming: input.streaming ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.createdAt ?? now,
  };
}

describe("runtime notification content tracking", () => {
  it("uses the latest assistant message segment from a turn", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a", itemId: "item-a" }),
      "first segment",
    );
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-b", itemId: "item-b" }),
      "final segment",
    );

    expect(tracker.take(makeTurnCompletedEvent())).toBe("final segment");
  });

  it("keeps appending chunks within the same assistant item", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-b-1", itemId: "item-b" }),
      "final ",
    );
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-b-2", itemId: "item-b" }),
      "segment",
    );

    expect(tracker.take(makeTurnCompletedEvent())).toBe("final segment");
  });

  it("starts a new notification segment after approval boundary for the same item", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a-before", itemId: "item-a" }),
      "before approval",
    );
    tracker.markBoundary(makeRuntimeTrackingEvent({ eventId: "event-request-opened" }));
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a-after", itemId: "item-a" }),
      " after approval",
    );

    expect(
      tracker.messageKeys(makeRuntimeTrackingEvent({ eventId: "event-inspect", itemId: "item-a" })),
    ).toEqual(["item:item-a", "item:item-a:segment:1"]);
    expect(tracker.take(makeTurnCompletedEvent())).toBe("after approval");
  });

  it("starts a new notification segment after user input boundary for the same item", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a-before", itemId: "item-a" }),
      "before input",
    );
    tracker.markBoundary(makeRuntimeTrackingEvent({ eventId: "event-user-input-requested" }));
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a-after", itemId: "item-a" }),
      " after input",
    );

    expect(tracker.take(makeTurnCompletedEvent())).toBe("after input");
  });

  it("does not increment segments repeatedly without new assistant content", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a-before", itemId: "item-a" }),
      "first",
    );
    tracker.markBoundary(makeRuntimeTrackingEvent({ eventId: "event-request-opened" }));
    tracker.markBoundary(makeRuntimeTrackingEvent({ eventId: "event-user-input-requested" }));
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a-after", itemId: "item-a" }),
      "second",
    );

    expect(
      tracker.messageKeys(makeRuntimeTrackingEvent({ eventId: "event-inspect", itemId: "item-a" })),
    ).toEqual(["item:item-a", "item:item-a:segment:1"]);
    expect(tracker.take(makeTurnCompletedEvent())).toBe("second");
  });

  it("does not concatenate earlier assistant items into the body", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a", itemId: "item-a" }),
      "first",
    );
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-b", itemId: "item-b" }),
      "second",
    );

    expect(tracker.take(makeTurnCompletedEvent())).toBe("second");
  });

  it("uses assistant item completion detail when no delta exists", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.setMessage(
      makeRuntimeTrackingEvent({ eventId: "event-item-completed", itemId: "item-completed" }),
      "completed detail",
    );

    expect(tracker.take(makeTurnCompletedEvent())).toBe("completed detail");
  });

  it("clears tracked content after completion", () => {
    const tracker = createRuntimeNotificationContentTrackerForTest();
    tracker.appendDelta(
      makeRuntimeTrackingEvent({ eventId: "event-item-a", itemId: "item-a" }),
      "final segment",
    );

    expect(tracker.take(makeTurnCompletedEvent())).toBe("final segment");
    expect(tracker.take(makeTurnCompletedEvent())).toBeNull();
  });
});

describe("selectLatestThreadContentForTurnCompletion", () => {
  it("prefers runtime content over projected same-turn content", () => {
    expect(
      selectLatestThreadContentForTurnCompletion({
        event: makeTurnCompletedEvent(),
        runtimeContent: "after approval",
        projectedContent: {
          content: "before approval",
          turnId: TurnId.make("turn-1"),
          streaming: false,
        },
      }),
    ).toBe("after approval");
  });

  it("uses projected content when runtime content is unavailable", () => {
    expect(
      selectLatestThreadContentForTurnCompletion({
        event: makeTurnCompletedEvent(),
        runtimeContent: null,
        projectedContent: {
          content: "projected final",
          turnId: TurnId.make("turn-1"),
          streaming: false,
        },
      }),
    ).toBe("projected final");
  });
});

describe("selectProjectedThreadContentForTurnCompletion", () => {
  it("uses latestTurn assistantMessageId when selecting projected fallback", () => {
    expect(
      selectProjectedThreadContentForTurnCompletion({
        event: makeTurnCompletedEvent(),
        thread: {
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: MessageId.make("assistant:item-a:segment:1"),
          },
          messages: [
            makeProjectedMessage({
              id: "assistant:item-a:segment:1",
              text: " after approval",
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
            makeProjectedMessage({
              id: "assistant:item-a",
              text: "before approval",
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
          ],
        },
      })?.content,
    ).toBe("after approval");
  });
});

describe("deriveWebPushPayloadForEvent", () => {
  it("does not send a completion notification for placeholder turn diffs", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnDiffCompletedEvent("missing"),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Thread still running",
      latestThreadContent: null,
    });

    expect(payload).toBeNull();
  });

  it("does not send a completion notification for finalized turn diffs", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnDiffCompletedEvent("ready"),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Finished thread",
      latestThreadContent: null,
    });

    expect(payload).toBeNull();
  });

  it("uses the thread title and latest content for runtime turn completion", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnCompletedEvent(),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Finished thread",
      latestThreadContent: "Latest assistant response",
    });

    expect(payload).toEqual({
      title: "Finished thread",
      body: "Latest assistant response",
      url: "/environment-local/thread-1",
      tag: "thread:thread-1:turn:turn-1",
    });
  });

  it("falls back to the event content when latest thread content is unavailable", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnCompletedEvent(),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Finished thread",
      latestThreadContent: null,
    });

    expect(payload).toEqual({
      title: "Finished thread",
      body: "Agent turn completed",
      url: "/environment-local/thread-1",
      tag: "thread:thread-1:turn:turn-1",
    });
  });

  it("uses the error message before latest content for failed turn notifications", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnCompletedEvent("failed", {
        errorMessage: "Provider quota exhausted",
      }),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Finished thread",
      latestThreadContent: "Partial assistant response",
    });

    expect(payload).toEqual({
      title: "Finished thread",
      body: "Provider quota exhausted",
      url: "/environment-local/thread-1",
      tag: "thread:thread-1:turn:turn-1",
    });
  });

  it("does not notify for cancelled turn completions", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnCompletedEvent("cancelled"),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Stopped thread",
      latestThreadContent: "Partial assistant response",
    });

    expect(payload).toBeNull();
  });

  it("does not notify for interrupted manual stop completions", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnCompletedEvent("interrupted", {
        errorMessage: "Session stopped.",
      }),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Stopped thread",
      latestThreadContent: "Partial assistant response",
    });

    expect(payload).toBeNull();
  });

  it("uses a generic action body for non-stop interrupted turn notifications", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeTurnCompletedEvent("interrupted", {
        errorMessage: "rate limit exceeded",
        stopReason: "quota",
      }),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Interrupted thread",
      latestThreadContent: "Partial assistant response",
    });

    expect(payload).toEqual({
      title: "Interrupted thread",
      body: "Agent interrupted. Open Salchi to choose the next action.",
      url: "/environment-local/thread-1",
      tag: "thread:thread-1:turn:turn-1",
    });
  });

  it("uses the thread title and activity summary for approval notifications", () => {
    const payload = deriveWebPushPayloadForEvent({
      event: makeActivityAppendedEvent(),
      environmentId: EnvironmentId.make("environment-local"),
      threadTitle: "Approval thread",
      latestThreadContent: "Command approval requested",
    });

    expect(payload).toEqual({
      title: "Approval thread",
      body: "Command approval requested",
      url: "/environment-local/thread-1",
      tag: "thread:thread-1:approval:event-activity-approval.requested",
    });
  });

  it("suppresses late turn completion notifications after the session is stopped", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(makeThreadShell({ status: "stopped" })),
      ),
    ).toBe(false);
  });

  it("keeps suppressing stale completions for a different active turn", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(makeThreadShell({ status: "running", activeTurnId: TurnId.make("turn-2") })),
      ),
    ).toBe(false);
  });

  it("suppresses successful completion notifications for unengaged materialized subagents", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(
          makeThreadShell({
            parentThreadId: ThreadId.make("parent-thread"),
            subagentKind: "thread_spawn",
            latestUserMessageAt: null,
          }),
        ),
      ),
    ).toBe(false);
  });

  it("notifies materialized subagents after durable user engagement", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(
          makeThreadShell({
            parentThreadId: ThreadId.make("parent-thread"),
            subagentKind: "thread_spawn",
            latestUserMessageAt: "2026-01-01T00:00:01.000Z",
          }),
        ),
      ),
    ).toBe(true);
  });

  it("notifies materialized subagents after same-process user engagement", () => {
    const childThreadId = ThreadId.make("thread-1");

    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(
          makeThreadShell({
            id: childThreadId,
            parentThreadId: ThreadId.make("parent-thread"),
            subagentKind: "thread_spawn",
            latestUserMessageAt: null,
          }),
        ),
        {
          engagedThreadIds: new Set([childThreadId]),
        },
      ),
    ).toBe(true);
  });

  it("keeps notifying root threads without user engagement", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(
          makeThreadShell({
            parentThreadId: null,
            subagentKind: null,
            latestUserMessageAt: null,
          }),
        ),
      ),
    ).toBe(true);
  });

  it("does not suppress non-materialized child thread kinds", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent(),
        Option.some(
          makeThreadShell({
            parentThreadId: ThreadId.make("parent-thread"),
            subagentKind: "independent_thread",
            latestUserMessageAt: null,
          }),
        ),
      ),
    ).toBe(true);
  });

  it("keeps notifying unengaged materialized subagent failures", () => {
    expect(
      shouldNotifyRuntimeTurnCompletion(
        makeTurnCompletedEvent("failed", {
          errorMessage: "Provider quota exhausted",
        }),
        Option.some(
          makeThreadShell({
            parentThreadId: ThreadId.make("parent-thread"),
            subagentKind: "thread_spawn",
            latestUserMessageAt: null,
          }),
        ),
      ),
    ).toBe(true);
  });
});
