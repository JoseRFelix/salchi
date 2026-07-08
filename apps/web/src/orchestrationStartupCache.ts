import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import type { EnvironmentState } from "./store";
import { hasEnvironmentThreadDetailContent } from "./threadDetailContent";

const STORAGE_KEY = "t3code:orchestration-startup-cache:v1";
const DOCUMENT_VERSION = 1;
const MAX_CACHED_ENVIRONMENTS = 8;
const MAX_CACHED_PROJECTS = 250;
const MAX_CACHED_SHELL_THREADS = 1_000;
const MAX_CACHED_DETAIL_THREADS = 12;
const MAX_CACHED_THREAD_MESSAGES = 800;
const MAX_CACHED_THREAD_ACTIVITIES = 400;
const MAX_CACHED_THREAD_PROPOSED_PLANS = 100;
const MAX_CACHED_THREAD_DIFFS = 250;
const MAX_CACHE_DOCUMENT_CHARS = 4_500_000;
const WRITE_DEBOUNCE_MS = 500;

interface CachedEnvironmentEntry {
  readonly updatedAt: string;
  readonly state: EnvironmentState;
}

interface CachedOrchestrationDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly environments: Record<string, CachedEnvironmentEntry>;
}

interface PendingEnvironmentWrite {
  state: EnvironmentState;
  readonly preferredThreadIds: Set<ThreadId>;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export interface CachedThreadDetail {
  readonly messageIds: EnvironmentState["messageIdsByThreadId"][ThreadId];
  readonly messageById: EnvironmentState["messageByThreadId"][ThreadId];
  readonly queuedTurnIds: EnvironmentState["queuedTurnIdsByThreadId"][ThreadId];
  readonly queuedTurnById: EnvironmentState["queuedTurnByThreadId"][ThreadId];
  readonly activityIds: EnvironmentState["activityIdsByThreadId"][ThreadId];
  readonly activityById: EnvironmentState["activityByThreadId"][ThreadId];
  readonly proposedPlanIds: EnvironmentState["proposedPlanIdsByThreadId"][ThreadId];
  readonly proposedPlanById: EnvironmentState["proposedPlanByThreadId"][ThreadId];
  readonly turnDiffIds: EnvironmentState["turnDiffIdsByThreadId"][ThreadId];
  readonly turnDiffSummaryById: EnvironmentState["turnDiffSummaryByThreadId"][ThreadId];
  readonly pageInfo: EnvironmentState["threadDetailPageInfoByThreadId"][ThreadId] | null;
}

const pendingWrites = new Map<EnvironmentId, PendingEnvironmentWrite>();
let memoizedDocument: {
  readonly raw: string | null;
  readonly document: CachedOrchestrationDocument;
} | null = null;

function invalidateDocumentMemo(): void {
  memoizedDocument = null;
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

function isEnvironmentStateLike(value: unknown): value is EnvironmentState {
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
      if (!isEnvironmentStateLike(entry.state)) {
        continue;
      }
      environments[environmentId] = {
        updatedAt: entry.updatedAt,
        state: {
          ...entry.state,
          threadDetailPageInfoByThreadId: isRecord(entry.state.threadDetailPageInfoByThreadId)
            ? entry.state.threadDetailPageInfoByThreadId
            : {},
          lastAppliedEventSequenceByThreadId: isRecord(
            entry.state.lastAppliedEventSequenceByThreadId,
          )
            ? (entry.state.lastAppliedEventSequenceByThreadId as Record<ThreadId, number>)
            : {},
          lastAppliedEventIdByThreadId: isRecord(entry.state.lastAppliedEventIdByThreadId)
            ? (entry.state.lastAppliedEventIdByThreadId as Record<ThreadId, string>)
            : {},
          bootstrapComplete: false,
        },
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
): CachedOrchestrationDocument | null {
  const entries = Object.entries(document.environments);
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

function writeDocument(document: CachedOrchestrationDocument): void {
  const resolvedStorage = storage();
  if (!resolvedStorage) {
    return;
  }

  let nextDocument: CachedOrchestrationDocument | null = document;
  while (nextDocument) {
    const encoded = JSON.stringify(nextDocument);
    if (encoded.length > MAX_CACHE_DOCUMENT_CHARS) {
      nextDocument = removeOldestEnvironment(nextDocument);
      continue;
    }

    try {
      resolvedStorage.setItem(STORAGE_KEY, encoded);
      invalidateDocumentMemo();
      return;
    } catch {
      nextDocument = removeOldestEnvironment(nextDocument);
    }
  }
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

function retainOrderedThreadIds(state: EnvironmentState, preferredThreadIds: readonly ThreadId[]) {
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
    if (retained.size >= MAX_CACHED_SHELL_THREADS) {
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
): Set<ThreadId> {
  const retainedThreadIdSet = new Set(retainedThreadIds);
  const detailThreadIds = retainedThreadIds.filter((threadId) =>
    hasEnvironmentThreadDetailContent(state, threadId),
  );
  const retained = new Set<ThreadId>();

  for (const threadId of preferredThreadIds) {
    if (retainedThreadIdSet.has(threadId) && hasEnvironmentThreadDetailContent(state, threadId)) {
      retained.add(threadId);
    }
  }

  for (const threadId of [...detailThreadIds].toSorted((left, right) =>
    compareThreadUpdatedAt(state, left, right),
  )) {
    if (retained.size >= MAX_CACHED_DETAIL_THREADS) {
      break;
    }
    retained.add(threadId);
  }

  return retained;
}

function retainProjectState(
  state: EnvironmentState,
  retainedThreadIds: readonly ThreadId[],
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
    if (orderedProjectIds.length >= MAX_CACHED_PROJECTS) {
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
): Pick<EnvironmentState, "turnDiffIdsByThreadId" | "turnDiffSummaryByThreadId"> {
  const turnDiffIdsByThreadId: Record<string, EnvironmentState["turnDiffIdsByThreadId"][ThreadId]> =
    {};
  const turnDiffSummaryByThreadId: Record<
    string,
    EnvironmentState["turnDiffSummaryByThreadId"][ThreadId]
  > = {};

  for (const threadId of detailThreadIds) {
    const ids = (state.turnDiffIdsByThreadId[threadId] ?? []).slice(-MAX_CACHED_THREAD_DIFFS);
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
): EnvironmentState {
  const retainedThreadIds = retainOrderedThreadIds(state, preferredThreadIds);
  const retainedThreadIdSet = new Set(retainedThreadIds);
  const detailThreadIds = retainDetailThreadIds(state, retainedThreadIds, preferredThreadIds);
  const projectState = retainProjectState(state, retainedThreadIds);
  const messageState = retainThreadItemRecord(
    state.messageIdsByThreadId,
    state.messageByThreadId,
    detailThreadIds,
    MAX_CACHED_THREAD_MESSAGES,
  );
  const queuedTurnState = retainThreadItemRecord(
    state.queuedTurnIdsByThreadId,
    state.queuedTurnByThreadId,
    detailThreadIds,
    MAX_CACHED_THREAD_MESSAGES,
  );
  const activityState = retainThreadItemRecord(
    state.activityIdsByThreadId,
    state.activityByThreadId,
    detailThreadIds,
    MAX_CACHED_THREAD_ACTIVITIES,
  );
  const proposedPlanState = retainThreadItemRecord(
    state.proposedPlanIdsByThreadId,
    state.proposedPlanByThreadId,
    detailThreadIds,
    MAX_CACHED_THREAD_PROPOSED_PLANS,
  );
  const turnDiffState = retainTurnDiffRecords(state, detailThreadIds);

  return {
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
  };
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

export function readCachedEnvironmentState(environmentId: EnvironmentId): EnvironmentState | null {
  const cached = readDocument().environments[environmentId];
  return cached
    ? {
        ...cached.state,
        queuedTurnIdsByThreadId: cached.state.queuedTurnIdsByThreadId ?? {},
        queuedTurnByThreadId: cached.state.queuedTurnByThreadId ?? {},
        lastAppliedEventSequenceByThreadId: cached.state.lastAppliedEventSequenceByThreadId ?? {},
        lastAppliedEventIdByThreadId: cached.state.lastAppliedEventIdByThreadId ?? {},
        bootstrapComplete: false,
      }
    : null;
}

export function readCachedThreadDetail(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): CachedThreadDetail | null {
  const cached = readDocument().environments[environmentId];
  if (!cached || !hasEnvironmentThreadDetailContent(cached.state, threadId)) {
    return null;
  }

  return {
    messageIds: [...(cached.state.messageIdsByThreadId[threadId] ?? [])],
    messageById: { ...cached.state.messageByThreadId[threadId] },
    queuedTurnIds: [...(cached.state.queuedTurnIdsByThreadId[threadId] ?? [])],
    queuedTurnById: { ...cached.state.queuedTurnByThreadId[threadId] },
    activityIds: [...(cached.state.activityIdsByThreadId[threadId] ?? [])],
    activityById: { ...cached.state.activityByThreadId[threadId] },
    proposedPlanIds: [...(cached.state.proposedPlanIdsByThreadId[threadId] ?? [])],
    proposedPlanById: { ...cached.state.proposedPlanByThreadId[threadId] },
    turnDiffIds: [...(cached.state.turnDiffIdsByThreadId[threadId] ?? [])],
    turnDiffSummaryById: { ...cached.state.turnDiffSummaryByThreadId[threadId] },
    pageInfo: cached.state.threadDetailPageInfoByThreadId[threadId] ?? null,
  };
}

export function writeCachedEnvironmentState(
  environmentId: EnvironmentId,
  state: EnvironmentState,
  options?: {
    readonly preferredThreadIds?: readonly ThreadId[];
  },
): void {
  const document = readDocument();
  writeDocument({
    version: DOCUMENT_VERSION,
    environments: retainNewestEnvironments({
      ...document.environments,
      [environmentId]: {
        updatedAt: new Date().toISOString(),
        state: createCachedEnvironmentState(state, options?.preferredThreadIds ?? []),
      },
    }),
  });
}

export function scheduleCachedEnvironmentStateWrite(
  environmentId: EnvironmentId,
  state: EnvironmentState,
  options?: {
    readonly preferredThreadIds?: readonly ThreadId[];
  },
): void {
  if (!storage()) {
    return;
  }

  const pending = pendingWrites.get(environmentId) ?? {
    state,
    preferredThreadIds: new Set<ThreadId>(),
    timeoutId: null,
  };
  pending.state = state;
  for (const threadId of options?.preferredThreadIds ?? []) {
    pending.preferredThreadIds.add(threadId);
  }
  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId);
  }
  pending.timeoutId = setTimeout(() => {
    pendingWrites.delete(environmentId);
    writeCachedEnvironmentState(environmentId, pending.state, {
      preferredThreadIds: [...pending.preferredThreadIds],
    });
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(environmentId, pending);
}

export function removeCachedEnvironmentState(environmentId: EnvironmentId): void {
  const pending = pendingWrites.get(environmentId);
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
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
  }
  pendingWrites.clear();
  storage()?.removeItem(STORAGE_KEY);
  invalidateDocumentMemo();
}

export const ORCHESTRATION_STARTUP_CACHE_STORAGE_KEY = STORAGE_KEY;
