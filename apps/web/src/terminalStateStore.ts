/**
 * Single Zustand store for terminal UI state keyed by scoped thread identity.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import {
  type ScopedThreadRef,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  detectDevServerLinksFromText,
  mergeDevServerLinks,
  type DevServerLink,
} from "./devServerLinks";
import { resolveStorage } from "./lib/storage";
import { terminalRunningSubprocessFromEvent } from "./terminalActivity";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

export interface ThreadTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface TerminalEventEntry {
  id: number;
  event: TerminalEvent;
}

const TERMINAL_STATE_STORAGE_KEY = "t3code:terminal-state:v1";
const EMPTY_DEV_SERVER_LINKS: ReadonlyArray<DevServerLink> = [];
const EMPTY_TERMINAL_EVENT_ENTRIES: ReadonlyArray<TerminalEventEntry> = [];
const MAX_TERMINAL_EVENT_BUFFER = 200;
const MAX_TERMINAL_SNAPSHOT_HISTORY_LINES = 5_000;
const DEV_SERVER_LINK_DETECTION_HISTORY_TAIL_CHARS = 4_096;

interface PersistedTerminalStateStoreState {
  terminalStateByThreadKey?: Record<string, ThreadTerminalState>;
}

export function migratePersistedTerminalStateStoreState(
  persistedState: unknown,
  version: number,
): PersistedTerminalStateStoreState {
  if (version === 1 && persistedState && typeof persistedState === "object") {
    const candidate = persistedState as PersistedTerminalStateStoreState;
    const nextTerminalStateByThreadKey = Object.fromEntries(
      Object.entries(candidate.terminalStateByThreadKey ?? {}).filter(([threadKey]) =>
        parseScopedThreadKey(threadKey),
      ),
    );
    return { terminalStateByThreadKey: nextTerminalStateByThreadKey };
  }
  return { terminalStateByThreadKey: {} };
}

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

function terminalEventBufferKey(threadRef: ScopedThreadRef, terminalId: string): string {
  return `${terminalThreadKey(threadRef)}\u0000${terminalId}`;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

function appendTerminalEventEntry(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  nextTerminalEventId: number,
  threadRef: ScopedThreadRef,
  event: TerminalEvent,
) {
  const key = terminalEventBufferKey(threadRef, event.terminalId);
  const currentEntries = terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
  const nextEntry: TerminalEventEntry = {
    id: nextTerminalEventId,
    event,
  };
  const nextEntries =
    currentEntries.length >= MAX_TERMINAL_EVENT_BUFFER
      ? [...currentEntries.slice(1), nextEntry]
      : [...currentEntries, nextEntry];

  return {
    terminalEventEntriesByKey: {
      ...terminalEventEntriesByKey,
      [key]: nextEntries,
    },
    nextTerminalEventId: nextTerminalEventId + 1,
  };
}

function capTerminalSnapshotHistory(history: string): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= MAX_TERMINAL_SNAPSHOT_HISTORY_LINES) return history;
  const capped = lines.slice(lines.length - MAX_TERMINAL_SNAPSHOT_HISTORY_LINES).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function normalizeTerminalSessionSnapshot(
  snapshot: TerminalSessionSnapshot,
): TerminalSessionSnapshot {
  const history = capTerminalSnapshotHistory(snapshot.history);
  return history === snapshot.history ? snapshot : { ...snapshot, history };
}

function terminalSnapshotKey(threadRef: ScopedThreadRef, terminalId: string): string {
  return terminalEventBufferKey(threadRef, terminalId);
}

function terminalDevServerLinksKey(threadRef: ScopedThreadRef, terminalId: string): string {
  return terminalEventBufferKey(threadRef, terminalId);
}

function devServerLinksEqual(
  left: ReadonlyArray<DevServerLink> | undefined,
  right: ReadonlyArray<DevServerLink>,
): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftLink = left[index];
    const rightLink = right[index];
    if (!leftLink || !rightLink) return false;
    if (
      leftLink.url !== rightLink.url ||
      leftLink.displayUrl !== rightLink.displayUrl ||
      leftLink.label !== rightLink.label ||
      leftLink.host !== rightLink.host ||
      leftLink.port !== rightLink.port
    ) {
      return false;
    }
  }
  return true;
}

function setTerminalDevServerLinks(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadRef: ScopedThreadRef,
  terminalId: string,
  links: ReadonlyArray<DevServerLink>,
): Record<string, ReadonlyArray<DevServerLink>> {
  const key = terminalDevServerLinksKey(threadRef, terminalId);
  const nextLinks = mergeDevServerLinks(links);
  if (nextLinks.length === 0) {
    if (!terminalDevServerLinksByKey[key]) {
      return terminalDevServerLinksByKey;
    }
    const { [key]: _removed, ...rest } = terminalDevServerLinksByKey;
    return rest;
  }
  if (devServerLinksEqual(terminalDevServerLinksByKey[key], nextLinks)) {
    return terminalDevServerLinksByKey;
  }
  return {
    ...terminalDevServerLinksByKey,
    [key]: nextLinks,
  };
}

function mergeTerminalDevServerLinks(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadRef: ScopedThreadRef,
  terminalId: string,
  links: ReadonlyArray<DevServerLink>,
): Record<string, ReadonlyArray<DevServerLink>> {
  if (links.length === 0) return terminalDevServerLinksByKey;
  const current =
    terminalDevServerLinksByKey[terminalDevServerLinksKey(threadRef, terminalId)] ??
    EMPTY_DEV_SERVER_LINKS;
  return setTerminalDevServerLinks(terminalDevServerLinksByKey, threadRef, terminalId, [
    ...links,
    ...current,
  ]);
}

function linkDetectionTextForOutput(history: string, data: string): string {
  if (history.length <= DEV_SERVER_LINK_DETECTION_HISTORY_TAIL_CHARS) {
    return `${history}${data}`;
  }
  return `${history.slice(-DEV_SERVER_LINK_DETECTION_HISTORY_TAIL_CHARS)}${data}`;
}

function updateTerminalDevServerLinksForEvent(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadRef: ScopedThreadRef,
  event: TerminalEvent,
  currentSnapshot: TerminalSessionSnapshot | undefined,
): Record<string, ReadonlyArray<DevServerLink>> {
  switch (event.type) {
    case "started":
    case "restarted":
      return setTerminalDevServerLinks(
        terminalDevServerLinksByKey,
        threadRef,
        event.terminalId,
        event.snapshot.status === "running"
          ? detectDevServerLinksFromText(event.snapshot.history)
          : EMPTY_DEV_SERVER_LINKS,
      );
    case "output":
      return mergeTerminalDevServerLinks(
        terminalDevServerLinksByKey,
        threadRef,
        event.terminalId,
        detectDevServerLinksFromText(
          linkDetectionTextForOutput(currentSnapshot?.history ?? "", event.data),
        ),
      );
    case "activity":
      return setTerminalDevServerLinks(
        terminalDevServerLinksByKey,
        threadRef,
        event.terminalId,
        event.hasRunningSubprocess && currentSnapshot
          ? detectDevServerLinksFromText(currentSnapshot.history)
          : EMPTY_DEV_SERVER_LINKS,
      );
    case "cleared":
    case "exited":
    case "error":
      return setTerminalDevServerLinks(
        terminalDevServerLinksByKey,
        threadRef,
        event.terminalId,
        EMPTY_DEV_SERVER_LINKS,
      );
  }
}

function updateTerminalDevServerLinksForSnapshot(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadRef: ScopedThreadRef,
  snapshot: TerminalSessionSnapshot,
): Record<string, ReadonlyArray<DevServerLink>> {
  if (snapshot.status !== "running") {
    return setTerminalDevServerLinks(
      terminalDevServerLinksByKey,
      threadRef,
      snapshot.terminalId,
      EMPTY_DEV_SERVER_LINKS,
    );
  }
  return setTerminalDevServerLinks(
    terminalDevServerLinksByKey,
    threadRef,
    snapshot.terminalId,
    detectDevServerLinksFromText(snapshot.history),
  );
}

function removeTerminalDevServerLinksForThread(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadKey: string,
): Record<string, ReadonlyArray<DevServerLink>> {
  const nextTerminalDevServerLinksByKey = { ...terminalDevServerLinksByKey };
  let removedLinks = false;
  for (const key of Object.keys(nextTerminalDevServerLinksByKey)) {
    if (key.startsWith(`${threadKey}\u0000`)) {
      delete nextTerminalDevServerLinksByKey[key];
      removedLinks = true;
    }
  }
  return removedLinks ? nextTerminalDevServerLinksByKey : terminalDevServerLinksByKey;
}

function removeTerminalDevServerLinks(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadRef: ScopedThreadRef,
  terminalId: string,
): Record<string, ReadonlyArray<DevServerLink>> {
  const key = terminalDevServerLinksKey(threadRef, terminalId);
  if (!terminalDevServerLinksByKey[key]) {
    return terminalDevServerLinksByKey;
  }
  const { [key]: _removed, ...rest } = terminalDevServerLinksByKey;
  return rest;
}

function upsertTerminalSessionSnapshot(
  terminalSessionSnapshotsByKey: Record<string, TerminalSessionSnapshot>,
  threadRef: ScopedThreadRef,
  snapshot: TerminalSessionSnapshot,
): Record<string, TerminalSessionSnapshot> {
  const normalizedSnapshot = normalizeTerminalSessionSnapshot(snapshot);
  const key = terminalSnapshotKey(threadRef, normalizedSnapshot.terminalId);
  const current = terminalSessionSnapshotsByKey[key];
  if (
    current?.threadId === normalizedSnapshot.threadId &&
    current.terminalId === normalizedSnapshot.terminalId &&
    current.cwd === normalizedSnapshot.cwd &&
    current.worktreePath === normalizedSnapshot.worktreePath &&
    current.status === normalizedSnapshot.status &&
    current.pid === normalizedSnapshot.pid &&
    current.history === normalizedSnapshot.history &&
    current.exitCode === normalizedSnapshot.exitCode &&
    current.exitSignal === normalizedSnapshot.exitSignal &&
    current.updatedAt === normalizedSnapshot.updatedAt
  ) {
    return terminalSessionSnapshotsByKey;
  }
  return {
    ...terminalSessionSnapshotsByKey,
    [key]: normalizedSnapshot,
  };
}

function updateTerminalSessionSnapshotsForEvent(
  terminalSessionSnapshotsByKey: Record<string, TerminalSessionSnapshot>,
  threadRef: ScopedThreadRef,
  event: TerminalEvent,
): Record<string, TerminalSessionSnapshot> {
  if (event.type === "started" || event.type === "restarted") {
    return upsertTerminalSessionSnapshot(terminalSessionSnapshotsByKey, threadRef, event.snapshot);
  }

  const key = terminalSnapshotKey(threadRef, event.terminalId);
  const current = terminalSessionSnapshotsByKey[key];
  if (!current) {
    return terminalSessionSnapshotsByKey;
  }

  switch (event.type) {
    case "output":
      return {
        ...terminalSessionSnapshotsByKey,
        [key]: {
          ...current,
          history: capTerminalSnapshotHistory(`${current.history}${event.data}`),
          updatedAt: event.createdAt,
        },
      };
    case "cleared":
      return {
        ...terminalSessionSnapshotsByKey,
        [key]: {
          ...current,
          history: "",
          updatedAt: event.createdAt,
        },
      };
    case "activity":
      if (event.hasRunningSubprocess) {
        return terminalSessionSnapshotsByKey;
      }
      return {
        ...terminalSessionSnapshotsByKey,
        [key]: {
          ...current,
          history: "",
          updatedAt: event.createdAt,
        },
      };
    case "exited":
      return {
        ...terminalSessionSnapshotsByKey,
        [key]: {
          ...current,
          status: "exited",
          pid: null,
          exitCode: event.exitCode,
          exitSignal: event.exitSignal,
          updatedAt: event.createdAt,
        },
      };
    case "error":
      return {
        ...terminalSessionSnapshotsByKey,
        [key]: {
          ...current,
          status: "error",
          pid: null,
          updatedAt: event.createdAt,
        },
      };
    default:
      return terminalSessionSnapshotsByKey;
  }
}

function removeTerminalSessionSnapshotsForThread(
  terminalSessionSnapshotsByKey: Record<string, TerminalSessionSnapshot>,
  threadKey: string,
): Record<string, TerminalSessionSnapshot> {
  const nextTerminalSessionSnapshotsByKey = { ...terminalSessionSnapshotsByKey };
  let removedSnapshots = false;
  for (const key of Object.keys(nextTerminalSessionSnapshotsByKey)) {
    if (key.startsWith(`${threadKey}\u0000`)) {
      delete nextTerminalSessionSnapshotsByKey[key];
      removedSnapshots = true;
    }
  }
  return removedSnapshots ? nextTerminalSessionSnapshotsByKey : terminalSessionSnapshotsByKey;
}

function removeTerminalSessionSnapshot(
  terminalSessionSnapshotsByKey: Record<string, TerminalSessionSnapshot>,
  threadRef: ScopedThreadRef,
  terminalId: string,
): Record<string, TerminalSessionSnapshot> {
  const key = terminalSnapshotKey(threadRef, terminalId);
  if (!terminalSessionSnapshotsByKey[key]) {
    return terminalSessionSnapshotsByKey;
  }
  const { [key]: _removed, ...rest } = terminalSessionSnapshotsByKey;
  return rest;
}

function launchContextFromStartEvent(
  event: Extract<TerminalEvent, { type: "started" | "restarted" }>,
): ThreadTerminalLaunchContext {
  return {
    cwd: event.snapshot.cwd,
    worktreePath: event.snapshot.worktreePath,
  };
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalState,
  terminalId: string,
  mode: "split" | "new",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split");
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : normalized.activeTerminalId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

export function selectThreadTerminalState(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadTerminalState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadKey[terminalThreadKey(threadRef)] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadKey(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<string, ThreadTerminalState> {
  if (threadRef.threadId.length === 0) {
    return terminalStateByThreadKey;
  }

  const threadKey = terminalThreadKey(threadRef);
  const current = selectThreadTerminalState(terminalStateByThreadKey, threadRef);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadKey;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadKey[threadKey] === undefined) {
      return terminalStateByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = terminalStateByThreadKey;
    return rest;
  }

  return {
    ...terminalStateByThreadKey,
    [threadKey]: next,
  };
}

export function selectTerminalEventEntries(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  threadRef: ScopedThreadRef | null | undefined,
  terminalId: string,
): ReadonlyArray<TerminalEventEntry> {
  if (!threadRef || threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_TERMINAL_EVENT_ENTRIES;
  }
  return (
    terminalEventEntriesByKey[terminalEventBufferKey(threadRef, terminalId)] ??
    EMPTY_TERMINAL_EVENT_ENTRIES
  );
}

export function selectTerminalSessionSnapshot(
  terminalSessionSnapshotsByKey: Record<string, TerminalSessionSnapshot>,
  threadRef: ScopedThreadRef | null | undefined,
  terminalId: string,
): TerminalSessionSnapshot | null {
  if (!threadRef || threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return null;
  }
  return terminalSessionSnapshotsByKey[terminalSnapshotKey(threadRef, terminalId)] ?? null;
}

export function selectTerminalDevServerLinks(
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>,
  threadRef: ScopedThreadRef | null | undefined,
  terminalId: string,
): ReadonlyArray<DevServerLink> {
  if (!threadRef || threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_DEV_SERVER_LINKS;
  }
  return (
    terminalDevServerLinksByKey[terminalDevServerLinksKey(threadRef, terminalId)] ??
    EMPTY_DEV_SERVER_LINKS
  );
}

interface TerminalStateStoreState {
  terminalStateByThreadKey: Record<string, ThreadTerminalState>;
  terminalLaunchContextByThreadKey: Record<string, ThreadTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  terminalSessionSnapshotsByKey: Record<string, TerminalSessionSnapshot>;
  terminalDevServerLinksByKey: Record<string, ReadonlyArray<DevServerLink>>;
  nextTerminalEventId: number;
  setTerminalOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  splitTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  setTerminalLaunchContext: (
    threadRef: ScopedThreadRef,
    context: ThreadTerminalLaunchContext,
  ) => void;
  clearTerminalLaunchContext: (threadRef: ScopedThreadRef) => void;
  setTerminalActivity: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  recordTerminalEvent: (threadRef: ScopedThreadRef, event: TerminalEvent) => void;
  applyTerminalEvent: (threadRef: ScopedThreadRef, event: TerminalEvent) => void;
  recordTerminalSnapshot: (threadRef: ScopedThreadRef, snapshot: TerminalSessionSnapshot) => void;
  clearTerminalState: (threadRef: ScopedThreadRef) => void;
  removeTerminalState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalStates: (activeThreadKeys: Set<string>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
            state.terminalStateByThreadKey,
            threadRef,
            updater,
          );
          if (nextTerminalStateByThreadKey === state.terminalStateByThreadKey) {
            return state;
          }
          return {
            terminalStateByThreadKey: nextTerminalStateByThreadKey,
          };
        });
      };

      return {
        terminalStateByThreadKey: {},
        terminalLaunchContextByThreadKey: {},
        terminalEventEntriesByKey: {},
        terminalSessionSnapshotsByKey: {},
        terminalDevServerLinksByKey: {},
        nextTerminalEventId: 1,
        setTerminalOpen: (threadRef, open) =>
          updateTerminal(threadRef, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => splitThreadTerminal(state, terminalId)),
        newTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => newThreadTerminal(state, terminalId)),
        ensureTerminal: (threadRef, terminalId, options) =>
          updateTerminal(threadRef, (state) => {
            let nextState = state;
            if (!state.terminalIds.includes(terminalId)) {
              nextState = newThreadTerminal(nextState, terminalId);
            }
            if (options?.active === false) {
              nextState = {
                ...nextState,
                activeTerminalId: state.activeTerminalId,
                activeTerminalGroupId: state.activeTerminalGroupId,
              };
            }
            if (options?.active ?? true) {
              nextState = setThreadActiveTerminal(nextState, terminalId);
            }
            if (options?.open) {
              nextState = setThreadTerminalOpen(nextState, true);
            }
            return normalizeThreadTerminalState(nextState);
          }),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadRef, terminalId) =>
          set((state) => {
            const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
              state.terminalStateByThreadKey,
              threadRef,
              (current) => closeThreadTerminal(current, terminalId),
            );
            const nextTerminalSessionSnapshotsByKey = removeTerminalSessionSnapshot(
              state.terminalSessionSnapshotsByKey,
              threadRef,
              terminalId,
            );
            const nextTerminalDevServerLinksByKey = removeTerminalDevServerLinks(
              state.terminalDevServerLinksByKey,
              threadRef,
              terminalId,
            );
            if (
              nextTerminalStateByThreadKey === state.terminalStateByThreadKey &&
              nextTerminalSessionSnapshotsByKey === state.terminalSessionSnapshotsByKey &&
              nextTerminalDevServerLinksByKey === state.terminalDevServerLinksByKey
            ) {
              return state;
            }
            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalSessionSnapshotsByKey: nextTerminalSessionSnapshotsByKey,
              terminalDevServerLinksByKey: nextTerminalDevServerLinksByKey,
            };
          }),
        setTerminalLaunchContext: (threadRef, context) =>
          set((state) => ({
            terminalLaunchContextByThreadKey: {
              ...state.terminalLaunchContextByThreadKey,
              [terminalThreadKey(threadRef)]: context,
            },
          })),
        clearTerminalLaunchContext: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            if (!state.terminalLaunchContextByThreadKey[threadKey]) {
              return state;
            }
            const { [threadKey]: _removed, ...rest } = state.terminalLaunchContextByThreadKey;
            return { terminalLaunchContextByThreadKey: rest };
          }),
        setTerminalActivity: (threadRef, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadRef, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        recordTerminalEvent: (threadRef, event) =>
          set((state) =>
            appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              threadRef,
              event,
            ),
          ),
        applyTerminalEvent: (threadRef, event) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            let nextTerminalStateByThreadKey = state.terminalStateByThreadKey;
            let nextTerminalLaunchContextByThreadKey = state.terminalLaunchContextByThreadKey;
            const currentSnapshot =
              state.terminalSessionSnapshotsByKey[terminalSnapshotKey(threadRef, event.terminalId)];
            const nextTerminalSessionSnapshotsByKey = updateTerminalSessionSnapshotsForEvent(
              state.terminalSessionSnapshotsByKey,
              threadRef,
              event,
            );
            const nextTerminalDevServerLinksByKey = updateTerminalDevServerLinksForEvent(
              state.terminalDevServerLinksByKey,
              threadRef,
              event,
              currentSnapshot,
            );

            if (event.type === "started" || event.type === "restarted") {
              nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
                nextTerminalStateByThreadKey,
                threadRef,
                (current) => {
                  let nextState = current;
                  if (!current.terminalIds.includes(event.terminalId)) {
                    nextState = newThreadTerminal(nextState, event.terminalId);
                  }
                  nextState = setThreadActiveTerminal(nextState, event.terminalId);
                  nextState = setThreadTerminalOpen(nextState, true);
                  return normalizeThreadTerminalState(nextState);
                },
              );
              nextTerminalLaunchContextByThreadKey = {
                ...nextTerminalLaunchContextByThreadKey,
                [threadKey]: launchContextFromStartEvent(event),
              };
            }

            const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
            if (hasRunningSubprocess !== null) {
              nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
                nextTerminalStateByThreadKey,
                threadRef,
                (current) =>
                  setThreadTerminalActivity(current, event.terminalId, hasRunningSubprocess),
              );
            }

            const nextEventState = appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              threadRef,
              event,
            );

            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalLaunchContextByThreadKey: nextTerminalLaunchContextByThreadKey,
              terminalSessionSnapshotsByKey: nextTerminalSessionSnapshotsByKey,
              terminalDevServerLinksByKey: nextTerminalDevServerLinksByKey,
              ...nextEventState,
            };
          }),
        recordTerminalSnapshot: (threadRef, snapshot) =>
          set((state) => {
            const normalizedSnapshot = normalizeTerminalSessionSnapshot(snapshot);
            const nextTerminalSessionSnapshotsByKey = upsertTerminalSessionSnapshot(
              state.terminalSessionSnapshotsByKey,
              threadRef,
              normalizedSnapshot,
            );
            const nextTerminalDevServerLinksByKey = updateTerminalDevServerLinksForSnapshot(
              state.terminalDevServerLinksByKey,
              threadRef,
              normalizedSnapshot,
            );
            if (
              nextTerminalSessionSnapshotsByKey === state.terminalSessionSnapshotsByKey &&
              nextTerminalDevServerLinksByKey === state.terminalDevServerLinksByKey
            ) {
              return state;
            }
            return {
              terminalSessionSnapshotsByKey: nextTerminalSessionSnapshotsByKey,
              terminalDevServerLinksByKey: nextTerminalDevServerLinksByKey,
            };
          }),
        clearTerminalState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
              state.terminalStateByThreadKey,
              threadRef,
              () => createDefaultThreadTerminalState(),
            );
            const hadLaunchContext =
              state.terminalLaunchContextByThreadKey[threadKey] !== undefined;
            const { [threadKey]: _removed, ...remainingLaunchContexts } =
              state.terminalLaunchContextByThreadKey;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadKey}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            const nextTerminalSessionSnapshotsByKey = removeTerminalSessionSnapshotsForThread(
              state.terminalSessionSnapshotsByKey,
              threadKey,
            );
            const nextTerminalDevServerLinksByKey = removeTerminalDevServerLinksForThread(
              state.terminalDevServerLinksByKey,
              threadKey,
            );
            if (
              nextTerminalStateByThreadKey === state.terminalStateByThreadKey &&
              !hadLaunchContext &&
              !removedEventEntries &&
              nextTerminalSessionSnapshotsByKey === state.terminalSessionSnapshotsByKey &&
              nextTerminalDevServerLinksByKey === state.terminalDevServerLinksByKey
            ) {
              return state;
            }
            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalLaunchContextByThreadKey: remainingLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
              terminalSessionSnapshotsByKey: nextTerminalSessionSnapshotsByKey,
              terminalDevServerLinksByKey: nextTerminalDevServerLinksByKey,
            };
          }),
        removeTerminalState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const hadTerminalState = state.terminalStateByThreadKey[threadKey] !== undefined;
            const hadLaunchContext =
              state.terminalLaunchContextByThreadKey[threadKey] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadKey}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            const nextTerminalSessionSnapshotsByKey = removeTerminalSessionSnapshotsForThread(
              state.terminalSessionSnapshotsByKey,
              threadKey,
            );
            const nextTerminalDevServerLinksByKey = removeTerminalDevServerLinksForThread(
              state.terminalDevServerLinksByKey,
              threadKey,
            );
            if (
              !hadTerminalState &&
              !hadLaunchContext &&
              !removedEventEntries &&
              nextTerminalSessionSnapshotsByKey === state.terminalSessionSnapshotsByKey &&
              nextTerminalDevServerLinksByKey === state.terminalDevServerLinksByKey
            ) {
              return state;
            }
            const nextTerminalStateByThreadKey = { ...state.terminalStateByThreadKey };
            delete nextTerminalStateByThreadKey[threadKey];
            const nextLaunchContexts = { ...state.terminalLaunchContextByThreadKey };
            delete nextLaunchContexts[threadKey];
            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalLaunchContextByThreadKey: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
              terminalSessionSnapshotsByKey: nextTerminalSessionSnapshotsByKey,
              terminalDevServerLinksByKey: nextTerminalDevServerLinksByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeThreadKeys) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadKey).filter(
              (key) => !activeThreadKeys.has(key),
            );
            const orphanedLaunchContextIds = Object.keys(
              state.terminalLaunchContextByThreadKey,
            ).filter((key) => !activeThreadKeys.has(key));
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [threadKey] = key.split("\u0000");
              if (threadKey && !activeThreadKeys.has(threadKey)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            const nextTerminalSessionSnapshotsByKey = {
              ...state.terminalSessionSnapshotsByKey,
            };
            let removedSnapshots = false;
            for (const key of Object.keys(nextTerminalSessionSnapshotsByKey)) {
              const [threadKey] = key.split("\u0000");
              if (threadKey && !activeThreadKeys.has(threadKey)) {
                delete nextTerminalSessionSnapshotsByKey[key];
                removedSnapshots = true;
              }
            }
            const nextTerminalDevServerLinksByKey = {
              ...state.terminalDevServerLinksByKey,
            };
            let removedDevServerLinks = false;
            for (const key of Object.keys(nextTerminalDevServerLinksByKey)) {
              const [threadKey] = key.split("\u0000");
              if (threadKey && !activeThreadKeys.has(threadKey)) {
                delete nextTerminalDevServerLinksByKey[key];
                removedDevServerLinks = true;
              }
            }
            if (
              orphanedIds.length === 0 &&
              orphanedLaunchContextIds.length === 0 &&
              !removedEventEntries &&
              !removedSnapshots &&
              !removedDevServerLinks
            ) {
              return state;
            }
            const next = { ...state.terminalStateByThreadKey };
            for (const id of orphanedIds) {
              delete next[id];
            }
            const nextLaunchContexts = { ...state.terminalLaunchContextByThreadKey };
            for (const id of orphanedLaunchContextIds) {
              delete nextLaunchContexts[id];
            }
            return {
              terminalStateByThreadKey: next,
              terminalLaunchContextByThreadKey: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
              terminalSessionSnapshotsByKey: removedSnapshots
                ? nextTerminalSessionSnapshotsByKey
                : state.terminalSessionSnapshotsByKey,
              terminalDevServerLinksByKey: removedDevServerLinks
                ? nextTerminalDevServerLinksByKey
                : state.terminalDevServerLinksByKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createTerminalStateStorage),
      migrate: migratePersistedTerminalStateStoreState,
      partialize: (state) => ({
        terminalStateByThreadKey: state.terminalStateByThreadKey,
      }),
    },
  ),
);
