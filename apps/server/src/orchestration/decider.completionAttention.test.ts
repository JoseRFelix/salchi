import {
  CheckpointRef,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@salchi/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-18T00:00:00.000Z";
const threadId = ThreadId.make("thread-attention");
const turnId = TurnId.make("turn-attention");

const seedCompletedThread = Effect.gen(function* () {
  const created = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      projectId: ProjectId.make("project-attention"),
      title: "Attention",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(created, {
    sequence: 2,
    eventId: EventId.make("event-turn-completed"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.turn-diff-completed",
    occurredAt: now,
    commandId: CommandId.make("command-turn-completed"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("checkpoint-attention"),
      status: "ready",
      files: [],
      attribution: "unattributed",
      assistantMessageId: null,
      completedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("completion attention decider", (it) => {
  it.effect("acknowledges only the exact latest terminal completion", () =>
    Effect.gen(function* () {
      const readModel = yield* seedCompletedThread;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.completion.acknowledge",
          commandId: CommandId.make("command-acknowledge"),
          threadId,
          turnId,
        },
        readModel,
      });

      expect("type" in event).toBe(true);
      if (!("type" in event)) return;
      expect(event.type).toBe("thread.completion-acknowledged");
      expect(event.payload).toEqual({ threadId, turnId });
      const acknowledged = yield* projectEvent(readModel, {
        ...event,
        sequence: 3,
      } as OrchestrationEvent);
      expect(acknowledged.threads[0]?.seenCompletionTurnId).toBe(turnId);

      const duplicateAcknowledgeError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.completion.acknowledge",
            commandId: CommandId.make("command-duplicate-acknowledge"),
            threadId,
            turnId,
          },
          readModel: acknowledged,
        }),
      );
      expect(duplicateAcknowledgeError.message).toContain("already acknowledged");

      const markedUnreadEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.completion.mark-unread",
          commandId: CommandId.make("command-mark-unread"),
          threadId,
          turnId,
        },
        readModel: acknowledged,
      });
      expect("type" in markedUnreadEvent).toBe(true);
      if (!("type" in markedUnreadEvent)) return;
      const markedUnread = yield* projectEvent(acknowledged, {
        ...markedUnreadEvent,
        sequence: 4,
      } as OrchestrationEvent);
      expect(markedUnread.threads[0]?.seenCompletionTurnId).toBeNull();

      const duplicateMarkUnreadError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.completion.mark-unread",
            commandId: CommandId.make("command-duplicate-mark-unread"),
            threadId,
            turnId,
          },
          readModel: markedUnread,
        }),
      );
      expect(duplicateMarkUnreadError.message).toContain("not currently acknowledged");
    }),
  );

  it.effect("rejects a stale completion identity", () =>
    Effect.gen(function* () {
      const readModel = yield* seedCompletedThread;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.completion.acknowledge",
            commandId: CommandId.make("command-stale-acknowledge"),
            threadId,
            turnId: TurnId.make("turn-older"),
          },
          readModel,
        }),
      );

      expect(error.message).toContain("not the latest unread-eligible completion");
    }),
  );
});
