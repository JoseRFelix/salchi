import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";

import type { SidebarThreadSummary } from "./types";

export type InboxLifecycleSection = "drafts" | "pinned" | "active" | "snoozed" | "settled";

export interface InboxThreadPartitions<TThread> {
  readonly drafts: TThread[];
  readonly pinned: TThread[];
  readonly active: TThread[];
  readonly snoozed: TThread[];
  readonly settled: TThread[];
}

export type InboxSnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface InboxSnoozePreset {
  readonly id: InboxSnoozePresetId;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function validTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function threadKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function compareThreadIdentity(
  left: Pick<SidebarThreadSummary, "environmentId" | "id">,
  right: Pick<SidebarThreadSummary, "environmentId" | "id">,
): number {
  return threadKey(left).localeCompare(threadKey(right));
}

function compareCreatedNewestFirst<
  T extends Pick<SidebarThreadSummary, "createdAt" | "environmentId" | "id">,
>(left: T, right: T): number {
  return (
    validTimestampMs(right.createdAt) - validTimestampMs(left.createdAt) ||
    compareThreadIdentity(left, right)
  );
}

export function buildInboxLifecycleThreadKeyByThreadKey<
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "id" | "parentThreadId">,
>(threads: readonly TThread[]): ReadonlyMap<string, string> {
  const threadByKey = new Map(threads.map((thread) => [threadKey(thread), thread] as const));
  const lifecycleKeyByThreadKey = new Map<string, string>();
  for (const thread of threads) {
    const ownKey = threadKey(thread);
    if (lifecycleKeyByThreadKey.has(ownKey)) continue;
    const visited = new Set<string>([ownKey]);
    let current = thread;
    let lifecycleKey = ownKey;
    while (current.parentThreadId) {
      const parentKey = scopedThreadKey(
        scopeThreadRef(current.environmentId, current.parentThreadId),
      );
      if (visited.has(parentKey)) break;
      const parent = threadByKey.get(parentKey);
      if (!parent) break;
      visited.add(parentKey);
      lifecycleKey = parentKey;
      current = parent;
    }
    for (const key of visited) lifecycleKeyByThreadKey.set(key, lifecycleKey);
  }
  return lifecycleKeyByThreadKey;
}

export function resolveInboxLifecycleSection(input: {
  readonly thread: SidebarThreadSummary;
  readonly isDraft: boolean;
  readonly now: string;
}): InboxLifecycleSection {
  if (input.isDraft) return "drafts";
  if (
    input.thread.snoozedUntil != null &&
    validTimestampMs(input.thread.snoozedUntil) > validTimestampMs(input.now)
  ) {
    return "snoozed";
  }
  if (input.thread.settledOverride === "settled" || input.thread.settledAt != null) {
    return "settled";
  }
  if (input.thread.pinnedAt != null) return "pinned";
  return "active";
}

export function activeThreadAnchorTimestampMs(
  thread: Pick<SidebarThreadSummary, "createdAt" | "unsettledAt">,
): number {
  return Math.max(validTimestampMs(thread.createdAt), validTimestampMs(thread.unsettledAt));
}

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0 || key.at(-1) === PIN_ORDER_DIGITS[0]) return false;
  for (const character of key) {
    if (!PIN_ORDER_DIGITS.includes(character)) return false;
  }
  return true;
}

function pinOrderMidpoint(before: string, after: string): string {
  if (after !== "" && before >= after) throw new Error("pin order bounds are out of order");
  if (after !== "") {
    let prefixLength = 0;
    while ((before.charAt(prefixLength) || PIN_ORDER_DIGITS[0]) === after.charAt(prefixLength)) {
      prefixLength += 1;
    }
    if (prefixLength > 0) {
      return (
        after.slice(0, prefixLength) +
        pinOrderMidpoint(before.slice(prefixLength), after.slice(prefixLength))
      );
    }
  }
  const beforeDigit = before === "" ? 0 : PIN_ORDER_DIGITS.indexOf(before.charAt(0));
  const afterDigit =
    after === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(after.charAt(0));
  if (afterDigit - beforeDigit > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((beforeDigit + afterDigit) / 2));
  }
  if (after.length > 1) return after.charAt(0);
  return PIN_ORDER_DIGITS.charAt(beforeDigit) + pinOrderMidpoint(before.slice(1), "");
}

export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const lower = before ?? "";
  const upper = after ?? "";
  if (lower !== "" && !isValidPinOrderKey(lower)) return null;
  if (upper !== "" && !isValidPinOrderKey(upper)) return null;
  if (upper !== "" && lower >= upper) return null;
  return pinOrderMidpoint(lower, upper);
}

export function generateSpreadPinOrderKeys(count: number): string[] {
  const space = PIN_ORDER_DIGITS.length * PIN_ORDER_DIGITS.length;
  const step = space / (count + 1);
  const keys: string[] = [];
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    let value = Math.max(Math.round(step * (index + 1)), previous + 1);
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    value = Math.min(value, space - 1);
    previous = value;
    keys.push(
      PIN_ORDER_DIGITS.charAt(Math.floor(value / PIN_ORDER_DIGITS.length)) +
        PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length),
    );
  }
  return keys;
}

export function planPinnedReorder(input: {
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const movedIndex = input.orderedIds.indexOf(input.movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? (input.orderedIds[movedIndex - 1] ?? null) : null;
  const afterId =
    movedIndex < input.orderedIds.length - 1 ? (input.orderedIds[movedIndex + 1] ?? null) : null;
  const beforeKey = beforeId === null ? null : (input.keysById.get(beforeId) ?? null);
  const afterKey = afterId === null ? null : (input.keysById.get(afterId) ?? null);
  if ((beforeId === null || beforeKey !== null) && (afterId === null || afterKey !== null)) {
    const orderKey = pinOrderKeyBetween(beforeKey, afterKey);
    if (orderKey !== null) return [{ id: input.movedId, orderKey }];
  }
  const spreadKeys = generateSpreadPinOrderKeys(input.orderedIds.length);
  return input.orderedIds.flatMap((id, index) => {
    const orderKey = spreadKeys[index]!;
    return input.keysById.get(id) === orderKey ? [] : [{ id, orderKey }];
  });
}

export function sortPinnedThreadsByOrderKey<
  T extends Pick<SidebarThreadSummary, "createdAt" | "environmentId" | "id" | "pinOrderKey">,
>(threads: readonly T[]): T[] {
  const keyed = threads.filter((thread) => thread.pinOrderKey != null);
  const keyless = threads.filter((thread) => thread.pinOrderKey == null);
  keyed.sort((left, right) =>
    left.pinOrderKey! < right.pinOrderKey!
      ? -1
      : left.pinOrderKey! > right.pinOrderKey!
        ? 1
        : compareThreadIdentity(left, right),
  );
  keyless.sort(compareCreatedNewestFirst);
  return [...keyed, ...keyless];
}

export function partitionInboxThreads<TThread extends SidebarThreadSummary>(input: {
  readonly threads: readonly TThread[];
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
  const rootByKey = new Map(visibleThreads.map((thread) => [threadKey(thread), thread] as const));

  for (const thread of visibleThreads) {
    const ownKey = threadKey(thread);
    const rootKey = lifecycleKeyByThreadKey.get(ownKey) ?? ownKey;
    const lifecycleThread = rootByKey.get(rootKey) ?? thread;
    const section = resolveInboxLifecycleSection({
      thread: lifecycleThread,
      isDraft: input.draftThreadKeys.has(rootKey),
      now: input.now,
    });
    partitions[section].push(thread);
  }

  partitions.drafts.sort(compareCreatedNewestFirst);
  partitions.active.sort(
    (left, right) =>
      activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
      compareThreadIdentity(left, right),
  );
  partitions.pinned.splice(
    0,
    partitions.pinned.length,
    ...sortPinnedThreadsByOrderKey(partitions.pinned),
  );
  partitions.snoozed.sort(
    (left, right) =>
      validTimestampMs(left.snoozedUntil) - validTimestampMs(right.snoozedUntil) ||
      compareCreatedNewestFirst(left, right),
  );
  partitions.settled.sort(
    (left, right) =>
      validTimestampMs(right.settledAt) - validTimestampMs(left.settledAt) ||
      compareThreadIdentity(left, right),
  );
  return partitions;
}

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function addCalendarDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveInboxSnoozePresets(now: Date): ReadonlyArray<InboxSnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: InboxSnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeLabel(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];
  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }
  const tomorrow = atHour(addCalendarDays(now, 1), 9);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addCalendarDays(now, daysUntilMonday), 9);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    });
  }
  return presets;
}

export function snoozeWakeLabel(snoozedUntil: string, now: string): string {
  const remainingMs = validTimestampMs(snoozedUntil) - validTimestampMs(now);
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export function resolveInboxWokeAt(
  thread: Pick<SidebarThreadSummary, "snoozedUntil">,
  now: string,
): string | null {
  return thread.snoozedUntil != null &&
    validTimestampMs(thread.snoozedUntil) <= validTimestampMs(now)
    ? thread.snoozedUntil
    : null;
}

export function getNextInboxWakeAtMs(
  threads: readonly Pick<SidebarThreadSummary, "snoozedUntil">[],
  now: string,
): number | null {
  const nowMs = validTimestampMs(now);
  let nextWake = Number.POSITIVE_INFINITY;
  for (const thread of threads) {
    const wake = validTimestampMs(thread.snoozedUntil);
    if (wake > nowMs && wake < nextWake) nextWake = wake;
  }
  return Number.isFinite(nextWake) ? nextWake : null;
}
