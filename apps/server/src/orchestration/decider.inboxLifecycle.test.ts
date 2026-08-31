import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@salchi/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const activityAt = "2026-08-27T12:00:00.000Z";
const threadId = ThreadId.make("thread-inbox-lifecycle");

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function makeReadModel(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-inbox-lifecycle"),
        title: "Inbox lifecycle",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        queuedTurns: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: createdAt,
  };
}

function asEvents(value: PlannedEvent | ReadonlyArray<PlannedEvent>): ReadonlyArray<PlannedEvent> {
  return Array.isArray(value) ? value : [value as PlannedEvent];
}

function projectEvents(
  initial: OrchestrationReadModel,
  planned: PlannedEvent | ReadonlyArray<PlannedEvent>,
) {
  return Effect.gen(function* () {
    let next = initial;
    for (const event of asEvents(planned)) {
      next = yield* projectEvent(next, {
        ...event,
        sequence: next.snapshotSequence + 1,
      } as OrchestrationEvent);
    }
    return next;
  });
}

function onlyThread(readModel: OrchestrationReadModel) {
  const thread = readModel.threads[0];
  if (!thread) throw new Error("expected lifecycle test thread");
  return thread;
}

it.layer(NodeServices.layer)("inbox lifecycle decider and projector", (it) => {
  it.effect("projects pin order, snooze, settle, and explicit un-settle state", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel();

      const pin = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("command-pin"),
          threadId,
          orderKey: "g",
        },
        readModel,
      });
      expect(asEvents(pin).map((event) => event.type)).toEqual(["thread.pinned"]);
      readModel = yield* projectEvents(readModel, pin);
      expect(onlyThread(readModel)).toMatchObject({
        pinnedAt: expect.any(String),
        pinOrderKey: "g",
      });

      const reorder = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin.reorder",
          commandId: CommandId.make("command-reorder"),
          threadId,
          orderKey: "b",
        },
        readModel,
      });
      readModel = yield* projectEvents(readModel, reorder);
      expect(onlyThread(readModel).pinOrderKey).toBe("b");

      const snooze = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("command-snooze"),
          threadId,
          snoozedUntil: "2099-01-01T09:00:00.000Z",
        },
        readModel,
      });
      readModel = yield* projectEvents(readModel, snooze);
      expect(onlyThread(readModel)).toMatchObject({
        snoozedUntil: "2099-01-01T09:00:00.000Z",
        snoozedAt: expect.any(String),
        pinnedAt: expect.any(String),
      });

      const settle = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("command-settle"),
          threadId,
        },
        readModel,
      });
      expect(asEvents(settle).map((event) => event.type)).toEqual([
        "thread.settled",
        "thread.unpinned",
        "thread.unsnoozed",
      ]);
      readModel = yield* projectEvents(readModel, settle);
      expect(onlyThread(readModel)).toMatchObject({
        settledOverride: "settled",
        settledAt: expect.any(String),
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
      });

      const unsettle = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("command-unsettle"),
          threadId,
          reason: "user",
        },
        readModel,
      });
      readModel = yield* projectEvents(readModel, unsettle);
      expect(onlyThread(readModel)).toMatchObject({
        settledOverride: "active",
        settledAt: null,
        unsettledAt: expect.any(String),
      });
    }),
  );

  it.effect("automatically wakes and un-settles work when a turn starts", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        settledOverride: "settled",
        settledAt: createdAt,
        snoozedUntil: "2099-01-01T09:00:00.000Z",
        snoozedAt: createdAt,
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-resume"),
          threadId,
          message: {
            messageId: MessageId.make("message-resume"),
            role: "user",
            text: "Resume this work",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: activityAt,
        },
        readModel,
      });
      const events = asEvents(decided);
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsnoozed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const unsettled = events.find((event) => event.type === "thread.unsettled");
      const unsnoozed = events.find((event) => event.type === "thread.unsnoozed");
      expect((unsettled?.payload as { readonly reason?: string } | undefined)?.reason).toBe(
        "activity",
      );
      expect((unsnoozed?.payload as { readonly reason?: string } | undefined)?.reason).toBe(
        "activity",
      );

      const projected = yield* projectEvents(readModel, decided);
      expect(onlyThread(projected)).toMatchObject({
        settledOverride: null,
        settledAt: null,
        unsettledAt: activityAt,
        snoozedUntil: null,
        snoozedAt: null,
      });
    }),
  );

  it.effect("keeps a user snooze when a running session snapshot arrives", () =>
    Effect.gen(function* () {
      const snoozedUntil = "2099-01-01T09:00:00.000Z";
      const readModel = makeReadModel({
        snoozedUntil,
        snoozedAt: createdAt,
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("command-running-while-snoozed"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: activityAt,
          },
          createdAt: activityAt,
        },
        readModel,
      });

      expect(asEvents(decided).map((event) => event.type)).toEqual(["thread.session-set"]);
      const projected = yield* projectEvents(readModel, decided);
      expect(onlyThread(projected)).toMatchObject({ snoozedUntil, snoozedAt: createdAt });
    }),
  );

  it.effect("preserves an explicit un-settle anchor when activity resumes", () =>
    Effect.gen(function* () {
      const anchor = "2026-08-20T12:00:00.000Z";
      const readModel = makeReadModel({
        settledOverride: "active",
        unsettledAt: anchor,
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-active-resume"),
          threadId,
          message: {
            messageId: MessageId.make("message-active-resume"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: activityAt,
        },
        readModel,
      });
      const projected = yield* projectEvents(readModel, decided);
      expect(onlyThread(projected).settledOverride).toBeNull();
      expect(onlyThread(projected).unsettledAt).toBe(anchor);
    }),
  );

  it.effect("emits an asynchronous title regeneration request", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("command-regenerate-title"),
          threadId,
          regenerateTitle: true,
        },
        readModel: makeReadModel(),
      });
      const [event] = asEvents(decided);
      expect(event?.type).toBe("thread.title-regeneration-requested");
      if (event?.type === "thread.title-regeneration-requested") {
        expect(event.payload).toMatchObject({
          threadId,
          previousTitle: "Inbox lifecycle",
          requestedAt: expect.any(String),
        });
      }
    }),
  );
});
