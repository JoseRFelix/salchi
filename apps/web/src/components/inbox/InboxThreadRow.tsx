import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { ContextMenuItem, ScopedThreadRef } from "@salchi/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  RefreshCwIcon,
  SquarePenIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type SyntheticEvent } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  resolveInboxSnoozePresets,
  resolveInboxWokeAt,
  type InboxLifecycleSection,
  type InboxSnoozePresetId,
} from "../../inboxLifecycle";
import { resolveInboxRowVariant } from "../../inboxSidebarPresentation";
import type { InboxBackgroundLiveness } from "../../inboxThreadStatus";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { useLongPressContextMenu } from "../../hooks/useLongPressContextMenu";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { resolveSidebarThreadDisplayTitle, resolveThreadRowClassName } from "../Sidebar.logic";
import { InboxThreadStatus } from "../InboxThreadStatus";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  ThreadRowChangeRequestStatus,
  ThreadRowRemoteStatus,
  ThreadRowTerminalStatus,
} from "../ThreadStatusIndicators";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getFixedVirtualItemStyle } from "../virtualization/useSharedScrollVirtualizer";

export type InboxThreadAction =
  | "toggle-pin"
  | `snooze-${InboxSnoozePresetId}`
  | "unsnooze"
  | "toggle-settled"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "create-on-branch"
  | "copy-metadata"
  | "move-pin-up"
  | "move-pin-down"
  | "archive"
  | "delete"
  | "discard-draft";

export function snoozePresetIdFromInboxAction(
  action: InboxThreadAction,
): InboxSnoozePresetId | null {
  if (!action.startsWith("snooze-")) return null;
  const id = action.slice("snooze-".length);
  return id === "hour" ||
    id === "three-hours" ||
    id === "evening" ||
    id === "tomorrow" ||
    id === "next-week"
    ? id
    : null;
}

export interface InboxProjectIdentity {
  readonly cwd: string;
  readonly displayName: string;
  readonly environmentLabel: string | null;
}

interface InboxThreadRowProps {
  readonly thread: SidebarThreadSummary;
  readonly lifecycleThread: SidebarThreadSummary;
  readonly depth: number;
  readonly childCount: number;
  readonly section: InboxLifecycleSection;
  readonly projectIdentity: InboxProjectIdentity | null;
  readonly lifecycleThreadKey: string;
  readonly isLifecycleRoot: boolean;
  readonly isActive: boolean;
  readonly isDraft: boolean;
  readonly draftId: DraftId | null;
  readonly isSelected: boolean;
  readonly hasActiveLocalDispatch: boolean;
  readonly backgroundLiveness: InboxBackgroundLiveness;
  readonly isPending: boolean;
  readonly isThreadExpanded: boolean;
  readonly now: string;
  readonly canPin: boolean;
  readonly canSnooze: boolean;
  readonly canSettle: boolean;
  readonly canReorderPinned: boolean;
  readonly canRegenerateTitle: boolean;
  readonly canMarkUnread: boolean;
  readonly canMovePinUp: boolean;
  readonly canMovePinDown: boolean;
  readonly virtualIndex?: number;
  readonly virtualSetSize?: number;
  readonly virtualStride?: number;
  readonly onNavigate: (threadRef: ScopedThreadRef, event: React.MouseEvent) => void;
  readonly onAction: (
    action: InboxThreadAction,
    thread: SidebarThreadSummary,
    lifecycleThreadKey: string,
  ) => void;
  readonly onToggleExpanded: (threadKey: string) => void;
  readonly onPinnedDragStart: (lifecycleThreadKey: string) => void;
  readonly onPinnedDrop: (targetLifecycleThreadKey: string) => void;
}

function lifecycleActionItems(input: {
  readonly isBusy: boolean;
  readonly isDraft: boolean;
  readonly isPinned: boolean;
  readonly section: InboxLifecycleSection;
  readonly canPin: boolean;
  readonly canSnooze: boolean;
  readonly canSettle: boolean;
  readonly canRegenerateTitle: boolean;
  readonly canMarkUnread: boolean;
  readonly hasBranch: boolean;
}): ContextMenuItem<InboxThreadAction>[] {
  if (input.isDraft) {
    return [{ id: "discard-draft", label: "Discard draft", destructive: true, icon: "trash" }];
  }
  const snoozeItems = resolveInboxSnoozePresets(new Date()).map(
    (preset) =>
      ({
        id: `snooze-${preset.id}`,
        label: `${preset.label} · ${preset.whenLabel}`,
        disabled: !input.canSnooze || input.isBusy,
      }) satisfies ContextMenuItem<InboxThreadAction>,
  );
  return [
    {
      id: "toggle-pin",
      label: input.isPinned ? "Unpin" : "Pin",
      disabled: !input.canPin,
    },
    ...(input.section === "snoozed"
      ? ([
          { id: "unsnooze", label: "Wake now", disabled: !input.canSnooze },
        ] satisfies ContextMenuItem<InboxThreadAction>[])
      : snoozeItems),
    {
      id: "toggle-settled",
      label: input.section === "settled" ? "Move to active" : "Settle",
      disabled: !input.canSettle || input.isBusy,
    },
    { id: "rename", label: "Rename" },
    {
      id: "regenerate-title",
      label: "Regenerate title",
      disabled: !input.canRegenerateTitle || input.isBusy,
    },
    { id: "mark-unread", label: "Mark unread", disabled: !input.canMarkUnread },
    {
      id: "create-on-branch",
      label: "Create thread on this branch",
      disabled: !input.hasBranch,
    },
    { id: "copy-metadata", label: "Copy metadata" },
    { id: "archive", label: "Archive", disabled: input.isBusy },
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  ];
}

function SnoozeMenu(props: {
  readonly disabled: boolean;
  readonly onAction: (action: InboxThreadAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(() => (open ? resolveInboxSnoozePresets(new Date()) : []), [open]);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Snooze thread"
              disabled={props.disabled}
              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <AlarmClockIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Snooze</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => props.onAction(`snooze-${preset.id}`)}>
            <AlarmClockIcon />
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {preset.whenLabel}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function AdvancedActionsMenu(props: {
  readonly thread: SidebarThreadSummary;
  readonly isBusy: boolean;
  readonly isPinned: boolean;
  readonly section: InboxLifecycleSection;
  readonly canPin: boolean;
  readonly canRegenerateTitle: boolean;
  readonly canMarkUnread: boolean;
  readonly canMovePinUp: boolean;
  readonly canMovePinDown: boolean;
  readonly onAction: (action: InboxThreadAction) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={`More actions for ${resolveSidebarThreadDisplayTitle(props.thread)}`}
              data-thread-selection-safe
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">More actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuItem disabled={!props.canPin} onClick={() => props.onAction("toggle-pin")}>
          <PinIcon />
          {props.isPinned ? "Unpin" : "Pin"}
        </MenuItem>
        {props.isPinned ? (
          <>
            <MenuItem disabled={!props.canMovePinUp} onClick={() => props.onAction("move-pin-up")}>
              <ArrowUpIcon />
              Move up
            </MenuItem>
            <MenuItem
              disabled={!props.canMovePinDown}
              onClick={() => props.onAction("move-pin-down")}
            >
              <ArrowDownIcon />
              Move down
            </MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => props.onAction("rename")}>
          <PencilIcon />
          Rename
        </MenuItem>
        <MenuItem
          disabled={!props.canRegenerateTitle || props.isBusy}
          onClick={() => props.onAction("regenerate-title")}
        >
          <RefreshCwIcon />
          Regenerate title
        </MenuItem>
        <MenuItem disabled={!props.canMarkUnread} onClick={() => props.onAction("mark-unread")}>
          <Undo2Icon />
          Mark unread
        </MenuItem>
        <MenuItem
          disabled={props.thread.branch === null}
          onClick={() => props.onAction("create-on-branch")}
        >
          <GitBranchIcon />
          Create on this branch
        </MenuItem>
        <MenuItem onClick={() => props.onAction("copy-metadata")}>
          <ClipboardCopyIcon />
          Copy metadata
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={props.isBusy} onClick={() => props.onAction("archive")}>
          <ArchiveIcon />
          Archive
        </MenuItem>
        <MenuItem variant="destructive" onClick={() => props.onAction("delete")}>
          <Trash2Icon />
          Delete
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export const InboxThreadRow = memo(function InboxThreadRow(props: InboxThreadRowProps) {
  const { thread, lifecycleThread, depth, childCount } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const draftPrompt = useComposerDraftStore((state) =>
    props.draftId === null ? "" : (state.draftsByThreadKey[props.draftId]?.prompt ?? ""),
  );
  const activityAt = thread.updatedAt ?? thread.createdAt;
  const isWoke = resolveInboxWokeAt(lifecycleThread, props.now) !== null;
  const isPinned = lifecycleThread.pinnedAt != null;
  const isBusy =
    props.isPending ||
    (thread.session?.status === "running" && thread.session.activeTurnId != null);
  const displayTitle = resolveSidebarThreadDisplayTitle(thread);
  const lifecycleLabel =
    props.section === "snoozed" && lifecycleThread.snoozedUntil
      ? formatRelativeTimeLabel(lifecycleThread.snoozedUntil)
      : props.section === "settled" && lifecycleThread.settledAt
        ? formatRelativeTimeLabel(lifecycleThread.settledAt)
        : null;
  const rowVariant = resolveInboxRowVariant(props.section);
  const projectName = props.projectIdentity?.displayName ?? "Unknown project";
  const runAction = useCallback(
    (action: InboxThreadAction) => props.onAction(action, thread, props.lifecycleThreadKey),
    [props, thread],
  );

  const openContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        lifecycleActionItems({
          isBusy,
          isDraft: props.isDraft,
          isPinned,
          section: props.section,
          canPin: props.canPin,
          canSnooze: props.canSnooze,
          canSettle: props.canSettle,
          canRegenerateTitle: props.canRegenerateTitle,
          canMarkUnread: props.canMarkUnread,
          hasBranch: thread.branch !== null,
        }),
        position,
      );
      if (clicked) runAction(clicked);
    },
    [isBusy, isPinned, props, runAction, thread.branch],
  );
  const longPress = useLongPressContextMenu<HTMLButtonElement>({
    enabled: true,
    onLongPress: openContextMenu,
  });
  const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();
  const expandControl =
    childCount > 0 ? (
      <button
        type="button"
        data-thread-selection-safe
        aria-label={props.isThreadExpanded ? `Collapse ${displayTitle}` : `Expand ${displayTitle}`}
        aria-expanded={props.isThreadExpanded}
        className="-ml-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onPointerDown={stopPropagation}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onToggleExpanded(threadKey);
        }}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform duration-150",
            props.isThreadExpanded && "rotate-90",
          )}
        />
      </button>
    ) : null;

  if (props.isDraft) {
    const preview = draftPrompt.trim().split("\n", 1)[0]?.trim() || displayTitle;
    return (
      <SidebarMenuItem
        className="list-none py-0.5"
        data-thread-item
        data-testid={`inbox-thread-row-${thread.id}`}
      >
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "group/inbox-draft relative cursor-pointer overflow-hidden rounded-md px-2.5 py-2 outline-none",
            props.isActive
              ? "bg-sidebar-row-active"
              : "bg-amber-400/[0.06] hover:bg-amber-400/[0.11]",
            props.isSelected && "ring-1 ring-amber-500/60",
          )}
          onClick={(event) => props.onNavigate(threadRef, event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onNavigate(threadRef, event as unknown as React.MouseEvent);
            }
          }}
        >
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon className="size-3 shrink-0 text-amber-600 dark:text-amber-300/80" />
            <ProjectFavicon
              environmentId={thread.environmentId}
              cwd={props.projectIdentity?.cwd ?? ""}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              {projectName}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Discard draft"
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/inbox-draft:opacity-100 max-sm:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      runAction("discard-draft");
                    }}
                  />
                }
              >
                <XIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Discard draft</TooltipPopup>
            </Tooltip>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{preview}</div>
        </div>
      </SidebarMenuItem>
    );
  }

  const hoverActions = (
    <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/inbox-row:opacity-100 group-focus-within/inbox-row:opacity-100 max-sm:opacity-100">
      {props.section === "snoozed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Wake thread"
                disabled={!props.canSnooze}
                className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                onClick={(event) => {
                  event.stopPropagation();
                  runAction("unsnooze");
                }}
              />
            }
          >
            <AlarmClockOffIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Wake now</TooltipPopup>
        </Tooltip>
      ) : props.section !== "settled" ? (
        <SnoozeMenu disabled={!props.canSnooze || isBusy} onAction={runAction} />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={props.section === "settled" ? "Move to active" : "Settle thread"}
              disabled={!props.canSettle || isBusy}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(event) => {
                event.stopPropagation();
                runAction("toggle-settled");
              }}
            />
          }
        >
          {props.section === "settled" ? (
            <Undo2Icon className="size-3.5" />
          ) : (
            <CheckIcon className="size-3.5" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {props.section === "settled" ? "Move to active" : "Settle"}
        </TooltipPopup>
      </Tooltip>
      <AdvancedActionsMenu
        thread={thread}
        isBusy={isBusy}
        isPinned={isPinned}
        section={props.section}
        canPin={props.canPin}
        canRegenerateTitle={props.canRegenerateTitle}
        canMarkUnread={props.canMarkUnread}
        canMovePinUp={props.canMovePinUp}
        canMovePinDown={props.canMovePinDown}
        onAction={runAction}
      />
    </span>
  );
  const statusSlot = (
    <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
      <span className="flex min-w-0 items-center gap-1 group-hover/inbox-row:hidden group-focus-within/inbox-row:hidden max-sm:hidden">
        {isPinned ? (
          <PinIcon aria-label="Pinned" className="size-3 text-muted-foreground/65" />
        ) : null}
        {rowVariant === "card" ? (
          <InboxThreadStatus
            activityAt={activityAt}
            hasActiveLocalDispatch={props.hasActiveLocalDispatch}
            backgroundLiveness={props.backgroundLiveness}
            isActive={props.isActive}
            isWoke={isWoke}
            thread={thread}
          />
        ) : null}
        <ThreadRowTerminalStatus thread={thread} />
        {props.projectIdentity?.environmentLabel ? (
          <ThreadRowRemoteStatus environmentLabel={props.projectIdentity.environmentLabel} />
        ) : null}
      </span>
      {hoverActions}
    </div>
  );
  const draggable = props.section === "pinned" && props.isLifecycleRoot && props.canReorderPinned;

  return (
    <SidebarMenuItem
      className={cn(
        "group/inbox-row list-none rounded-md py-0.5 [content-visibility:auto]",
        rowVariant === "card"
          ? "[contain-intrinsic-size:auto_82px]"
          : "[contain-intrinsic-size:auto_40px]",
      )}
      data-thread-item
      data-selected={props.isSelected ? "true" : undefined}
      data-virtual-index={props.virtualIndex}
      data-testid={`inbox-thread-row-${thread.id}`}
      aria-posinset={props.virtualIndex === undefined ? undefined : props.virtualIndex + 1}
      aria-setsize={props.virtualSetSize}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        event.dataTransfer.effectAllowed = "move";
        props.onPinnedDragStart(props.lifecycleThreadKey);
      }}
      onDragOver={(event) => {
        if (draggable) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!draggable) return;
        event.preventDefault();
        props.onPinnedDrop(props.lifecycleThreadKey);
      }}
      style={
        props.virtualIndex === undefined || props.virtualStride === undefined
          ? undefined
          : getFixedVirtualItemStyle(props.virtualIndex, props.virtualStride)
      }
    >
      <SidebarMenuButton
        render={<div role="button" tabIndex={0} />}
        isActive={props.isActive}
        className={cn(
          resolveThreadRowClassName({
            isActive: props.isActive,
            isSelected: props.isSelected,
            isDraft: false,
          }),
          rowVariant === "card"
            ? "h-[4.875rem] items-stretch rounded-md px-2.5 py-2"
            : "h-9 items-center gap-2 rounded-md px-2.5 py-1",
          props.section === "settled" && !props.isActive && "opacity-70",
          draggable && "cursor-grab active:cursor-grabbing",
        )}
        onClick={(event) => props.onNavigate(threadRef, event)}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            props.onNavigate(threadRef, event as unknown as React.MouseEvent);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void openContextMenu({ x: event.clientX, y: event.clientY });
        }}
        {...longPress}
      >
        {rowVariant === "card" ? (
          <div className={cn("flex min-w-0 flex-1 flex-col justify-center", depth > 0 && "pl-3")}>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/65">
              {draggable ? <GripVerticalIcon className="-ml-1 size-3 shrink-0 opacity-40" /> : null}
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectIdentity?.cwd ?? ""}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 truncate">{projectName}</span>
              {props.projectIdentity?.environmentLabel ? (
                <span className="min-w-0 truncate">· {props.projectIdentity.environmentLabel}</span>
              ) : null}
              {statusSlot}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              {expandControl}
              {depth > 0 ? (
                <GitBranchIcon
                  aria-label="Subagent"
                  className="size-3 shrink-0 text-muted-foreground/55"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={displayTitle}>
                {displayTitle}
              </span>
              {thread.branch !== null ? (
                <ThreadRowChangeRequestStatus thread={thread} showNumber />
              ) : null}
            </div>
            <div className="mt-0.5 flex min-h-4 min-w-0 items-center gap-2 text-[10px] text-muted-foreground/55">
              {thread.branch ? (
                <span className="flex min-w-0 items-center gap-1">
                  <GitBranchIcon className="size-3 shrink-0" />
                  <span className="truncate">{thread.branch}</span>
                </span>
              ) : null}
              {thread.worktreePath ? (
                <Tooltip>
                  <TooltipTrigger render={<FolderGit2Icon className="size-3 shrink-0" />} />
                  <TooltipPopup side="top">Worktree: {thread.worktreePath}</TooltipPopup>
                </Tooltip>
              ) : null}
              {thread.modelSelection ? (
                <span
                  className="flex min-w-0 items-center gap-1"
                  title={thread.modelSelection.instanceId}
                >
                  <BotIcon className="size-3 shrink-0" />
                  <span className="max-w-20 truncate">{thread.modelSelection.instanceId}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <ProjectFavicon
              environmentId={thread.environmentId}
              cwd={props.projectIdentity?.cwd ?? ""}
              className="size-4 shrink-0"
            />
            {expandControl}
            {depth > 0 ? (
              <GitBranchIcon className="size-3 shrink-0 text-muted-foreground/55" />
            ) : null}
            <span className="min-w-8 flex-1 truncate text-[13px]" title={displayTitle}>
              {displayTitle}
            </span>
            <span className="max-w-16 shrink truncate text-[10px] text-muted-foreground/55">
              {projectName}
            </span>
            {lifecycleLabel ? (
              <span className="shrink-0 text-[10px] text-muted-foreground/55">
                {lifecycleLabel}
              </span>
            ) : null}
            {statusSlot}
          </>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
