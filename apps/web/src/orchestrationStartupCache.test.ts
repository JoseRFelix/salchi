import {
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadDetailPageInfo,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentState } from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";
import {
  clearOrchestrationStartupCacheForTests,
  readCachedThreadDetail,
  writeCachedEnvironmentState,
} from "./orchestrationStartupCache";

const ENVIRONMENT_ID = EnvironmentId.make("environment-cache-test");
const PROJECT_ID = ProjectId.make("project-cache-test");
const THREAD_ID = ThreadId.make("thread-cache-test");
const SHELL_ONLY_THREAD_ID = ThreadId.make("thread-shell-only");

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
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
      store.set(key, value);
    },
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
    readonly messageText?: string;
    readonly pageInfo?: OrchestrationThreadDetailPageInfo;
  } = {},
): EnvironmentState {
  const messageId = MessageId.make("message-1");
  const queuedTurnId = MessageId.make("queued-message-1");
  const activityId = EventId.make("activity-1");
  const planId = "plan-1" as never;
  const turnId = TurnId.make("turn-1");
  const createdAt = "2026-04-01T00:01:00.000Z";
  const hasDetail = input.messageText !== undefined;

  return {
    projectIds: [PROJECT_ID],
    projectById: {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
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
    threadIds: [THREAD_ID, SHELL_ONLY_THREAD_ID],
    threadIdsByProjectId: {
      [PROJECT_ID]: [THREAD_ID, SHELL_ONLY_THREAD_ID],
    },
    threadShellById: {
      [THREAD_ID]: {
        id: THREAD_ID,
        environmentId: ENVIRONMENT_ID,
        codexThreadId: null,
        projectId: PROJECT_ID,
        title: "Cached thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        error: null,
        createdAt,
        archivedAt: null,
        updatedAt: createdAt,
        branch: null,
        worktreePath: null,
      },
      [SHELL_ONLY_THREAD_ID]: {
        id: SHELL_ONLY_THREAD_ID,
        environmentId: ENVIRONMENT_ID,
        codexThreadId: null,
        projectId: PROJECT_ID,
        title: "Shell only",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        error: null,
        createdAt,
        archivedAt: null,
        updatedAt: createdAt,
        branch: null,
        worktreePath: null,
      },
    },
    threadSessionById: {
      [THREAD_ID]: null,
      [SHELL_ONLY_THREAD_ID]: null,
    },
    threadTurnStateById: {
      [THREAD_ID]: { latestTurn: null },
      [SHELL_ONLY_THREAD_ID]: { latestTurn: null },
    },
    messageIdsByThreadId: hasDetail ? { [THREAD_ID]: [messageId] } : {},
    messageByThreadId: hasDetail
      ? {
          [THREAD_ID]: {
            [messageId]: {
              id: messageId,
              role: "user",
              text: input.messageText,
              createdAt,
              streaming: false,
            },
          },
        }
      : {},
    queuedTurnIdsByThreadId: hasDetail ? { [THREAD_ID]: [queuedTurnId] } : {},
    queuedTurnByThreadId: hasDetail
      ? {
          [THREAD_ID]: {
            [queuedTurnId]: {
              threadId: THREAD_ID,
              messageId: queuedTurnId,
              role: "user",
              text: "queued",
              attachments: [],
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_INTERACTION_MODE,
              createdAt,
              updatedAt: createdAt,
            },
          },
        }
      : {},
    activityIdsByThreadId: hasDetail ? { [THREAD_ID]: [activityId] } : {},
    activityByThreadId: hasDetail
      ? {
          [THREAD_ID]: {
            [activityId]: {
              id: activityId,
              tone: "info",
              kind: "step",
              summary: "activity",
              payload: {},
              turnId,
              sequence: 1,
              createdAt,
            },
          },
        }
      : {},
    proposedPlanIdsByThreadId: hasDetail ? { [THREAD_ID]: [planId] } : {},
    proposedPlanByThreadId: hasDetail
      ? {
          [THREAD_ID]: {
            [planId]: {
              id: planId,
              turnId,
              planMarkdown: "plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt,
              updatedAt: createdAt,
            },
          },
        }
      : {},
    turnDiffIdsByThreadId: hasDetail ? { [THREAD_ID]: [turnId] } : {},
    turnDiffSummaryByThreadId: hasDetail
      ? {
          [THREAD_ID]: {
            [turnId]: {
              turnId,
              completedAt: createdAt,
              status: "ready" as const,
              checkpointTurnCount: 1,
              files: [],
            },
          } as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId],
        }
      : {},
    threadDetailPageInfoByThreadId:
      hasDetail && input.pageInfo ? { [THREAD_ID]: input.pageInfo } : {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: false,
  };
}

describe("orchestration startup cache thread detail", () => {
  beforeEach(() => {
    const localStorage = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    clearOrchestrationStartupCacheForTests();
  });

  afterEach(() => {
    clearOrchestrationStartupCacheForTests();
    vi.unstubAllGlobals();
  });

  it("roundtrips cached detail for a single thread", () => {
    const pageInfo = makePageInfo(1);
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "cached message", pageInfo }),
      { preferredThreadIds: [THREAD_ID] },
    );

    const detail = readCachedThreadDetail(ENVIRONMENT_ID, THREAD_ID);

    expect(detail?.messageIds).toEqual([MessageId.make("message-1")]);
    expect(detail?.messageById[MessageId.make("message-1")]?.text).toBe("cached message");
    expect(detail?.queuedTurnIds).toEqual([MessageId.make("queued-message-1")]);
    expect(detail?.activityIds).toEqual([EventId.make("activity-1")]);
    expect(detail?.proposedPlanIds).toEqual(["plan-1"]);
    expect(detail?.turnDiffIds).toEqual([TurnId.make("turn-1")]);
    expect(detail?.pageInfo).toEqual(pageInfo);
  });

  it("returns null for unknown and shell-only threads", () => {
    writeCachedEnvironmentState(ENVIRONMENT_ID, makeEnvironmentState(), {
      preferredThreadIds: [THREAD_ID, SHELL_ONLY_THREAD_ID],
    });

    expect(readCachedThreadDetail(ENVIRONMENT_ID, ThreadId.make("thread-missing"))).toBeNull();
    expect(readCachedThreadDetail(ENVIRONMENT_ID, SHELL_ONLY_THREAD_ID)).toBeNull();
  });

  it("invalidates the memoized document after a write", () => {
    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "first cached message" }),
      { preferredThreadIds: [THREAD_ID] },
    );
    expect(
      readCachedThreadDetail(ENVIRONMENT_ID, THREAD_ID)?.messageById[MessageId.make("message-1")]
        ?.text,
    ).toBe("first cached message");

    writeCachedEnvironmentState(
      ENVIRONMENT_ID,
      makeEnvironmentState({ messageText: "second cached message" }),
      { preferredThreadIds: [THREAD_ID] },
    );

    expect(
      readCachedThreadDetail(ENVIRONMENT_ID, THREAD_ID)?.messageById[MessageId.make("message-1")]
        ?.text,
    ).toBe("second cached message");
  });
});
