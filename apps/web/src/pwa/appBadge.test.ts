import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@salchi/contracts";

import { type EnvironmentState, useStore } from "../store";
import {
  __resetPwaAppBadgeSyncForTests,
  canUseAppBadge,
  installPwaAppBadgeSync,
  resyncAppBadge,
  writeAppBadgeCount,
} from "./appBadge";

const initialStoreState = useStore.getState();

function installBadgeGlobals(
  responseOk = true,
  visibilityState: DocumentVisibilityState = "hidden",
) {
  const postMessage = vi.fn(
    (
      message: { readonly requestId?: string; readonly snapshots?: readonly unknown[] },
      ports?: MessagePort[],
    ) => {
      ports?.[0]?.postMessage({
        requestId: message.requestId ?? null,
        ok: responseOk,
        count: message.snapshots?.length ?? 0,
      });
    },
  );
  const registration = {
    active: { postMessage },
    waiting: null,
    installing: null,
  };
  const serviceWorker = Object.assign(new EventTarget(), {
    getRegistration: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  });
  const navigatorLike = {
    setAppBadge: vi.fn(async () => {}),
    clearAppBadge: vi.fn(async () => {}),
    serviceWorker,
  };
  const windowLike = Object.assign(new EventTarget(), {
    isSecureContext: true,
    location: { origin: "https://salchi.example" },
    PushManager: function PushManager() {},
    Notification: function Notification() {},
  });
  const documentLike = new EventTarget() as EventTarget & {
    visibilityState: DocumentVisibilityState;
  };
  Object.defineProperty(documentLike, "visibilityState", {
    configurable: true,
    value: visibilityState,
  });
  vi.stubGlobal("navigator", navigatorLike);
  vi.stubGlobal("window", windowLike);
  vi.stubGlobal("document", documentLike);
  return {
    documentLike,
    navigatorLike,
    postMessage,
    setVisibilityState(nextVisibilityState: DocumentVisibilityState) {
      Object.defineProperty(documentLike, "visibilityState", {
        configurable: true,
        value: nextVisibilityState,
      });
    },
    windowLike,
  };
}

function makeEnvironmentState(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly seenCompletionTurnId?: TurnId | null;
  readonly archivedAt?: string | null;
  readonly hiddenFromThreadList?: boolean;
  readonly bootstrapComplete?: boolean;
}): EnvironmentState {
  const threadId = input.threadId ?? ThreadId.make("thread-1");
  const turnId = TurnId.make("turn-1");
  const summary = {
    id: threadId,
    environmentId: input.environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    interactionMode: "default" as const,
    session: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    latestTurn: {
      turnId,
      state: "completed" as const,
      requestedAt: "2026-08-18T00:00:00.000Z",
      startedAt: "2026-08-18T00:00:00.000Z",
      completedAt: "2026-08-18T00:01:00.000Z",
      assistantMessageId: null,
    },
    seenCompletionTurnId: input.seenCompletionTurnId ?? null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: "2026-08-18T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hiddenFromThreadList: input.hiddenFromThreadList ?? false,
  };
  return {
    projectIds: [],
    projectById: {},
    threadIds: [threadId],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    sidebarThreadSummaryById: { [threadId]: summary },
    unreadCompletionTurnIdByThreadId:
      summary.archivedAt === null &&
      summary.hiddenFromThreadList !== true &&
      summary.seenCompletionTurnId !== turnId
        ? { [threadId]: turnId }
        : {},
    completionAttentionSequence: 7,
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
    bootstrapComplete: input.bootstrapComplete ?? true,
  };
}

function setEnvironmentStates(states: Record<string, EnvironmentState>) {
  useStore.setState({ environmentStateById: states });
}

async function flushBadgeSync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

async function flushBadgeMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function installAuthoritativeBadgeSync(
  environmentIsAuthoritative: (environmentId: EnvironmentId) => boolean = () => true,
) {
  installPwaAppBadgeSync({ isEnvironmentAuthoritative: environmentIsAuthoritative });
}

beforeEach(() => {
  __resetPwaAppBadgeSyncForTests();
  useStore.setState(initialStoreState, true);
});

afterEach(() => {
  __resetPwaAppBadgeSyncForTests();
  useStore.setState(initialStoreState, true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("canUseAppBadge", () => {
  it("requires setAppBadge support", () => {
    expect(canUseAppBadge({ setAppBadge: vi.fn() })).toBe(true);
    expect(canUseAppBadge({ clearAppBadge: vi.fn() })).toBe(false);
    expect(canUseAppBadge(null)).toBe(false);
  });
});

describe("writeAppBadgeCount", () => {
  it("sets positive counts and clears zero", async () => {
    const navigatorLike = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    };

    await expect(writeAppBadgeCount(2.8, navigatorLike)).resolves.toBe(true);
    await expect(writeAppBadgeCount(0, navigatorLike)).resolves.toBe(true);

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(2);
    expect(navigatorLike.clearAppBadge).toHaveBeenCalledTimes(1);
  });
});

describe("installPwaAppBadgeSync", () => {
  it("clears completion alerts instead of restoring unread state when the app opens", async () => {
    vi.useFakeTimers();
    const { navigatorLike, postMessage } = installBadgeGlobals(true, "visible");
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });

    installAuthoritativeBadgeSync();
    await flushBadgeMicrotasks();

    expect(navigatorLike.clearAppBadge).toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushBadgeMicrotasks();

    expect(postMessage).toHaveBeenCalledWith({
      type: "salchi.clear-turn-completion-notifications",
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "salchi.sync-unread-completions" }),
      expect.anything(),
    );
  });

  it("clears completion alerts when a backgrounded app becomes visible", async () => {
    const { documentLike, navigatorLike, postMessage, setVisibilityState } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });
    installAuthoritativeBadgeSync();
    await flushBadgeSync();
    navigatorLike.clearAppBadge.mockClear();
    postMessage.mockClear();

    setVisibilityState("visible");
    documentLike.dispatchEvent(new Event("visibilitychange"));
    await flushBadgeMicrotasks();

    expect(navigatorLike.clearAppBadge).toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("does not clear durable worker state before the server snapshot is ready", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({
        environmentId,
        bootstrapComplete: false,
      }),
    });

    installAuthoritativeBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "salchi.sync-displayed-notification-badge" }),
      [expect.anything()],
    );
  });

  it("sends authoritative unread state to the worker without racing its badge write", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });

    installAuthoritativeBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "salchi.sync-unread-completions",
        snapshots: [
          {
            environmentId,
            sequence: 7,
            completions: [{ threadId: ThreadId.make("thread-1"), completionId: "turn-1" }],
          },
        ],
        removedEnvironmentIds: [],
      }),
      [expect.anything()],
    );
  });

  it("clears the badge when the exact latest completion becomes seen", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });
    installAuthoritativeBadgeSync();
    await flushBadgeSync();

    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({
        environmentId,
        seenCompletionTurnId: TurnId.make("turn-1"),
      }),
    });
    await flushBadgeSync();

    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshots: [{ environmentId, sequence: 7, completions: [] }],
      }),
      [expect.anything()],
    );
  });

  it("aggregates environments and excludes archived or hidden threads", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const firstEnvironmentId = EnvironmentId.make("env-1");
    const secondEnvironmentId = EnvironmentId.make("env-2");
    const thirdEnvironmentId = EnvironmentId.make("env-3");
    setEnvironmentStates({
      [firstEnvironmentId]: makeEnvironmentState({ environmentId: firstEnvironmentId }),
      [secondEnvironmentId]: makeEnvironmentState({
        environmentId: secondEnvironmentId,
        threadId: ThreadId.make("thread-2"),
      }),
      [thirdEnvironmentId]: makeEnvironmentState({
        environmentId: thirdEnvironmentId,
        threadId: ThreadId.make("thread-3"),
        hiddenFromThreadList: true,
      }),
    });

    installAuthoritativeBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshots: expect.arrayContaining([
          expect.objectContaining({ environmentId: firstEnvironmentId }),
          expect.objectContaining({ environmentId: secondEnvironmentId }),
          expect.objectContaining({ environmentId: thirdEnvironmentId, completions: [] }),
        ]),
      }),
      [expect.anything()],
    );
  });

  it("does not rescan or rewrite badges for detail-only store updates", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-1");
    const environmentState = makeEnvironmentState({ environmentId });
    setEnvironmentStates({ [environmentId]: environmentState });
    installAuthoritativeBadgeSync();
    await flushBadgeSync();
    navigatorLike.setAppBadge.mockClear();
    postMessage.mockClear();

    setEnvironmentStates({
      [environmentId]: {
        ...environmentState,
        messageByThreadId: { [ThreadId.make("thread-1")]: {} },
      },
    });
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("sends disconnected snapshots safely because the worker compares sequences", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const connectedEnvironmentId = EnvironmentId.make("env-connected");
    const disconnectedEnvironmentId = EnvironmentId.make("env-disconnected");
    setEnvironmentStates({
      [connectedEnvironmentId]: makeEnvironmentState({
        environmentId: connectedEnvironmentId,
      }),
      [disconnectedEnvironmentId]: makeEnvironmentState({
        environmentId: disconnectedEnvironmentId,
        threadId: ThreadId.make("thread-disconnected"),
      }),
    });

    installAuthoritativeBadgeSync((environmentId) => environmentId === connectedEnvironmentId);
    await flushBadgeSync();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "salchi.sync-unread-completions",
        snapshots: [
          {
            environmentId: connectedEnvironmentId,
            sequence: 7,
            completions: [{ threadId: ThreadId.make("thread-1"), completionId: "turn-1" }],
          },
          {
            environmentId: disconnectedEnvironmentId,
            sequence: 7,
            completions: [
              { threadId: ThreadId.make("thread-disconnected"), completionId: "turn-1" },
            ],
          },
        ],
      }),
      [expect.anything()],
    );
    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();
  });

  it("allows callers to force a re-sync", async () => {
    const { navigatorLike, postMessage } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });
    installAuthoritativeBadgeSync();
    await flushBadgeSync();
    navigatorLike.setAppBadge.mockClear();
    postMessage.mockClear();

    resyncAppBadge();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to a direct badge write when the worker rejects synchronization", async () => {
    const { navigatorLike } = installBadgeGlobals(false);
    const environmentId = EnvironmentId.make("env-1");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });

    installAuthoritativeBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).toHaveBeenCalledWith(1);
  });

  it("does not directly overwrite another environment while it is still bootstrapping", async () => {
    const { navigatorLike } = installBadgeGlobals(false);
    const readyEnvironmentId = EnvironmentId.make("env-ready");
    const loadingEnvironmentId = EnvironmentId.make("env-loading");
    setEnvironmentStates({
      [readyEnvironmentId]: makeEnvironmentState({ environmentId: readyEnvironmentId }),
      [loadingEnvironmentId]: makeEnvironmentState({
        environmentId: loadingEnvironmentId,
        bootstrapComplete: false,
      }),
    });

    installAuthoritativeBadgeSync();
    await flushBadgeSync();

    expect(navigatorLike.setAppBadge).not.toHaveBeenCalled();
    expect(navigatorLike.clearAppBadge).not.toHaveBeenCalled();
  });

  it("drops durable worker state when an environment is removed", async () => {
    const { postMessage } = installBadgeGlobals();
    const environmentId = EnvironmentId.make("env-removed");
    setEnvironmentStates({
      [environmentId]: makeEnvironmentState({ environmentId }),
    });
    installAuthoritativeBadgeSync();
    await flushBadgeSync();
    postMessage.mockClear();

    setEnvironmentStates({});
    await flushBadgeSync();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "salchi.sync-unread-completions",
        snapshots: [],
        removedEnvironmentIds: [environmentId],
      }),
      [expect.anything()],
    );
  });
});
