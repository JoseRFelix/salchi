import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { ScopedThreadRef } from "@salchi/contracts";
import { GitBranchIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";

import type { InboxChangeRequestSnapshot } from "../../inboxChangeRequest";
import { resolveInboxWokeAt } from "../../inboxLifecycle";
import { resolveInboxThreadStatus, type InboxBackgroundLiveness } from "../../inboxThreadStatus";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "../../lib/utils";
import { resolveSidebarThreadDisplayTitle } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { InboxThreadRowChangeRequestStatus } from "../ThreadStatusIndicators";
import type { InboxProjectIdentity } from "./InboxThreadRow";

const STATUS_LABELS = {
  working: "Working",
  monitoring: "Monitoring",
  approval: "Approval",
  input: "Input",
  failed: "Failed",
  woke: "Woke",
  done: "Done",
  ready: null,
} as const;

const STATUS_CLASSES = {
  working: "text-sky-600 dark:text-sky-400",
  monitoring: "text-sky-600 dark:text-sky-400",
  approval: "text-amber-700 dark:text-amber-300",
  input: "text-indigo-600 dark:text-indigo-300",
  failed: "text-red-700 dark:text-red-300",
  woke: "text-amber-700 dark:text-amber-300",
  done: "text-emerald-700 dark:text-emerald-300",
  ready: "text-muted-foreground/55",
} as const;

export function InboxSearchResultRow(props: {
  readonly optionId: string;
  readonly thread: SidebarThreadSummary;
  readonly lifecycleThread: SidebarThreadSummary;
  readonly projectIdentity: InboxProjectIdentity | null;
  readonly isDraft: boolean;
  readonly isActive: boolean;
  readonly isHighlighted: boolean;
  readonly hasActiveLocalDispatch: boolean;
  readonly backgroundLiveness: InboxBackgroundLiveness;
  readonly now: string;
  readonly lastVisitedAt: string | null;
  readonly changeRequestSnapshot: InboxChangeRequestSnapshot | null;
  readonly virtualized?: boolean;
  readonly listPosition?: number;
  readonly listSize?: number;
  readonly onNavigate: (threadRef: ScopedThreadRef, event: MouseEvent) => void;
  readonly onHighlight: () => void;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const wokeAt = resolveInboxWokeAt(props.lifecycleThread, props.now);
  const isWoke =
    wokeAt != null &&
    (props.lastVisitedAt == null || Date.parse(props.lastVisitedAt) < Date.parse(wokeAt));
  const status = resolveInboxThreadStatus({
    thread: props.thread,
    hasActiveLocalDispatch: props.hasActiveLocalDispatch,
    isActive: props.isActive,
    isWoke,
    backgroundLiveness: props.backgroundLiveness,
  });
  const statusLabel = STATUS_LABELS[status];
  const displayTitle = resolveSidebarThreadDisplayTitle(props.thread);
  const activityAt = props.thread.updatedAt ?? props.thread.createdAt;
  const Row = props.virtualized ? "div" : "li";

  return (
    <Row
      id={props.optionId}
      role="option"
      aria-selected={props.isHighlighted}
      aria-posinset={props.listPosition}
      aria-setsize={props.listSize}
      className="list-none"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <button
        type="button"
        className={cn(
          "flex h-12 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left outline-none",
          props.isActive && "bg-sidebar-row-active",
          props.isHighlighted && "bg-accent text-accent-foreground",
          !props.isActive && !props.isHighlighted && "hover:bg-accent/60",
        )}
        onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
          if (event.pointerType !== "touch") props.onHighlight();
        }}
        onClick={(event) => props.onNavigate(threadRef, event)}
      >
        {props.isDraft ? (
          <SquarePenIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
        ) : (
          <ProjectFavicon
            environmentId={props.thread.environmentId}
            cwd={props.projectIdentity?.cwd ?? ""}
            className="size-4 shrink-0"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{displayTitle}</span>
            {props.thread.branch ? (
              <InboxThreadRowChangeRequestStatus
                thread={props.thread}
                showNumber
                snapshot={props.changeRequestSnapshot}
              />
            ) : null}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/60">
            <span className="truncate">
              {props.projectIdentity?.displayName ?? "Unknown project"}
            </span>
            {props.thread.branch ? (
              <>
                <span aria-hidden>·</span>
                <GitBranchIcon className="size-2.5 shrink-0" />
                <span className="truncate">{props.thread.branch}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className={cn("shrink-0 text-[10px] font-medium", STATUS_CLASSES[status])}>
          {statusLabel ?? formatRelativeTimeLabel(activityAt)}
        </span>
      </button>
    </Row>
  );
}
