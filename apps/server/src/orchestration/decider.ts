import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationQueuedTurn,
  type OrchestrationReadModel,
} from "@salchi/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request")
  );
}

function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

function threadHasQueuedTurnStart(
  thread: OrchestrationReadModel["threads"][number],
  now: string,
): boolean {
  if (thread.queuedTurns.length > 0) return true;
  if (thread.session?.status === "error") return false;
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate === null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(now) - latestUserMessageAtMs;
  return (
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function mergeMessageAttachments<TAttachment extends { readonly id: string }>(
  existing: ReadonlyArray<TAttachment> | undefined,
  next: ReadonlyArray<TAttachment>,
): TAttachment[] {
  const merged: TAttachment[] = [];
  const seenIds = new Set<string>();
  for (const attachment of [...(existing ?? []), ...next]) {
    if (seenIds.has(attachment.id)) {
      continue;
    }
    seenIds.add(attachment.id);
    merged.push(attachment);
  }
  return merged;
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

const buildQueuedTurnDispatchEvents = Effect.fn("buildQueuedTurnDispatchEvents")(function* (input: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "thread.queued-turn.confirm" | "thread.queued-turn.dispatch" }
  >;
  readonly queuedTurn: OrchestrationQueuedTurn;
  readonly messageAlreadyPersisted: boolean;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  const { command, queuedTurn } = input;
  const dispatchedEvent: PlannedOrchestrationEvent = {
    ...(yield* withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    })),
    type: "thread.queued-turn-dispatched",
    payload: {
      threadId: command.threadId,
      messageId: command.messageId,
      dispatchedAt: command.createdAt,
    },
  };
  const userMessageEvent: PlannedOrchestrationEvent | undefined = input.messageAlreadyPersisted
    ? undefined
    : {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: dispatchedEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: queuedTurn.messageId,
          role: queuedTurn.role,
          text: queuedTurn.text,
          attachments: queuedTurn.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
  const turnStartRequestedEvent: PlannedOrchestrationEvent = {
    ...(yield* withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    })),
    causationEventId: userMessageEvent?.eventId ?? dispatchedEvent.eventId,
    type: "thread.turn-start-requested",
    payload: {
      threadId: command.threadId,
      messageId: queuedTurn.messageId,
      ...(queuedTurn.modelSelection !== undefined
        ? { modelSelection: queuedTurn.modelSelection }
        : {}),
      ...(queuedTurn.titleSeed !== undefined ? { titleSeed: queuedTurn.titleSeed } : {}),
      runtimeMode: queuedTurn.runtimeMode,
      interactionMode: queuedTurn.interactionMode,
      ...(queuedTurn.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: queuedTurn.sourceProposedPlan }
        : {}),
      createdAt: command.createdAt,
    },
  };

  return userMessageEvent
    ? [dispatchedEvent, userMessageEvent, turnStartRequestedEvent]
    : [dispatchedEvent, turnStartRequestedEvent];
});

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          parentThreadId: command.parentThreadId ?? null,
          createdByThreadId: command.createdByThreadId ?? null,
          subagentKind: command.subagentKind ?? null,
          subagentNickname: command.subagentNickname ?? null,
          subagentRole: command.subagentRole ?? null,
          hiddenFromThreadList: command.hiddenFromThreadList ?? false,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has an active session and cannot be settled`,
        });
      }
      if (hasOpenBlockingRequest(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
        });
      }
      const occurredAt = yield* nowIso;
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
        });
      }
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      const companionEvents: PlannedOrchestrationEvent[] = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned",
          payload: { threadId: command.threadId, updatedAt: occurredAt },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: { threadId: command.threadId, reason: "user", updatedAt: occurredAt },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const alreadyActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} snooze wake time must be in the future`,
        });
      }
      if (hasOpenBlockingRequest(thread) || threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has pending user work and cannot be snoozed`,
        });
      }
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned",
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      const promotionEvents: PlannedOrchestrationEvent[] = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: { threadId: command.threadId, reason: "user", updatedAt: occurredAt },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: { threadId: command.threadId, reason: "user", updatedAt: occurredAt },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.pinnedAt == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: thread.pinOrderKey === command.orderKey ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.completion.acknowledge":
    case "thread.completion.mark-unread": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const latestTurn = thread.latestTurn;
      if (
        latestTurn === null ||
        latestTurn.turnId !== command.turnId ||
        latestTurn.completedAt === null ||
        latestTurn.state === "running" ||
        latestTurn.state === "interrupted"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.turnId}' is not the latest unread-eligible completion for thread '${command.threadId}'.`,
        });
      }
      if (
        command.type === "thread.completion.acknowledge" &&
        thread.seenCompletionTurnId === command.turnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.turnId}' is already acknowledged for thread '${command.threadId}'.`,
        });
      }
      if (
        command.type === "thread.completion.mark-unread" &&
        thread.seenCompletionTurnId !== command.turnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.turnId}' is not currently acknowledged for thread '${command.threadId}'.`,
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type:
          command.type === "thread.completion.acknowledge"
            ? "thread.completion-acknowledged"
            : "thread.completion-marked-unread",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.regenerateTitle === true && command.title !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "title and regenerateTitle cannot be specified together",
        });
      }
      const occurredAt = yield* nowIso;
      if (command.regenerateTitle === true) {
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.title-regeneration-requested",
          payload: {
            threadId: command.threadId,
            previousTitle: thread.title,
            requestedAt: occurredAt,
          },
        };
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      const lifecycleEvents: PlannedOrchestrationEvent[] = [];
      if (targetThread.settledOverride != null) {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: { threadId: command.threadId, reason: "activity", updatedAt: command.createdAt },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: { threadId: command.threadId, reason: "activity", updatedAt: command.createdAt },
        });
      }
      return [...lifecycleEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.queue": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      if (targetThread.queuedTurns.some((entry) => entry.messageId === command.message.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.message.messageId}' already exists on thread '${command.threadId}'.`,
        });
      }
      const queuedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-queued",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const lifecycleEvents: PlannedOrchestrationEvent[] = [];
      if (targetThread.settledOverride != null) {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: { threadId: command.threadId, reason: "activity", updatedAt: command.createdAt },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: { threadId: command.threadId, reason: "activity", updatedAt: command.createdAt },
        });
      }
      return lifecycleEvents.length > 0 ? [...lifecycleEvents, queuedEvent] : queuedEvent;
    }

    case "thread.turn.hold-for-recovery": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-queued",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: command.message.role,
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: command.sourceProposedPlan }
            : {}),
          recoveryConfirmationRequired: true,
          createdAt: command.requestedAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.queued-turn.update": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (queuedTurn.recoveryConfirmationRequired) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' requires recovery confirmation before it can be updated.`,
        });
      }
      if (queuedTurn.steering !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is already being steered into turn '${queuedTurn.steering.expectedTurnId}'.`,
        });
      }
      if (command.text.trim().length === 0 && queuedTurn.attachments.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' must include text or an attachment.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.queued-turn-updated",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          text: command.text,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.queued-turn.cancel": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (queuedTurn.steering !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is already being steered into turn '${queuedTurn.steering.expectedTurnId}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.queued-turn-cancelled",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          recoveryConfirmationRequired: queuedTurn.recoveryConfirmationRequired,
          cancelledAt: command.createdAt,
        },
      };
    }

    case "thread.queued-turn.steer": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (queuedTurn.recoveryConfirmationRequired) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' requires recovery confirmation before it can be steered.`,
        });
      }
      if (queuedTurn.steering !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is already being steered into turn '${queuedTurn.steering.expectedTurnId}'.`,
        });
      }
      if (
        targetThread.session?.status !== "running" ||
        targetThread.session.activeTurnId !== command.expectedTurnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.expectedTurnId}' is no longer the active running turn on thread '${command.threadId}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.queued-turn-steer-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          expectedTurnId: command.expectedTurnId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.queued-turn.confirm": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (queuedTurn.steering !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is being steered into turn '${queuedTurn.steering.expectedTurnId}' and cannot be dispatched.`,
        });
      }
      if (!queuedTurn.recoveryConfirmationRequired) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not require recovery confirmation.`,
        });
      }
      const messageAlreadyPersisted = targetThread.messages.some(
        (message) => message.id === queuedTurn.messageId && message.role === "user",
      );
      return yield* buildQueuedTurnDispatchEvents({
        command,
        queuedTurn,
        messageAlreadyPersisted,
      });
    }

    case "thread.queued-turn.dispatch": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (queuedTurn.recoveryConfirmationRequired) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' requires explicit recovery confirmation before it can be dispatched.`,
        });
      }
      if (queuedTurn.steering !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is being steered into turn '${queuedTurn.steering.expectedTurnId}' and cannot be dispatched.`,
        });
      }
      return yield* buildQueuedTurnDispatchEvents({
        command,
        queuedTurn,
        messageAlreadyPersisted: false,
      });
    }

    case "thread.queued-turn.steer.complete": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (
        queuedTurn.steering === undefined ||
        queuedTurn.steering.expectedTurnId !== command.turnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is not reserved for steering into turn '${command.turnId}'.`,
        });
      }
      const steeredEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.queued-turn-steered",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          turnId: command.turnId,
          steeredAt: command.createdAt,
        },
      };
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: steeredEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: queuedTurn.messageId,
          role: queuedTurn.role,
          text: queuedTurn.text,
          attachments: queuedTurn.attachments,
          turnId: command.turnId,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return [steeredEvent, userMessageEvent];
    }

    case "thread.queued-turn.steer.fail": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurn = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queuedTurn || queuedTurn.steering?.expectedTurnId !== command.expectedTurnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.messageId}' is not reserved for steering into turn '${command.expectedTurnId}'.`,
        });
      }
      const failedEventBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      const failedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...failedEventBase,
        type: "thread.queued-turn-steer-failed",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          expectedTurnId: command.expectedTurnId,
          failedAt: command.createdAt,
        },
      };
      const activityEventBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      const activityEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...activityEventBase,
        causationEventId: failedEvent.eventId,
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: activityEventBase.eventId,
            tone: "error",
            kind: "provider.turn.steer.failed",
            summary: "Provider turn steering failed",
            payload: {
              detail: command.detail,
              messageId: command.messageId,
            },
            turnId: command.expectedTurnId,
            createdAt: command.createdAt,
          },
        },
      };
      return [failedEvent, activityEvent];
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const resolvedTurnId =
        command.turnId ??
        (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : undefined) ??
        thread.session?.activeTurnId ??
        undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(resolvedTurnId !== undefined ? { turnId: resolvedTurnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      if (!isSessionActivity || (thread.settledOverride == null && thread.snoozedUntil == null)) {
        return sessionSetEvent;
      }
      const lifecycleEvents: PlannedOrchestrationEvent[] = [];
      if (thread.settledOverride != null) {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: { threadId: command.threadId, reason: "activity", updatedAt: command.createdAt },
        });
      }
      if (thread.snoozedUntil != null) {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: { threadId: command.threadId, reason: "activity", updatedAt: command.createdAt },
        });
      }
      return [...lifecycleEvents, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.attachments.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((entry) => entry.id === command.messageId);
      if (existingMessage && existingMessage.role !== command.role) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.messageId}' already exists with role '${existingMessage.role}'.`,
        });
      }

      const latestTurn = thread.latestTurn;
      const isActiveTurnMessage =
        command.turnId !== undefined &&
        latestTurn !== null &&
        latestTurn.turnId === command.turnId &&
        latestTurn.state === "running";
      const attachments = mergeMessageAttachments(
        existingMessage?.attachments,
        command.attachments,
      );

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: command.role,
          text: "",
          attachments,
          turnId: existingMessage?.turnId ?? command.turnId ?? null,
          streaming: existingMessage?.streaming ?? isActiveTurnMessage,
          createdAt: existingMessage?.createdAt ?? command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          attribution: command.attribution ?? "unattributed",
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
