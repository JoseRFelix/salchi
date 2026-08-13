import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type { OrchestrationThreadActivity, OrchestrationThreadShell } from "@salchi/contracts";
import { isRecord } from "@salchi/shared/Record";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_IDLE_READY_ROOT_SESSIONS = 4;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly maxIdleReadyRootSessions?: number;
}

function activityIdentity(
  activity: OrchestrationThreadActivity,
  field: "taskId" | "subagentId",
): string | null {
  if (!isRecord(activity.payload)) {
    return null;
  }
  const value = activity.payload[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function hasLiveBackgroundActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  const liveTasks = new Set<string>();
  const liveSubagents = new Set<string>();

  for (const activity of activities) {
    if (activity.kind === "task.started" || activity.kind === "task.progress") {
      const taskId = activityIdentity(activity, "taskId");
      if (taskId) liveTasks.add(taskId);
    } else if (activity.kind === "task.completed") {
      const taskId = activityIdentity(activity, "taskId");
      if (taskId) liveTasks.delete(taskId);
    } else if (activity.kind === "subagent.started" || activity.kind === "subagent.updated") {
      const subagentId = activityIdentity(activity, "subagentId");
      if (subagentId) liveSubagents.add(subagentId);
    } else if (activity.kind === "subagent.completed") {
      const subagentId = activityIdentity(activity, "subagentId");
      if (subagentId) liveSubagents.delete(subagentId);
    }
  }

  return liveTasks.size > 0 || liveSubagents.size > 0;
}

export function threadIdsWithLiveDescendants(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlySet<string> {
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));
  const owners = new Set<string>();
  for (const thread of threads) {
    const session = thread.session;
    if (
      session?.activeTurnId == null &&
      session?.status !== "starting" &&
      session?.status !== "running"
    ) {
      continue;
    }

    let ownerId = thread.createdByThreadId;
    const visited = new Set<string>();
    while (ownerId !== null && !visited.has(String(ownerId))) {
      const normalizedOwnerId = String(ownerId);
      visited.add(normalizedOwnerId);
      owners.add(normalizedOwnerId);
      ownerId = threadsById.get(normalizedOwnerId)?.createdByThreadId ?? null;
    }
  }
  return owners;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxIdleReadyRootSessions = Math.max(
      0,
      options?.maxIdleReadyRootSessions ?? DEFAULT_MAX_IDLE_READY_ROOT_SESSIONS,
    );

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const threadsById = new Map(shellSnapshot.threads.map((thread) => [thread.id, thread]));
      const liveDescendantOwnerIds = threadIdsWithLiveDescendants(shellSnapshot.threads);
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;
      const candidates: Array<{
        readonly binding: (typeof bindings)[number];
        readonly idleDurationMs: number;
        readonly lastSeenMs: number;
        readonly isIdleReadyRoot: boolean;
      }> = [];

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        const thread = threadsById.get(binding.threadId);
        const isIdleReadyRoot =
          thread?.createdByThreadId == null && thread?.session?.status === "ready";
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        if (idleDurationMs < inactivityThresholdMs && !isIdleReadyRoot) {
          continue;
        }

        if (liveDescendantOwnerIds.has(String(binding.threadId))) {
          yield* Effect.logDebug("provider.session.reaper.skipped-live-descendant", {
            threadId: binding.threadId,
            idleDurationMs,
          });
          continue;
        }

        const hasBackgroundActivity = yield* projectionSnapshotQuery
          .getThreadDetailById(binding.threadId)
          .pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (detail) => hasLiveBackgroundActivity(detail.activities),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.background-check-failed", {
                threadId: binding.threadId,
                cause,
              }).pipe(Effect.as(true)),
            ),
          );
        if (hasBackgroundActivity) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            idleDurationMs,
          });
          continue;
        }

        candidates.push({
          binding,
          idleDurationMs,
          lastSeenMs,
          isIdleReadyRoot,
        });
      }

      const overCapacityThreadIds = new Set(
        candidates
          .filter((candidate) => candidate.isIdleReadyRoot)
          .toSorted(
            (left, right) =>
              right.lastSeenMs - left.lastSeenMs ||
              String(right.binding.threadId).localeCompare(String(left.binding.threadId)),
          )
          .slice(maxIdleReadyRootSessions)
          .map((candidate) => candidate.binding.threadId),
      );

      for (const candidate of candidates) {
        const { binding, idleDurationMs } = candidate;
        const reason =
          idleDurationMs >= inactivityThresholdMs
            ? "inactivity_threshold"
            : overCapacityThreadIds.has(binding.threadId)
              ? "idle_ready_capacity"
              : null;
        if (reason === null) {
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason,
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
          maxIdleReadyRootSessions,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
