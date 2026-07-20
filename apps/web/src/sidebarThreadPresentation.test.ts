import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import type { DraftThreadState } from "./composerDraftStore";
import type { LocalDispatchSnapshot } from "./components/ChatView.logic";
import { sortThreads } from "./lib/threadSort";
import { buildSidebarThreadPresentation } from "./sidebarThreadPresentation";
import type { SidebarThreadSummary, Thread } from "./types";

const environmentId = EnvironmentId.make("env-sidebar-pending");
const projectId = ProjectId.make("project-sidebar-pending");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
  options: [],
};

function makeDraftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    threadId: ThreadId.make("thread-draft-pending"),
    environmentId,
    projectId,
    logicalProjectKey: "logical-project",
    createdAt: "2026-04-03T20:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    envMode: "local",
    sourceProposedPlan: null,
    promotedTo: null,
    ...overrides,
  };
}

function makeLocalDispatch(overrides: Partial<LocalDispatchSnapshot> = {}): LocalDispatchSnapshot {
  return {
    startedAt: "2026-04-03T20:30:00.000Z",
    preparingWorktree: false,
    latestTurnTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-server"),
    environmentId,
    projectId,
    title: "Server thread",
    interactionMode: "default",
    session: null,
    createdAt: "2026-04-03T19:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-03T19:05:00.000Z",
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    latestUserMessageAt: "2026-04-03T19:05:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeServerThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-draft-pending"),
    environmentId,
    codexThreadId: null,
    projectId,
    title: "Server detail title",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    queuedTurns: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-03T20:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-03T20:20:00.000Z",
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("buildSidebarThreadPresentation", () => {
  it("adds a pending row for a locally dispatched draft thread", () => {
    const draftThread = makeDraftThread();
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, draftThread.threadId));

    const presentation = buildSidebarThreadPresentation({
      serverThreads: [],
      draftThreads: [draftThread],
      localDispatchByThreadKey: {
        [threadKey]: makeLocalDispatch(),
      },
    });

    expect(presentation.pendingThreadKeys.has(threadKey)).toBe(true);
    expect(presentation.threads).toHaveLength(1);
    expect(presentation.threads[0]).toMatchObject({
      id: draftThread.threadId,
      title: "New thread",
      latestUserMessageAt: "2026-04-03T20:30:00.000Z",
      updatedAt: "2026-04-03T20:30:00.000Z",
      branch: "main",
    });
  });

  it("adds a pending row for a promoted draft while the server sidebar summary is missing", () => {
    const promotedRef = scopeThreadRef(environmentId, ThreadId.make("thread-promoted"));
    const draftThread = makeDraftThread({
      threadId: promotedRef.threadId,
      promotedTo: promotedRef,
    });
    const threadKey = scopedThreadKey(promotedRef);

    const presentation = buildSidebarThreadPresentation({
      serverThreads: [],
      draftThreads: [draftThread],
      localDispatchByThreadKey: {},
    });

    expect(presentation.pendingThreadKeys.has(threadKey)).toBe(true);
    expect(presentation.threads[0]?.id).toBe(promotedRef.threadId);
  });

  it("uses local dispatch from the draft key for a promoted pending row", () => {
    const promotedRef = scopeThreadRef(environmentId, ThreadId.make("thread-promoted-after-send"));
    const draftThread = makeDraftThread({
      threadId: ThreadId.make("thread-draft-before-promotion"),
      promotedTo: promotedRef,
    });
    const draftThreadKey = scopedThreadKey(scopeThreadRef(environmentId, draftThread.threadId));
    const promotedThreadKey = scopedThreadKey(promotedRef);

    const presentation = buildSidebarThreadPresentation({
      serverThreads: [],
      draftThreads: [draftThread],
      localDispatchByThreadKey: {
        [draftThreadKey]: makeLocalDispatch({
          startedAt: "2026-04-03T20:45:00.000Z",
        }),
      },
    });

    expect(presentation.pendingThreadKeys.has(promotedThreadKey)).toBe(true);
    expect(presentation.threads[0]).toMatchObject({
      id: promotedRef.threadId,
      latestUserMessageAt: "2026-04-03T20:45:00.000Z",
      updatedAt: "2026-04-03T20:45:00.000Z",
    });
  });

  it("does not add an idle unpromoted draft row", () => {
    const presentation = buildSidebarThreadPresentation({
      serverThreads: [],
      draftThreads: [makeDraftThread()],
      localDispatchByThreadKey: {},
    });

    expect(presentation.threads).toEqual([]);
    expect(presentation.pendingThreadKeys.size).toBe(0);
  });

  it("lets the server sidebar row override a pending draft row", () => {
    const draftThread = makeDraftThread();
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, draftThread.threadId));
    const serverThread = makeSidebarThreadSummary({
      id: draftThread.threadId,
      title: "Authoritative server row",
    });

    const presentation = buildSidebarThreadPresentation({
      serverThreads: [serverThread],
      draftThreads: [draftThread],
      localDispatchByThreadKey: {
        [threadKey]: makeLocalDispatch(),
      },
    });

    expect(presentation.pendingThreadKeys.size).toBe(0);
    expect(presentation.threads).toEqual([serverThread]);
  });

  it("uses server detail title without changing pending dispatch sort position", () => {
    const draftThread = makeDraftThread();
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, draftThread.threadId));
    const olderServerThread = makeSidebarThreadSummary({
      id: ThreadId.make("thread-older"),
      title: "Older thread",
      latestUserMessageAt: "2026-04-03T20:00:00.000Z",
      updatedAt: "2026-04-03T20:00:00.000Z",
    });

    const presentation = buildSidebarThreadPresentation({
      serverThreads: [olderServerThread],
      draftThreads: [draftThread],
      localDispatchByThreadKey: {
        [threadKey]: makeLocalDispatch({ startedAt: "2026-04-03T20:30:00.000Z" }),
      },
      serverThreadByKey: new Map([[threadKey, makeServerThread()]]),
    });

    const sortedThreads = sortThreads(presentation.threads, "updated_at");

    expect(sortedThreads[0]?.id).toBe(draftThread.threadId);
    expect(sortedThreads[0]?.title).toBe("Server detail title");
  });
});
