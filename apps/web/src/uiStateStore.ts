import { Debouncer } from "@tanstack/react-pacer";
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { create } from "zustand";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface PersistedUiState {
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  collapsedThreadKeys?: string[];
  threadLastVisitedAtById?: Record<string, string>;
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

export interface UiThreadState {
  threadExpandedById: Record<string, boolean>;
  threadLastVisitedAtById: Record<string, string>;
  seededThreadVisitedKeys: ReadonlySet<string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiState extends UiProjectState, UiThreadState, UiEndpointState {}

export interface SyncProjectInput {
  /** Physical project key (env + cwd). Used for manual sort order. */
  key: string;
  /** Logical group key. Used for expand/collapse state. */
  logicalKey: string;
  cwd: string;
}

export interface SyncThreadInput {
  key: string;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadExpandedById: {},
  threadLastVisitedAtById: {},
  seededThreadVisitedKeys: new Set<string>(),
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
};

const persistedCollapsedProjectCwds = new Set<string>();
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedProjectOrderCwdSet = new Set<string>();
// Pre-fix persisted shape only listed expanded cwds, so anything not listed
// was treated as collapsed. Track whether the loaded blob carried the new
// `collapsedProjectCwds` field so we can preserve that legacy semantic for
// one session after upgrade, until persistState rewrites in the new shape.
let persistedProjectStateUsesLegacyShape = false;
const currentProjectCwdById = new Map<string, string>();
const currentProjectCwdsByLogicalKey = new Map<string, string[]>();
const currentLogicalKeyByPhysicalKey = new Map<string, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    hydratePersistedProjectState(parsed);
    return {
      ...initialState,
      defaultAdvertisedEndpointKey:
        typeof parsed.defaultAdvertisedEndpointKey === "string" &&
        parsed.defaultAdvertisedEndpointKey.length > 0
          ? parsed.defaultAdvertisedEndpointKey
          : null,
      threadExpandedById: sanitizePersistedCollapsedThreadKeys(parsed.collapsedThreadKeys),
      threadLastVisitedAtById: sanitizePersistedThreadLastVisitedAt(parsed.threadLastVisitedAtById),
      threadChangedFilesExpandedById: sanitizePersistedThreadChangedFilesExpanded(
        parsed.threadChangedFilesExpandedById,
      ),
    };
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean" && expanded === false) {
        nextTurns[turnId] = false;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

function sanitizePersistedCollapsedThreadKeys(
  value: PersistedUiState["collapsedThreadKeys"],
): Record<string, boolean> {
  if (!Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    value.flatMap((threadKey) =>
      typeof threadKey === "string" && threadKey.length > 0 ? [[threadKey, false] as const] : [],
    ),
  );
}

function sanitizePersistedThreadLastVisitedAt(
  value: PersistedUiState["threadLastVisitedAtById"],
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([threadKey, lastVisitedAt]) =>
      threadKey.length > 0 &&
      typeof lastVisitedAt === "string" &&
      Number.isFinite(Date.parse(lastVisitedAt))
        ? [[threadKey, lastVisitedAt] as const]
        : [],
    ),
  );
}

export function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedCollapsedProjectCwds.clear();
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedProjectOrderCwdSet.clear();
  persistedProjectStateUsesLegacyShape = !Array.isArray(parsed.collapsedProjectCwds);
  for (const cwd of parsed.collapsedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedCollapsedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwdSet.has(cwd)) {
      persistedProjectOrderCwdSet.add(cwd);
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    // Persist collapsed cwds explicitly so an empty/missing field unambiguously
    // means "first install" rather than "user collapsed everything"; without
    // this, the syncProjects fallback would re-expand all rows on next launch.
    const collapsedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => !expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const collapsedThreadKeys = Object.entries(state.threadExpandedById).flatMap(
      ([threadKey, expanded]) => (expanded === false ? [threadKey] : []),
    );
    const threadLastVisitedAtById = Object.fromEntries(
      Object.entries(state.threadLastVisitedAtById).filter(
        ([threadKey]) => !state.seededThreadVisitedKeys.has(threadKey),
      ),
    );
    const threadChangedFilesExpandedById = Object.fromEntries(
      Object.entries(state.threadChangedFilesExpandedById).flatMap(([threadId, turns]) => {
        const nextTurns = Object.fromEntries(
          Object.entries(turns).filter(([, expanded]) => expanded === false),
        );
        return Object.keys(nextTurns).length > 0 ? [[threadId, nextTurns]] : [];
      }),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        collapsedProjectCwds,
        expandedProjectCwds,
        collapsedThreadKeys,
        threadLastVisitedAtById,
        projectOrderCwds,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        threadChangedFilesExpandedById,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function isTimestampAfter(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  if (Number.isNaN(leftMs)) {
    return false;
  }
  const rightMs = Date.parse(right);
  return Number.isNaN(rightMs) || leftMs > rightMs;
}

function withoutSeededThreadVisitedKey(
  state: UiState,
  threadId: string,
): ReadonlySet<string> | null {
  if (!state.seededThreadVisitedKeys.has(threadId)) {
    return null;
  }
  const nextSeededThreadVisitedKeys = new Set(state.seededThreadVisitedKeys);
  nextSeededThreadVisitedKeys.delete(threadId);
  return nextSeededThreadVisitedKeys;
}

function projectOrdersEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

function nestedBooleanRecordsEqual(
  left: Record<string, Record<string, boolean>>,
  right: Record<string, Record<string, boolean>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (!(key in right) || !recordsEqual(value, right[key]!)) {
      return false;
    }
  }
  return true;
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousLogicalKeyByPhysicalKey = new Map(currentLogicalKeyByPhysicalKey);
  currentProjectCwdById.clear();
  currentLogicalKeyByPhysicalKey.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.key, project.cwd);
    currentLogicalKeyByPhysicalKey.set(project.key, project.logicalKey);
  }
  currentProjectCwdsByLogicalKey.clear();
  const currentProjectCwdSetsByLogicalKey = new Map<string, Set<string>>();
  for (const project of projects) {
    const cwds = currentProjectCwdsByLogicalKey.get(project.logicalKey);
    if (cwds) {
      let cwdSet = currentProjectCwdSetsByLogicalKey.get(project.logicalKey);
      if (!cwdSet) {
        cwdSet = new Set(cwds);
        currentProjectCwdSetsByLogicalKey.set(project.logicalKey, cwdSet);
      }
      if (!cwdSet.has(project.cwd)) {
        cwdSet.add(project.cwd);
        cwds.push(project.cwd);
      }
    } else {
      currentProjectCwdsByLogicalKey.set(project.logicalKey, [project.cwd]);
      currentProjectCwdSetsByLogicalKey.set(project.logicalKey, new Set([project.cwd]));
    }
  }
  // Build reverse map: for each new logical key, which previous logical keys
  // did its member projects live under? Lets us preserve expand state when a
  // project's logical key changes (e.g. late-arriving repo metadata flips the
  // group identity).
  const previousLogicalKeysByNewLogicalKey = new Map<string, Set<string>>();
  for (const project of projects) {
    const previousLogicalKey = previousLogicalKeyByPhysicalKey.get(project.key);
    if (!previousLogicalKey || previousLogicalKey === project.logicalKey) {
      continue;
    }
    const set = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
    if (set) {
      set.add(previousLogicalKey);
    } else {
      previousLogicalKeysByNewLogicalKey.set(project.logicalKey, new Set([previousLogicalKey]));
    }
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.key) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    if (!(project.logicalKey in nextExpandedById)) {
      const groupCwds = currentProjectCwdsByLogicalKey.get(project.logicalKey) ?? [project.cwd];
      const fallbackFromPreviousLogicalKey = (() => {
        const previousKeys = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
        if (!previousKeys) {
          return undefined;
        }
        for (const previousKey of previousKeys) {
          if (previousKey in previousExpandedById) {
            return previousExpandedById[previousKey];
          }
        }
        return undefined;
      })();
      const fallbackFromPersistedShape = (() => {
        if (groupCwds.some((cwd) => persistedExpandedProjectCwds.has(cwd))) {
          return true;
        }
        if (groupCwds.some((cwd) => persistedCollapsedProjectCwds.has(cwd))) {
          return false;
        }
        if (persistedProjectStateUsesLegacyShape && persistedExpandedProjectCwds.size > 0) {
          return false;
        }
        return true;
      })();
      const expanded =
        previousExpandedById[project.logicalKey] ??
        fallbackFromPreviousLogicalKey ??
        fallbackFromPersistedShape;
      nextExpandedById[project.logicalKey] = expanded;
    }
    return {
      id: project.key,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const currentProjectIds = new Set(mappedProjects.map((project) => project.id));
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<string>();
          const orderedProjectIds: string[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (currentProjectIds.has(projectId) ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
  };
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.key));
  const syncedEnvironmentIds = new Set<string>();
  for (const thread of threads) {
    const parsedThreadKey = parseScopedThreadKey(thread.key);
    if (parsedThreadKey) {
      syncedEnvironmentIds.add(parsedThreadKey.environmentId);
    }
  }
  const shouldRetainThreadUiEntry = (threadId: string): boolean => {
    if (retainedThreadIds.has(threadId)) {
      return true;
    }
    const parsedThreadKey = parseScopedThreadKey(threadId);
    if (!parsedThreadKey) {
      return false;
    }
    return !syncedEnvironmentIds.has(parsedThreadKey.environmentId);
  };
  const nextThreadExpandedById = Object.fromEntries(
    Object.entries(state.threadExpandedById).filter(
      ([threadId, expanded]) => expanded === false && shouldRetainThreadUiEntry(threadId),
    ),
  );
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) =>
      shouldRetainThreadUiEntry(threadId),
    ),
  );
  const nextSeededThreadVisitedKeys = new Set(
    [...state.seededThreadVisitedKeys].filter((threadId) => shouldRetainThreadUiEntry(threadId)),
  );
  for (const thread of threads) {
    const seedVisitedAt = thread.seedVisitedAt;
    if (seedVisitedAt === undefined || seedVisitedAt.length === 0) {
      continue;
    }

    const previousVisitedAt = nextThreadLastVisitedAtById[thread.key];
    if (previousVisitedAt === undefined) {
      nextThreadLastVisitedAtById[thread.key] = seedVisitedAt;
      nextSeededThreadVisitedKeys.add(thread.key);
    } else if (
      nextSeededThreadVisitedKeys.has(thread.key) &&
      isTimestampAfter(seedVisitedAt, previousVisitedAt)
    ) {
      nextThreadLastVisitedAtById[thread.key] = seedVisitedAt;
    }
  }
  const nextThreadChangedFilesExpandedById = Object.fromEntries(
    Object.entries(state.threadChangedFilesExpandedById).filter(([threadId]) =>
      shouldRetainThreadUiEntry(threadId),
    ),
  );
  if (
    recordsEqual(state.threadExpandedById, nextThreadExpandedById) &&
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    setsEqual(state.seededThreadVisitedKeys, nextSeededThreadVisitedKeys) &&
    nestedBooleanRecordsEqual(
      state.threadChangedFilesExpandedById,
      nextThreadChangedFilesExpandedById,
    )
  ) {
    return state;
  }
  return {
    ...state,
    threadExpandedById: nextThreadExpandedById,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    seededThreadVisitedKeys: nextSeededThreadVisitedKeys,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
  };
}

export function markThreadVisited(state: UiState, threadId: string, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    const nextSeededThreadVisitedKeys = withoutSeededThreadVisitedKey(state, threadId);
    if (nextSeededThreadVisitedKeys) {
      return {
        ...state,
        seededThreadVisitedKeys: nextSeededThreadVisitedKeys,
      };
    }
    return state;
  }
  const nextSeededThreadVisitedKeys = withoutSeededThreadVisitedKey(state, threadId);
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
    seededThreadVisitedKeys: nextSeededThreadVisitedKeys ?? state.seededThreadVisitedKeys,
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  const nextSeededThreadVisitedKeys = withoutSeededThreadVisitedKey(state, threadId);
  if (!latestTurnCompletedAt) {
    if (nextSeededThreadVisitedKeys) {
      return {
        ...state,
        seededThreadVisitedKeys: nextSeededThreadVisitedKeys,
      };
    }
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    if (nextSeededThreadVisitedKeys) {
      return {
        ...state,
        seededThreadVisitedKeys: nextSeededThreadVisitedKeys,
      };
    }
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    if (nextSeededThreadVisitedKeys) {
      return {
        ...state,
        seededThreadVisitedKeys: nextSeededThreadVisitedKeys,
      };
    }
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
    seededThreadVisitedKeys: nextSeededThreadVisitedKeys ?? state.seededThreadVisitedKeys,
  };
}

export function clearThreadUi(state: UiState, threadId: string): UiState {
  const hasExpandedState = threadId in state.threadExpandedById;
  const hasVisitedState = threadId in state.threadLastVisitedAtById;
  const hasSeededState = state.seededThreadVisitedKeys.has(threadId);
  const hasChangedFilesState = threadId in state.threadChangedFilesExpandedById;
  if (!hasExpandedState && !hasVisitedState && !hasSeededState && !hasChangedFilesState) {
    return state;
  }
  const nextThreadExpandedById = { ...state.threadExpandedById };
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  const nextSeededThreadVisitedKeys = new Set(state.seededThreadVisitedKeys);
  const nextThreadChangedFilesExpandedById = { ...state.threadChangedFilesExpandedById };
  delete nextThreadExpandedById[threadId];
  delete nextThreadLastVisitedAtById[threadId];
  nextSeededThreadVisitedKeys.delete(threadId);
  delete nextThreadChangedFilesExpandedById[threadId];
  return {
    ...state,
    threadExpandedById: nextThreadExpandedById,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    seededThreadVisitedKeys: nextSeededThreadVisitedKeys,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
  };
}

export function toggleThreadExpanded(state: UiState, threadId: string): UiState {
  const expanded = state.threadExpandedById[threadId] ?? true;
  return setThreadExpanded(state, threadId, !expanded);
}

export function setThreadExpanded(state: UiState, threadId: string, expanded: boolean): UiState {
  if ((state.threadExpandedById[threadId] ?? true) === expanded) {
    return state;
  }

  if (expanded) {
    const nextThreadExpandedById = { ...state.threadExpandedById };
    delete nextThreadExpandedById[threadId];
    return {
      ...state,
      threadExpandedById: nextThreadExpandedById,
    };
  }

  return {
    ...state,
    threadExpandedById: {
      ...state.threadExpandedById,
      [threadId]: false,
    },
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[turnId] ?? true;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded) {
    if (!(turnId in currentThreadState)) {
      return state;
    }

    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[turnId];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadChangedFilesExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadChangedFilesExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadChangedFilesExpandedById: {
        ...state.threadChangedFilesExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: false,
      },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function toggleProject(state: UiState, projectId: string): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(state: UiState, projectId: string, expanded: boolean): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = state.projectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...state.projectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  markThreadVisited: (threadId: string, visitedAt?: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  clearThreadUi: (threadId: string) => void;
  toggleThreadExpanded: (threadId: string) => void;
  setThreadExpanded: (threadId: string, expanded: boolean) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  toggleProject: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  reorderProjects: (
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  toggleThreadExpanded: (threadId) => set((state) => toggleThreadExpanded(state, threadId)),
  setThreadExpanded: (threadId, expanded) =>
    set((state) => setThreadExpanded(state, threadId, expanded)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectIds, targetProjectIds) =>
    set((state) => reorderProjects(state, draggedProjectIds, targetProjectIds)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
