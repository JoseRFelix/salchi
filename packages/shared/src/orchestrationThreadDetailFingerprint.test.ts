import { describe, expect, it } from "vitest";
import {
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadDetailSnapshot,
} from "@salchi/contracts";

import {
  computeOrchestrationThreadDetailFingerprint,
  orchestrationThreadDetailFingerprintsEqual,
} from "./orchestrationThreadDetailFingerprint.js";

describe("orchestration thread detail fingerprint", () => {
  it("is stable for equivalent snapshots and changes when visible message content changes", () => {
    const first = makeSnapshot("Still working");
    const equivalent = makeSnapshot("Still working");
    const changed = makeSnapshot("Still working with more text");

    const firstFingerprint = computeOrchestrationThreadDetailFingerprint(first);
    expect(
      orchestrationThreadDetailFingerprintsEqual(
        firstFingerprint,
        computeOrchestrationThreadDetailFingerprint(equivalent),
      ),
    ).toBe(true);
    expect(
      orchestrationThreadDetailFingerprintsEqual(
        firstFingerprint,
        computeOrchestrationThreadDetailFingerprint(changed),
      ),
    ).toBe(false);
  });
});

function makeSnapshot(text: string): OrchestrationThreadDetailSnapshot {
  const threadId = ThreadId.make("thread-1");
  const turnId = TurnId.make("turn-1");
  const now = "2026-04-13T00:00:00.000Z";
  return {
    snapshotSequence: 1,
    pageInfo: EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: MessageId.make("message-1"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      session: {
        threadId,
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text,
          attachments: [],
          turnId,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      queuedTurns: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    },
  };
}
