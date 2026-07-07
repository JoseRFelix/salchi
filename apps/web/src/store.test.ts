import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  CheckpointRef,
  DEFAULT_MODEL,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadDetailPageCursors,
  type OrchestrationThreadDetailPageInfo,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  hydrateCachedThreadDetail,
  removeEnvironmentState,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsForProjectRef,
  selectThreadByRef,
  selectThreadExistsByRef,
  setThreadBranch,
  mergeServerThreadDetailTailSnapshot,
  mergeServerThreadDetailPage,
  selectThreadsAcrossEnvironments,
  syncSidebarThreadSummariesForEnvironment,
  syncServerThreadDetail,
  type AppState,
  type EnvironmentState,
} from "./store";
import type { CachedThreadDetail } from "./orchestrationStartupCache";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatAttachment,
  type SidebarThreadSummary,
  type Thread,
} from "./types";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  useSavedEnvironmentRegistryStore,
} from "./environments/runtime";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function withActiveEnvironmentState(
  environmentState: EnvironmentState,
  overrides: Partial<AppState & EnvironmentState> = {},
): AppState {
  const {
    activeEnvironmentId: overrideActiveEnvironmentId,
    environmentStateById: overrideEnvironmentStateById,
    ...environmentOverrides
  } = overrides;
  const activeEnvironmentId = overrideActiveEnvironmentId ?? localEnvironmentId;
  const mergedEnvironmentState = {
    ...environmentState,
    ...environmentOverrides,
  };
  const environmentStateById =
    overrideEnvironmentStateById ??
    (activeEnvironmentId
      ? {
          [activeEnvironmentId]: mergedEnvironmentState,
        }
      : {});

  return {
    activeEnvironmentId,
    environmentStateById,
    accountRateLimitsByInstanceId: {},
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    queuedTurns: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeMessage(index: number): Thread["messages"][number] {
  const id = MessageId.make(`message-${index}`);
  const turnId = TurnId.make(`turn-${index}`);
  const createdAt = `2026-02-13T00:0${index}:00.000Z`;
  return {
    id,
    role: index % 2 === 0 ? "assistant" : "user",
    text: `message ${index}`,
    turnId,
    createdAt,
    completedAt: createdAt,
    streaming: false,
  };
}

function makeQueuedTurn(index: number): Thread["queuedTurns"][number] {
  const createdAt = `2026-02-13T00:0${index}:00.000Z`;
  return {
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(`queued-message-${index}`),
    role: "user",
    text: `queued message ${index}`,
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeActivity(index: number): Thread["activities"][number] {
  return {
    id: EventId.make(`activity-${index}`),
    tone: "info",
    kind: "step",
    summary: `activity ${index}`,
    payload: {},
    turnId: TurnId.make(`turn-${index}`),
    sequence: index,
    createdAt: `2026-02-13T00:0${index}:30.000Z`,
  };
}

function makePlan(index: number): Thread["proposedPlans"][number] {
  const createdAt = `2026-02-13T00:0${index}:15.000Z`;
  return {
    id: `plan-${index}` as never,
    turnId: TurnId.make(`turn-${index}`),
    planMarkdown: `plan ${index}`,
    implementedAt: null,
    implementationThreadId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeTurnDiffSummary(index: number): Thread["turnDiffSummaries"][number] {
  return {
    turnId: TurnId.make(`turn-${index}`),
    completedAt: `2026-02-13T00:0${index}:45.000Z`,
    status: "ready",
    checkpointTurnCount: index,
    checkpointRef: CheckpointRef.make(`checkpoint-${index}`),
    assistantMessageId: MessageId.make(`message-${index}`),
    files: [],
  };
}

function toOrchestrationChatAttachment(
  attachment: ChatAttachment,
): NonNullable<OrchestrationThread["messages"][number]["attachments"]>[number] {
  if (attachment.type === "pdf") {
    return {
      type: "pdf",
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }
  return {
    type: "image",
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

function makeOrchestrationThread(
  thread: Thread,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt ?? thread.createdAt,
    archivedAt: thread.archivedAt,
    deletedAt: null,
    messages: thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.attachments
        ? {
            attachments: message.attachments.map(toOrchestrationChatAttachment),
          }
        : {}),
      turnId: message.turnId ?? null,
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    })),
    queuedTurns: thread.queuedTurns.map((queuedTurn) => ({
      threadId: queuedTurn.threadId,
      messageId: queuedTurn.messageId,
      role: queuedTurn.role,
      text: queuedTurn.text,
      attachments: queuedTurn.attachments.map(toOrchestrationChatAttachment),
      ...(queuedTurn.modelSelection !== undefined
        ? { modelSelection: queuedTurn.modelSelection }
        : {}),
      ...(queuedTurn.titleSeed !== undefined ? { titleSeed: queuedTurn.titleSeed } : {}),
      runtimeMode: queuedTurn.runtimeMode,
      interactionMode: queuedTurn.interactionMode,
      ...(queuedTurn.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: queuedTurn.sourceProposedPlan }
        : {}),
      createdAt: queuedTurn.createdAt,
      updatedAt: queuedTurn.updatedAt,
    })),
    proposedPlans: thread.proposedPlans.map((plan) => ({ ...plan })),
    activities: thread.activities.map((activity) => ({ ...activity })),
    checkpoints: thread.turnDiffSummaries.map((summary) => ({
      turnId: summary.turnId,
      checkpointTurnCount: summary.checkpointTurnCount ?? 0,
      checkpointRef: summary.checkpointRef ?? CheckpointRef.make(`checkpoint-${summary.turnId}`),
      status:
        summary.status === "ready" || summary.status === "missing" || summary.status === "error"
          ? summary.status
          : "ready",
      attribution: summary.attribution ?? "unattributed",
      files: summary.files.map((file) => ({
        path: file.path,
        kind: file.kind ?? "modified",
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      })),
      assistantMessageId: summary.assistantMessageId ?? null,
      completedAt: summary.completedAt,
    })),
    session: thread.session
      ? {
          threadId: thread.id,
          status:
            thread.session.status === "running"
              ? "running"
              : thread.session.status === "ready"
                ? "ready"
                : thread.session.status === "connecting"
                  ? "starting"
                  : "error",
          providerName: "codex",
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: thread.error,
          updatedAt: thread.updatedAt ?? thread.createdAt,
        }
      : null,
    ...overrides,
  };
}

function makePageInfo(input: {
  hasMoreBefore: boolean;
  startIndex: number;
}): OrchestrationThreadDetailPageInfo {
  return {
    messages: {
      hasMoreBefore: input.hasMoreBefore,
      startCursor: {
        id: `message-${input.startIndex}`,
        createdAt: `2026-02-13T00:0${input.startIndex}:00.000Z`,
      },
    },
    proposedPlans: {
      hasMoreBefore: input.hasMoreBefore,
      startCursor: {
        id: `plan-${input.startIndex}`,
        createdAt: `2026-02-13T00:0${input.startIndex}:15.000Z`,
      },
    },
    activities: {
      hasMoreBefore: input.hasMoreBefore,
      startCursor: {
        id: `activity-${input.startIndex}`,
        createdAt: `2026-02-13T00:0${input.startIndex}:30.000Z`,
        sequence: input.startIndex,
      },
    },
    checkpoints: {
      hasMoreBefore: input.hasMoreBefore,
      startCursor: {
        id: `turn-${input.startIndex}`,
        createdAt: `2026-02-13T00:0${input.startIndex}:45.000Z`,
        checkpointTurnCount: input.startIndex,
      },
    },
  };
}

function makeEmptyPageInfo(): OrchestrationThreadDetailPageInfo {
  return {
    messages: { hasMoreBefore: false, startCursor: null },
    proposedPlans: { hasMoreBefore: false, startCursor: null },
    activities: { hasMoreBefore: false, startCursor: null },
    checkpoints: { hasMoreBefore: false, startCursor: null },
  };
}

function makeCachedThreadDetail(
  thread: Thread,
  pageInfo: OrchestrationThreadDetailPageInfo | null = makeEmptyPageInfo(),
): CachedThreadDetail {
  return {
    messageIds: thread.messages.map((message) => message.id),
    messageById: Object.fromEntries(
      thread.messages.map((message) => [message.id, message] as const),
    ) as CachedThreadDetail["messageById"],
    queuedTurnIds: thread.queuedTurns.map((queuedTurn) => queuedTurn.messageId),
    queuedTurnById: Object.fromEntries(
      thread.queuedTurns.map((queuedTurn) => [queuedTurn.messageId, queuedTurn] as const),
    ) as CachedThreadDetail["queuedTurnById"],
    activityIds: thread.activities.map((activity) => activity.id),
    activityById: Object.fromEntries(
      thread.activities.map((activity) => [activity.id, activity] as const),
    ) as CachedThreadDetail["activityById"],
    proposedPlanIds: thread.proposedPlans.map((plan) => plan.id),
    proposedPlanById: Object.fromEntries(
      thread.proposedPlans.map((plan) => [plan.id, plan] as const),
    ) as CachedThreadDetail["proposedPlanById"],
    turnDiffIds: thread.turnDiffSummaries.map((summary) => summary.turnId),
    turnDiffSummaryById: Object.fromEntries(
      thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
    ) as CachedThreadDetail["turnDiffSummaryById"],
    pageInfo,
  };
}

function makeActivityPageCursor(index: number): OrchestrationThreadDetailPageCursors["activities"] {
  return {
    id: `activity-${index}`,
    createdAt: `2026-02-13T00:0${index}:30.000Z`,
    sequence: index,
  };
}

function makeState(thread: Thread): AppState {
  const projectId = ProjectId.make("project-1");
  const project = {
    id: projectId,
    environmentId: thread.environmentId,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    scripts: [],
  };
  const threadIdsByProjectId: EnvironmentState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  const environmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: project,
    },
    threadIds: [thread.id],
    threadIdsByProjectId,
    threadShellById: {
      [thread.id]: {
        id: thread.id,
        environmentId: thread.environmentId,
        codexThreadId: thread.codexThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        error: thread.error,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        updatedAt: thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    },
    threadSessionById: {
      [thread.id]: thread.session,
    },
    threadTurnStateById: {
      [thread.id]: {
        latestTurn: thread.latestTurn,
        ...(thread.pendingSourceProposedPlan
          ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
          : {}),
      },
    },
    messageIdsByThreadId: {
      [thread.id]: thread.messages.map((message) => message.id),
    },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.messages.map((message) => [message.id, message] as const),
      ) as EnvironmentState["messageByThreadId"][ThreadId],
    },
    queuedTurnIdsByThreadId: {
      [thread.id]: thread.queuedTurns.map((queuedTurn) => queuedTurn.messageId),
    },
    queuedTurnByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.queuedTurns.map((queuedTurn) => [queuedTurn.messageId, queuedTurn] as const),
      ) as EnvironmentState["queuedTurnByThreadId"][ThreadId],
    },
    activityIdsByThreadId: {
      [thread.id]: thread.activities.map((activity) => activity.id),
    },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.activities.map((activity) => [activity.id, activity] as const),
      ) as EnvironmentState["activityByThreadId"][ThreadId],
    },
    proposedPlanIdsByThreadId: {
      [thread.id]: thread.proposedPlans.map((plan) => plan.id),
    },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.proposedPlans.map((plan) => [plan.id, plan] as const),
      ) as EnvironmentState["proposedPlanByThreadId"][ThreadId],
    },
    turnDiffIdsByThreadId: {
      [thread.id]: thread.turnDiffSummaries.map((summary) => summary.turnId),
    },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
      ) as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId],
    },
    threadDetailPageInfoByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, {
    activeEnvironmentId: thread.environmentId,
  });
}

function makeEmptyState(overrides: Partial<AppState & EnvironmentState> = {}): AppState {
  const environmentState: EnvironmentState = {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    queuedTurnIdsByThreadId: {},
    queuedTurnByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    threadDetailPageInfoByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, overrides);
}

function localEnvironmentStateOf(state: AppState): EnvironmentState {
  return selectEnvironmentState(state, localEnvironmentId);
}

function environmentStateOf(state: AppState, environmentId: EnvironmentId): EnvironmentState {
  return selectEnvironmentState(state, environmentId);
}

function projectsOf(state: AppState) {
  return selectProjectsAcrossEnvironments(state);
}

afterEach(() => {
  resetSavedEnvironmentRegistryStoreForTests();
});

function threadsOf(state: AppState) {
  return selectThreadsAcrossEnvironments(state);
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.make("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("environment state removal", () => {
  it("drops local state for removed environments", () => {
    const removedThread = makeThread({
      environmentId: remoteEnvironmentId,
      id: ThreadId.make("thread-removed"),
    });
    const keptThread = makeThread({ id: ThreadId.make("thread-kept") });
    const removedState = makeState(removedThread).environmentStateById[remoteEnvironmentId]!;
    const keptState = makeState(keptThread).environmentStateById[localEnvironmentId]!;
    const state: AppState = {
      activeEnvironmentId: remoteEnvironmentId,
      environmentStateById: {
        [remoteEnvironmentId]: removedState,
        [localEnvironmentId]: keptState,
      },
      accountRateLimitsByInstanceId: {},
    };

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next.activeEnvironmentId).toBeNull();
    expect(next.environmentStateById[remoteEnvironmentId]).toBeUndefined();
    expect(next.environmentStateById[localEnvironmentId]).toBe(keptState);
  });

  it("preserves active environment when removing a different environment", () => {
    const state = makeState(makeThread());

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next).toBe(state);
  });
});

describe("thread selection memoization", () => {
  it("returns stable thread references for repeated reads of the same state", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "hello",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
      activities: [
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "working",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-13T00:01:30.000Z",
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: null,
          planMarkdown: "plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-13T00:02:00.000Z",
          updatedAt: "2026-02-13T00:02:00.000Z",
        },
      ],
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-13T00:03:00.000Z",
          files: [],
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(state, ref);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(second?.messages).toBe(first?.messages);
    expect(second?.activities).toBe(first?.activities);
    expect(second?.proposedPlans).toBe(first?.proposedPlans);
    expect(second?.turnDiffSummaries).toBe(first?.turnDiffSummaries);
  });

  it("reuses the derived thread when the app state wrapper changes but thread data does not", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "done",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const wrappedState: AppState = {
      ...state,
      environmentStateById: { ...state.environmentStateById },
    };

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(wrappedState, ref);

    expect(second).toBe(first);
  });

  it("updates the derived thread when the underlying thread data changes", () => {
    const thread = makeThread();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const firstState = makeState(thread);
    const secondState = makeState({
      ...thread,
      messages: [
        {
          id: MessageId.make("message-2"),
          role: "user",
          text: "new",
          createdAt: "2026-02-13T00:04:00.000Z",
          streaming: false,
        },
      ],
    });

    const first = selectThreadByRef(firstState, ref);
    const second = selectThreadByRef(secondState, ref);

    expect(second).not.toBe(first);
    expect(second?.messages).toHaveLength(1);
    expect(second?.messages[0]?.text).toBe("new");
  });

  it("checks thread existence without materializing the full thread", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    expect(selectThreadExistsByRef(state, ref)).toBe(true);
    expect(
      selectThreadExistsByRef(
        state,
        scopeThreadRef(thread.environmentId, ThreadId.make("missing")),
      ),
    ).toBe(false);
    expect(selectThreadExistsByRef(state, null)).toBe(false);
  });
});

describe("thread detail structural sharing", () => {
  it("backfills a missing sidebar entry from a full thread detail snapshot", () => {
    const threadId = ThreadId.make("thread-detail-sidebar-full");
    const sourceThread = makeThread({
      id: threadId,
      messages: [makeMessage(1)],
    });

    const next = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(sourceThread),
      localEnvironmentId,
    );

    expect(
      selectSidebarThreadsForProjectRef(next, {
        environmentId: localEnvironmentId,
        projectId: sourceThread.projectId,
      }).map((thread) => thread.id),
    ).toEqual([threadId]);
  });

  it("backfills a missing sidebar entry from a tail thread detail snapshot", () => {
    const threadId = ThreadId.make("thread-detail-sidebar-tail");
    const sourceThread = makeThread({
      id: threadId,
      messages: [makeMessage(1)],
    });

    const next = mergeServerThreadDetailTailSnapshot(
      makeEmptyState(),
      makeOrchestrationThread(sourceThread),
      localEnvironmentId,
    );

    expect(
      selectSidebarThreadsForProjectRef(next, {
        environmentId: localEnvironmentId,
        projectId: sourceThread.projectId,
      }).map((thread) => thread.id),
    ).toEqual([threadId]);
  });

  it("backfills a missing sidebar entry from an older thread detail page", () => {
    const threadId = ThreadId.make("thread-detail-sidebar-page");
    const sourceThread = makeThread({
      id: threadId,
      messages: [makeMessage(1)],
    });

    const next = mergeServerThreadDetailPage(
      makeEmptyState(),
      {
        snapshotSequence: 1,
        thread: makeOrchestrationThread(sourceThread),
        pageInfo: makeEmptyPageInfo(),
      },
      localEnvironmentId,
    );

    expect(
      selectSidebarThreadsForProjectRef(next, {
        environmentId: localEnvironmentId,
        projectId: sourceThread.projectId,
      }).map((thread) => thread.id),
    ).toEqual([threadId]);
  });

  it("preserves shell-owned sidebar flags when detail events resync a summary", () => {
    const threadId = ThreadId.make("thread-detail-sidebar-flags");
    const sourceThread = makeThread({ id: threadId });
    const base = makeState(sourceThread);
    const environmentState = localEnvironmentStateOf(base);
    const existingSummary: SidebarThreadSummary = {
      id: sourceThread.id,
      environmentId: localEnvironmentId,
      projectId: sourceThread.projectId,
      title: sourceThread.title,
      interactionMode: sourceThread.interactionMode,
      session: sourceThread.session,
      createdAt: sourceThread.createdAt,
      archivedAt: sourceThread.archivedAt,
      updatedAt: sourceThread.updatedAt,
      latestTurn: sourceThread.latestTurn,
      branch: sourceThread.branch,
      worktreePath: sourceThread.worktreePath,
      latestUserMessageAt: "2026-02-13T00:00:00.000Z",
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    };
    const state: AppState = {
      ...base,
      environmentStateById: {
        [localEnvironmentId]: {
          ...environmentState,
          sidebarThreadSummaryById: {
            [threadId]: existingSummary,
          },
        },
      },
    };

    const next = applyOrchestrationEvents(
      state,
      [
        makeEvent("thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: sourceThread.runtimeMode,
            activeTurnId: TurnId.make("turn-running"),
            lastError: null,
            updatedAt: "2026-02-13T00:01:00.000Z",
          },
        }),
      ],
      localEnvironmentId,
      { syncSidebarSummaries: true },
    );

    const summary = selectSidebarThreadSummaryByRef(
      next,
      scopeThreadRef(localEnvironmentId, threadId),
    );
    expect(summary?.session?.orchestrationStatus).toBe("running");
    expect(summary?.hasPendingApprovals).toBe(true);
    expect(summary?.hasPendingUserInput).toBe(true);
    expect(summary?.hasActionableProposedPlan).toBe(true);
    expect(summary?.latestUserMessageAt).toBe("2026-02-13T00:00:00.000Z");
  });

  it("hydrates cached thread detail into an existing shell with empty detail", () => {
    const threadId = ThreadId.make("thread-cache-hydrate");
    const shellThread = makeThread({ id: threadId });
    const cachedThread = makeThread({
      id: threadId,
      messages: [makeMessage(1)],
      queuedTurns: [{ ...makeQueuedTurn(2), threadId }],
      activities: [makeActivity(1)],
      proposedPlans: [makePlan(1)],
      turnDiffSummaries: [makeTurnDiffSummary(1)],
    });
    const pageInfo = makePageInfo({ hasMoreBefore: true, startIndex: 1 });

    const next = hydrateCachedThreadDetail(
      makeState(shellThread),
      localEnvironmentId,
      threadId,
      makeCachedThreadDetail(cachedThread, pageInfo),
    );
    const hydratedThread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));

    expect(hydratedThread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-1"),
    ]);
    expect(hydratedThread?.queuedTurns.map((queuedTurn) => queuedTurn.messageId)).toEqual([
      MessageId.make("queued-message-2"),
    ]);
    expect(hydratedThread?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
    ]);
    expect(hydratedThread?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(hydratedThread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-1"),
    ]);
    expect(hydratedThread?.detailPageInfo).toEqual(pageInfo);
  });

  it("does not hydrate cached thread detail over live detail rows", () => {
    const threadId = ThreadId.make("thread-cache-live-detail");
    const liveThread = makeThread({
      id: threadId,
      messages: [makeMessage(1)],
    });
    const cachedThread = makeThread({
      id: threadId,
      messages: [{ ...makeMessage(2), text: "cached should not replace live detail" }],
    });
    const state = makeState(liveThread);

    const next = hydrateCachedThreadDetail(
      state,
      localEnvironmentId,
      threadId,
      makeCachedThreadDetail(cachedThread),
    );

    expect(next).toBe(state);
  });

  it("does not hydrate cached thread detail when the shell is missing", () => {
    const threadId = ThreadId.make("thread-cache-missing-shell");
    const cachedThread = makeThread({
      id: threadId,
      messages: [makeMessage(1)],
    });
    const state = makeEmptyState();

    const next = hydrateCachedThreadDetail(
      state,
      localEnvironmentId,
      threadId,
      makeCachedThreadDetail(cachedThread),
    );

    expect(next).toBe(state);
  });

  it("dedupes overlapping cached rows when the tail snapshot arrives", () => {
    const threadId = ThreadId.make("thread-cache-tail-dedupe");
    const hydrated = hydrateCachedThreadDetail(
      makeState(makeThread({ id: threadId })),
      localEnvironmentId,
      threadId,
      makeCachedThreadDetail(
        makeThread({
          id: threadId,
          messages: [makeMessage(1)],
        }),
      ),
    );

    const next = mergeServerThreadDetailTailSnapshot(
      hydrated,
      makeOrchestrationThread(
        makeThread({
          id: threadId,
          messages: [makeMessage(1), makeMessage(2)],
        }),
      ),
      localEnvironmentId,
    );
    const thread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));

    expect(thread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-1"),
      MessageId.make("message-2"),
    ]);
  });

  it("can resync sidebar summaries for all known environment threads", () => {
    const threadId = ThreadId.make("thread-detail-sidebar-all");
    const sourceThread = makeThread({ id: threadId });
    const base = makeState(sourceThread);
    const next = syncSidebarThreadSummariesForEnvironment(base, localEnvironmentId);

    expect(
      selectSidebarThreadsForProjectRef(next, {
        environmentId: localEnvironmentId,
        projectId: sourceThread.projectId,
      }).map((thread) => thread.id),
    ).toEqual([threadId]);
  });

  it("treats identical thread detail snapshots as a store no-op", () => {
    const threadId = ThreadId.make("thread-identical-detail");
    const sourceThread = makeThread({
      id: threadId,
      messages: [makeMessage(1), makeMessage(2)],
      activities: [makeActivity(1), makeActivity(2)],
      proposedPlans: [makePlan(1), makePlan(2)],
      turnDiffSummaries: [makeTurnDiffSummary(1), makeTurnDiffSummary(2)],
    });
    const first = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(sourceThread),
      localEnvironmentId,
    );
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const firstThread = selectThreadByRef(first, ref);
    expect(firstThread).toBeDefined();

    const equivalentThread = makeThread({
      id: threadId,
      messages: [makeMessage(1), makeMessage(2)],
      activities: [makeActivity(1), makeActivity(2)],
      proposedPlans: [makePlan(1), makePlan(2)],
      turnDiffSummaries: [makeTurnDiffSummary(1), makeTurnDiffSummary(2)],
    });
    const second = syncServerThreadDetail(
      first,
      makeOrchestrationThread(equivalentThread),
      localEnvironmentId,
    );
    const secondThread = selectThreadByRef(second, ref);

    expect(second).toBe(first);
    expect(secondThread).toBe(firstThread);
    expect(secondThread?.messages).toBe(firstThread?.messages);
    expect(secondThread?.activities).toBe(firstThread?.activities);
    expect(secondThread?.proposedPlans).toBe(firstThread?.proposedPlans);
    expect(secondThread?.turnDiffSummaries).toBe(firstThread?.turnDiffSummaries);
  });

  it("does not replace the shell for identical normalized model selections", () => {
    const threadId = ThreadId.make("thread-identical-model-selection");
    const sourceThread = makeThread({
      id: threadId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
        options: [{ id: "effort", value: "high" }],
      },
    });
    const first = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(sourceThread),
      localEnvironmentId,
    );
    const firstShell = localEnvironmentStateOf(first).threadShellById[threadId];

    const equivalentThread = makeThread({
      id: threadId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
        options: [{ id: "effort", value: "high" }],
      },
    });
    const second = syncServerThreadDetail(
      first,
      makeOrchestrationThread(equivalentThread),
      localEnvironmentId,
    );

    expect(localEnvironmentStateOf(second).threadShellById[threadId]).toBe(firstShell);
    expect(second).toBe(first);
  });

  it("updates longer streaming assistant text while reusing unchanged messages", () => {
    const threadId = ThreadId.make("thread-streaming-update");
    const userMessage = makeMessage(1);
    const assistantMessageId = MessageId.make("assistant-streaming");
    const turnId = TurnId.make("turn-streaming");
    const initialThread = makeThread({
      id: threadId,
      messages: [
        userMessage,
        {
          id: assistantMessageId,
          role: "assistant",
          text: "Still working",
          turnId,
          createdAt: "2026-02-13T00:02:00.000Z",
          streaming: true,
        },
      ],
    });
    const first = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(initialThread),
      localEnvironmentId,
    );
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const firstThread = selectThreadByRef(first, ref);

    const updatedThread = makeThread({
      id: threadId,
      messages: [
        makeMessage(1),
        {
          id: assistantMessageId,
          role: "assistant",
          text: "Still working with more text",
          turnId,
          createdAt: "2026-02-13T00:02:00.000Z",
          streaming: true,
        },
      ],
    });
    const second = syncServerThreadDetail(
      first,
      makeOrchestrationThread(updatedThread),
      localEnvironmentId,
    );
    const secondThread = selectThreadByRef(second, ref);

    expect(second).not.toBe(first);
    expect(secondThread?.messages).not.toBe(firstThread?.messages);
    expect(secondThread?.messages[0]).toBe(firstThread?.messages[0]);
    expect(secondThread?.messages[1]).not.toBe(firstThread?.messages[1]);
    expect(secondThread?.messages[1]?.text).toBe("Still working with more text");
    expect(secondThread?.messages[1]?.streaming).toBe(true);
  });

  it("updates a streaming assistant message when it completes", () => {
    const threadId = ThreadId.make("thread-streaming-completed");
    const messageId = MessageId.make("assistant-streaming-completed");
    const turnId = TurnId.make("turn-streaming-completed");
    const initialThread = makeThread({
      id: threadId,
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Final response",
          turnId,
          createdAt: "2026-02-13T00:02:00.000Z",
          streaming: true,
        },
      ],
    });
    const first = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(initialThread),
      localEnvironmentId,
    );

    const completedThread = makeThread({
      id: threadId,
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Final response",
          turnId,
          createdAt: "2026-02-13T00:02:00.000Z",
          completedAt: "2026-02-13T00:03:00.000Z",
          streaming: false,
        },
      ],
    });
    const second = syncServerThreadDetail(
      first,
      makeOrchestrationThread(completedThread),
      localEnvironmentId,
    );
    const thread = selectThreadByRef(second, scopeThreadRef(localEnvironmentId, threadId));

    expect(second).not.toBe(first);
    expect(thread?.messages[0]?.streaming).toBe(false);
    expect(thread?.messages[0]?.completedAt).toBe("2026-02-13T00:03:00.000Z");
  });

  it("keeps an existing assistant turn id when late repeat message events omit it", () => {
    const threadId = ThreadId.make("thread-late-null-turn");
    const messageId = MessageId.make("assistant-late-null-turn");
    const turnId = TurnId.make("turn-late-null-turn");
    const initialThread = makeThread({
      id: threadId,
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-02-13T00:01:00.000Z",
        startedAt: "2026-02-13T00:01:00.000Z",
        completedAt: "2026-02-13T00:02:00.000Z",
        assistantMessageId: messageId,
      },
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Initial answer",
          turnId,
          createdAt: "2026-02-13T00:01:00.000Z",
          completedAt: "2026-02-13T00:02:00.000Z",
          streaming: false,
        },
      ],
    });
    const first = makeState(initialThread);

    const second = applyOrchestrationEvents(
      first,
      [
        makeEvent(
          "thread.message-sent",
          {
            threadId,
            messageId,
            role: "assistant",
            text: " late tail",
            turnId: null,
            streaming: true,
            createdAt: "2026-02-13T00:03:00.000Z",
            updatedAt: "2026-02-13T00:03:00.000Z",
          },
          { sequence: 2 },
        ),
        makeEvent(
          "thread.message-sent",
          {
            threadId,
            messageId,
            role: "assistant",
            text: "",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-13T00:03:01.000Z",
            updatedAt: "2026-02-13T00:03:01.000Z",
          },
          { sequence: 3 },
        ),
      ],
      localEnvironmentId,
    );
    const thread = selectThreadByRef(second, scopeThreadRef(localEnvironmentId, threadId));

    expect(thread?.messages[0]?.text).toBe("Initial answer late tail");
    expect(thread?.messages[0]?.turnId).toBe(turnId);
    expect(thread?.messages[0]?.streaming).toBe(false);
    expect(thread?.latestTurn?.assistantMessageId).toBe(messageId);
  });

  it("reuses unchanged activity payloads from fresh snapshot objects", () => {
    const threadId = ThreadId.make("thread-activity-payload-same");
    const initialThread = makeThread({
      id: threadId,
      activities: [
        {
          ...makeActivity(1),
          payload: {
            nested: { count: 1 },
            items: ["alpha", true],
          },
        },
      ],
    });
    const first = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(initialThread),
      localEnvironmentId,
    );
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const firstThread = selectThreadByRef(first, ref);

    const equivalentThread = makeThread({
      id: threadId,
      activities: [
        {
          ...makeActivity(1),
          payload: {
            nested: { count: 1 },
            items: ["alpha", true],
          },
        },
      ],
    });
    const second = syncServerThreadDetail(
      first,
      makeOrchestrationThread(equivalentThread),
      localEnvironmentId,
    );
    const secondThread = selectThreadByRef(second, ref);

    expect(second).toBe(first);
    expect(secondThread?.activities).toBe(firstThread?.activities);
    expect(secondThread?.activities[0]).toBe(firstThread?.activities[0]);
  });

  it("updates activities when a nested payload value changes", () => {
    const threadId = ThreadId.make("thread-activity-payload-changed");
    const initialThread = makeThread({
      id: threadId,
      activities: [
        {
          ...makeActivity(1),
          payload: { nested: { count: 1 } },
        },
      ],
    });
    const first = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(initialThread),
      localEnvironmentId,
    );
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const firstThread = selectThreadByRef(first, ref);

    const updatedThread = makeThread({
      id: threadId,
      activities: [
        {
          ...makeActivity(1),
          payload: { nested: { count: 2 } },
        },
      ],
    });
    const second = syncServerThreadDetail(
      first,
      makeOrchestrationThread(updatedThread),
      localEnvironmentId,
    );
    const secondThread = selectThreadByRef(second, ref);

    expect(second).not.toBe(first);
    expect(secondThread?.activities).not.toBe(firstThread?.activities);
    expect(secondThread?.activities[0]).not.toBe(firstThread?.activities[0]);
    expect(secondThread?.activities[0]?.payload).toEqual({ nested: { count: 2 } });
  });
});

describe("thread detail pagination", () => {
  it("maps persisted user attachments to environment attachment preview URLs", () => {
    const originalWindow = globalThis.window;
    Reflect.set(globalThis, "window", {
      desktopBridge: undefined,
      location: { origin: "http://primary.test" },
    });
    useSavedEnvironmentRegistryStore.setState({
      byId: {
        [localEnvironmentId]: {
          environmentId: localEnvironmentId,
          label: "Local",
          httpBaseUrl: "http://environment.test",
          wsBaseUrl: "ws://environment.test",
          createdAt: "2026-02-13T00:00:00.000Z",
          lastConnectedAt: null,
        },
      },
    });
    try {
      const threadId = ThreadId.make("thread-attachments");
      const messageId = MessageId.make("message-attachments");
      const sourceThread = makeThread({
        id: threadId,
        messages: [
          {
            id: messageId,
            role: "user",
            text: "inspect this",
            turnId: null,
            createdAt: "2026-02-13T00:00:00.000Z",
            completedAt: "2026-02-13T00:00:00.000Z",
            streaming: false,
            attachments: [
              {
                type: "image",
                id: "thread-attachments-file-1",
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
              {
                type: "pdf",
                id: "thread-attachments-file-2",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 8,
              },
            ],
          },
        ],
      });

      const next = syncServerThreadDetail(
        makeEmptyState(),
        makeOrchestrationThread(sourceThread),
        localEnvironmentId,
      );
      const thread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));

      expect(thread?.messages[0]?.attachments).toEqual([
        {
          type: "image",
          id: "thread-attachments-file-1",
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 4,
          previewUrl: "http://environment.test/attachments/thread-attachments-file-1",
        },
        {
          type: "pdf",
          id: "thread-attachments-file-2",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 8,
          previewUrl: "http://environment.test/attachments/thread-attachments-file-2",
        },
      ]);
    } finally {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Reflect.set(globalThis, "window", originalWindow);
      }
    }
  });

  it("seeds thread detail from a tail subscription snapshot", () => {
    const threadId = ThreadId.make("thread-tail-seed");
    const pageInfo = makePageInfo({ hasMoreBefore: true, startIndex: 3 });
    const next = mergeServerThreadDetailTailSnapshot(
      makeEmptyState(),
      makeOrchestrationThread(
        makeThread({
          id: threadId,
          messages: [makeMessage(3), makeMessage(4)],
          activities: [makeActivity(3)],
        }),
      ),
      localEnvironmentId,
      { pageInfo },
    );
    const thread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));

    expect(thread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-3"),
      MessageId.make("message-4"),
    ]);
    expect(thread?.activities.map((activity) => activity.id)).toEqual([EventId.make("activity-3")]);
    expect(thread?.detailPageInfo).toEqual(pageInfo);
  });

  it("merges tail subscription snapshots without dropping loaded older rows", () => {
    const threadId = ThreadId.make("thread-tail-preserve-older");
    const pageInfo = makePageInfo({ hasMoreBefore: true, startIndex: 1 });
    const initial = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(
        makeThread({
          id: threadId,
          messages: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4)],
        }),
      ),
      localEnvironmentId,
      { pageInfo },
    );

    const next = mergeServerThreadDetailTailSnapshot(
      initial,
      makeOrchestrationThread(
        makeThread({
          id: threadId,
          messages: [
            makeMessage(3),
            { ...makeMessage(4), text: "repaired recent message" },
            makeMessage(5),
          ],
        }),
      ),
      localEnvironmentId,
      { pageInfo: makePageInfo({ hasMoreBefore: true, startIndex: 3 }) },
    );
    const thread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));

    expect(thread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-1"),
      MessageId.make("message-2"),
      MessageId.make("message-3"),
      MessageId.make("message-4"),
      MessageId.make("message-5"),
    ]);
    expect(
      thread?.messages.find((message) => message.id === MessageId.make("message-4"))?.text,
    ).toBe("repaired recent message");
    expect(thread?.detailPageInfo).toEqual(pageInfo);
  });

  it("updates older-page page info only for requested collections", () => {
    const threadId = ThreadId.make("thread-pageinfo-requested-only");
    const initialPageInfo = makePageInfo({ hasMoreBefore: true, startIndex: 3 });
    const initial = syncServerThreadDetail(
      makeEmptyState(),
      makeOrchestrationThread(
        makeThread({
          id: threadId,
          messages: [makeMessage(3), makeMessage(4)],
          activities: [makeActivity(3), makeActivity(4)],
        }),
      ),
      localEnvironmentId,
      { pageInfo: initialPageInfo },
    );
    const incomingPageInfo = makeEmptyPageInfo();
    const next = mergeServerThreadDetailPage(
      initial,
      {
        snapshotSequence: 5,
        thread: makeOrchestrationThread(
          makeThread({
            id: threadId,
            activities: [makeActivity(1), makeActivity(2)],
          }),
        ),
        pageInfo: incomingPageInfo,
      },
      localEnvironmentId,
      {
        requestedBefore: {
          activities: makeActivityPageCursor(3),
        },
      },
    );
    const thread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));

    expect(thread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-3"),
      MessageId.make("message-4"),
    ]);
    expect(thread?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
      EventId.make("activity-2"),
      EventId.make("activity-3"),
      EventId.make("activity-4"),
    ]);
    expect(thread?.detailPageInfo?.messages).toEqual(initialPageInfo.messages);
    expect(thread?.detailPageInfo?.activities).toEqual(incomingPageInfo.activities);
    expect(
      localEnvironmentStateOf(next).threadDetailPageInfoByThreadId[threadId]?.messages,
    ).toEqual(initialPageInfo.messages);
  });

  it("prepends older detail pages without replacing the visible recent page", () => {
    const threadId = ThreadId.make("thread-paged");
    const currentThread = makeThread({
      id: threadId,
      messages: [makeMessage(3), makeMessage(4)],
      proposedPlans: [makePlan(3), makePlan(4)],
      activities: [makeActivity(3), makeActivity(4)],
      turnDiffSummaries: [makeTurnDiffSummary(3), makeTurnDiffSummary(4)],
    });
    const olderPageThread = makeThread({
      id: threadId,
      messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
      proposedPlans: [makePlan(1), makePlan(2), makePlan(3)],
      activities: [makeActivity(1), makeActivity(2), makeActivity(3)],
      turnDiffSummaries: [makeTurnDiffSummary(1), makeTurnDiffSummary(2), makeTurnDiffSummary(3)],
    });
    const pageInfo = makePageInfo({ hasMoreBefore: false, startIndex: 1 });
    const snapshot: OrchestrationThreadDetailSnapshot = {
      snapshotSequence: 4,
      thread: makeOrchestrationThread(olderPageThread),
      pageInfo,
    };

    const next = mergeServerThreadDetailPage(
      makeState(currentThread),
      snapshot,
      localEnvironmentId,
    );
    const thread = selectThreadByRef(next, scopeThreadRef(localEnvironmentId, threadId));
    const environmentState = localEnvironmentStateOf(next);

    expect(thread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-1"),
      MessageId.make("message-2"),
      MessageId.make("message-3"),
      MessageId.make("message-4"),
    ]);
    expect(thread?.proposedPlans.map((plan) => plan.id)).toEqual([
      "plan-1",
      "plan-2",
      "plan-3",
      "plan-4",
    ]);
    expect(thread?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
      EventId.make("activity-2"),
      EventId.make("activity-3"),
      EventId.make("activity-4"),
    ]);
    expect(thread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-1"),
      TurnId.make("turn-2"),
      TurnId.make("turn-3"),
      TurnId.make("turn-4"),
    ]);
    expect(environmentState.messageIdsByThreadId[threadId]).toEqual([
      MessageId.make("message-1"),
      MessageId.make("message-2"),
      MessageId.make("message-3"),
      MessageId.make("message-4"),
    ]);
    expect(environmentState.threadDetailPageInfoByThreadId[threadId]).toEqual(pageInfo);
    expect(thread?.detailPageInfo).toEqual(pageInfo);

    const repeated = mergeServerThreadDetailPage(next, snapshot, localEnvironmentId);
    const repeatedThread = selectThreadByRef(
      repeated,
      scopeThreadRef(localEnvironmentId, threadId),
    );
    expect(repeated).toBe(next);
    expect(repeatedThread).toBe(thread);
    expect(repeatedThread?.messages).toBe(thread?.messages);
    expect(repeatedThread?.activities).toBe(thread?.activities);
    expect(repeatedThread?.proposedPlans).toBe(thread?.proposedPlans);
    expect(repeatedThread?.turnDiffSummaries).toBe(thread?.turnDiffSummaries);
    expect(repeatedThread?.messages.map((message) => message.id)).toEqual([
      MessageId.make("message-1"),
      MessageId.make("message-2"),
      MessageId.make("message-3"),
      MessageId.make("message-4"),
    ]);
    expect(repeatedThread?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
      EventId.make("activity-2"),
      EventId.make("activity-3"),
      EventId.make("activity-4"),
    ]);
  });

  it("keeps a paged snapshot isolated to its environment", () => {
    const sharedThreadId = ThreadId.make("thread-shared-page");
    const localThread = makeThread({
      id: sharedThreadId,
      messages: [makeMessage(4)],
    });
    const remoteThread = makeThread({
      id: sharedThreadId,
      environmentId: remoteEnvironmentId,
      messages: [makeMessage(9)],
    });
    const remoteState = environmentStateOf(makeState(remoteThread), remoteEnvironmentId);
    const localState = environmentStateOf(makeState(localThread), localEnvironmentId);
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: localState,
        [remoteEnvironmentId]: remoteState,
      },
      accountRateLimitsByInstanceId: {},
    };
    const pageInfo = makePageInfo({ hasMoreBefore: true, startIndex: 1 });

    const next = mergeServerThreadDetailPage(
      state,
      {
        snapshotSequence: 2,
        thread: makeOrchestrationThread(
          makeThread({
            id: sharedThreadId,
            environmentId: remoteEnvironmentId,
            messages: [makeMessage(8), makeMessage(9)],
          }),
        ),
        pageInfo,
      },
      remoteEnvironmentId,
    );

    expect(
      selectThreadByRef(next, scopeThreadRef(localEnvironmentId, sharedThreadId))?.messages.map(
        (message) => message.id,
      ),
    ).toEqual([MessageId.make("message-4")]);
    expect(
      selectThreadByRef(next, scopeThreadRef(remoteEnvironmentId, sharedThreadId))?.messages.map(
        (message) => message.id,
      ),
    ).toEqual([MessageId.make("message-8"), MessageId.make("message-9")]);
    expect(
      environmentStateOf(next, localEnvironmentId).threadDetailPageInfoByThreadId[sharedThreadId],
    ).toBeUndefined();
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadDetailPageInfoByThreadId[sharedThreadId],
    ).toEqual(pageInfo);
  });
});

describe("setThreadBranch", () => {
  it("updates only the scoped thread environment", () => {
    const sharedThreadId = ThreadId.make("thread-shared");
    const localThread = makeThread({
      id: sharedThreadId,
      environmentId: localEnvironmentId,
      branch: "local-branch",
    });
    const remoteThread = makeThread({
      id: sharedThreadId,
      environmentId: remoteEnvironmentId,
      branch: "remote-branch",
    });
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: environmentStateOf(makeState(localThread), localEnvironmentId),
        [remoteEnvironmentId]: environmentStateOf(makeState(remoteThread), remoteEnvironmentId),
      },
      accountRateLimitsByInstanceId: {},
    };

    const next = setThreadBranch(
      state,
      scopeThreadRef(remoteEnvironmentId, sharedThreadId),
      "remote-next",
      "/tmp/remote-worktree",
    );

    expect(
      environmentStateOf(next, localEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("local-branch");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("remote-next");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.worktreePath,
    ).toBe("/tmp/remote-worktree");
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(makeThread())), {
      bootstrapComplete: false,
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.make("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(localEnvironmentStateOf(next).bootstrapComplete).toBe(false);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.make("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.make("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const state: AppState = makeEmptyState({
      projectIds: [originalProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(projectsOf(next)).toHaveLength(1);
    expect(projectsOf(next)[0]?.id).toBe(recreatedProjectId);
    expect(projectsOf(next)[0]?.cwd).toBe("/tmp/project");
    expect(projectsOf(next)[0]?.name).toBe("Project Recreated");
    expect(localEnvironmentStateOf(next).projectIds).toEqual([recreatedProjectId]);
    expect(localEnvironmentStateOf(next).projectById[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).projectById[recreatedProjectId]?.id).toBe(
      recreatedProjectId,
    );
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const threadId = ThreadId.make("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(thread)), {
      projectIds: [originalProjectId, recreatedProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
        [recreatedProjectId]: {
          id: recreatedProjectId,
          environmentId: localEnvironmentId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)).toHaveLength(1);
    expect(threadsOf(next)[0]?.projectId).toBe(recreatedProjectId);
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[recreatedProjectId]).toEqual([
      threadId,
    ]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.make("thread-1"),
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.make("thread-2") });
    const baseState = makeState(thread1);
    const baseEnvironmentState = localEnvironmentStateOf(baseState);
    const state = withActiveEnvironmentState(baseEnvironmentState, {
      threadIds: [thread1.id, thread2.id],
      threadShellById: {
        ...baseEnvironmentState.threadShellById,
        [thread2.id]: {
          id: thread2.id,
          environmentId: thread2.environmentId,
          codexThreadId: thread2.codexThreadId,
          projectId: thread2.projectId,
          title: thread2.title,
          modelSelection: thread2.modelSelection,
          runtimeMode: thread2.runtimeMode,
          interactionMode: thread2.interactionMode,
          error: thread2.error,
          createdAt: thread2.createdAt,
          archivedAt: thread2.archivedAt,
          updatedAt: thread2.updatedAt,
          branch: thread2.branch,
          worktreePath: thread2.worktreePath,
        },
      },
      threadSessionById: {
        ...baseEnvironmentState.threadSessionById,
        [thread2.id]: thread2.session,
      },
      threadTurnStateById: {
        ...baseEnvironmentState.threadTurnStateById,
        [thread2.id]: {
          latestTurn: thread2.latestTurn,
        },
      },
      messageIdsByThreadId: {
        ...baseEnvironmentState.messageIdsByThreadId,
        [thread2.id]: [],
      },
      messageByThreadId: {
        ...baseEnvironmentState.messageByThreadId,
        [thread2.id]: {},
      },
      activityIdsByThreadId: {
        ...baseEnvironmentState.activityIdsByThreadId,
        [thread2.id]: [],
      },
      activityByThreadId: {
        ...baseEnvironmentState.activityByThreadId,
        [thread2.id]: {},
      },
      proposedPlanIdsByThreadId: {
        ...baseEnvironmentState.proposedPlanIdsByThreadId,
        [thread2.id]: [],
      },
      proposedPlanByThreadId: {
        ...baseEnvironmentState.proposedPlanByThreadId,
        [thread2.id]: {},
      },
      turnDiffIdsByThreadId: {
        ...baseEnvironmentState.turnDiffIdsByThreadId,
        [thread2.id]: [],
      },
      turnDiffSummaryByThreadId: {
        ...baseEnvironmentState.turnDiffSummaryByThreadId,
        [thread2.id]: {},
      },
      sidebarThreadSummaryById: {
        ...baseEnvironmentState.sidebarThreadSummaryById,
      },
      threadIdsByProjectId: {
        [thread1.projectId]: [thread1.id, thread2.id],
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.make("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.make("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("hello world");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("running");
    const nextEnvironmentState = next.environmentStateById[localEnvironmentId];
    const previousEnvironmentState = state.environmentStateById[localEnvironmentId];
    expect(nextEnvironmentState?.threadShellById[thread2.id]).toBe(
      previousEnvironmentState?.threadShellById[thread2.id],
    );
    expect(nextEnvironmentState?.threadSessionById[thread2.id]).toBe(
      previousEnvironmentState?.threadSessionById[thread2.id],
    );
    expect(nextEnvironmentState?.messageIdsByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messageIdsByThreadId[thread2.id],
    );
    expect(nextEnvironmentState?.messageByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messageByThreadId[thread2.id],
    );
  });

  it("promotes queued turns into the timeline when they are dispatched", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const queuedTurn = makeQueuedTurn(1);

    const queued = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-queued", queuedTurn),
      localEnvironmentId,
    );
    expect(threadsOf(queued)[0]?.queuedTurns.map((turn) => turn.text)).toEqual([
      "queued message 1",
    ]);
    expect(threadsOf(queued)[0]?.messages).toEqual([]);

    const cancelled = applyOrchestrationEvent(
      queued,
      makeEvent("thread.queued-turn-cancelled", {
        threadId: thread.id,
        messageId: queuedTurn.messageId,
        cancelledAt: "2026-02-13T00:02:00.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(cancelled)[0]?.queuedTurns).toEqual([]);

    const queuedAgain = applyOrchestrationEvent(
      cancelled,
      makeEvent("thread.turn-queued", queuedTurn),
      localEnvironmentId,
    );
    const dispatched = applyOrchestrationEvent(
      queuedAgain,
      makeEvent("thread.queued-turn-dispatched", {
        threadId: thread.id,
        messageId: queuedTurn.messageId,
        dispatchedAt: "2026-02-13T00:03:00.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(dispatched)[0]?.queuedTurns).toEqual([]);
    expect(threadsOf(dispatched)[0]?.messages).toEqual([
      {
        id: queuedTurn.messageId,
        role: queuedTurn.role,
        text: queuedTurn.text,
        turnId: null,
        createdAt: "2026-02-13T00:03:00.000Z",
        completedAt: "2026-02-13T00:03:00.000Z",
        streaming: false,
      },
    ]);

    const sent = applyOrchestrationEvent(
      dispatched,
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId: queuedTurn.messageId,
        role: "user",
        text: queuedTurn.text,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: "2026-02-13T00:03:00.000Z",
        updatedAt: "2026-02-13T00:03:00.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(sent)[0]?.messages.map((message) => message.text)).toEqual([
      "queued message 1",
    ]);
    expect(threadsOf(sent)[0]?.messages).toHaveLength(1);
  });

  it("orders synthesized queued messages by dispatch time", () => {
    const queuedTurn = makeQueuedTurn(1);
    const existingMessage = makeMessage(2);
    const thread = makeThread({
      messages: [existingMessage],
      queuedTurns: [queuedTurn],
    });
    const state = makeState(thread);

    const dispatched = applyOrchestrationEvent(
      state,
      makeEvent("thread.queued-turn-dispatched", {
        threadId: thread.id,
        messageId: queuedTurn.messageId,
        dispatchedAt: "2026-02-13T00:03:00.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(dispatched)[0]?.messages.map((message) => message.id)).toEqual([
      existingMessage.id,
      queuedTurn.messageId,
    ]);
    expect(
      threadsOf(dispatched)[0]?.messages.find((message) => message.id === queuedTurn.messageId),
    ).toMatchObject({
      createdAt: "2026-02-13T00:03:00.000Z",
      completedAt: "2026-02-13T00:03:00.000Z",
    });
  });

  it("does not synthesize a queued message when the dispatched turn is not known locally", () => {
    const thread = makeThread({
      queuedTurns: [makeQueuedTurn(1)],
    });
    const state = makeState(thread);

    const dispatched = applyOrchestrationEvent(
      state,
      makeEvent("thread.queued-turn-dispatched", {
        threadId: thread.id,
        messageId: MessageId.make("missing-queued-message"),
        dispatchedAt: "2026-02-13T00:03:00.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(dispatched)[0]?.queuedTurns.map((turn) => turn.messageId)).toEqual([
      MessageId.make("queued-message-1"),
    ]);
    expect(threadsOf(dispatched)[0]?.messages).toEqual([]);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(
      state,
      [
        makeEvent(
          "thread.session-set",
          {
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-1"),
              lastError: null,
              updatedAt: "2026-02-27T00:00:02.000Z",
            },
          },
          { sequence: 2 },
        ),
        makeEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            messageId: MessageId.make("assistant-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-02-27T00:00:03.000Z",
            updatedAt: "2026-02-27T00:00:03.000Z",
          },
          { sequence: 3 },
        ),
      ],
      localEnvironmentId,
    );

    // A completed assistant message must not settle the turn while the
    // session is still running it — providers emit interim assistant
    // messages between tool calls.
    expect(threadsOf(next)[0]?.session?.status).toBe("running");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("running");
    expect(threadsOf(next)[0]?.latestTurn?.completedAt).toBeNull();
    expect(threadsOf(next)[0]?.messages).toHaveLength(1);

    const settled = applyOrchestrationEvents(
      next,
      [
        makeEvent(
          "thread.session-set",
          {
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-02-27T00:00:04.000Z",
            },
          },
          { sequence: 4 },
        ),
      ],
      localEnvironmentId,
    );

    // Leaving the running session status is the turn-end signal.
    expect(threadsOf(settled)[0]?.latestTurn?.state).toBe("completed");
    expect(threadsOf(settled)[0]?.latestTurn?.completedAt).toBe("2026-02-27T00:00:04.000Z");
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-1"),
        status: "ready",
        files: [],
        attribution: "unattributed",
        assistantMessageId: MessageId.make("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.make("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.make("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            assistantMessageId: MessageId.make("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.make("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(threadsOf(next)[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
    ]);
    expect(threadsOf(next)[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.make("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.make("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.make("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(reverted)[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-3"),
      state: "running",
    });
    expect(threadsOf(next)[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});
