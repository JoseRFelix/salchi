import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import { create } from "zustand";

import type { SidebarThreadSummary } from "./types";

export const INBOX_LIFECYCLE_STORAGE_KEY = "salchi:sidebar-inbox-prototype:lifecycle:v1";
const INBOX_LIFECYCLE_VERSION = 2;

export interface InboxThreadLifecycle {
  readonly pinnedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly settledAt: string | null;
  readonly reactivatedAt: string | null;
  readonly wokeAt: string | null;
}

export type InboxLifecycleByThreadKey = Readonly<Record<string, InboxThreadLifecycle>>;

interface PersistedInboxLifecycleDocument {
  readonly version: typeof INBOX_LIFECYCLE_VERSION;
  readonly threads: InboxLifecycleByThreadKey;
}

export type InboxLifecycleSection = "drafts" | "pinned" | "active" | "snoozed" | "settled";

export interface InboxThreadPartitions<TThread> {
  readonly drafts: TThread[];
  readonly pinned: TThread[];
  readonly active: TThread[];
  readonly snoozed: TThread[];
  readonly settled: TThread[];
}

export type InboxSnoozePreset = "one-hour" | "tomorrow" | "one-week";

export type InboxLifecycleAction =
  | { readonly type: "pin"; readonly threadKey: string; readonly at: string }
  | { readonly type: "unpin"; readonly threadKey: string; readonly at: string }
  | { readonly type: "snooze"; readonly threadKey: string; readonly until: string }
  | { readonly type: "unsnooze"; readonly threadKey: string; readonly at: string }
  | { readonly type: "settle"; readonly threadKey: string; readonly at: string }
  | { readonly type: "unsettle"; readonly threadKey: string; readonly at: string }
  | { readonly type: "acknowledge-wake"; readonly threadKey: string; readonly at: string }
  | { readonly type: "remove"; readonly threadKey: string };

const EMPTY_THREAD_LIFECYCLE: InboxThreadLifecycle = {
  pinnedAt: null,
  snoozedUntil: null,
  settledAt: null,
  reactivatedAt: null,
  wokeAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function sanitizeLifecycleEntry(value: unknown): InboxThreadLifecycle | null {
  if (!isRecord(value)) {
    return null;
  }
  const entry = {
    pinnedAt: sanitizeTimestamp(value.pinnedAt),
    snoozedUntil: sanitizeTimestamp(value.snoozedUntil),
    settledAt: sanitizeTimestamp(value.settledAt),
    reactivatedAt: sanitizeTimestamp(value.reactivatedAt),
    wokeAt: sanitizeTimestamp(value.wokeAt),
  } satisfies InboxThreadLifecycle;
  return entry.pinnedAt ||
    entry.snoozedUntil ||
    entry.settledAt ||
    entry.reactivatedAt ||
    entry.wokeAt
    ? entry
    : null;
}

export function parseInboxLifecycleDocument(raw: string | null): InboxLifecycleByThreadKey {
  if (!raw) {
    return {};
  }
  try {
    const document = JSON.parse(raw) as unknown;
    if (
      !isRecord(document) ||
      (document.version !== 1 && document.version !== INBOX_LIFECYCLE_VERSION) ||
      !isRecord(document.threads)
    ) {
      return {};
    }
    const entries = Object.entries(document.threads).flatMap(([threadKey, value]) => {
      const entry = parseScopedThreadKey(threadKey) ? sanitizeLifecycleEntry(value) : null;
      return entry ? ([[threadKey, entry]] as const) : [];
    });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function readInboxLifecycleState(
  storage: Pick<Storage, "getItem">,
): InboxLifecycleByThreadKey {
  try {
    return parseInboxLifecycleDocument(storage.getItem(INBOX_LIFECYCLE_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function persistInboxLifecycleState(
  storage: Pick<Storage, "setItem">,
  lifecycleByThreadKey: InboxLifecycleByThreadKey,
): void {
  const document = {
    version: INBOX_LIFECYCLE_VERSION,
    threads: lifecycleByThreadKey,
  } satisfies PersistedInboxLifecycleDocument;
  try {
    storage.setItem(INBOX_LIFECYCLE_STORAGE_KEY, JSON.stringify(document));
  } catch {
    // The inbox is a presentation prototype. Storage failures must not block navigation or chat.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function threadLifecycleOrEmpty(
  state: InboxLifecycleByThreadKey,
  threadKey: string,
): InboxThreadLifecycle {
  return state[threadKey] ?? EMPTY_THREAD_LIFECYCLE;
}

function setThreadLifecycle(
  state: InboxLifecycleByThreadKey,
  threadKey: string,
  lifecycle: InboxThreadLifecycle,
): InboxLifecycleByThreadKey {
  if (
    !lifecycle.pinnedAt &&
    !lifecycle.snoozedUntil &&
    !lifecycle.settledAt &&
    !lifecycle.reactivatedAt &&
    !lifecycle.wokeAt
  ) {
    if (!state[threadKey]) {
      return state;
    }
    const next = { ...state };
    delete next[threadKey];
    return next;
  }
  return {
    ...state,
    [threadKey]: lifecycle,
  };
}

export function applyInboxLifecycleAction(
  state: InboxLifecycleByThreadKey,
  action: InboxLifecycleAction,
): InboxLifecycleByThreadKey {
  if (!parseScopedThreadKey(action.threadKey)) {
    return state;
  }
  if (action.type === "remove") {
    if (!state[action.threadKey]) {
      return state;
    }
    const next = { ...state };
    delete next[action.threadKey];
    return next;
  }

  const current = threadLifecycleOrEmpty(state, action.threadKey);
  switch (action.type) {
    case "pin":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        pinnedAt: action.at,
      });
    case "unpin":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        pinnedAt: null,
        reactivatedAt: action.at,
      });
    case "snooze":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        snoozedUntil: action.until,
        wokeAt: null,
      });
    case "unsnooze":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        snoozedUntil: null,
        reactivatedAt: action.at,
        wokeAt: action.at,
      });
    case "settle":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        settledAt: action.at,
        snoozedUntil: null,
        wokeAt: null,
      });
    case "unsettle":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        settledAt: null,
        reactivatedAt: action.at,
      });
    case "acknowledge-wake":
      return setThreadLifecycle(state, action.threadKey, {
        ...current,
        snoozedUntil: null,
        reactivatedAt: action.at,
        wokeAt: null,
      });
  }
}

function validTimestampMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function inboxThreadKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function buildInboxLifecycleThreadKeyByThreadKey<
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "id" | "parentThreadId">,
>(threads: readonly TThread[]): ReadonlyMap<string, string> {
  const threadByKey = new Map(threads.map((thread) => [inboxThreadKey(thread), thread] as const));
  const lifecycleKeyByThreadKey = new Map<string, string>();

  const resolveLifecycleKey = (thread: TThread): string => {
    const threadKey = inboxThreadKey(thread);
    const cached = lifecycleKeyByThreadKey.get(threadKey);
    if (cached) {
      return cached;
    }
    const visited = new Set<string>([threadKey]);
    let current = thread;
    let lifecycleKey = threadKey;
    while (current.parentThreadId) {
      const parentKey = scopedThreadKey(
        scopeThreadRef(current.environmentId, current.parentThreadId),
      );
      if (visited.has(parentKey)) {
        break;
      }
      const parent = threadByKey.get(parentKey);
      if (!parent) {
        break;
      }
      visited.add(parentKey);
      lifecycleKey = parentKey;
      current = parent;
    }
    for (const visitedKey of visited) {
      lifecycleKeyByThreadKey.set(visitedKey, lifecycleKey);
    }
    return lifecycleKey;
  };

  for (const thread of threads) {
    resolveLifecycleKey(thread);
  }
  return lifecycleKeyByThreadKey;
}

function compareThreadKeys(
  left: Pick<SidebarThreadSummary, "environmentId" | "id">,
  right: Pick<SidebarThreadSummary, "environmentId" | "id">,
): number {
  return inboxThreadKey(left).localeCompare(inboxThreadKey(right));
}

function compareCreatedNewestFirst<
  TThread extends Pick<SidebarThreadSummary, "createdAt" | "environmentId" | "id">,
>(left: TThread, right: TThread): number {
  return (
    validTimestampMs(right.createdAt) - validTimestampMs(left.createdAt) ||
    compareThreadKeys(left, right)
  );
}

export function resolveInboxThreadActivityAt(
  thread: Pick<
    SidebarThreadSummary,
    "createdAt" | "latestTurn" | "latestUserMessageAt" | "session"
  >,
  lifecycle: InboxThreadLifecycle | undefined,
): string {
  const activeSessionAt =
    thread.session?.status === "connecting" || thread.session?.status === "running"
      ? thread.session.updatedAt
      : null;
  const candidates = [
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    activeSessionAt,
    lifecycle?.reactivatedAt,
    lifecycle?.snoozedUntil,
  ];
  let latest = thread.createdAt;
  let latestMs = validTimestampMs(thread.createdAt);
  for (const candidate of candidates) {
    const candidateMs = validTimestampMs(candidate);
    if (candidate && candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest;
}

export function resolveInboxWokeAt(
  lifecycle: InboxThreadLifecycle | undefined,
  now: string,
): string | null {
  if (lifecycle?.wokeAt) {
    return lifecycle.wokeAt;
  }
  if (
    lifecycle?.snoozedUntil &&
    validTimestampMs(lifecycle.snoozedUntil) <= validTimestampMs(now)
  ) {
    return lifecycle.snoozedUntil;
  }
  return null;
}

export function resolveInboxLifecycleSection(
  threadKey: string,
  lifecycleByThreadKey: InboxLifecycleByThreadKey,
  draftThreadKeys: ReadonlySet<string>,
  now: string,
): InboxLifecycleSection {
  if (draftThreadKeys.has(threadKey)) {
    return "drafts";
  }
  const lifecycle = lifecycleByThreadKey[threadKey];
  const nowMs = validTimestampMs(now);
  if (lifecycle?.snoozedUntil && validTimestampMs(lifecycle.snoozedUntil) > nowMs) {
    return "snoozed";
  }
  if (lifecycle?.settledAt) {
    return "settled";
  }
  if (lifecycle?.pinnedAt) {
    return "pinned";
  }
  return "active";
}

export function partitionInboxThreads<TThread extends SidebarThreadSummary>(input: {
  readonly threads: readonly TThread[];
  readonly lifecycleByThreadKey: InboxLifecycleByThreadKey;
  readonly draftThreadKeys: ReadonlySet<string>;
  readonly now: string;
}): InboxThreadPartitions<TThread> {
  const partitions: InboxThreadPartitions<TThread> = {
    drafts: [],
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  const visibleThreads = input.threads.filter(
    (thread) => thread.archivedAt === null && thread.hiddenFromThreadList !== true,
  );
  const lifecycleKeyByThreadKey = buildInboxLifecycleThreadKeyByThreadKey(visibleThreads);
  const activityAtByLifecycleKey = new Map<string, number>();
  for (const thread of visibleThreads) {
    const threadKey = inboxThreadKey(thread);
    const lifecycleThreadKey = lifecycleKeyByThreadKey.get(threadKey) ?? threadKey;
    const activityAt = validTimestampMs(
      resolveInboxThreadActivityAt(thread, input.lifecycleByThreadKey[lifecycleThreadKey]),
    );
    activityAtByLifecycleKey.set(
      lifecycleThreadKey,
      Math.max(activityAtByLifecycleKey.get(lifecycleThreadKey) ?? 0, activityAt),
    );
  }
  for (const thread of visibleThreads) {
    const threadKey = inboxThreadKey(thread);
    const lifecycleThreadKey = lifecycleKeyByThreadKey.get(threadKey) ?? threadKey;
    partitions[
      resolveInboxLifecycleSection(
        lifecycleThreadKey,
        input.lifecycleByThreadKey,
        input.draftThreadKeys,
        input.now,
      )
    ].push(thread);
  }

  partitions.drafts.sort(compareCreatedNewestFirst);
  partitions.active.sort((left, right) => {
    const leftKey = lifecycleKeyByThreadKey.get(inboxThreadKey(left)) ?? inboxThreadKey(left);
    const rightKey = lifecycleKeyByThreadKey.get(inboxThreadKey(right)) ?? inboxThreadKey(right);
    return (
      (activityAtByLifecycleKey.get(rightKey) ?? 0) -
        (activityAtByLifecycleKey.get(leftKey) ?? 0) || compareCreatedNewestFirst(left, right)
    );
  });
  partitions.pinned.sort((left, right) => {
    const leftKey = lifecycleKeyByThreadKey.get(inboxThreadKey(left)) ?? inboxThreadKey(left);
    const rightKey = lifecycleKeyByThreadKey.get(inboxThreadKey(right)) ?? inboxThreadKey(right);
    const leftLifecycle = input.lifecycleByThreadKey[leftKey];
    const rightLifecycle = input.lifecycleByThreadKey[rightKey];
    return (
      validTimestampMs(leftLifecycle?.pinnedAt) - validTimestampMs(rightLifecycle?.pinnedAt) ||
      compareCreatedNewestFirst(left, right)
    );
  });
  partitions.snoozed.sort((left, right) => {
    const leftKey = lifecycleKeyByThreadKey.get(inboxThreadKey(left)) ?? inboxThreadKey(left);
    const rightKey = lifecycleKeyByThreadKey.get(inboxThreadKey(right)) ?? inboxThreadKey(right);
    const leftLifecycle = input.lifecycleByThreadKey[leftKey];
    const rightLifecycle = input.lifecycleByThreadKey[rightKey];
    return (
      validTimestampMs(leftLifecycle?.snoozedUntil) -
        validTimestampMs(rightLifecycle?.snoozedUntil) || compareCreatedNewestFirst(left, right)
    );
  });
  partitions.settled.sort((left, right) => {
    const leftKey = lifecycleKeyByThreadKey.get(inboxThreadKey(left)) ?? inboxThreadKey(left);
    const rightKey = lifecycleKeyByThreadKey.get(inboxThreadKey(right)) ?? inboxThreadKey(right);
    const leftLifecycle = input.lifecycleByThreadKey[leftKey];
    const rightLifecycle = input.lifecycleByThreadKey[rightKey];
    return (
      validTimestampMs(rightLifecycle?.settledAt) - validTimestampMs(leftLifecycle?.settledAt) ||
      compareThreadKeys(left, right)
    );
  });
  return partitions;
}

export function resolveInboxSnoozeUntil(preset: InboxSnoozePreset, now: string): string {
  const nowMs = validTimestampMs(now);
  if (preset === "tomorrow") {
    const tomorrowMorning = new Date(nowMs);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(9, 0, 0, 0);
    return tomorrowMorning.toISOString();
  }
  const durationMs = preset === "one-hour" ? 60 * 60_000 : 7 * 86_400_000;
  return new Date(nowMs + durationMs).toISOString();
}

export function getNextInboxWakeAtMs(
  lifecycleByThreadKey: InboxLifecycleByThreadKey,
  now: string,
): number | null {
  const nowMs = validTimestampMs(now);
  let nextWakeAtMs = Number.POSITIVE_INFINITY;
  for (const lifecycle of Object.values(lifecycleByThreadKey)) {
    const wakeAtMs = validTimestampMs(lifecycle.snoozedUntil);
    if (wakeAtMs > nowMs && wakeAtMs < nextWakeAtMs) {
      nextWakeAtMs = wakeAtMs;
    }
  }
  return Number.isFinite(nextWakeAtMs) ? nextWakeAtMs : null;
}

interface InboxLifecycleStore {
  readonly lifecycleByThreadKey: InboxLifecycleByThreadKey;
  readonly dispatch: (action: InboxLifecycleAction) => void;
}

const initialLifecycleState = (() => {
  const storage = browserStorage();
  return storage ? readInboxLifecycleState(storage) : {};
})();

export const useInboxLifecycleStore = create<InboxLifecycleStore>((set) => ({
  lifecycleByThreadKey: initialLifecycleState,
  dispatch: (action) => {
    set((current) => {
      const next = applyInboxLifecycleAction(current.lifecycleByThreadKey, action);
      if (next === current.lifecycleByThreadKey) {
        return current;
      }
      const storage = browserStorage();
      if (storage) {
        persistInboxLifecycleState(storage, next);
      }
      return { lifecycleByThreadKey: next };
    });
  },
}));

export function __resetInboxLifecycleStoreForTests(
  lifecycleByThreadKey: InboxLifecycleByThreadKey = {},
): void {
  useInboxLifecycleStore.setState({ lifecycleByThreadKey });
}
