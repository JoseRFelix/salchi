import { describe, expect, it } from "vitest";
import { EnvironmentId, ThreadId, TurnId, type OrchestrationLatestTurn } from "@salchi/contracts";

import {
  countUnseenCompletedThreads,
  getAcknowledgedCompletionTurnId,
  getUnseenCompletionTurnId,
  hasUnseenCompletion,
  normalizeSeenCompletionTurnId,
} from "./threadCompletion";

function makeLatestTurn(
  turnId: string,
  state: OrchestrationLatestTurn["state"] = "completed",
  completedAt: string | null = "2026-06-12T12:00:00.000Z",
): Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt"> {
  return { turnId: TurnId.make(turnId), state, completedAt };
}

describe("hasUnseenCompletion", () => {
  it("uses the exact completion identity instead of client timestamps", () => {
    const latestTurn = makeLatestTurn("turn-latest");

    expect(hasUnseenCompletion({ latestTurn, seenCompletionTurnId: null })).toBe(true);
    expect(
      hasUnseenCompletion({
        latestTurn,
        seenCompletionTurnId: TurnId.make("turn-older"),
      }),
    ).toBe(true);
    expect(
      hasUnseenCompletion({
        latestTurn,
        seenCompletionTurnId: TurnId.make("turn-latest"),
      }),
    ).toBe(false);
    expect(getUnseenCompletionTurnId({ latestTurn, seenCompletionTurnId: null })).toBe(
      latestTurn.turnId,
    );
    expect(
      getAcknowledgedCompletionTurnId({
        latestTurn,
        seenCompletionTurnId: latestTurn.turnId,
      }),
    ).toBe(latestTurn.turnId);
  });

  it("treats a missing legacy attention field as read, but preserves explicit unread null", () => {
    const latestTurn = makeLatestTurn("turn-legacy");

    expect(normalizeSeenCompletionTurnId({ latestTurn })).toBe(latestTurn.turnId);
    expect(hasUnseenCompletion({ latestTurn })).toBe(false);
    expect(normalizeSeenCompletionTurnId({ latestTurn, seenCompletionTurnId: null })).toBeNull();
    expect(hasUnseenCompletion({ latestTurn, seenCompletionTurnId: null })).toBe(true);
  });

  it("ignores active and interrupted turns", () => {
    expect(hasUnseenCompletion({ latestTurn: null, seenCompletionTurnId: null })).toBe(false);
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn("turn-running", "running", null),
        seenCompletionTurnId: null,
      }),
    ).toBe(false);
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn("turn-interrupted", "interrupted"),
        seenCompletionTurnId: null,
      }),
    ).toBe(false);
  });

  it("counts failed terminal turns as unread", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn("turn-failed", "error"),
        seenCompletionTurnId: null,
      }),
    ).toBe(true);
  });
});

describe("countUnseenCompletedThreads", () => {
  it("counts visible, unarchived unread threads once each", () => {
    const environmentId = EnvironmentId.make("environment-local");

    expect(
      countUnseenCompletedThreads([
        {
          id: ThreadId.make("thread-seen"),
          environmentId,
          archivedAt: null,
          latestTurn: makeLatestTurn("turn-seen"),
          seenCompletionTurnId: TurnId.make("turn-seen"),
        },
        {
          id: ThreadId.make("thread-unseen"),
          environmentId,
          archivedAt: null,
          latestTurn: makeLatestTurn("turn-unseen"),
          seenCompletionTurnId: null,
        },
        {
          id: ThreadId.make("thread-archived"),
          environmentId,
          archivedAt: "2026-06-12T12:06:00.000Z",
          latestTurn: makeLatestTurn("turn-archived"),
          seenCompletionTurnId: null,
        },
        {
          id: ThreadId.make("thread-hidden"),
          environmentId,
          archivedAt: null,
          hiddenFromThreadList: true,
          latestTurn: makeLatestTurn("turn-hidden"),
          seenCompletionTurnId: null,
        },
      ]),
    ).toBe(1);
  });
});
