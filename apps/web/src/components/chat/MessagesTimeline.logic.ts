import { formatDuration, type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@salchi/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

export function shouldShowChangedFilesReport(
  summary: TurnDiffSummary | undefined,
): summary is TurnDiffSummary {
  if (!summary || summary.files.length === 0) return false;
  return summary.attribution === "edit-snapshots" || summary.attribution === "touched-paths";
}

function fallbackTurnIdForNullTurnAssistant(input: {
  latestTurn: TimelineLatestTurn | null;
  activeTurnId: TurnId | null;
}): TurnId | null {
  if (input.activeTurnId !== null) {
    return input.activeTurnId;
  }
  const latestTurn = input.latestTurn;
  if (latestTurn?.state === "running" && latestTurn.completedAt === null) {
    return latestTurn.turnId;
  }
  return null;
}

function deriveTerminalAssistantMessageIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  fallbackTurnId: TurnId | null;
  isWorking: boolean;
}) {
  const lastAssistantMessageIdByResponseKey = new Map<string, MessageId>();
  const terminalAssistantMessageIdByTurnId = new Map<TurnId, MessageId>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    if (!message.turnId && input.fallbackTurnId === null && input.isWorking) {
      continue;
    }

    const responseKey =
      message.turnId !== null && message.turnId !== undefined
        ? `turn:${message.turnId}`
        : input.fallbackTurnId !== null
          ? `turn:${input.fallbackTurnId}`
          : `legacy-null-turn:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
    if (message.turnId) {
      terminalAssistantMessageIdByTurnId.set(message.turnId, message.id);
    }
  }

  return {
    terminalAssistantMessageIds: new Set(lastAssistantMessageIdByResponseKey.values()),
    terminalAssistantMessageIdByTurnId,
  };
}

export function deriveTurnDiffSummaryByMessageId(input: {
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  terminalAssistantMessageIdByTurnId: ReadonlyMap<TurnId, MessageId>;
}): ReadonlyMap<MessageId, TurnDiffSummary> {
  const byMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    const anchor =
      input.terminalAssistantMessageIdByTurnId.get(summary.turnId) ?? summary.assistantMessageId;
    if (!anchor) {
      continue;
    }
    byMessageId.set(anchor, summary);
  }
  return byMessageId;
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

function turnIdForTimelineEntry(
  entry: TimelineEntry,
  fallbackTurnId: TurnId | null,
): TurnId | null {
  return entry.kind === "message" && entry.message.role === "assistant"
    ? (entry.message.turnId ?? fallbackTurnId)
    : entry.kind === "work"
      ? (entry.entry.turnId ?? null)
      : null;
}

/**
 * Turns count as unsettled while their lifecycle is still active, or while
 * queued-turn projection has rendered the current response before latestTurn
 * has caught up. The queued fallback is intentionally scoped to entries after
 * the latest user message so older completed turns stay folded.
 */
function deriveUnsettledTurnIds(input: {
  latestTurn: TimelineLatestTurn | null;
  activeTurnId: TurnId | null;
  fallbackTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  isWorking: boolean;
}): ReadonlySet<TurnId> {
  const result = new Set<TurnId>();

  if (input.latestTurn) {
    const isSettled = input.latestTurn.completedAt !== null && input.latestTurn.state !== "running";
    if (!isSettled) {
      result.add(input.latestTurn.turnId);
    }
  }

  if (!input.isWorking) {
    return result;
  }

  if (input.activeTurnId !== null) {
    result.add(input.activeTurnId);
  }

  let latestUserEntryIndex = -1;
  for (let index = input.timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = input.timelineEntries[index];
    if (entry?.kind === "message" && entry.message.role === "user") {
      latestUserEntryIndex = index;
      break;
    }
  }

  if (latestUserEntryIndex >= 0) {
    for (let index = latestUserEntryIndex + 1; index < input.timelineEntries.length; index += 1) {
      const entry = input.timelineEntries[index];
      if (!entry) {
        continue;
      }
      const turnId = turnIdForTimelineEntry(entry, input.fallbackTurnId);
      if (turnId !== null) {
        result.add(turnId);
      }
    }
  }

  return result;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnIds: ReadonlySet<TurnId>;
  isWorking: boolean;
  fallbackTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId = turnIdForTimelineEntry(entry, input.fallbackTurnId);
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (input.unsettledTurnIds.has(turnId)) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id !== group.terminalEntry?.id) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message"
        ? (lastEntry.message.completedAt ?? lastEntry.createdAt)
        : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.completedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? input.isWorking
          ? `Stopped after ${duration}`
          : `You stopped after ${duration}`
        : input.isWorking
          ? "Response stopped"
          : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  activeTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const fallbackTurnId = fallbackTurnIdForNullTurnAssistant({
    latestTurn: input.latestTurn ?? null,
    activeTurnId: input.activeTurnId ?? null,
  });
  const { terminalAssistantMessageIds, terminalAssistantMessageIdByTurnId } =
    deriveTerminalAssistantMessageIds({
      timelineEntries: input.timelineEntries,
      fallbackTurnId,
      isWorking: input.isWorking,
    });
  const turnDiffSummaryByAssistantMessageId = deriveTurnDiffSummaryByMessageId({
    turnDiffSummaries: input.turnDiffSummaries,
    terminalAssistantMessageIdByTurnId,
  });
  const unsettledTurnIds = deriveUnsettledTurnIds({
    latestTurn: input.latestTurn ?? null,
    activeTurnId: input.activeTurnId ?? null,
    fallbackTurnId,
    timelineEntries: input.timelineEntries,
    isWorking: input.isWorking,
  });
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnIds,
    isWorking: input.isWorking,
    fallbackTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const precedingTimelineEntryId = input.timelineEntries[index - 1]?.id ?? null;
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: `work-group:after:${precedingTimelineEntryId ?? "start"}`,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const messageTurnId = timelineEntry.message.turnId ?? null;
    const effectiveMessageTurnId =
      timelineEntry.message.role === "assistant"
        ? (messageTurnId ?? fallbackTurnId)
        : messageTurnId;
    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      ((effectiveMessageTurnId !== null && unsettledTurnIds.has(effectiveMessageTurnId)) ||
        (messageTurnId === null && input.isWorking));

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return areWorkEntriesUnchanged(a.groupedEntries, (b as typeof a).groupedEntries);

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

function areWorkEntriesUnchanged(
  aEntries: ReadonlyArray<WorkLogEntry>,
  bEntries: ReadonlyArray<WorkLogEntry>,
): boolean {
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every((entry, index) => {
    const bEntry = bEntries[index];
    return bEntry !== undefined && isWorkEntryUnchanged(entry, bEntry);
  });
}

function isWorkEntryUnchanged(a: WorkLogEntry, b: WorkLogEntry): boolean {
  return (
    a.stableId === b.stableId &&
    a.id === b.id &&
    a.turnId === b.turnId &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.command === b.command &&
    a.rawCommand === b.rawCommand &&
    a.tone === b.tone &&
    a.toolTitle === b.toolTitle &&
    a.itemType === b.itemType &&
    a.requestKind === b.requestKind &&
    a.toolCallId === b.toolCallId &&
    a.toolLifecycleStatus === b.toolLifecycleStatus &&
    a.sourceActivityKind === b.sourceActivityKind &&
    a.createdAt === b.createdAt &&
    areStringArraysUnchanged(a.changedFiles, b.changedFiles)
  );
}

function areStringArraysUnchanged(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  const aValues = a ?? [];
  const bValues = b ?? [];
  if (aValues.length !== bValues.length) {
    return false;
  }
  return aValues.every((value, index) => value === bValues[index]);
}
