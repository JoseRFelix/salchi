import { hasUnseenCompletion } from "./threadCompletion";
import type { SidebarThreadSummary } from "./types";

export type InboxThreadStatus =
  | "working"
  | "monitoring"
  | "approval"
  | "input"
  | "failed"
  | "woke"
  | "done"
  | "ready";

export type InboxBackgroundLiveness = "working" | "monitoring" | null;

export function classifyInboxBackgroundThread(
  thread: Pick<SidebarThreadSummary, "subagentKind" | "subagentNickname" | "subagentRole">,
): Exclude<InboxBackgroundLiveness, null> {
  const description = [thread.subagentKind, thread.subagentNickname, thread.subagentRole]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /\b(?:monitor|monitoring|watch|watching|poll|polling|tail|tailing|babysit)\b/i.test(
    description,
  )
    ? "monitoring"
    : "working";
}

function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }
  return null;
}

export function resolveInboxWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn?.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
}

export function formatInboxWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1_000)) : 0;
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function resolveInboxThreadStatus(input: {
  readonly thread: Pick<
    SidebarThreadSummary,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "latestTurn"
    | "seenCompletionTurnId"
    | "session"
  >;
  readonly hasActiveLocalDispatch: boolean;
  readonly isActive: boolean;
  readonly isWoke: boolean;
  readonly backgroundLiveness?: InboxBackgroundLiveness;
}): InboxThreadStatus {
  const { thread } = input;
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (
    input.hasActiveLocalDispatch ||
    thread.session?.status === "connecting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return "working";
  }
  if (input.backgroundLiveness === "working") {
    return "working";
  }
  if (input.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (input.isWoke) {
    return "woke";
  }
  if (!input.isActive && hasUnseenCompletion(thread)) {
    return "done";
  }
  return "ready";
}
