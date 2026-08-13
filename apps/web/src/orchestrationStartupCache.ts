import type { EnvironmentId, ProjectId, ThreadId } from "@salchi/contracts";

import type { EnvironmentState } from "./store";
import { clearPersistedStartupThreadTargetForEnvironment } from "./startupNavigation";
import { hasEnvironmentThreadDetailContent } from "./threadDetailContent";
import {
  clearIndexedDbCachedEnvironmentStates,
  removeIndexedDbCachedEnvironmentState,
  writeIndexedDbCachedEnvironmentState,
} from "./orchestrationStartupCacheIndexedDb";

const STORAGE_KEY = "salchi:orchestration-startup-cache:v1";
const DOCUMENT_VERSION = 1;
const MAX_CACHED_ENVIRONMENTS = 8;
const MAX_CACHED_PROJECTS = 250;
const MAX_LOCAL_CACHED_SHELL_THREADS = 100;
const MAX_CACHED_DETAIL_THREADS = 12;
const MAX_CACHED_THREAD_MESSAGES = 800;
const MAX_CACHED_THREAD_ACTIVITIES = 400;
const MAX_CACHED_THREAD_PROPOSED_PLANS = 100;
const MAX_CACHED_THREAD_DIFFS = 250;
const MAX_CACHE_DOCUMENT_CHARS = 2_000_000;
const WRITE_DEBOUNCE_MS = 500;
const WRITE_IDLE_TIMEOUT_MS = 2_000;
const DETAIL_THREAD_CACHE_CAP_LADDER = [MAX_CACHED_DETAIL_THREADS, 6, 3, 1] as const;
const SHELL_THREAD_CACHE_CAP_LADDER = [MAX_LOCAL_CACHED_SHELL_THREADS, 50, 20, 0] as const;

interface CachedThreadDetailLimits {
  readonly messages: number;
  readonly queuedTurns: number;
  readonly activities: number;
  readonly proposedPlans: number;
  readonly turnDiffs: number;
}

const DEFAULT_CACHED_THREAD_DETAIL_LIMITS: CachedThreadDetailLimits = {
  messages: MAX_CACHED_THREAD_MESSAGES,
  queuedTurns: MAX_CACHED_THREAD_MESSAGES,
  activities: MAX_CACHED_THREAD_ACTIVITIES,
  proposedPlans: MAX_CACHED_THREAD_PROPOSED_PLANS,
  turnDiffs: MAX_CACHED_THREAD_DIFFS,
};

/**
 * A single coding conversation can exceed the whole startup-cache budget through message text or
 * tool activity payloads. Preserve progressively smaller recent tails for the preferred thread
 * before falling back to a shell-only cache.
 */
const COMPACT_CACHED_THREAD_DETAIL_LIMITS = [
  { messages: 200, queuedTurns: 100, activities: 100, proposedPlans: 25, turnDiffs: 50 },
  { messages: 50, queuedTurns: 25, activities: 25, proposedPlans: 10, turnDiffs: 10 },
  { messages: 20, queuedTurns: 5, activities: 5, proposedPlans: 3, turnDiffs: 3 },
  { messages: 5, queuedTurns: 1, activities: 0, proposedPlans: 1, turnDiffs: 1 },
  { messages: 1, queuedTurns: 0, activities: 0, proposedPlans: 0, turnDiffs: 0 },
] as const satisfies readonly CachedThreadDetailLimits[];
const MINIMAL_CACHED_THREAD_DETAIL_LIMITS =
  COMPACT_CACHED_THREAD_DETAIL_LIMITS[COMPACT_CACHED_THREAD_DETAIL_LIMITS.length - 1]!;

interface CachedEnvironmentEntry {
  readonly updatedAt: string;
  readonly shellRevision: string | null;
  readonly shellComplete: boolean;
  readonly state: EnvironmentState;
}

interface CachedOrchestrationDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly environments: Record<string, CachedEnvironmentEntry>;
}

export interface CachedEnvironmentStateEntry {
  readonly environmentId: EnvironmentId;
  readonly updatedAt: string;
  readonly shellRevision: string | null;
  readonly shellComplete: boolean;
  readonly state: EnvironmentState;
}

interface PendingEnvironmentWrite {
  state: EnvironmentState;
  readonly preferredThreadIds: Set<ThreadId>;
  preserveCachedShell: boolean;
  readonly removedProjectIds: Set<ProjectId>;
  readonly removedThreadIds: Set<ThreadId>;
  timeoutId: ReturnType<typeof setTimeout> | null;
  idleCallbackId: number | null;
}

export interface CachedEnvironmentStateWriteOptions {
  readonly preferredThreadIds?: readonly ThreadId[];
  /**
   * Detail can arrive before the authoritative shell. In that case, retain cached shell entities
   * that are absent from the detail-only state unless an accompanying tombstone removes them.
   */
  readonly preserveCachedShell?: boolean;
  readonly removedProjectIds?: readonly ProjectId[];
  readonly removedThreadIds?: readonly ThreadId[];
}

interface StartupCachePersistenceTargets {
  readonly documentTarget?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  > | null;
  readonly windowTarget?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

const pendingWrites = new Map<EnvironmentId, PendingEnvironmentWrite>();
let cacheRevisionCounter = 0;
let memoizedDocument: {
  readonly raw: string | null;
  readonly document: CachedOrchestrationDocument;
} | null = null;

function invalidateDocumentMemo(): void {
  memoizedDocument = null;
}

function createCacheRevision(updatedAt: string): string {
  cacheRevisionCounter += 1;
  return `${updatedAt}:${cacheRevisionCounter.toString(36)}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isEnvironmentStateLike(value: unknown): value is EnvironmentState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isStringArray(value.projectIds) &&
    isRecord(value.projectById) &&
    isStringArray(value.threadIds) &&
    isRecord(value.threadIdsByProjectId) &&
    isRecord(value.threadShellById) &&
    isRecord(value.threadSessionById) &&
    isRecord(value.threadTurnStateById) &&
    isRecord(value.messageIdsByThreadId) &&
    isRecord(value.messageByThreadId) &&
    (value.queuedTurnIdsByThreadId === undefined || isRecord(value.queuedTurnIdsByThreadId)) &&
    (value.queuedTurnByThreadId === undefined || isRecord(value.queuedTurnByThreadId)) &&
    isRecord(value.activityIdsByThreadId) &&
    isRecord(value.activityByThreadId) &&
    isRecord(value.proposedPlanIdsByThreadId) &&
    isRecord(value.proposedPlanByThreadId) &&
    isRecord(value.turnDiffIdsByThreadId) &&
    isRecord(value.turnDiffSummaryByThreadId) &&
    (value.threadDetailPageInfoByThreadId === undefined ||
      isRecord(value.threadDetailPageInfoByThreadId)) &&
    (value.lastAppliedEventSequenceByThreadId === undefined ||
      isRecord(value.lastAppliedEventSequenceByThreadId)) &&
    (value.lastAppliedEventIdByThreadId === undefined ||
      isRecord(value.lastAppliedEventIdByThreadId)) &&
    isRecord(value.sidebarThreadSummaryById)
  );
}

function emptyDocument(): CachedOrchestrationDocument {
  return {
    version: DOCUMENT_VERSION,
    environments: {},
  };
}

function readDocument(): CachedOrchestrationDocument {
  const resolvedStorage = storage();
  if (!resolvedStorage) {
    return emptyDocument();
  }

  try {
    const raw = resolvedStorage.getItem(STORAGE_KEY);
    if (memoizedDocument?.raw === raw) {
      return memoizedDocument.document;
    }

    if (!raw) {
      const document = emptyDocument();
      memoizedDocument = { raw, document };
      return document;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== DOCUMENT_VERSION ||
      !isRecord(parsed.environments)
    ) {
      const document = emptyDocument();
      memoizedDocument = { raw, document };
      return document;
    }

    const environments: Record<string, CachedEnvironmentEntry> = {};
    for (const [environmentId, entry] of Object.entries(parsed.environments)) {
      if (!isRecord(entry) || typeof entry.updatedAt !== "string") {
        continue;
      }
      const state = decodeCachedEnvironmentState(entry.state);
      if (!state) {
        continue;
      }
      environments[environmentId] = {
        updatedAt: entry.updatedAt,
        // Legacy records used updatedAt as the implicit shared revision.
        shellRevision: Object.prototype.hasOwnProperty.call(entry, "shellRevision")
          ? typeof entry.shellRevision === "string"
            ? entry.shellRevision
            : null
          : entry.updatedAt,
        shellComplete: entry.shellComplete === true,
        state,
      };
    }

    const document: CachedOrchestrationDocument = {
      version: DOCUMENT_VERSION,
      environments,
    };
    memoizedDocument = { raw, document };
    return document;
  } catch {
    const document = emptyDocument();
    memoizedDocument = { raw: null, document };
    return document;
  }
}

function removeOldestEnvironment(
  document: CachedOrchestrationDocument,
  options: { readonly excludeEnvironmentId?: EnvironmentId } = {},
): CachedOrchestrationDocument | null {
  const entries = Object.entries(document.environments).filter(
    ([environmentId]) => environmentId !== options.excludeEnvironmentId,
  );
  if (entries.length === 0) {
    return null;
  }

  const [oldestEnvironmentId] = entries.toSorted(([, left], [, right]) =>
    left.updatedAt.localeCompare(right.updatedAt),
  )[0]!;
  const { [oldestEnvironmentId]: _removed, ...environments } = document.environments;
  return {
    version: DOCUMENT_VERSION,
    environments,
  };
}

function tryPersistDocument(document: CachedOrchestrationDocument): boolean {
  const resolvedStorage = storage();
  if (!resolvedStorage) {
    return false;
  }

  const encoded = JSON.stringify(document);
  if (encoded.length > MAX_CACHE_DOCUMENT_CHARS) {
    return false;
  }

  try {
    resolvedStorage.setItem(STORAGE_KEY, encoded);
    invalidateDocumentMemo();
    return true;
  } catch {
    return false;
  }
}

function writeDocument(document: CachedOrchestrationDocument): void {
  tryPersistDocument(document);
}

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function pickThreadRecord<T>(
  record: Record<ThreadId, T>,
  retainedThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  const nextRecord: Record<string, T> = {};
  for (const threadId of retainedThreadIds) {
    if (hasOwn(record, threadId)) {
      nextRecord[threadId] = record[threadId] as T;
    }
  }
  return nextRecord as Record<ThreadId, T>;
}

function compareThreadUpdatedAt(state: EnvironmentState, left: ThreadId, right: ThreadId): number {
  const leftUpdatedAt = state.threadShellById[left]?.updatedAt ?? "";
  const rightUpdatedAt = state.threadShellById[right]?.updatedAt ?? "";
  return rightUpdatedAt.localeCompare(leftUpdatedAt) || right.localeCompare(left);
}

function retainOrderedThreadIds(
  state: EnvironmentState,
  preferredThreadIds: readonly ThreadId[],
  maxShellThreads: number,
) {
  const shellThreadIds = state.threadIds.filter((threadId) => state.threadShellById[threadId]);
  const retained = new Set<ThreadId>();

  for (const threadId of preferredThreadIds) {
    if (state.threadShellById[threadId]) {
      retained.add(threadId);
    }
  }

  for (const threadId of [...shellThreadIds].toSorted((left, right) =>
    compareThreadUpdatedAt(state, left, right),
  )) {
    if (retained.size >= maxShellThreads) {
      break;
    }
    retained.add(threadId);
  }

  return shellThreadIds.filter((threadId) => retained.has(threadId));
}

function retainDetailThreadIds(
  state: EnvironmentState,
  retainedThreadIds: readonly ThreadId[],
  preferredThreadIds: readonly ThreadId[],
  maxDetailThreads: number,
): Set<ThreadId> {
  if (maxDetailThreads <= 0) {
    return new Set();
  }

  const retainedThreadIdSet = new Set(retainedThreadIds);
  const detailThreadIds = retainedThreadIds.filter((threadId) =>
    hasEnvironmentThreadDetailContent(state, threadId),
  );
  const retained = new Set<ThreadId>();

  for (const threadId of preferredThreadIds) {
    if (retained.size >= maxDetailThreads) {
      break;
    }
    if (retainedThreadIdSet.has(threadId) && hasEnvironmentThreadDetailContent(state, threadId)) {
      retained.add(threadId);
    }
  }

  for (const threadId of [...detailThreadIds].toSorted((left, right) =>
    compareThreadUpdatedAt(state, left, right),
  )) {
    if (retained.size >= maxDetailThreads) {
      break;
    }
    retained.add(threadId);
  }

  return retained;
}

function retainProjectState(
  state: EnvironmentState,
  retainedThreadIds: readonly ThreadId[],
  maxProjects: number,
): Pick<EnvironmentState, "projectIds" | "projectById"> {
  const referencedProjectIds = new Set(
    retainedThreadIds.flatMap((threadId) => {
      const projectId = state.threadShellById[threadId]?.projectId;
      return projectId ? [projectId] : [];
    }),
  );
  const orderedProjectIds: ProjectId[] = [];
  const appendProjectId = (projectId: ProjectId) => {
    if (!state.projectById[projectId] || orderedProjectIds.includes(projectId)) {
      return;
    }
    orderedProjectIds.push(projectId);
  };

  for (const projectId of state.projectIds) {
    if (referencedProjectIds.has(projectId)) {
      appendProjectId(projectId);
    }
  }
  for (const projectId of state.projectIds) {
    if (orderedProjectIds.length >= maxProjects) {
      break;
    }
    appendProjectId(projectId);
  }

  return {
    projectIds: orderedProjectIds,
    projectById: Object.fromEntries(
      orderedProjectIds.map((projectId) => [projectId, state.projectById[projectId]] as const),
    ) as EnvironmentState["projectById"],
  };
}

function rebuildThreadIdsByProjectId(
  state: EnvironmentState,
  retainedThreadIds: readonly ThreadId[],
): Record<ProjectId, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const threadId of retainedThreadIds) {
    const projectId = state.threadShellById[threadId]?.projectId;
    if (!projectId) {
      continue;
    }
    threadIdsByProjectId[projectId] = [...(threadIdsByProjectId[projectId] ?? []), threadId];
  }
  return threadIdsByProjectId as Record<ProjectId, ThreadId[]>;
}

function appendMissingIds<Id extends string>(
  existingIds: readonly Id[],
  incomingIds: readonly Id[],
): Id[] {
  const mergedIds = [...existingIds];
  const seen = new Set<Id>(existingIds);
  for (const id of incomingIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedIds.push(id);
  }
  return mergedIds;
}

/**
 * Detail subscriptions can update the active conversation before the shell snapshot has
 * populated projects and inactive threads. An explicitly detail-only write must enrich the
 * existing cache, not replace its complete sidebar shell with the partial store state.
 */
function mergeDetailStateWithCachedShell(
  state: EnvironmentState,
  cachedState: EnvironmentState | null,
  options: Pick<
    CachedEnvironmentStateWriteOptions,
    "preserveCachedShell" | "removedProjectIds" | "removedThreadIds"
  >,
): EnvironmentState {
  if (!options.preserveCachedShell || cachedState === null) {
    return state;
  }

  const removedProjectIds = new Set(options.removedProjectIds ?? []);
  const removedThreadIds = new Set(options.removedThreadIds ?? []);
  const cachedProjectIds = cachedState.projectIds.filter(
    (projectId) => !removedProjectIds.has(projectId),
  );
  const cachedThreadIds = cachedState.threadIds.filter((threadId) => {
    if (removedThreadIds.has(threadId)) {
      return false;
    }
    const projectId = cachedState.threadShellById[threadId]?.projectId;
    return projectId === undefined || !removedProjectIds.has(projectId);
  });
  const projectIds = appendMissingIds(
    cachedProjectIds,
    state.projectIds.filter((projectId) => !removedProjectIds.has(projectId)),
  );
  const threadIds = appendMissingIds(
    cachedThreadIds,
    state.threadIds.filter((threadId) => {
      if (removedThreadIds.has(threadId)) {
        return false;
      }
      const projectId = state.threadShellById[threadId]?.projectId;
      return projectId === undefined || !removedProjectIds.has(projectId);
    }),
  );
  const mergedState: EnvironmentState = {
    ...cachedState,
    ...state,
    projectIds,
    projectById: {
      ...cachedState.projectById,
      ...state.projectById,
    },
    threadIds,
    threadShellById: {
      ...cachedState.threadShellById,
      ...state.threadShellById,
    },
    threadSessionById: {
      ...cachedState.threadSessionById,
      ...state.threadSessionById,
    },
    threadTurnStateById: {
      ...cachedState.threadTurnStateById,
      ...state.threadTurnStateById,
    },
    messageIdsByThreadId: {
      ...cachedState.messageIdsByThreadId,
      ...state.messageIdsByThreadId,
    },
    messageByThreadId: {
      ...cachedState.messageByThreadId,
      ...state.messageByThreadId,
    },
    queuedTurnIdsByThreadId: {
      ...cachedState.queuedTurnIdsByThreadId,
      ...state.queuedTurnIdsByThreadId,
    },
    queuedTurnByThreadId: {
      ...cachedState.queuedTurnByThreadId,
      ...state.queuedTurnByThreadId,
    },
    activityIdsByThreadId: {
      ...cachedState.activityIdsByThreadId,
      ...state.activityIdsByThreadId,
    },
    activityByThreadId: {
      ...cachedState.activityByThreadId,
      ...state.activityByThreadId,
    },
    proposedPlanIdsByThreadId: {
      ...cachedState.proposedPlanIdsByThreadId,
      ...state.proposedPlanIdsByThreadId,
    },
    proposedPlanByThreadId: {
      ...cachedState.proposedPlanByThreadId,
      ...state.proposedPlanByThreadId,
    },
    turnDiffIdsByThreadId: {
      ...cachedState.turnDiffIdsByThreadId,
      ...state.turnDiffIdsByThreadId,
    },
    turnDiffSummaryByThreadId: {
      ...cachedState.turnDiffSummaryByThreadId,
      ...state.turnDiffSummaryByThreadId,
    },
    threadDetailPageInfoByThreadId: {
      ...cachedState.threadDetailPageInfoByThreadId,
      ...state.threadDetailPageInfoByThreadId,
    },
    lastAppliedEventSequenceByThreadId: {
      ...cachedState.lastAppliedEventSequenceByThreadId,
      ...state.lastAppliedEventSequenceByThreadId,
    },
    lastAppliedEventIdByThreadId: {
      ...cachedState.lastAppliedEventIdByThreadId,
      ...state.lastAppliedEventIdByThreadId,
    },
    sidebarThreadSummaryById: {
      ...cachedState.sidebarThreadSummaryById,
      ...state.sidebarThreadSummaryById,
    },
    bootstrapComplete: false,
  };

  return {
    ...mergedState,
    threadIdsByProjectId: rebuildThreadIdsByProjectId(mergedState, threadIds),
  };
}

function isTransientCachedSession(
  session: EnvironmentState["threadSessionById"][ThreadId] | null | undefined,
): boolean {
  return (
    session?.status === "connecting" ||
    session?.status === "running" ||
    session?.orchestrationStatus === "starting" ||
    session?.orchestrationStatus === "running" ||
    (session?.activeTurnId !== undefined && session.activeTurnId !== null)
  );
}

function isTransientCachedTurn(
  turnState: EnvironmentState["threadTurnStateById"][ThreadId] | undefined,
): boolean {
  return turnState?.latestTurn?.state === "running" && turnState.latestTurn.completedAt === null;
}

/**
 * A runtime can finish while an installed PWA is suspended or terminated. Persisting a running
 * session as durable startup truth makes that thread appear to work forever until the socket has
 * reconciled it. Cached conversations remain useful, but active runtime state must be confirmed by
 * the server after every process start.
 */
function stripTransientRuntimeState(state: EnvironmentState): EnvironmentState {
  const threadSessionById = { ...state.threadSessionById };
  const threadTurnStateById = { ...state.threadTurnStateById };
  const sidebarThreadSummaryById = { ...state.sidebarThreadSummaryById };
  let changed = false;

  for (const threadId of state.threadIds) {
    if (isTransientCachedSession(threadSessionById[threadId])) {
      threadSessionById[threadId] = null;
      changed = true;
    }
    if (isTransientCachedTurn(threadTurnStateById[threadId])) {
      threadTurnStateById[threadId] = {
        ...threadTurnStateById[threadId],
        latestTurn: null,
      };
      changed = true;
    }

    const summary = sidebarThreadSummaryById[threadId];
    if (!summary) {
      continue;
    }
    const stripSession = isTransientCachedSession(summary.session);
    const stripTurn =
      summary.latestTurn?.state === "running" && summary.latestTurn.completedAt === null;
    if (!stripSession && !stripTurn) {
      continue;
    }
    sidebarThreadSummaryById[threadId] = {
      ...summary,
      ...(stripSession ? { session: null } : {}),
      ...(stripTurn ? { latestTurn: null } : {}),
    };
    changed = true;
  }

  return changed
    ? {
        ...state,
        threadSessionById,
        threadTurnStateById,
        sidebarThreadSummaryById,
      }
    : state;
}

function retainThreadItemRecord<T>(
  idsByThreadId: Record<ThreadId, string[]>,
  byThreadId: Record<ThreadId, Record<string, T>>,
  detailThreadIds: ReadonlySet<ThreadId>,
  maxItems: number,
): {
  idsByThreadId: Record<ThreadId, string[]>;
  byThreadId: Record<ThreadId, Record<string, T>>;
} {
  const nextIdsByThreadId: Record<string, string[]> = {};
  const nextByThreadId: Record<string, Record<string, T>> = {};

  if (maxItems <= 0) {
    return {
      idsByThreadId: nextIdsByThreadId as Record<ThreadId, string[]>,
      byThreadId: nextByThreadId as Record<ThreadId, Record<string, T>>,
    };
  }

  for (const threadId of detailThreadIds) {
    const ids = (idsByThreadId[threadId] ?? []).slice(-maxItems);
    const byId = byThreadId[threadId];
    if (ids.length === 0 || !byId) {
      continue;
    }
    nextIdsByThreadId[threadId] = ids;
    const nextById: Record<string, T> = {};
    for (const id of ids) {
      if (hasOwn(byId, id)) {
        nextById[id] = byId[id] as T;
      }
    }
    nextByThreadId[threadId] = nextById;
  }

  return {
    idsByThreadId: nextIdsByThreadId as Record<ThreadId, string[]>,
    byThreadId: nextByThreadId as Record<ThreadId, Record<string, T>>,
  };
}

function retainTurnDiffRecords(
  state: EnvironmentState,
  detailThreadIds: ReadonlySet<ThreadId>,
  maxItems: number,
): Pick<EnvironmentState, "turnDiffIdsByThreadId" | "turnDiffSummaryByThreadId"> {
  const turnDiffIdsByThreadId: Record<string, EnvironmentState["turnDiffIdsByThreadId"][ThreadId]> =
    {};
  const turnDiffSummaryByThreadId: Record<
    string,
    EnvironmentState["turnDiffSummaryByThreadId"][ThreadId]
  > = {};

  if (maxItems <= 0) {
    return {
      turnDiffIdsByThreadId: turnDiffIdsByThreadId as EnvironmentState["turnDiffIdsByThreadId"],
      turnDiffSummaryByThreadId:
        turnDiffSummaryByThreadId as EnvironmentState["turnDiffSummaryByThreadId"],
    };
  }

  for (const threadId of detailThreadIds) {
    const ids = (state.turnDiffIdsByThreadId[threadId] ?? []).slice(-maxItems);
    const byId = state.turnDiffSummaryByThreadId[threadId];
    if (ids.length === 0 || !byId) {
      continue;
    }
    turnDiffIdsByThreadId[threadId] = ids;
    turnDiffSummaryByThreadId[threadId] = Object.fromEntries(
      ids.flatMap((id) => (hasOwn(byId, id) ? [[id, byId[id]] as const] : [])),
    ) as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId];
  }

  return {
    turnDiffIdsByThreadId: turnDiffIdsByThreadId as EnvironmentState["turnDiffIdsByThreadId"],
    turnDiffSummaryByThreadId:
      turnDiffSummaryByThreadId as EnvironmentState["turnDiffSummaryByThreadId"],
  };
}

function createCachedEnvironmentState(
  state: EnvironmentState,
  preferredThreadIds: readonly ThreadId[],
  options: {
    readonly maxDetailThreads?: number;
    readonly maxShellThreads?: number;
    readonly maxProjects?: number;
    readonly detailLimits?: CachedThreadDetailLimits;
  } = {},
): EnvironmentState {
  const maxDetailThreads = options.maxDetailThreads ?? MAX_CACHED_DETAIL_THREADS;
  const maxShellThreads = options.maxShellThreads ?? MAX_LOCAL_CACHED_SHELL_THREADS;
  const maxProjects = options.maxProjects ?? MAX_CACHED_PROJECTS;
  const detailLimits = options.detailLimits ?? DEFAULT_CACHED_THREAD_DETAIL_LIMITS;
  const retainedThreadIds = retainOrderedThreadIds(state, preferredThreadIds, maxShellThreads);
  const retainedThreadIdSet = new Set(retainedThreadIds);
  const detailThreadIds = retainDetailThreadIds(
    state,
    retainedThreadIds,
    preferredThreadIds,
    maxDetailThreads,
  );
  const projectState = retainProjectState(state, retainedThreadIds, maxProjects);
  const messageState = retainThreadItemRecord(
    state.messageIdsByThreadId,
    state.messageByThreadId,
    detailThreadIds,
    detailLimits.messages,
  );
  const queuedTurnState = retainThreadItemRecord(
    state.queuedTurnIdsByThreadId,
    state.queuedTurnByThreadId,
    detailThreadIds,
    detailLimits.queuedTurns,
  );
  const activityState = retainThreadItemRecord(
    state.activityIdsByThreadId,
    state.activityByThreadId,
    detailThreadIds,
    detailLimits.activities,
  );
  const proposedPlanState = retainThreadItemRecord(
    state.proposedPlanIdsByThreadId,
    state.proposedPlanByThreadId,
    detailThreadIds,
    detailLimits.proposedPlans,
  );
  const turnDiffState = retainTurnDiffRecords(state, detailThreadIds, detailLimits.turnDiffs);

  return stripTransientRuntimeState({
    ...projectState,
    threadIds: retainedThreadIds,
    threadIdsByProjectId: rebuildThreadIdsByProjectId(state, retainedThreadIds),
    threadShellById: pickThreadRecord(state.threadShellById, retainedThreadIdSet),
    threadSessionById: pickThreadRecord(state.threadSessionById, retainedThreadIdSet),
    threadTurnStateById: pickThreadRecord(state.threadTurnStateById, retainedThreadIdSet),
    messageIdsByThreadId: messageState.idsByThreadId as EnvironmentState["messageIdsByThreadId"],
    messageByThreadId: messageState.byThreadId as EnvironmentState["messageByThreadId"],
    queuedTurnIdsByThreadId:
      queuedTurnState.idsByThreadId as EnvironmentState["queuedTurnIdsByThreadId"],
    queuedTurnByThreadId: queuedTurnState.byThreadId as EnvironmentState["queuedTurnByThreadId"],
    activityIdsByThreadId: activityState.idsByThreadId as EnvironmentState["activityIdsByThreadId"],
    activityByThreadId: activityState.byThreadId as EnvironmentState["activityByThreadId"],
    proposedPlanIdsByThreadId:
      proposedPlanState.idsByThreadId as EnvironmentState["proposedPlanIdsByThreadId"],
    proposedPlanByThreadId:
      proposedPlanState.byThreadId as EnvironmentState["proposedPlanByThreadId"],
    ...turnDiffState,
    threadDetailPageInfoByThreadId: pickThreadRecord(
      state.threadDetailPageInfoByThreadId,
      detailThreadIds,
    ),
    lastAppliedEventSequenceByThreadId: pickThreadRecord(
      state.lastAppliedEventSequenceByThreadId ?? {},
      retainedThreadIdSet,
    ),
    lastAppliedEventIdByThreadId: pickThreadRecord(
      state.lastAppliedEventIdByThreadId ?? {},
      retainedThreadIdSet,
    ),
    sidebarThreadSummaryById: pickThreadRecord(state.sidebarThreadSummaryById, retainedThreadIdSet),
    bootstrapComplete: false,
  });
}

function hasCompleteShellCoverage(source: EnvironmentState, cached: EnvironmentState): boolean {
  const sourceProjectIds = source.projectIds.filter((projectId) => source.projectById[projectId]);
  const sourceThreadIds = source.threadIds.filter((threadId) => source.threadShellById[threadId]);
  return (
    cached.projectIds.length === sourceProjectIds.length &&
    cached.threadIds.length === sourceThreadIds.length &&
    sourceProjectIds.every((projectId) => cached.projectById[projectId] !== undefined) &&
    sourceThreadIds.every((threadId) => cached.threadShellById[threadId] !== undefined)
  );
}

function retainNewestEnvironments(
  environments: Record<string, CachedEnvironmentEntry>,
): Record<string, CachedEnvironmentEntry> {
  return Object.fromEntries(
    Object.entries(environments)
      .toSorted(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_CACHED_ENVIRONMENTS),
  );
}

function prepareCachedEnvironmentStateForHydration(state: EnvironmentState): EnvironmentState {
  return stripTransientRuntimeState({
    ...state,
    queuedTurnIdsByThreadId: state.queuedTurnIdsByThreadId ?? {},
    queuedTurnByThreadId: state.queuedTurnByThreadId ?? {},
    lastAppliedEventSequenceByThreadId: state.lastAppliedEventSequenceByThreadId ?? {},
    lastAppliedEventIdByThreadId: state.lastAppliedEventIdByThreadId ?? {},
    bootstrapComplete: false,
  });
}

export function decodeCachedEnvironmentState(value: unknown): EnvironmentState | null {
  return isEnvironmentStateLike(value) ? prepareCachedEnvironmentStateForHydration(value) : null;
}

export function readCachedEnvironmentState(environmentId: EnvironmentId): EnvironmentState | null {
  const cached = readDocument().environments[environmentId];
  return cached ? prepareCachedEnvironmentStateForHydration(cached.state) : null;
}

export function readCachedEnvironmentStateEntries(): readonly CachedEnvironmentStateEntry[] {
  return Object.entries(readDocument().environments)
    .toSorted(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
    .map(([environmentId, cached]) => ({
      environmentId: environmentId as EnvironmentId,
      updatedAt: cached.updatedAt,
      shellRevision: cached.shellRevision,
      shellComplete: cached.shellComplete,
      state: prepareCachedEnvironmentStateForHydration(cached.state),
    }));
}

export function writeCachedEnvironmentState(
  environmentId: EnvironmentId,
  state: EnvironmentState,
  options: CachedEnvironmentStateWriteOptions = {},
): void {
  const document = readDocument();
  const updatedAt = new Date().toISOString();
  const cachedEntry = document.environments[environmentId] ?? null;
  const cachedState = cachedEntry?.state ?? null;
  const cachedDetailThreadIds = cachedState
    ? cachedState.threadIds
        .filter((threadId) => hasEnvironmentThreadDetailContent(cachedState, threadId))
        .toSorted((left, right) => compareThreadUpdatedAt(cachedState, left, right))
    : [];
  const preferredThreadIds = appendMissingIds(
    options.preferredThreadIds ?? [],
    cachedDetailThreadIds,
  );
  const stateForWrite = mergeDetailStateWithCachedShell(state, cachedState, options);
  const durableState = createCachedEnvironmentState(stateForWrite, preferredThreadIds, {
    maxShellThreads: Number.POSITIVE_INFINITY,
    maxProjects: Number.POSITIVE_INFINITY,
  });
  // Shell-stream writes are complete. Detail-stream writes can also safely advance the durable
  // shell when they are enriching a local shell that was known to be complete before compaction.
  const canProduceCompleteShell =
    state.bootstrapComplete ||
    options.preserveCachedShell !== true ||
    cachedEntry?.shellComplete === true;
  const hasShellTombstones =
    (options.removedProjectIds?.length ?? 0) > 0 || (options.removedThreadIds?.length ?? 0) > 0;
  const shellRevision = canProduceCompleteShell
    ? createCacheRevision(updatedAt)
    : hasShellTombstones
      ? null
      : (cachedEntry?.shellRevision ?? null);
  const durableShellState = canProduceCompleteShell
    ? createCachedEnvironmentState(durableState, [], {
        maxDetailThreads: 0,
        maxShellThreads: Number.POSITIVE_INFINITY,
        maxProjects: Number.POSITIVE_INFINITY,
      })
    : null;
  void writeIndexedDbCachedEnvironmentState({
    environmentId,
    updatedAt,
    state: durableState,
    ...(shellRevision !== null && durableShellState !== null
      ? {
          shellRevision,
          shellUpdatedAt: updatedAt,
          shellState: durableShellState,
        }
      : {}),
  });
  const createDocument = (limits: {
    readonly maxDetailThreads: number;
    readonly maxShellThreads?: number;
    readonly detailLimits?: CachedThreadDetailLimits;
  }): CachedOrchestrationDocument => {
    const cachedEnvironmentState = createCachedEnvironmentState(
      stateForWrite,
      preferredThreadIds,
      limits,
    );
    return {
      version: DOCUMENT_VERSION,
      environments: retainNewestEnvironments({
        ...document.environments,
        [environmentId]: {
          updatedAt,
          shellRevision,
          shellComplete:
            canProduceCompleteShell &&
            hasCompleteShellCoverage(stateForWrite, cachedEnvironmentState),
          state: cachedEnvironmentState,
        },
      }),
    };
  };
  const retainOnlyCurrentEnvironment = (
    nextDocument: CachedOrchestrationDocument,
  ): CachedOrchestrationDocument => ({
    version: DOCUMENT_VERSION,
    environments: {
      [environmentId]: nextDocument.environments[environmentId]!,
    },
  });
  const stripOtherEnvironmentDetail = (
    nextDocument: CachedOrchestrationDocument,
  ): CachedOrchestrationDocument => ({
    version: DOCUMENT_VERSION,
    environments: Object.fromEntries(
      Object.entries(nextDocument.environments).map(([cachedEnvironmentId, entry]) => [
        cachedEnvironmentId,
        cachedEnvironmentId === environmentId
          ? entry
          : {
              ...entry,
              state: createCachedEnvironmentState(entry.state, [], { maxDetailThreads: 0 }),
            },
      ]),
    ),
  });

  const availableDetailThreadCount = stateForWrite.threadIds.filter((threadId) =>
    hasEnvironmentThreadDetailContent(stateForWrite, threadId),
  ).length;
  const detailThreadCaps = [
    ...new Set(
      DETAIL_THREAD_CACHE_CAP_LADDER.map((maxDetailThreads) =>
        Math.min(maxDetailThreads, availableDetailThreadCount),
      ),
    ),
  ].filter((maxDetailThreads) => maxDetailThreads > 0);
  const detailedDocuments: CachedOrchestrationDocument[] = [];

  for (const maxDetailThreads of detailThreadCaps) {
    const nextDocument = createDocument({ maxDetailThreads });
    detailedDocuments.push(nextDocument);
    if (tryPersistDocument(nextDocument)) {
      return;
    }
  }

  if (availableDetailThreadCount > 0) {
    for (const detailLimits of COMPACT_CACHED_THREAD_DETAIL_LIMITS) {
      const compactPreferredDetailDocument = createDocument({
        maxDetailThreads: 1,
        detailLimits,
      });
      detailedDocuments.push(compactPreferredDetailDocument);
      if (tryPersistDocument(compactPreferredDetailDocument)) {
        return;
      }
    }
  }

  // Under document or browser quota pressure, detail from the conversation the user is opening is
  // more useful than detail from another environment. Keep every environment's projects and
  // sidebar threads while reducing only their conversation detail.
  if (Object.keys(document.environments).some((cachedId) => cachedId !== environmentId)) {
    for (const detailedDocument of detailedDocuments) {
      if (tryPersistDocument(stripOtherEnvironmentDetail(detailedDocument))) {
        return;
      }
    }
  }

  const shellOnlyDocument = createDocument({ maxDetailThreads: 0 });
  if (tryPersistDocument(shellOnlyDocument)) {
    return;
  }

  const allEnvironmentShellDocument = stripOtherEnvironmentDetail(shellOnlyDocument);
  if (tryPersistDocument(allEnvironmentShellDocument)) {
    return;
  }

  let nextDocument: CachedOrchestrationDocument | null = allEnvironmentShellDocument;
  while (nextDocument !== null) {
    nextDocument = removeOldestEnvironment(nextDocument, { excludeEnvironmentId: environmentId });
    if (nextDocument === null) {
      break;
    }
    if (tryPersistDocument(nextDocument)) {
      return;
    }
  }

  // A large shell can still exceed the document or browser quota after detail and older
  // environments have been removed. Keep every project plus progressively fewer recent thread
  // rows, instead of silently leaving a previous detail-only document with no sidebar projects.
  for (const maxShellThreads of SHELL_THREAD_CACHE_CAP_LADDER.slice(1)) {
    for (const maxDetailThreads of [1, 0] as const) {
      const compactCurrentEnvironment = retainOnlyCurrentEnvironment(
        createDocument({
          maxDetailThreads,
          maxShellThreads,
          detailLimits: MINIMAL_CACHED_THREAD_DETAIL_LIMITS,
        }),
      );
      if (tryPersistDocument(compactCurrentEnvironment)) {
        return;
      }
    }
  }
}

export function scheduleCachedEnvironmentStateWrite(
  environmentId: EnvironmentId,
  state: EnvironmentState,
  options: CachedEnvironmentStateWriteOptions = {},
): void {
  if (!storage() && typeof indexedDB === "undefined") {
    return;
  }

  const pending = pendingWrites.get(environmentId) ?? {
    state,
    preferredThreadIds: new Set<ThreadId>(),
    preserveCachedShell: false,
    removedProjectIds: new Set<ProjectId>(),
    removedThreadIds: new Set<ThreadId>(),
    timeoutId: null,
    idleCallbackId: null,
  };
  pending.state = state;
  pending.preserveCachedShell = options.preserveCachedShell ?? false;
  pending.removedProjectIds.clear();
  for (const projectId of options.removedProjectIds ?? []) {
    pending.removedProjectIds.add(projectId);
  }
  pending.removedThreadIds.clear();
  for (const threadId of options.removedThreadIds ?? []) {
    pending.removedThreadIds.add(threadId);
  }
  for (const threadId of options.preferredThreadIds ?? []) {
    pending.preferredThreadIds.add(threadId);
  }
  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId);
  }
  if (pending.idleCallbackId !== null && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(pending.idleCallbackId);
    pending.idleCallbackId = null;
  }
  pending.timeoutId = setTimeout(() => {
    pending.timeoutId = null;
    const persist = () => {
      pending.idleCallbackId = null;
      if (pendingWrites.get(environmentId) !== pending) {
        return;
      }
      pendingWrites.delete(environmentId);
      writeCachedEnvironmentState(environmentId, pending.state, {
        preferredThreadIds: [...pending.preferredThreadIds],
        preserveCachedShell: pending.preserveCachedShell,
        removedProjectIds: [...pending.removedProjectIds],
        removedThreadIds: [...pending.removedThreadIds],
      });
    };
    if (typeof requestIdleCallback === "function") {
      pending.idleCallbackId = requestIdleCallback(persist, {
        timeout: WRITE_IDLE_TIMEOUT_MS,
      });
    } else {
      persist();
    }
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(environmentId, pending);
}

export function flushPendingCachedEnvironmentStateWrite(environmentId: EnvironmentId): void {
  const pending = pendingWrites.get(environmentId);
  if (!pending) {
    return;
  }
  pendingWrites.delete(environmentId);
  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId);
    pending.timeoutId = null;
  }
  if (pending.idleCallbackId !== null && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(pending.idleCallbackId);
    pending.idleCallbackId = null;
  }
  writeCachedEnvironmentState(environmentId, pending.state, {
    preferredThreadIds: [...pending.preferredThreadIds],
    preserveCachedShell: pending.preserveCachedShell,
    removedProjectIds: [...pending.removedProjectIds],
    removedThreadIds: [...pending.removedThreadIds],
  });
}

export function flushPendingCachedEnvironmentStateWrites(): void {
  for (const environmentId of pendingWrites.keys()) {
    flushPendingCachedEnvironmentStateWrite(environmentId);
  }
}

export function installOrchestrationStartupCachePersistence(
  targets: StartupCachePersistenceTargets = {},
): () => void {
  const documentTarget =
    targets.documentTarget ?? (typeof document === "undefined" ? null : document);
  const windowTarget = targets.windowTarget ?? (typeof window === "undefined" ? null : window);
  const handleVisibilityChange = () => {
    // On mobile, hidden is the last lifecycle transition reliably delivered before the OS can
    // suspend or kill an installed PWA. Persist synchronously while the current detail is intact.
    if (documentTarget?.visibilityState === "hidden") {
      flushPendingCachedEnvironmentStateWrites();
    }
  };
  const handlePageHide = () => {
    flushPendingCachedEnvironmentStateWrites();
  };

  documentTarget?.addEventListener("visibilitychange", handleVisibilityChange);
  windowTarget?.addEventListener("pagehide", handlePageHide);

  return () => {
    documentTarget?.removeEventListener("visibilitychange", handleVisibilityChange);
    windowTarget?.removeEventListener("pagehide", handlePageHide);
  };
}

export function removeCachedEnvironmentState(environmentId: EnvironmentId): void {
  clearPersistedStartupThreadTargetForEnvironment(environmentId);
  void removeIndexedDbCachedEnvironmentState(environmentId);
  const pending = pendingWrites.get(environmentId);
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  if (pending && pending.idleCallbackId !== null && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(pending.idleCallbackId);
  }
  pendingWrites.delete(environmentId);

  const document = readDocument();
  if (!document.environments[environmentId]) {
    return;
  }

  const { [environmentId]: _removed, ...environments } = document.environments;
  writeDocument({
    version: DOCUMENT_VERSION,
    environments,
  });
  invalidateDocumentMemo();
}

export function clearOrchestrationStartupCacheForTests(): void {
  for (const pending of pendingWrites.values()) {
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
    }
    if (pending.idleCallbackId !== null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(pending.idleCallbackId);
    }
  }
  pendingWrites.clear();
  storage()?.removeItem(STORAGE_KEY);
  invalidateDocumentMemo();
}

export async function clearOrchestrationStartupCacheDurableForTests(): Promise<void> {
  clearOrchestrationStartupCacheForTests();
  await clearIndexedDbCachedEnvironmentStates();
}

export const ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY = STORAGE_KEY;
