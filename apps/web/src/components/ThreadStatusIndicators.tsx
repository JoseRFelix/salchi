import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { VcsStatusResult } from "@salchi/contracts";
import { CloudIcon, GitPullRequestIcon, TerminalIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { useLocalDispatchStore } from "../localDispatchStore";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import {
  nextInboxChangeRequestSnapshot,
  type InboxChangeRequestSnapshot,
} from "../inboxChangeRequest";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  number: number;
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  if (pr.state === "open") {
    return {
      number: pr.number,
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      number: pr.number,
      label: `${presentation.shortName} closed`,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      number: pr.number,
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Change request state without the compact thread-status dot. Full inbox cards
 * use this alongside their t3code-style status slot.
 */
function useThreadChangeRequestStatus(
  thread: SidebarThreadSummary,
  options: {
    readonly snapshot?: InboxChangeRequestSnapshot | null;
    readonly onSnapshot?: ((snapshot: InboxChangeRequestSnapshot | null) => void) | undefined;
  } = {},
): PrStatusIndicator | null {
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const onSnapshotRef = useRef(options.onSnapshot);
  const snapshotRef = useRef(options.snapshot);
  onSnapshotRef.current = options.onSnapshot;
  snapshotRef.current = options.snapshot;

  useEffect(() => {
    const onSnapshot = onSnapshotRef.current;
    if (onSnapshot == null || gitStatus.data == null) return;
    const next = nextInboxChangeRequestSnapshot({
      threadBranch: thread.branch,
      gitStatus: gitStatus.data,
      previous: snapshotRef.current ?? null,
      observedAt: new Date().toISOString(),
    });
    onSnapshot(next);
  }, [gitStatus.data, thread.branch]);
  const currentPr = resolveThreadPr(thread.branch, gitStatus.data);
  const snapshotPr =
    options.snapshot?.branch === thread.branch ? (options.snapshot.pr ?? null) : null;
  const pr = currentPr ?? snapshotPr;
  return prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
}

function ThreadChangeRequestStatusView({
  status,
  showNumber = false,
}: {
  status: PrStatusIndicator;
  showNumber?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={status.url}
            target="_blank"
            rel="noreferrer"
            aria-label={status.tooltip}
            className={`inline-flex items-center justify-center gap-0.5 ${status.colorClass}`}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <ChangeRequestStatusIcon className="size-3" />
        {showNumber ? <span className="text-[10px] font-medium">#{status.number}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{status.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadRowChangeRequestStatus({
  thread,
  showNumber = false,
  snapshot = null,
  onSnapshot,
}: {
  thread: SidebarThreadSummary;
  showNumber?: boolean;
  snapshot?: InboxChangeRequestSnapshot | null;
  onSnapshot?: ((snapshot: InboxChangeRequestSnapshot | null) => void) | undefined;
}) {
  const prStatus = useThreadChangeRequestStatus(thread, { snapshot, onSnapshot });
  return prStatus ? (
    <ThreadChangeRequestStatusView status={prStatus} showNumber={showNumber} />
  ) : null;
}

/**
 * Pure change-request presentation for inbox rows. The inbox observes git
 * targets above the virtualized list, so mounting a row never starts work or
 * changes lifecycle classification.
 */
export function InboxThreadRowChangeRequestStatus({
  thread,
  showNumber = false,
  snapshot,
}: {
  thread: SidebarThreadSummary;
  showNumber?: boolean;
  snapshot: InboxChangeRequestSnapshot | null;
}) {
  const pr = snapshot?.branch === thread.branch ? snapshot.pr : null;
  const prStatus = prStatusIndicator(pr, null);
  return prStatus ? (
    <ThreadChangeRequestStatusView status={prStatus} showNumber={showNumber} />
  ) : null;
}

function useThreadTerminalStatus(thread: SidebarThreadSummary): TerminalStatusIndicator | null {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  return terminalStatusFromRunningIds(runningTerminalIds);
}

function ThreadTerminalStatusView({ status }: { status: TerminalStatusIndicator }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={status.label}
            className={`inline-flex items-center justify-center ${status.colorClass}`}
          />
        }
      >
        <TerminalIcon className={`size-3 ${status.pulse ? "animate-pulse" : ""}`} />
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadRowTerminalStatus({ thread }: { thread: SidebarThreadSummary }) {
  const status = useThreadTerminalStatus(thread);
  return status ? <ThreadTerminalStatusView status={status} /> : null;
}

export function ThreadRowRemoteStatus({ environmentLabel }: { environmentLabel: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span aria-label={environmentLabel} className="inline-flex items-center justify-center" />
        }
      >
        <CloudIcon className="size-3 text-muted-foreground/60" />
      </TooltipTrigger>
      <TooltipPopup side="top">{environmentLabel}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const hasActiveLocalDispatch = useLocalDispatchStore(
    (state) => state.localDispatchByThreadKey[threadKey] !== undefined,
  );
  const prStatus = useThreadChangeRequestStatus(thread);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      hasActiveLocalDispatch,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? <ThreadChangeRequestStatusView status={prStatus} /> : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const terminalStatus = useThreadTerminalStatus(thread);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? <ThreadTerminalStatusView status={terminalStatus} /> : null}
      {isRemoteThread ? (
        <ThreadRowRemoteStatus environmentLabel={threadEnvironmentLabel ?? "Remote"} />
      ) : null}
    </span>
  );
}
