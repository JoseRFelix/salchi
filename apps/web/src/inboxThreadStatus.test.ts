import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
} from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  formatInboxWorkingDurationLabel,
  resolveInboxThreadStatus,
  resolveInboxWorkingStartedAt,
} from "./inboxThreadStatus";
import type { SidebarThreadSummary } from "./types";

const latestTurn = (state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn => ({
  turnId: TurnId.make(`turn-${state}`),
  state,
  requestedAt: "2026-08-30T10:00:00.000Z",
  startedAt: "2026-08-30T10:00:01.000Z",
  completedAt: state === "running" ? null : "2026-08-30T10:01:00.000Z",
  assistantMessageId: null,
});

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-status"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-local"),
    title: "Status thread",
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-30T09:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    seenCompletionTurnId: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: "2026-08-30T09:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const resolve = (
  thread: SidebarThreadSummary,
  options: { active?: boolean; dispatching?: boolean; woke?: boolean } = {},
) =>
  resolveInboxThreadStatus({
    thread,
    hasActiveLocalDispatch: options.dispatching ?? false,
    isActive: options.active ?? false,
    isWoke: options.woke ?? false,
  });

describe("resolveInboxThreadStatus", () => {
  it("matches t3code's attention priority", () => {
    expect(
      resolve(
        makeThread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          latestTurn: latestTurn("running"),
        }),
      ),
    ).toBe("approval");
    expect(
      resolve(makeThread({ hasPendingUserInput: true, latestTurn: latestTurn("running") })),
    ).toBe("input");
    expect(resolve(makeThread({ latestTurn: latestTurn("running") }))).toBe("working");
    expect(resolve(makeThread(), { dispatching: true })).toBe("working");
  });

  it("shows failed, woke, and unseen done states without labeling resting work", () => {
    expect(resolve(makeThread({ latestTurn: latestTurn("error") }))).toBe("failed");
    expect(resolve(makeThread(), { woke: true })).toBe("woke");
    expect(resolve(makeThread({ latestTurn: latestTurn("completed") }))).toBe("done");
    expect(resolve(makeThread({ latestTurn: latestTurn("completed") }), { active: true })).toBe(
      "ready",
    );
    expect(
      resolve(
        makeThread({
          latestTurn: latestTurn("completed"),
          seenCompletionTurnId: TurnId.make("turn-completed"),
        }),
      ),
    ).toBe("ready");
  });
});

describe("inbox working duration", () => {
  it("uses the running turn start and falls back to its request timestamp", () => {
    const running = latestTurn("running");
    expect(resolveInboxWorkingStartedAt(makeThread({ latestTurn: running }))).toBe(
      running.startedAt,
    );
    expect(
      resolveInboxWorkingStartedAt(
        makeThread({ latestTurn: { ...running, startedAt: "not-a-timestamp" } }),
      ),
    ).toBe(running.requestedAt);
  });

  it("formats the same compact elapsed labels as t3code", () => {
    expect(formatInboxWorkingDurationLabel(59_999)).toBe("59s");
    expect(formatInboxWorkingDurationLabel(60_000)).toBe("1m");
    expect(formatInboxWorkingDurationLabel(3_720_000)).toBe("1h 2m");
  });
});
