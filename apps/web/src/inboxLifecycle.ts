import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { TimestampFormat } from "@salchi/contracts/settings";

import type { SidebarThreadSummary } from "./types";
import { formatShortTimestamp } from "./timestampFormat";

export type InboxLifecycleSection = "drafts" | "pinned" | "active" | "snoozed" | "settled";

export interface InboxThreadPartitions<TThread> {
  readonly drafts: TThread[];
  readonly pinned: TThread[];
  readonly active: TThread[];
  readonly snoozed: TThread[];
  readonly settled: TThread[];
}

export interface InboxChangeRequestSettleSource {
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string | null | undefined;
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
export const INBOX_QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

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

type InboxThreadActivitySource = Pick<
  SidebarThreadSummary,
  "createdAt" | "latestUserMessageAt" | "latestTurn"
>;

function threadUserActivityAnchorAt(thread: InboxThreadActivitySource): string {
  let anchor = thread.createdAt;
  for (const candidate of [thread.latestUserMessageAt, thread.latestTurn?.requestedAt]) {
    if (candidate != null && validTimestampMs(candidate) > validTimestampMs(anchor)) {
      anchor = candidate;
    }
  }
  return anchor;
}

export function changeRequestAutoSettles(
  changeRequest: InboxChangeRequestSettleSource | null | undefined,
  options: {
    readonly autoSettleOnMerge?: boolean | undefined;
    readonly thread?: InboxThreadActivitySource | null | undefined;
  } = {},
): boolean {
  if (changeRequest == null) return false;
  const terminal =
    changeRequest.state === "closed" ||
    (changeRequest.state === "merged" && options.autoSettleOnMerge !== false);
  if (!terminal) return false;
  if (changeRequest.updatedAt == null || options.thread == null) return true;
  const changedAt = Date.parse(changeRequest.updatedAt);
  const userActivityAt = Date.parse(threadUserActivityAnchorAt(options.thread));
  return Number.isNaN(changedAt) || Number.isNaN(userActivityAt) || changedAt >= userActivityAt;
}

export function inboxThreadLastActivityAt(
  thread: Pick<SidebarThreadSummary, "latestUserMessageAt" | "latestTurn">,
): string | null {
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const candidateMs = Date.parse(candidate);
    if (candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest;
}

export function hasInboxQueuedTurnStart(
  thread: Pick<SidebarThreadSummary, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (thread.latestUserMessageAt == null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const now = Date.parse(options.now);
  if (Number.isNaN(messageAt) || Number.isNaN(now)) return false;
  if (Math.abs(now - messageAt) > INBOX_QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestTurn == null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((candidate) => candidate == null || Date.parse(candidate) < messageAt);
}

export function canSettleInboxThread(
  thread: Pick<
    SidebarThreadSummary,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "connecting" || thread.session?.status === "running") return false;
  return !hasInboxQueuedTurnStart(thread, options);
}

export function canSnoozeInboxThread(
  thread: Pick<
    SidebarThreadSummary,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  return !hasInboxQueuedTurnStart(thread, options);
}

type InboxThreadSnoozeSource = Pick<
  SidebarThreadSummary,
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
>;

export function threadRaisedHandWhileSnoozed(thread: InboxThreadSnoozeSource): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  if (
    thread.session?.status === "error" &&
    (thread.snoozedAt == null ||
      validTimestampMs(thread.session.updatedAt) > validTimestampMs(thread.snoozedAt))
  ) {
    return true;
  }
  return (
    thread.snoozedAt != null &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt != null &&
    validTimestampMs(thread.latestTurn.completedAt) > validTimestampMs(thread.snoozedAt)
  );
}

export function effectiveInboxSnoozed(
  thread: InboxThreadSnoozeSource,
  options: { readonly now: string },
): boolean {
  if (thread.snoozedUntil == null) return false;
  const wakeAt = Date.parse(thread.snoozedUntil);
  const now = Date.parse(options.now);
  if (Number.isNaN(wakeAt) || Number.isNaN(now) || wakeAt <= now) return false;
  return !threadRaisedHandWhileSnoozed(thread);
}

export function effectiveInboxSettled(
  thread: SidebarThreadSummary,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge?: boolean | undefined;
    readonly changeRequest?: InboxChangeRequestSettleSource | null | undefined;
    readonly changeRequestKnown?: boolean | undefined;
  },
): boolean {
  if (!canSettleInboxThread(thread, { now: options.now })) {
    const queuedStartIsServerAdjudicated =
      !thread.hasPendingApprovals &&
      !thread.hasPendingUserInput &&
      thread.session?.status !== "connecting" &&
      thread.session?.status !== "running" &&
      thread.settledOverride === "settled" &&
      thread.settledAt != null &&
      thread.latestUserMessageAt != null &&
      validTimestampMs(thread.settledAt) >= validTimestampMs(thread.latestUserMessageAt);
    if (!queuedStartIsServerAdjudicated) return false;
  }
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "active") return false;
  if (
    changeRequestAutoSettles(options.changeRequest, {
      autoSettleOnMerge: options.autoSettleOnMerge,
      thread,
    })
  ) {
    return true;
  }
  if (options.changeRequest?.state === "open" || options.autoSettleAfterDays === null) return false;
  // A branch with no observed change-request snapshot stays visible. This is
  // conservative until its project is observed and avoids surprising hides.
  if (thread.branch != null && options.changeRequestKnown === false) return false;
  const lastActivityAt = inboxThreadLastActivityAt(thread);
  if (lastActivityAt == null) return false;
  return (
    validTimestampMs(lastActivityAt) <
    validTimestampMs(options.now) - options.autoSettleAfterDays * DAY_MS
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
  readonly autoSettleAfterDays?: number | null | undefined;
  readonly autoSettleOnMerge?: boolean | undefined;
  readonly changeRequest?: InboxChangeRequestSettleSource | null | undefined;
  readonly changeRequestKnown?: boolean | undefined;
}): InboxLifecycleSection {
  if (input.isDraft) return "drafts";
  if (effectiveInboxSnoozed(input.thread, { now: input.now })) return "snoozed";
  if (
    effectiveInboxSettled(input.thread, {
      now: input.now,
      autoSettleAfterDays: input.autoSettleAfterDays ?? null,
      autoSettleOnMerge: input.autoSettleOnMerge,
      changeRequest: input.changeRequest,
      changeRequestKnown: input.changeRequestKnown,
    })
  )
    return "settled";
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
  readonly autoSettleAfterDays?: number | null | undefined;
  readonly autoSettleOnMerge?: boolean | undefined;
  readonly changeRequestByThreadKey?: ReadonlyMap<string, InboxChangeRequestSettleSource | null>;
  readonly changeRequestKnownThreadKeys?: ReadonlySet<string>;
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
    const changeRequest = input.changeRequestByThreadKey?.get(rootKey);
    const section = resolveInboxLifecycleSection({
      thread: lifecycleThread,
      isDraft: input.draftThreadKeys.has(rootKey),
      now: input.now,
      autoSettleAfterDays: input.autoSettleAfterDays,
      autoSettleOnMerge: input.autoSettleOnMerge,
      changeRequest,
      changeRequestKnown:
        input.changeRequestKnownThreadKeys == null ||
        input.changeRequestKnownThreadKeys.has(rootKey),
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
  partitions.settled.sort((left, right) => {
    const leftKey = threadKey(left);
    const rightKey = threadKey(right);
    const leftLifecycleKey = lifecycleKeyByThreadKey.get(leftKey) ?? leftKey;
    const rightLifecycleKey = lifecycleKeyByThreadKey.get(rightKey) ?? rightKey;
    return (
      settledSortTimestampMs(right, input.changeRequestByThreadKey?.get(rightLifecycleKey)) -
        settledSortTimestampMs(left, input.changeRequestByThreadKey?.get(leftLifecycleKey)) ||
      compareThreadIdentity(left, right)
    );
  });
  return partitions;
}

function settledSortTimestampMs(
  thread: SidebarThreadSummary,
  changeRequest: InboxChangeRequestSettleSource | null | undefined,
): number {
  return Math.max(
    validTimestampMs(thread.settledAt),
    validTimestampMs(changeRequest?.updatedAt),
    validTimestampMs(inboxThreadLastActivityAt(thread)),
    validTimestampMs(thread.createdAt),
  );
}

function timeLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
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

export function resolveInboxSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat = "locale",
): ReadonlyArray<InboxSnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: InboxSnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeLabel(inAnHour, timestampFormat),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeLabel(inThreeHours, timestampFormat),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];
  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeLabel(evening, timestampFormat),
      snoozedUntil: evening.toISOString(),
    });
  }
  const tomorrow = atHour(addCalendarDays(now, 1), 9);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeLabel(tomorrow, timestampFormat),
    snoozedUntil: tomorrow.toISOString(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addCalendarDays(now, daysUntilMonday), 9);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(nextWeek, timestampFormat)}`,
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

export function resolveInboxWokeAt(thread: InboxThreadSnoozeSource, now: string): string | null {
  if (thread.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(thread.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  if (threadRaisedHandWhileSnoozed(thread)) {
    if (
      thread.snoozedAt != null &&
      thread.latestTurn?.state === "completed" &&
      thread.latestTurn.completedAt != null &&
      validTimestampMs(thread.latestTurn.completedAt) > validTimestampMs(thread.snoozedAt)
    ) {
      return thread.latestTurn.completedAt;
    }
    return thread.session?.updatedAt ?? thread.snoozedAt ?? null;
  }
  return wakeAtMs <= validTimestampMs(now) ? thread.snoozedUntil : null;
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
