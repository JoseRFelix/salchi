import { ProjectId, ThreadId } from "@salchi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearThreadUi,
  hydratePersistedProjectState,
  markThreadVisited,
  markThreadUnread,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  reorderProjects,
  setDefaultAdvertisedEndpointKey,
  setProjectExpanded,
  setThreadExpanded,
  setThreadChangedFilesExpanded,
  syncProjects,
  syncThreads,
  toggleThreadExpanded,
  type UiState,
} from "./uiStateStore";
import { hasUnseenCompletion } from "./threadCompletion";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadExpandedById: {},
    threadLastVisitedAtById: {},
    seededThreadVisitedKeys: new Set<string>(),
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("markThreadVisited stores the provided server timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(next.seededThreadVisitedKeys.has(threadId)).toBe(false);
  });

  it("markThreadVisited does not move visit state backwards under clock skew", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:30:00.700Z",
      },
    });

    const next = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next).toBe(initialState);
  });

  it("markThreadVisited un-seeds a thread even when the visit timestamp does not move forward", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:30:00.700Z",
      },
      seededThreadVisitedKeys: new Set([threadId]),
    });

    const next = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(next.seededThreadVisitedKeys.has(threadId)).toBe(false);
  });

  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const threadId = ThreadId.make("thread-1");
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, latestTurnCompletedAt);

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
    expect(next.seededThreadVisitedKeys.has(threadId)).toBe(false);
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, null);

    expect(next).toBe(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const initialState = makeUiState({
      projectOrder: [project1, project2, project3],
    });

    const next = reorderProjects(initialState, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("reorderProjects is a no-op when dragged key is not in projectOrder", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const initialState = makeUiState({
      projectOrder: [project1, project2],
    });

    const next = reorderProjects(initialState, [ProjectId.make("missing")], [project2]);

    expect(next).toBe(initialState);
  });

  it("setDefaultAdvertisedEndpointKey stores endpoint preference by stable key", () => {
    const initialState = makeUiState();

    const next = setDefaultAdvertisedEndpointKey(initialState, "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });

  it("reorderProjects moves all member keys of a multi-member group together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyB, keyC],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("reorderProjects handles member keys scattered across projectOrder", () => {
    const keyALocal = "env-local:proj-a";
    const keyB = "env-local:proj-b";
    const keyARemote = "env-remote:proj-a";
    const keyC = "env-local:proj-c";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyB, keyARemote, keyC],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("reorderProjects places group after target when dragged from before a non-last target", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const keyD = "env-local:proj-d";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyB, keyC, keyD],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote, keyD]);
  });

  it("reorderProjects places group before target when dragged from after", () => {
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const initialState = makeUiState({
      projectOrder: [keyB, keyC, keyALocal, keyARemote],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyB]);

    expect(next.projectOrder).toEqual([keyALocal, keyARemote, keyB, keyC]);
  });

  it("reorderProjects with multi-member target inserts after first target occurrence", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyBLocal = "env-local:proj-b";
    const keyBRemote = "env-remote:proj-b";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyBLocal, keyBRemote],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyBLocal, keyBRemote]);

    // Target members may become non-contiguous; this is fine because the
    // sidebar groups by logical key using first-occurrence positioning.
    expect(next.projectOrder).toEqual([keyBLocal, keyALocal, keyARemote, keyBRemote]);
  });

  it("reorderProjects is a no-op when dragged group equals target group", () => {
    const key1 = "env-local:proj-a";
    const key2 = "env-remote:proj-a";
    const initialState = makeUiState({
      projectOrder: [key1, key2, "env-local:proj-b"],
    });

    const next = reorderProjects(initialState, [key1, key2], [key1, key2]);

    expect(next).toBe(initialState);
  });

  it("reorderProjects is a no-op when dragged keys are not in projectOrder", () => {
    const initialState = makeUiState({
      projectOrder: ["env-local:proj-a", "env-local:proj-b"],
    });

    const next = reorderProjects(initialState, ["env-local:missing"], ["env-local:proj-b"]);

    expect(next).toBe(initialState);
  });

  it("syncProjects preserves current project order during snapshot recovery", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
        [project2]: false,
      },
      projectOrder: [project2, project1],
    });

    const next = syncProjects(initialState, [
      { key: project1, logicalKey: project1, cwd: "/tmp/project-1" },
      { key: project2, logicalKey: project2, cwd: "/tmp/project-2" },
      { key: project3, logicalKey: project3, cwd: "/tmp/project-3" },
    ]);

    expect(next.projectOrder).toEqual([project2, project1, project3]);
    expect(next.projectExpandedById[project2]).toBe(false);
  });

  it("syncProjects preserves manual order across project id churn at the same cwd", () => {
    // Under the current design, physical key and logical key are both
    // cwd-derived, so an internal project-id change doesn't alter the store
    // keys. This test locks in that stability: re-syncing the same cwds keeps
    // manual order and collapse state.
    const keyProject1 = "env-local:/tmp/project-1";
    const keyProject2 = "env-local:/tmp/project-2";
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [keyProject1]: true,
          [keyProject2]: false,
        },
        projectOrder: [keyProject2, keyProject1],
      }),
      [
        { key: keyProject1, logicalKey: keyProject1, cwd: "/tmp/project-1" },
        { key: keyProject2, logicalKey: keyProject2, cwd: "/tmp/project-2" },
      ],
    );

    const next = syncProjects(initialState, [
      { key: keyProject1, logicalKey: keyProject1, cwd: "/tmp/project-1" },
      { key: keyProject2, logicalKey: keyProject2, cwd: "/tmp/project-2" },
    ]);

    expect(next.projectOrder).toEqual([keyProject2, keyProject1]);
    expect(next.projectExpandedById[keyProject2]).toBe(false);
  });

  it("syncProjects returns a new state when only project cwd changes", () => {
    const project1 = ProjectId.make("project-1");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [project1]: false,
        },
        projectOrder: [project1],
      }),
      [{ key: project1, logicalKey: project1, cwd: "/tmp/project-1" }],
    );

    const next = syncProjects(initialState, [
      { key: project1, logicalKey: project1, cwd: "/tmp/project-1-renamed" },
    ]);

    expect(next).not.toBe(initialState);
    expect(next.projectOrder).toEqual([project1]);
    expect(next.projectExpandedById[project1]).toBe(false);
  });

  it("syncProjects keys projectExpandedById by the logical key, not the physical key", () => {
    // In repository grouping mode, multiple physical projects (different
    // environments or different repo-relative paths) collapse into one
    // logical group. The group's expand state must be keyed by the logical
    // key so clicks on the grouped row toggle the shared state, and so the
    // state survives subsequent syncProjects calls (which rebuild the map
    // from incoming inputs).
    const physicalLocal = "env-local:/repo/project";
    const physicalRemote = "env-remote:/repo/project";
    const logicalKey = "repo-canonical-key";

    const initial = syncProjects(makeUiState(), [
      { key: physicalLocal, logicalKey, cwd: "/repo/project" },
      { key: physicalRemote, logicalKey, cwd: "/repo/project" },
    ]);

    expect(initial.projectExpandedById).toEqual({ [logicalKey]: true });

    const afterCollapse = { ...initial, projectExpandedById: { [logicalKey]: false } };
    const next = syncProjects(afterCollapse, [
      { key: physicalLocal, logicalKey, cwd: "/repo/project" },
      { key: physicalRemote, logicalKey, cwd: "/repo/project" },
    ]);

    expect(next.projectExpandedById[logicalKey]).toBe(false);
  });

  it("syncProjects preserves expand state when a project's logical key changes", () => {
    // Example: late-arriving repo metadata flips grouping identity from the
    // physical key to a canonical repository key. The row did not actually
    // change, so the user's collapse choice must carry over.
    const physicalKey = "env-local:/repo/project";
    const previousLogicalKey = physicalKey;
    const nextLogicalKey = "repo-canonical-key";

    const initial = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: previousLogicalKey, cwd: "/repo/project" },
    ]);

    expect(initial.projectExpandedById[previousLogicalKey]).toBe(true);

    const afterCollapse = {
      ...initial,
      projectExpandedById: { [previousLogicalKey]: false },
    };
    const next = syncProjects(afterCollapse, [
      { key: physicalKey, logicalKey: nextLogicalKey, cwd: "/repo/project" },
    ]);

    expect(next.projectExpandedById[nextLogicalKey]).toBe(false);
  });

  it("syncThreads prunes missing thread UI state", () => {
    const thread1 = ThreadId.make("thread-1");
    const thread2 = ThreadId.make("thread-2");
    const initialState = makeUiState({
      threadExpandedById: {
        [thread1]: false,
        [thread2]: false,
      },
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
        [thread2]: "2026-02-25T12:36:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
        [thread2]: {
          "turn-2": false,
        },
      },
    });

    const next = syncThreads(initialState, [{ key: thread1 }]);

    expect(next.threadExpandedById).toEqual({
      [thread1]: false,
    });
    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(next.seededThreadVisitedKeys).toEqual(new Set());
    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
  });

  it("syncThreads prunes only synced environments for scoped thread UI state", () => {
    const envARetained = "envA:thread-retained";
    const envADropped = "envA:thread-dropped";
    const envBRetained = "envB:thread-retained";
    const initialState = makeUiState({
      threadExpandedById: {
        [envARetained]: false,
        [envADropped]: false,
        [envBRetained]: false,
      },
      threadLastVisitedAtById: {
        [envARetained]: "2026-02-25T12:35:00.000Z",
        [envADropped]: "2026-02-25T12:36:00.000Z",
        [envBRetained]: "2026-02-25T12:37:00.000Z",
      },
      seededThreadVisitedKeys: new Set([envARetained, envADropped, envBRetained]),
      threadChangedFilesExpandedById: {
        [envARetained]: {
          "turn-retained-a": false,
        },
        [envADropped]: {
          "turn-dropped-a": false,
        },
        [envBRetained]: {
          "turn-retained-b": false,
        },
      },
    });

    const next = syncThreads(initialState, [{ key: envARetained }]);

    expect(next.threadExpandedById).toEqual({
      [envARetained]: false,
      [envBRetained]: false,
    });
    expect(next.threadLastVisitedAtById).toEqual({
      [envARetained]: "2026-02-25T12:35:00.000Z",
      [envBRetained]: "2026-02-25T12:37:00.000Z",
    });
    expect(next.seededThreadVisitedKeys).toEqual(new Set([envARetained, envBRetained]));
    expect(next.threadChangedFilesExpandedById).toEqual({
      [envARetained]: {
        "turn-retained-a": false,
      },
      [envBRetained]: {
        "turn-retained-b": false,
      },
    });
  });

  it("syncThreads seeds visit state for unseen snapshot threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = syncThreads(initialState, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(next.seededThreadVisitedKeys).toEqual(new Set([thread1]));
  });

  it("syncThreads raises newer visit seeds while an entry is still seeded", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const seeded = syncThreads(initialState, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);
    const next = syncThreads(seeded, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:36:00.000Z",
      },
    ]);

    expect(next.threadLastVisitedAtById[thread1]).toBe("2026-02-25T12:36:00.000Z");
    expect(next.seededThreadVisitedKeys).toEqual(new Set([thread1]));
  });

  it("syncThreads does not lower older visit seeds", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const seeded = syncThreads(initialState, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);
    const next = syncThreads(seeded, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:34:00.000Z",
      },
    ]);

    expect(next).toBe(seeded);
    expect(next.threadLastVisitedAtById[thread1]).toBe("2026-02-25T12:35:00.000Z");
    expect(next.seededThreadVisitedKeys).toEqual(new Set([thread1]));
  });

  it("syncThreads does not overwrite a real visit after markThreadVisited un-seeds it", () => {
    const thread1 = ThreadId.make("thread-1");
    const seeded = syncThreads(makeUiState(), [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);
    const visited = markThreadVisited(seeded, thread1, "2026-02-25T12:35:30.000Z");

    const next = syncThreads(visited, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:36:00.000Z",
      },
    ]);

    expect(next).toBe(visited);
    expect(next.threadLastVisitedAtById[thread1]).toBe("2026-02-25T12:35:30.000Z");
    expect(next.seededThreadVisitedKeys).toEqual(new Set());
  });

  it("syncThreads does not bump restored real visits with snapshot seeds", () => {
    const thread1 = "envA:thread-1";
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:30.000Z",
      },
    });

    const next = syncThreads(initialState, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:36:00.000Z",
      },
    ]);

    expect(next).toBe(initialState);
    expect(next.threadLastVisitedAtById[thread1]).toBe("2026-02-25T12:35:30.000Z");
    expect(next.seededThreadVisitedKeys).toEqual(new Set());
    expect(
      hasUnseenCompletion({
        latestTurn: {
          completedAt: "2026-02-25T12:35:31.000Z",
        },
        lastVisitedAt: next.threadLastVisitedAtById[thread1],
      }),
    ).toBe(true);
  });

  it("markThreadUnread un-seeds a thread so newer seeds do not overwrite the unread marker", () => {
    const thread1 = ThreadId.make("thread-1");
    const seeded = syncThreads(makeUiState(), [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);
    const unread = markThreadUnread(seeded, thread1, "2026-02-25T12:35:30.000Z");

    const next = syncThreads(unread, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:36:00.000Z",
      },
    ]);

    expect(next).toBe(unread);
    expect(next.threadLastVisitedAtById[thread1]).toBe("2026-02-25T12:35:29.999Z");
    expect(next.seededThreadVisitedKeys).toEqual(new Set());
  });

  it("syncThreads prunes seeded markers for dropped threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const thread2 = ThreadId.make("thread-2");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
        [thread2]: "2026-02-25T12:36:00.000Z",
      },
      seededThreadVisitedKeys: new Set([thread1, thread2]),
    });

    const next = syncThreads(initialState, [{ key: thread1 }]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(next.seededThreadVisitedKeys).toEqual(new Set([thread1]));
  });

  it("setProjectExpanded updates expansion without touching order", () => {
    const project1 = ProjectId.make("project-1");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
      },
      projectOrder: [project1],
    });

    const next = setProjectExpanded(initialState, project1, false);

    expect(next.projectExpandedById[project1]).toBe(false);
    expect(next.projectOrder).toEqual([project1]);
  });

  it("toggleThreadExpanded stores collapsed thread groups as false overrides", () => {
    const thread1 = ThreadId.make("thread-1");
    const collapsed = toggleThreadExpanded(makeUiState(), thread1);

    expect(collapsed.threadExpandedById).toEqual({
      [thread1]: false,
    });

    const expanded = toggleThreadExpanded(collapsed, thread1);

    expect(expanded.threadExpandedById).toEqual({});
  });

  it("setThreadExpanded removes expanded thread overrides", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadExpandedById: {
        [thread1]: false,
      },
    });

    const next = setThreadExpanded(initialState, thread1, true);

    expect(next.threadExpandedById).toEqual({});
  });

  it("clearThreadUi removes visit state for deleted threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadExpandedById: {
        [thread1]: false,
      },
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
    });

    const next = clearThreadUi(initialState, thread1);

    expect(next.threadExpandedById).toEqual({});
    expect(next.threadLastVisitedAtById).toEqual({});
    expect(next.seededThreadVisitedKeys).toEqual(new Set());
    expect(next.threadChangedFilesExpandedById).toEqual({});
  });

  it("clearThreadUi removes seeded markers for deleted threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      seededThreadVisitedKeys: new Set([thread1]),
    });

    const next = clearThreadUi(initialState, thread1);

    expect(next.seededThreadVisitedKeys).toEqual(new Set());
  });

  it("setThreadChangedFilesExpanded stores collapsed turns per thread", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", false);

    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
  });

  it("setThreadChangedFilesExpanded removes thread overrides when expanded again", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
    });

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", true);

    expect(next.threadChangedFilesExpandedById).toEqual({});
  });
});

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

describe("uiStateStore persistence round-trip", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
    // Reset module-level persistence state so tests don't bleed into each other.
    hydratePersistedProjectState({ collapsedProjectCwds: [], expandedProjectCwds: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves all-collapsed project state across restart", () => {
    // Regression: pre-fix, persistState only wrote `expandedProjectCwds`, so
    // an empty array on rehydrate was indistinguishable from a fresh install
    // and the syncProjects fallback re-expanded every row.
    const projectA = { key: "kA", logicalKey: "kA", cwd: "/projA" };
    const projectB = { key: "kB", logicalKey: "kB", cwd: "/projB" };

    let state = syncProjects(makeUiState(), [projectA, projectB]);
    state = setProjectExpanded(state, projectA.key, false);
    state = setProjectExpanded(state, projectB.key, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB]);

    expect(rehydrated.projectExpandedById).toEqual({
      [projectA.key]: false,
      [projectB.key]: false,
    });
  });

  it("respects mixed expand state on rehydrate and defaults new projects to expanded", () => {
    const projectA = { key: "kA", logicalKey: "kA", cwd: "/projA" };
    const projectB = { key: "kB", logicalKey: "kB", cwd: "/projB" };
    const projectC = { key: "kC", logicalKey: "kC", cwd: "/projC" };

    let state = syncProjects(makeUiState(), [projectA, projectB]);
    state = setProjectExpanded(state, projectB.key, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB, projectC]);

    expect(rehydrated.projectExpandedById).toEqual({
      [projectA.key]: true,
      [projectB.key]: false,
      [projectC.key]: true,
    });
  });

  it("preserves legacy not-in-expanded-list = collapsed for one upgrade session", () => {
    // Pre-fix shape only stored expandedProjectCwds. Absence of
    // collapsedProjectCwds opts the session into the legacy fallback so
    // upgrade users do not see previously collapsed rows pop open.
    hydratePersistedProjectState({
      expandedProjectCwds: ["/projA"],
    });

    const rehydrated = syncProjects(makeUiState(), [
      { key: "kA", logicalKey: "kA", cwd: "/projA" },
      { key: "kB", logicalKey: "kB", cwd: "/projB" },
    ]);

    expect(rehydrated.projectExpandedById).toEqual({
      kA: true,
      kB: false,
    });
  });

  it("preserves manual project order across restart", () => {
    const projectA = { key: "kOrderA", logicalKey: "kOrderA", cwd: "/order-projA" };
    const projectB = { key: "kOrderB", logicalKey: "kOrderB", cwd: "/order-projB" };
    const projectC = { key: "kOrderC", logicalKey: "kOrderC", cwd: "/order-projC" };

    let state = syncProjects(makeUiState(), [projectA, projectB, projectC]);
    state = reorderProjects(state, [projectC.key], [projectA.key]);
    expect(state.projectOrder).toEqual([projectC.key, projectA.key, projectB.key]);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.projectOrderCwds).toEqual([projectC.cwd, projectA.cwd, projectB.cwd]);

    hydratePersistedProjectState(persisted);
    // Fresh state (empty projectOrder) so syncProjects derives order from
    // persistedProjectOrderCwds rather than the in-memory projectOrder branch.
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB, projectC]);

    expect(rehydrated.projectOrder).toEqual([projectC.key, projectA.key, projectB.key]);
  });

  it("persists the default advertised endpoint preference", () => {
    const state = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
  });

  it("persists collapsed thread groups across restart", async () => {
    const thread1 = ThreadId.make("thread-1");
    const state = setThreadExpanded(makeUiState(), thread1, false);

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(persisted.collapsedThreadKeys).toEqual([thread1]);

    expect(makeUiState().threadExpandedById).toEqual({});
    vi.resetModules();
    const { useUiStateStore } = await import("./uiStateStore");
    expect(useUiStateStore.getState().threadExpandedById).toEqual({ [thread1]: false });
  });

  it("persists only non-seeded thread visit entries", () => {
    const realVisitThread = "envA:thread-real";
    const seededVisitThread = "envA:thread-seeded";
    const state = makeUiState({
      threadLastVisitedAtById: {
        [realVisitThread]: "2026-02-25T12:35:00.000Z",
        [seededVisitThread]: "2026-02-25T12:36:00.000Z",
      },
      seededThreadVisitedKeys: new Set([seededVisitThread]),
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.threadLastVisitedAtById).toEqual({
      [realVisitThread]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("restores marked visited thread entries without seeded markers", async () => {
    const thread1 = "envA:thread-visited";
    const state = markThreadVisited(makeUiState(), thread1, "2026-02-25T12:35:00.000Z");

    persistState(state);

    vi.resetModules();
    const { useUiStateStore } = await import("./uiStateStore");
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(useUiStateStore.getState().seededThreadVisitedKeys).toEqual(new Set());
  });

  it("restores marked unread thread entries", async () => {
    const thread1 = "envA:thread-unread";
    const state = markThreadUnread(makeUiState(), thread1, "2026-02-25T12:35:00.000Z");

    persistState(state);

    vi.resetModules();
    const { useUiStateStore } = await import("./uiStateStore");
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:34:59.999Z",
    });
    expect(useUiStateStore.getState().seededThreadVisitedKeys).toEqual(new Set());
  });

  it("loads legacy blobs without thread visit state", async () => {
    localStorageStub.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        collapsedProjectCwds: [],
        expandedProjectCwds: [],
      } satisfies PersistedUiState),
    );

    vi.resetModules();
    const { useUiStateStore } = await import("./uiStateStore");
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
  });

  it("sanitizes persisted thread visit entries", async () => {
    localStorageStub.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        collapsedProjectCwds: [],
        expandedProjectCwds: [],
        threadLastVisitedAtById: {
          "": "2026-02-25T12:35:00.000Z",
          "envA:thread-valid": "2026-02-25T12:35:00.000Z",
          "envA:thread-bad-date": "not-a-date",
          "envA:thread-non-string": 123,
        },
      }),
    );

    vi.resetModules();
    const { useUiStateStore } = await import("./uiStateStore");
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({
      "envA:thread-valid": "2026-02-25T12:35:00.000Z",
    });
  });

  it("keeps restored thread visits for environments missing from the first sync", async () => {
    const envAThread = "envA:thread-1";
    const envBThread = "envB:thread-2";
    const state = makeUiState({
      threadLastVisitedAtById: {
        [envAThread]: "2026-02-25T12:35:00.000Z",
        [envBThread]: "2026-02-25T12:36:00.000Z",
      },
    });

    persistState(state);

    vi.resetModules();
    const { useUiStateStore } = await import("./uiStateStore");
    useUiStateStore.getState().syncThreads([{ key: envAThread }]);

    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({
      [envAThread]: "2026-02-25T12:35:00.000Z",
      [envBThread]: "2026-02-25T12:36:00.000Z",
    });
  });

  it("preserves expand state across restart when project's logical key changes", () => {
    // After restart, in-memory previousExpandedById is empty, so the
    // previousLogicalKey-to-state bridge in syncProjects cannot help. The
    // persisted-cwd fallback is the only mechanism that can carry collapse
    // state across a restart that also flips a project into a new logical
    // group (e.g. late-arriving repo metadata). This locks in that path.
    const physicalKey = "env-local:/lk-restart-proj";
    const previousLogicalKey = physicalKey;
    const cwd = "/lk-restart-proj";

    let state = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: previousLogicalKey, cwd },
    ]);
    state = setProjectExpanded(state, previousLogicalKey, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);

    const nextLogicalKey = "lk-restart-canonical";
    const rehydrated = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: nextLogicalKey, cwd },
    ]);

    expect(rehydrated.projectExpandedById[nextLogicalKey]).toBe(false);
  });
});
