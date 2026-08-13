import {
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProposedPlanId,
  type OrchestrationThreadDetailPageInfo,
} from "@salchi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
  type EnvironmentState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";
import { hydrateOrchestrationStartupCache } from "./orchestrationStartupBootstrap";
import {
  clearOrchestrationStartupCacheForTests,
  flushPendingCachedEnvironmentStateWrite,
  installOrchestrationStartupCachePersistence,
  ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY,
  readCachedEnvironmentState,
  readCachedEnvironmentStateEntries,
  scheduleCachedEnvironmentStateWrite,
  writeCachedEnvironmentState,
} from "./orchestrationStartupCache";

const ENVIRONMENT_ID = EnvironmentId.make("environment-cache-test");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-cache-other");
const PROJECT_ID = ProjectId.make("project-cache-test");
const SECOND_PROJECT_ID = ProjectId.make("project-cache-second");
const THREAD_ID = ThreadId.make("thread-cache-test");
const SHELL_ONLY_THREAD_ID = ThreadId.make("thread-shell-only");

interface BudgetedStorage extends Storage {
  setMaxBytes: (maxBytes: number) => void;
  getStoredBytes: () => number;
}

interface ThreadStateInput {
  readonly id: ThreadId;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly messageText?: string;
  readonly pageInfo?: OrchestrationThreadDetailPageInfo;
}

function utf16Bytes(value: string): number {
  return value.length * 2;
}

function createLocalStorageStub(maxBytes = Number.POSITIVE_INFINITY): BudgetedStorage {
  const store = new Map<string, string>();
  let byteBudget = maxBytes;
  const getStoredBytes = () =>
    [...store.values()].reduce((total, value) => total + utf16Bytes(value), 0);

  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      const nextStoredBytes =
        getStoredBytes() - utf16Bytes(store.get(key) ?? "") + utf16Bytes(value);
      if (nextStoredBytes > byteBudget) {
        const error = new Error("QuotaExceededError");
        error.name = "QuotaExceededError";
        throw error;
      }
      store.set(key, value);
    },
    setMaxBytes: (nextMaxBytes) => {
      byteBudget = nextMaxBytes;
    },
    getStoredBytes,
  };
}

function makePageInfo(index: number): OrchestrationThreadDetailPageInfo {
  return {
    messages: {
      hasMoreBefore: true,
      startCursor: {
        id: `message-${index}`,
        createdAt: `2026-04-01T00:0${index}:00.000Z`,
      },
    },
    proposedPlans: { ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.proposedPlans },
    activities: { ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.activities },
    checkpoints: { ...EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO.checkpoints },
  };
}

function makeEnvironmentState(
  input: {
    readonly environmentId?: EnvironmentId;
    readonly projectId?: ProjectId;
    readonly messageText?: string;
    readonly pageInfo?: OrchestrationThreadDetailPageInfo;
    readonly threads?: readonly ThreadStateInput[];
  } = {},
): EnvironmentState {
  const environmentId = input.environmentId ?? ENVIRONMENT_ID;
  const projectId =
    input.projectId ??
    (environmentId === ENVIRONMENT_ID ? PROJECT_ID : ProjectId.make(`${environmentId}-project`));
  const createdAt = "2026-04-01T00:01:00.000Z";
  const threads: readonly ThreadStateInput[] =
    input.threads ??
    ([
      {
        id: THREAD_ID,
        title: "Cached thread",
        ...(input.messageText === undefined ? {} : { messageText: input.messageText }),
        ...(input.pageInfo === undefined ? {} : { pageInfo: input.pageInfo }),
      },
      { id: SHELL_ONLY_THREAD_ID, title: "Shell only" },
    ] satisfies readonly ThreadStateInput[]);

  const threadIds = threads.map((thread) => thread.id);
  const messageIdsByThreadId: Record<string, MessageId[]> = {};
  const messageByThreadId: Record<string, EnvironmentState["messageByThreadId"][ThreadId]> = {};
  const queuedTurnIdsByThreadId: Record<string, MessageId[]> = {};
  const queuedTurnByThreadId: Record<string, EnvironmentState["queuedTurnByThreadId"][ThreadId]> =
    {};
  const activityIdsByThreadId: Record<string, EventId[]> = {};
  const activityByThreadId: Record<string, EnvironmentState["activityByThreadId"][ThreadId]> = {};
  const proposedPlanIdsByThreadId: Record<string, OrchestrationProposedPlanId[]> = {};
  const proposedPlanByThreadId: Record<
    string,
    EnvironmentState["proposedPlanByThreadId"][ThreadId]
  > = {};
  const turnDiffIdsByThreadId: Record<string, TurnId[]> = {};
  const turnDiffSummaryByThreadId: Record<
    string,
    EnvironmentState["turnDiffSummaryByThreadId"][ThreadId]
  > = {};
  const threadDetailPageInfoByThreadId: Record<string, OrchestrationThreadDetailPageInfo> = {};

  for (const [index, thread] of threads.entries()) {
    if (thread.messageText === undefined) {
      continue;
    }

    const ordinal = index + 1;
    const messageId = MessageId.make(`message-${ordinal}`);
    const queuedTurnId = MessageId.make(`queued-message-${ordinal}`);
    const activityId = EventId.make(`activity-${ordinal}`);
    const planId = `plan-${ordinal}` as OrchestrationProposedPlanId;
    const turnId = TurnId.make(`turn-${ordinal}`);

    messageIdsByThreadId[thread.id] = [messageId];
    messageByThreadId[thread.id] = {
      [messageId]: {
        id: messageId,
        role: "user",
        text: thread.messageText,
        createdAt,
        streaming: false,
      },
    };
    queuedTurnIdsByThreadId[thread.id] = [queuedTurnId];
    queuedTurnByThreadId[thread.id] = {
      [queuedTurnId]: {
        threadId: thread.id,
        messageId: queuedTurnId,
        role: "user",
        text: "queued",
        attachments: [],
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        createdAt,
        updatedAt: createdAt,
      },
    };
    activityIdsByThreadId[thread.id] = [activityId];
    activityByThreadId[thread.id] = {
      [activityId]: {
        id: activityId,
        tone: "info",
        kind: "step",
        summary: "activity",
        payload: {},
        turnId,
        sequence: ordinal,
        createdAt,
      },
    };
    proposedPlanIdsByThreadId[thread.id] = [planId];
    proposedPlanByThreadId[thread.id] = {
      [planId]: {
        id: planId,
        turnId,
        planMarkdown: "plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt,
        updatedAt: createdAt,
      },
    };
    turnDiffIdsByThreadId[thread.id] = [turnId];
    turnDiffSummaryByThreadId[thread.id] = {
      [turnId]: {
        turnId,
        completedAt: createdAt,
        status: "ready" as const,
        checkpointTurnCount: 1,
        files: [],
      },
    };
    if (thread.pageInfo) {
      threadDetailPageInfoByThreadId[thread.id] = thread.pageInfo;
    }
  }

  return {
    projectIds: [projectId],
    projectById: {
      [projectId]: {
        id: projectId,
        environmentId,
        name: "Cache Project",
        cwd: "/tmp/cache-project",
        repositoryIdentity: null,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
        updatedAt: createdAt,
        scripts: [],
      },
    },
    threadIds,
    threadIdsByProjectId: {
      [projectId]: threadIds,
    },
    threadShellById: Object.fromEntries(
      threads.map((thread, index) => [
        thread.id,
        {
          id: thread.id,
          environmentId,
          codexThreadId: null,
          projectId,
          title: thread.title ?? `Cached thread ${index + 1}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          error: null,
          createdAt,
          archivedAt: null,
          updatedAt: thread.updatedAt ?? `2026-04-01T00:0${index + 1}:00.000Z`,
          branch: null,
          worktreePath: null,
        },
      ]),
    ) as EnvironmentState["threadShellById"],
    threadSessionById: Object.fromEntries(
      threadIds.map((threadId) => [threadId, null] as const),
    ) as EnvironmentState["threadSessionById"],
    threadTurnStateById: Object.fromEntries(
      threadIds.map((threadId) => [threadId, { latestTurn: null }] as const),
    ) as EnvironmentState["threadTurnStateById"],
    messageIdsByThreadId: messageIdsByThreadId as EnvironmentState["messageIdsByThreadId"],
    messageByThreadId: messageByThreadId as EnvironmentState["messageByThreadId"],
    queuedTurnIdsByThreadId: queuedTurnIdsByThreadId as EnvironmentState["queuedTurnIdsByThreadId"],
    queuedTurnByThreadId: queuedTurnByThreadId as EnvironmentState["queuedTurnByThreadId"],
    activityIdsByThreadId: activityIdsByThreadId as EnvironmentState["activityIdsByThreadId"],
    activityByThreadId: activityByThreadId as EnvironmentState["activityByThreadId"],
    proposedPlanIdsByThreadId:
      proposedPlanIdsByThreadId as EnvironmentState["proposedPlanIdsByThreadId"],
    proposedPlanByThreadId: proposedPlanByThreadId as EnvironmentState["proposedPlanByThreadId"],
    turnDiffIdsByThreadId: turnDiffIdsByThreadId as EnvironmentState["turnDiffIdsByThreadId"],
    turnDiffSummaryByThreadId:
      turnDiffSummaryByThreadId as EnvironmentState["turnDiffSummaryByThreadId"],
    threadDetailPageInfoByThreadId:
      threadDetailPageInfoByThreadId as EnvironmentState["threadDetailPageInfoByThreadId"],
    sidebarThreadSummaryById: Object.fromEntries(
      threads.map((thread, index) => [
        thread.id,
        {
          id: thread.id,
          environmentId,
          projectId,
          title: thread.title ?? `Cached thread ${index + 1}`,
          interactionMode: DEFAULT_INTERACTION_MODE,
          session: null,
          createdAt,
          archivedAt: null,
          updatedAt: thread.updatedAt ?? `2026-04-01T00:0${index + 1}:00.000Z`,
          latestTurn: null,
          branch: null,
          worktreePath: null,
          latestUserMessageAt: thread.messageText
            ? (thread.updatedAt ?? `2026-04-01T00:0${index + 1}:00.000Z`)
            : null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ]),
    ) as EnvironmentState["sidebarThreadSummaryById"],
    bootstrapComplete: false,
  };
}

function threadMessageTexts(state: EnvironmentState | null, threadId: ThreadId): string[] {
  if (!state) {
    return [];
  }
  return (state.messageIdsByThreadId[threadId] ?? []).flatMap((messageId) => {
    const message = state.messageByThreadId[threadId]?.[messageId];
    return message ? [message.text] : [];
  });
}

let localStorageStub: BudgetedStorage;

function measureStoredBytes(
  environmentId: EnvironmentId,
  state: EnvironmentState,
  options?: { readonly preferredThreadIds?: readonly ThreadId[] },
): number {
  localStorageStub.setMaxBytes(Number.POSITIVE_INFINITY);
  clearOrchestrationStartupCacheForTests();
  writeCachedEnvironmentState(environmentId, state, options);
  const storedBytes = localStorageStub.getStoredBytes();
  clearOrchestrationStartupCacheForTests();
  return storedBytes;
}

describe("orchestration startup cache", () => {
  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    clearOrchestrationStartupCacheForTests();
  });

  afterEach(() => {
    clearOrchestrationStartupCacheForTests();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    vi.unstubAllGlobals();
  });

  it("roundtrips cached environment detail for a single thread", () => {
    const pageInfo = makePageInfo(1);
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "cached message", pageInfo }),
      { preferredThreadIds: [THREAD_ID] },
    );

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);

    expect(cached?.messageIdsByThreadId[THREAD_ID]).toEqual([MessageId.make("message-1")]);
    expect(threadMessageTexts(cached, THREAD_ID)).toEqual(["cached message"]);
    expect(cached?.queuedTurnIdsByThreadId[THREAD_ID]).toEqual([
      MessageId.make("queued-message-1"),
    ]);
    expect(cached?.activityIdsByThreadId[THREAD_ID]).toEqual([EventId.make("activity-1")]);
    expect(cached?.proposedPlanIdsByThreadId[THREAD_ID]).toEqual(["plan-1"]);
    expect(cached?.turnDiffIdsByThreadId[THREAD_ID]).toEqual([TurnId.make("turn-1")]);
    expect(cached?.threadDetailPageInfoByThreadId[THREAD_ID]).toEqual(pageInfo);
    expect(readCachedEnvironmentStateEntries()[0]).toMatchObject({
      shellComplete: true,
      shellRevision: expect.any(String),
    });
  });

  it("hydrates projects, sidebar summaries, and thread detail before connection startup", () => {
    const cachedState = makeEnvironmentState({
      messageText: "instant cached conversation",
      threads: [
        {
          id: THREAD_ID,
          title: "Instant cached thread",
          updatedAt: "2026-04-01T00:10:00.000Z",
          messageText: "instant cached conversation",
        },
        {
          id: SHELL_ONLY_THREAD_ID,
          title: "Older cached thread",
          updatedAt: "2026-04-01T00:05:00.000Z",
        },
      ],
    });
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...cachedState,
        // Detail can arrive and be persisted before the shell stream owns these summaries.
        sidebarThreadSummaryById: {},
      },
      { preferredThreadIds: [THREAD_ID] },
    );

    const startupCache = hydrateOrchestrationStartupCache();

    expect(
      selectProjectsAcrossEnvironments(useStore.getState()).map((project) => project.name),
    ).toEqual(["Cache Project"]);
    expect(
      selectSidebarThreadsAcrossEnvironments(useStore.getState()).map((thread) => thread.title),
    ).toEqual(["Instant cached thread", "Older cached thread"]);
    expect(
      threadMessageTexts(
        useStore.getState().environmentStateById[ENVIRONMENT_ID] ?? null,
        THREAD_ID,
      ),
    ).toEqual(["instant cached conversation"]);
    expect(startupCache.threadIdsByEnvironment[ENVIRONMENT_ID]).toEqual([
      THREAD_ID,
      SHELL_ONLY_THREAD_ID,
    ]);
  });

  it("fills missing local startup detail from the durable cache without replacing the local shell", () => {
    const durableState = makeEnvironmentState({ messageText: "durable cached conversation" });
    const shellOnlyState: EnvironmentState = {
      ...durableState,
      threadShellById: {
        ...durableState.threadShellById,
        [THREAD_ID]: {
          ...durableState.threadShellById[THREAD_ID]!,
          title: "Newer local shell title",
        },
      },
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
    };

    useStore.getState().hydrateCachedEnvironmentState(ENVIRONMENT_ID, shellOnlyState);
    useStore.getState().hydrateCachedEnvironmentDetailState(ENVIRONMENT_ID, durableState);

    const hydrated = useStore.getState().environmentStateById[ENVIRONMENT_ID] ?? null;
    expect(threadMessageTexts(hydrated, THREAD_ID)).toEqual(["durable cached conversation"]);
    expect(hydrated?.threadShellById[THREAD_ID]?.title).toBe("Newer local shell title");
  });

  it("does not replace an existing local hot tail with asynchronous durable detail", () => {
    useStore
      .getState()
      .hydrateCachedEnvironmentState(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "newer local hot tail" }),
      );

    useStore
      .getState()
      .hydrateCachedEnvironmentDetailState(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "older durable detail" }),
      );

    expect(
      threadMessageTexts(
        useStore.getState().environmentStateById[ENVIRONMENT_ID] ?? null,
        THREAD_ID,
      ),
    ).toEqual(["newer local hot tail"]);
  });

  it("enriches a local hot tail from durable detail at the same projection sequence", () => {
    const localState = makeEnvironmentState({ messageText: "message template" });
    const templateMessageId = localState.messageIdsByThreadId[THREAD_ID]![0]!;
    const templateMessage = localState.messageByThreadId[THREAD_ID]![templateMessageId]!;
    const olderMessageId = MessageId.make("durable-older-message");
    const tailMessageId = MessageId.make("shared-tail-message");
    const durableState: EnvironmentState = {
      ...localState,
      messageIdsByThreadId: {
        [THREAD_ID]: [olderMessageId, tailMessageId],
      },
      messageByThreadId: {
        [THREAD_ID]: {
          [olderMessageId]: {
            ...templateMessage,
            id: olderMessageId,
            text: "durable older message",
          },
          [tailMessageId]: {
            ...templateMessage,
            id: tailMessageId,
            text: "stale durable tail",
          },
        },
      },
      lastAppliedEventSequenceByThreadId: {
        [THREAD_ID]: 42,
      },
    };
    const compactLocalState: EnvironmentState = {
      ...localState,
      messageIdsByThreadId: {
        [THREAD_ID]: [tailMessageId],
      },
      messageByThreadId: {
        [THREAD_ID]: {
          [tailMessageId]: {
            ...templateMessage,
            id: tailMessageId,
            text: "newer local tail",
          },
        },
      },
      lastAppliedEventSequenceByThreadId: {
        [THREAD_ID]: 42,
      },
    };

    useStore.getState().hydrateCachedEnvironmentState(ENVIRONMENT_ID, compactLocalState);
    useStore.getState().hydrateCachedEnvironmentDetailState(ENVIRONMENT_ID, durableState);

    expect(
      threadMessageTexts(
        useStore.getState().environmentStateById[ENVIRONMENT_ID] ?? null,
        THREAD_ID,
      ),
    ).toEqual(["durable older message", "newer local tail"]);
  });

  it("does not recreate an environment from durable detail after its local shell is removed", () => {
    useStore
      .getState()
      .hydrateCachedEnvironmentDetailState(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "stale durable environment" }),
      );

    expect(useStore.getState().environmentStateById[ENVIRONMENT_ID]).toBeUndefined();
  });

  it("does not recreate a thread that is absent from the synchronous sidebar shell", () => {
    const durableState = makeEnvironmentState({ messageText: "stale deleted thread detail" });
    const localState: EnvironmentState = {
      ...durableState,
      threadIds: [SHELL_ONLY_THREAD_ID],
      threadIdsByProjectId: {
        [PROJECT_ID]: [SHELL_ONLY_THREAD_ID],
      },
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
    };
    useStore.getState().hydrateCachedEnvironmentState(ENVIRONMENT_ID, localState);
    useStore.getState().hydrateCachedEnvironmentDetailState(ENVIRONMENT_ID, durableState);

    const hydrated = useStore.getState().environmentStateById[ENVIRONMENT_ID]!;
    expect(hydrated.threadIds).toEqual([SHELL_ONLY_THREAD_ID]);
    expect(threadMessageTexts(hydrated, THREAD_ID)).toEqual([]);
  });

  it("does not apply asynchronous durable detail after live bootstrap becomes authoritative", () => {
    const liveState = {
      ...makeEnvironmentState({ messageText: "live conversation" }),
      bootstrapComplete: true,
    };
    useStore.setState({
      activeEnvironmentId: ENVIRONMENT_ID,
      environmentStateById: {
        [ENVIRONMENT_ID]: liveState,
      },
    });

    useStore
      .getState()
      .hydrateCachedEnvironmentDetailState(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "stale durable conversation" }),
      );

    expect(
      threadMessageTexts(
        useStore.getState().environmentStateById[ENVIRONMENT_ID] ?? null,
        THREAD_ID,
      ),
    ).toEqual(["live conversation"]);
  });

  it("fills a compact synchronous sidebar shell without replacing newer local shell rows", () => {
    const durableState = makeEnvironmentState();
    const { [THREAD_ID]: _removedShell, ...threadShellById } = durableState.threadShellById;
    const { [THREAD_ID]: _removedSession, ...threadSessionById } = durableState.threadSessionById;
    const { [THREAD_ID]: _removedTurnState, ...threadTurnStateById } =
      durableState.threadTurnStateById;
    const { [THREAD_ID]: _removedSummary, ...sidebarThreadSummaryById } =
      durableState.sidebarThreadSummaryById;
    const localState: EnvironmentState = {
      ...durableState,
      threadIds: [SHELL_ONLY_THREAD_ID],
      threadIdsByProjectId: {
        [PROJECT_ID]: [SHELL_ONLY_THREAD_ID],
      },
      threadShellById: {
        ...threadShellById,
        [SHELL_ONLY_THREAD_ID]: {
          ...threadShellById[SHELL_ONLY_THREAD_ID]!,
          title: "Newer local shell row",
        },
      },
      threadSessionById,
      threadTurnStateById,
      sidebarThreadSummaryById,
    };
    useStore.getState().hydrateCachedEnvironmentState(ENVIRONMENT_ID, localState);

    useStore.getState().hydrateCachedEnvironmentShellState(ENVIRONMENT_ID, durableState);

    const hydrated = useStore.getState().environmentStateById[ENVIRONMENT_ID]!;
    expect(hydrated.threadIds).toEqual([THREAD_ID, SHELL_ONLY_THREAD_ID]);
    expect(hydrated.threadShellById[THREAD_ID]?.title).toBe("Cached thread");
    expect(hydrated.threadShellById[SHELL_ONLY_THREAD_ID]?.title).toBe("Newer local shell row");
  });

  it("does not apply an IndexedDB sidebar shell after live bootstrap becomes authoritative", () => {
    const liveState: EnvironmentState = {
      ...makeEnvironmentState({
        threads: [{ id: SHELL_ONLY_THREAD_ID, title: "Live shell thread" }],
      }),
      bootstrapComplete: true,
    };
    useStore.setState({
      activeEnvironmentId: ENVIRONMENT_ID,
      environmentStateById: {
        [ENVIRONMENT_ID]: liveState,
      },
    });

    useStore.getState().hydrateCachedEnvironmentShellState(ENVIRONMENT_ID, makeEnvironmentState());

    expect(useStore.getState().environmentStateById[ENVIRONMENT_ID]).toBe(liveState);
  });

  it("invalidates a compact shell revision when a pre-bootstrap tombstone cannot update it completely", () => {
    const completeState = makeEnvironmentState();
    writeCachedEnvironmentState(ENVIRONMENT_ID, completeState);
    const rawDocument = localStorageStub.getItem(ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY);
    if (!rawDocument) {
      throw new Error("Expected a startup cache document.");
    }
    const document = JSON.parse(rawDocument) as {
      environments: Record<string, { shellComplete: boolean }>;
    };
    document.environments[ENVIRONMENT_ID]!.shellComplete = false;
    localStorageStub.setItem(ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY, JSON.stringify(document));

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...completeState,
        threadIds: [SHELL_ONLY_THREAD_ID],
        threadIdsByProjectId: {
          [PROJECT_ID]: [SHELL_ONLY_THREAD_ID],
        },
      },
      {
        preserveCachedShell: true,
        removedThreadIds: [THREAD_ID],
      },
    );

    const cachedEntry = readCachedEnvironmentStateEntries()[0];
    expect(cachedEntry?.shellRevision).toBeNull();
    expect(cachedEntry?.state.threadIds).toEqual([SHELL_ONLY_THREAD_ID]);
  });

  it("does not let a detail-first write erase a previously cached sidebar shell", () => {
    const completeShellState = makeEnvironmentState({
      threads: [
        {
          id: THREAD_ID,
          title: "Previously cached active thread",
          messageText: "previous cached conversation",
        },
        {
          id: SHELL_ONLY_THREAD_ID,
          title: "Previously cached inactive thread",
        },
      ],
    });
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...completeShellState,
        projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
        projectById: {
          ...completeShellState.projectById,
          [SECOND_PROJECT_ID]: {
            ...completeShellState.projectById[PROJECT_ID]!,
            id: SECOND_PROJECT_ID,
            name: "Second Cache Project",
            cwd: "/tmp/cache-project-second",
          },
        },
      },
      { preferredThreadIds: [THREAD_ID] },
    );

    const detailFirstState = makeEnvironmentState({
      threads: [
        {
          id: THREAD_ID,
          title: "Fresh detail-first active thread",
          messageText: "fresh detail-first conversation",
        },
      ],
    });
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...detailFirstState,
        projectIds: [],
        projectById: {},
        sidebarThreadSummaryById: {},
      },
      { preferredThreadIds: [THREAD_ID], preserveCachedShell: true },
    );

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(cached?.projectIds).toEqual([PROJECT_ID, SECOND_PROJECT_ID]);
    expect(cached?.projectById[PROJECT_ID]?.name).toBe("Cache Project");
    expect(cached?.projectById[SECOND_PROJECT_ID]?.name).toBe("Second Cache Project");
    expect(cached?.threadIds).toEqual([THREAD_ID, SHELL_ONLY_THREAD_ID]);
    expect(cached?.threadShellById[THREAD_ID]?.title).toBe("Fresh detail-first active thread");
    expect(cached?.threadShellById[SHELL_ONLY_THREAD_ID]?.title).toBe(
      "Previously cached inactive thread",
    );
    expect(threadMessageTexts(cached, THREAD_ID)).toEqual(["fresh detail-first conversation"]);
  });

  it("does not reintroduce authoritative pre-bootstrap project or thread removals", () => {
    const completeState = makeEnvironmentState();
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...completeState,
        projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
        projectById: {
          ...completeState.projectById,
          [SECOND_PROJECT_ID]: {
            ...completeState.projectById[PROJECT_ID]!,
            id: SECOND_PROJECT_ID,
            name: "Removed Cache Project",
            cwd: "/tmp/cache-project-removed",
          },
        },
      },
      { preferredThreadIds: [THREAD_ID] },
    );

    const authoritativeState = makeEnvironmentState({
      threads: [{ id: THREAD_ID, title: "Authoritative remaining thread" }],
    });
    expect(authoritativeState.bootstrapComplete).toBe(false);
    writeCachedEnvironmentState(ENVIRONMENT_ID, authoritativeState, {
      preferredThreadIds: [THREAD_ID],
    });

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(cached?.projectIds).toEqual([PROJECT_ID]);
    expect(cached?.projectById[SECOND_PROJECT_ID]).toBeUndefined();
    expect(cached?.threadIds).toEqual([THREAD_ID]);
    expect(cached?.threadShellById[SHELL_ONLY_THREAD_ID]).toBeUndefined();
  });

  it("honors deletion tombstones while preserving a detail-only cached shell", () => {
    const completeState = makeEnvironmentState();
    writeCachedEnvironmentState(ENVIRONMENT_ID, completeState, {
      preferredThreadIds: [THREAD_ID],
    });

    const detailOnlyState = makeEnvironmentState({
      threads: [{ id: THREAD_ID, title: "Fresh detail after deletion" }],
    });
    writeCachedEnvironmentState(ENVIRONMENT_ID, detailOnlyState, {
      preferredThreadIds: [THREAD_ID],
      preserveCachedShell: true,
      removedThreadIds: [SHELL_ONLY_THREAD_ID],
    });

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(cached?.projectIds).toEqual([PROJECT_ID]);
    expect(cached?.threadIds).toEqual([THREAD_ID]);
    expect(cached?.threadShellById[SHELL_ONLY_THREAD_ID]).toBeUndefined();
  });

  it("round-trips the last persisted running state across a process restart", () => {
    const runningTurnId = TurnId.make("turn-running-before-background");
    const state = makeEnvironmentState({ messageText: "cached while running" });
    const runningSession: NonNullable<EnvironmentState["threadSessionById"][ThreadId]> = {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: runningTurnId,
      createdAt: "2026-04-01T00:01:00.000Z",
      updatedAt: "2026-04-01T00:02:00.000Z",
    };
    const runningTurn = {
      turnId: runningTurnId,
      state: "running" as const,
      requestedAt: "2026-04-01T00:02:00.000Z",
      startedAt: "2026-04-01T00:02:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    };

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...state,
        threadSessionById: { ...state.threadSessionById, [THREAD_ID]: runningSession },
        threadTurnStateById: {
          ...state.threadTurnStateById,
          [THREAD_ID]: { latestTurn: runningTurn },
        },
        sidebarThreadSummaryById: {
          ...state.sidebarThreadSummaryById,
          [THREAD_ID]: {
            ...state.sidebarThreadSummaryById[THREAD_ID]!,
            session: runningSession,
            latestTurn: runningTurn,
          },
        },
      },
      { preferredThreadIds: [THREAD_ID] },
    );

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(cached?.threadSessionById[THREAD_ID]).toEqual(runningSession);
    expect(cached?.threadTurnStateById[THREAD_ID]?.latestTurn).toEqual(runningTurn);
    expect(cached?.sidebarThreadSummaryById[THREAD_ID]?.session).toEqual(runningSession);
    expect(cached?.sidebarThreadSummaryById[THREAD_ID]?.latestTurn).toEqual(runningTurn);
    expect(threadMessageTexts(cached, THREAD_ID)).toEqual(["cached while running"]);
  });

  it("flushes an authoritative environment cache write without waiting for the debounce", () => {
    vi.useFakeTimers();
    try {
      const state = makeEnvironmentState();
      scheduleCachedEnvironmentStateWrite(ENVIRONMENT_ID, state);

      expect(readCachedEnvironmentState(ENVIRONMENT_ID)).toBeNull();
      flushPendingCachedEnvironmentStateWrite(ENVIRONMENT_ID);

      expect(readCachedEnvironmentState(ENVIRONMENT_ID)?.projectIds).toEqual([PROJECT_ID]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps shell-only threads without detail rows", () => {
    writeCachedEnvironmentState(ENVIRONMENT_ID, makeEnvironmentState(), {
      preferredThreadIds: [THREAD_ID, SHELL_ONLY_THREAD_ID],
    });

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);

    expect(cached?.threadShellById[THREAD_ID]?.title).toBe("Cached thread");
    expect(cached?.threadShellById[SHELL_ONLY_THREAD_ID]?.title).toBe("Shell only");
    expect(threadMessageTexts(cached, THREAD_ID)).toEqual([]);
    expect(threadMessageTexts(cached, SHELL_ONLY_THREAD_ID)).toEqual([]);
  });

  it("invalidates the memoized document after a write", () => {
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "first cached message" }),
      { preferredThreadIds: [THREAD_ID] },
    );
    expect(threadMessageTexts(readCachedEnvironmentState(ENVIRONMENT_ID), THREAD_ID)).toEqual([
      "first cached message",
    ]);

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "second cached message" }),
      { preferredThreadIds: [THREAD_ID] },
    );

    expect(threadMessageTexts(readCachedEnvironmentState(ENVIRONMENT_ID), THREAD_ID)).toEqual([
      "second cached message",
    ]);
  });

  it("flushes the newest pending thread detail when a PWA is backgrounded before debounce", () => {
    vi.useFakeTimers();
    const documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const windowTarget = new EventTarget();
    const cleanupPersistence = installOrchestrationStartupCachePersistence({
      documentTarget,
      windowTarget,
    });

    try {
      writeCachedEnvironmentState(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "stale previous-launch message" }),
        { preferredThreadIds: [THREAD_ID] },
      );
      scheduleCachedEnvironmentStateWrite(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "latest message before PWA close" }),
        { preferredThreadIds: [THREAD_ID] },
      );

      expect(threadMessageTexts(readCachedEnvironmentState(ENVIRONMENT_ID), THREAD_ID)).toEqual([
        "stale previous-launch message",
      ]);

      documentTarget.visibilityState = "hidden";
      documentTarget.dispatchEvent(new Event("visibilitychange"));

      expect(threadMessageTexts(readCachedEnvironmentState(ENVIRONMENT_ID), THREAD_ID)).toEqual([
        "latest message before PWA close",
      ]);

      // The cancelled debounce timer must not perform a second write later.
      vi.advanceTimersByTime(500);
      expect(threadMessageTexts(readCachedEnvironmentState(ENVIRONMENT_ID), THREAD_ID)).toEqual([
        "latest message before PWA close",
      ]);
    } finally {
      cleanupPersistence();
      vi.useRealTimers();
    }
  });

  it("flushes pending thread detail on pagehide even while the document is visible", () => {
    vi.useFakeTimers();
    const documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const windowTarget = new EventTarget();
    const cleanupPersistence = installOrchestrationStartupCachePersistence({
      documentTarget,
      windowTarget,
    });

    try {
      writeCachedEnvironmentState(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "pagehide stale message" }),
        { preferredThreadIds: [THREAD_ID] },
      );
      scheduleCachedEnvironmentStateWrite(
        ENVIRONMENT_ID,
        makeEnvironmentState({ messageText: "pagehide latest message" }),
        { preferredThreadIds: [THREAD_ID] },
      );

      windowTarget.dispatchEvent(new Event("pagehide"));

      expect(threadMessageTexts(readCachedEnvironmentState(ENVIRONMENT_ID), THREAD_ID)).toEqual([
        "pagehide latest message",
      ]);
    } finally {
      cleanupPersistence();
      vi.useRealTimers();
    }
  });

  it("degrades to current-environment shells instead of deleting the cache on quota pressure", () => {
    const shellOnlyBytes = measureStoredBytes(ENVIRONMENT_ID, makeEnvironmentState());
    localStorageStub.setMaxBytes(shellOnlyBytes + 200);

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "x".repeat(10_000) }),
      { preferredThreadIds: [THREAD_ID] },
    );

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(cached?.threadShellById[THREAD_ID]?.title).toBe("Cached thread");
    expect(cached?.threadShellById[SHELL_ONLY_THREAD_ID]?.title).toBe("Shell only");
    expect(threadMessageTexts(cached, THREAD_ID)).toEqual([]);
    expect(localStorageStub.getItem(ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY)).not.toBeNull();
    expect(localStorageStub.getStoredBytes()).toBeLessThanOrEqual(shellOnlyBytes + 200);
  });

  it("keeps preferred thread detail longest while walking the quota degradation ladder", () => {
    const threadIds = [1, 2, 3, 4].map((index) => ThreadId.make(`thread-detail-${index}`));
    const preferredThreadId = threadIds[3]!;
    const largeText = "preferred-detail-budget ".repeat(500);
    const makeThreads = (detailedThreadIds: ReadonlySet<ThreadId>): readonly ThreadStateInput[] =>
      threadIds.map((threadId, index) => ({
        id: threadId,
        title: `Thread ${index + 1}`,
        updatedAt: `2026-04-01T00:0${index + 1}:00.000Z`,
        ...(detailedThreadIds.has(threadId) ? { messageText: `${threadId} ${largeText}` } : {}),
      }));

    const oneDetailState = makeEnvironmentState({
      threads: makeThreads(new Set([preferredThreadId])),
    });
    const threeDetailState = makeEnvironmentState({
      threads: makeThreads(new Set([preferredThreadId, threadIds[0]!, threadIds[1]!])),
    });
    const oneDetailBytes = measureStoredBytes(ENVIRONMENT_ID, oneDetailState, {
      preferredThreadIds: [preferredThreadId],
    });
    const threeDetailBytes = measureStoredBytes(ENVIRONMENT_ID, threeDetailState, {
      preferredThreadIds: [preferredThreadId],
    });
    localStorageStub.setMaxBytes(
      oneDetailBytes + Math.max(100, Math.floor((threeDetailBytes - oneDetailBytes) / 2)),
    );

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ threads: makeThreads(new Set(threadIds)) }),
      { preferredThreadIds: [preferredThreadId] },
    );

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(threadMessageTexts(cached, preferredThreadId)).toHaveLength(1);
    for (const threadId of threadIds.filter((threadId) => threadId !== preferredThreadId)) {
      expect(threadMessageTexts(cached, threadId)).toEqual([]);
    }
  });

  it("keeps a recent preferred-thread message tail when its full conversation exceeds the document budget", () => {
    const state = makeEnvironmentState({ messageText: "message template" });
    const templateMessageId = state.messageIdsByThreadId[THREAD_ID]![0]!;
    const templateMessage = state.messageByThreadId[THREAD_ID]![templateMessageId]!;
    const messageIds = Array.from({ length: 40 }, (_, index) =>
      MessageId.make(`large-conversation-message-${index}`),
    );
    const messageById = Object.fromEntries(
      messageIds.map((messageId, index) => [
        messageId,
        {
          ...templateMessage,
          id: messageId,
          text: `large conversation message ${index} ${"x".repeat(60_000)}`,
          createdAt: new Date(Date.UTC(2026, 3, 1, 0, index)).toISOString(),
        },
      ]),
    ) as EnvironmentState["messageByThreadId"][ThreadId];

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...state,
        messageIdsByThreadId: {
          ...state.messageIdsByThreadId,
          [THREAD_ID]: messageIds,
        },
        messageByThreadId: {
          ...state.messageByThreadId,
          [THREAD_ID]: messageById,
        },
      },
      { preferredThreadIds: [THREAD_ID] },
    );

    const cachedMessages = threadMessageTexts(
      readCachedEnvironmentState(ENVIRONMENT_ID),
      THREAD_ID,
    );
    expect(cachedMessages.length).toBeGreaterThan(0);
    expect(cachedMessages.at(-1)).toBe(`large conversation message 39 ${"x".repeat(60_000)}`);
    expect(localStorageStub.getItem(ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY)?.length).toBeLessThan(
      2_000_000,
    );
  });

  it("drops older environment detail without dropping its sidebar shell", () => {
    writeCachedEnvironmentState(
      OTHER_ENVIRONMENT_ID,
      makeEnvironmentState({
        environmentId: OTHER_ENVIRONMENT_ID,
        messageText: `older environment ${"o".repeat(1_100_000)}`,
      }),
      { preferredThreadIds: [THREAD_ID] },
    );

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({
        messageText: `current environment ${"c".repeat(1_100_000)}`,
      }),
      { preferredThreadIds: [THREAD_ID] },
    );

    const currentMessages = threadMessageTexts(
      readCachedEnvironmentState(ENVIRONMENT_ID),
      THREAD_ID,
    );
    expect(currentMessages).toHaveLength(1);
    expect(currentMessages[0]?.startsWith("current environment ")).toBe(true);
    expect(currentMessages[0]).toHaveLength("current environment ".length + 1_100_000);
    const olderEnvironment = readCachedEnvironmentState(OTHER_ENVIRONMENT_ID);
    expect(olderEnvironment?.projectIds).toHaveLength(1);
    expect(olderEnvironment?.threadIds).toEqual([THREAD_ID, SHELL_ONLY_THREAD_ID]);
    expect(olderEnvironment?.threadShellById[THREAD_ID]?.title).toBe("Cached thread");
    expect(threadMessageTexts(olderEnvironment, THREAD_ID)).toEqual([]);

    hydrateOrchestrationStartupCache();
    const sidebarThreads = selectSidebarThreadsAcrossEnvironments(useStore.getState());
    expect(sidebarThreads.filter((thread) => thread.environmentId === ENVIRONMENT_ID)).toHaveLength(
      2,
    );
    expect(
      sidebarThreads.filter((thread) => thread.environmentId === OTHER_ENVIRONMENT_ID),
    ).toHaveLength(2);
  });

  it("drops older other environments before dropping current-environment shells", () => {
    const currentShellBytes = measureStoredBytes(ENVIRONMENT_ID, makeEnvironmentState());
    clearOrchestrationStartupCacheForTests();
    writeCachedEnvironmentState(
      OTHER_ENVIRONMENT_ID,
      makeEnvironmentState({
        environmentId: OTHER_ENVIRONMENT_ID,
        messageText: "older other environment detail ".repeat(1_000),
      }),
      { preferredThreadIds: [THREAD_ID] },
    );
    localStorageStub.setMaxBytes(currentShellBytes + 200);

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "current detail ".repeat(1_000) }),
      { preferredThreadIds: [THREAD_ID] },
    );

    const cached = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(cached?.threadShellById[THREAD_ID]?.title).toBe("Cached thread");
    expect(threadMessageTexts(cached, THREAD_ID)).toEqual([]);
    expect(readCachedEnvironmentState(OTHER_ENVIRONMENT_ID)).toBeNull();
    expect(localStorageStub.getStoredBytes()).toBeLessThanOrEqual(currentShellBytes + 200);
  });

  it("repairs a detail-only cache with every project when the complete shell exceeds the document budget", () => {
    const activeThreadId = ThreadId.make("thread-oversized-shell-active");
    const oversizedThreads = Array.from({ length: 1_000 }, (_, index) => ({
      id: index === 0 ? activeThreadId : ThreadId.make(`thread-oversized-shell-${index}`),
      title: `Oversized shell thread ${index} ${"x".repeat(1_000)}`,
      updatedAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
      ...(index === 0 ? { messageText: "cached active conversation" } : {}),
    }));
    const detailOnlyState = makeEnvironmentState({
      threads: [oversizedThreads[0]!],
    });
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      {
        ...detailOnlyState,
        projectIds: [],
        projectById: {},
        threadIdsByProjectId: {},
      },
      { preferredThreadIds: [activeThreadId], preserveCachedShell: true },
    );
    expect(readCachedEnvironmentState(ENVIRONMENT_ID)?.projectIds).toEqual([]);

    const completeState = makeEnvironmentState({ threads: oversizedThreads });
    writeCachedEnvironmentState(ENVIRONMENT_ID, {
      ...completeState,
      projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
      projectById: {
        ...completeState.projectById,
        [SECOND_PROJECT_ID]: {
          ...completeState.projectById[PROJECT_ID]!,
          id: SECOND_PROJECT_ID,
          name: "Second oversized-shell project",
          cwd: "/tmp/cache-project-second",
        },
      },
    });

    const repaired = readCachedEnvironmentState(ENVIRONMENT_ID);
    expect(repaired?.projectIds).toEqual([PROJECT_ID, SECOND_PROJECT_ID]);
    expect(repaired?.threadIds).toContain(activeThreadId);
    expect(repaired?.threadIds.length).toBeLessThan(oversizedThreads.length);
    expect(threadMessageTexts(repaired, activeThreadId)).toEqual(["cached active conversation"]);
    expect(readCachedEnvironmentStateEntries()[0]?.shellComplete).toBe(false);
    expect(localStorageStub.getItem(ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY)?.length).toBeLessThan(
      2_000_000,
    );
  });
});
