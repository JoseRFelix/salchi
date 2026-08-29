import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PinIcon,
  SearchIcon,
  SquarePenIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@salchi/client-runtime";
import type { ContextMenuItem, ScopedThreadRef } from "@salchi/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useSidebarThreadPresentation } from "../hooks/useSidebarThreadPresentation";
import { useSidebarLocalDispatchReconciliation } from "../hooks/useSidebarLocalDispatchReconciliation";
import { useThreadActions } from "../hooks/useThreadActions";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useLongPressContextMenu } from "../hooks/useLongPressContextMenu";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildInboxLifecycleThreadKeyByThreadKey,
  getNextInboxWakeAtMs,
  partitionInboxThreads,
  resolveInboxSnoozeUntil,
  type InboxLifecycleSection,
  type InboxSnoozePreset,
  useInboxLifecycleStore,
} from "../inboxLifecycle";
import {
  INBOX_SETTLED_SHELF_DEFAULT_EXPANDED,
  INBOX_SETTLED_SHELF_EXPANDED_KEY,
  INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED,
  INBOX_SNOOZED_SHELF_EXPANDED_KEY,
  inboxShelfLabel,
  resolveInboxRowVariant,
  resolveInboxShelfItems,
} from "../inboxSidebarPresentation";
import {
  resolveShortcutCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { selectProjectGroupingSettings } from "../logicalProject";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { readLocalApi } from "../localApi";
import { readEnvironmentApi } from "../environmentApi";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  flattenSidebarThreadTree,
  resolveAdjacentThreadId,
  resolveSidebarThreadDisplayTitle,
  resolveThreadRowClassName,
  type SidebarThreadTreeItem,
} from "./Sidebar.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarUsageBackgroundRefresh } from "./sidebar/SidebarUsageIndicator";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useServerKeybindings } from "../rpc/serverState";

const ALL_PROJECTS_SCOPE = "__salchi_inbox_all_projects__";
const MAX_WAKE_TIMEOUT_MS = 2_147_483_647;

type InboxThreadAction =
  | "toggle-pin"
  | "snooze-one-hour"
  | "snooze-tomorrow"
  | "snooze-one-week"
  | "unsnooze"
  | "toggle-settled"
  | "archive"
  | "delete"
  | "discard-draft";

interface InboxProjectIdentity {
  readonly cwd: string;
  readonly displayName: string;
  readonly environmentLabel: string | null;
}

interface InboxThreadRowProps {
  readonly thread: SidebarThreadSummary;
  readonly depth: number;
  readonly childCount: number;
  readonly section: InboxLifecycleSection;
  readonly projectIdentity: InboxProjectIdentity | null;
  readonly lifecycleThreadKey: string;
  readonly isActive: boolean;
  readonly isDraft: boolean;
  readonly isPending: boolean;
  readonly isThreadExpanded: boolean;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
  readonly onAction: (
    action: InboxThreadAction,
    thread: SidebarThreadSummary,
    lifecycleThreadKey: string,
  ) => void;
  readonly onToggleExpanded: (threadKey: string) => void;
}

function lifecycleActionItems(input: {
  readonly isBusy: boolean;
  readonly isDraft: boolean;
  readonly isPending: boolean;
  readonly isPinned: boolean;
  readonly section: InboxLifecycleSection;
}): ContextMenuItem<InboxThreadAction>[] {
  if (input.isDraft) {
    return [
      {
        id: "discard-draft",
        label: "Discard draft",
        destructive: true,
        icon: "trash",
      },
    ];
  }
  if (input.isPending) {
    return [];
  }
  return [
    { id: "toggle-pin", label: input.isPinned ? "Unpin" : "Pin" },
    ...(input.section === "snoozed"
      ? ([{ id: "unsnooze", label: "Wake now" }] satisfies ContextMenuItem<InboxThreadAction>[])
      : ([
          { id: "snooze-one-hour", label: "Snooze for 1 hour" },
          { id: "snooze-tomorrow", label: "Snooze until tomorrow" },
          { id: "snooze-one-week", label: "Snooze for 1 week" },
        ] satisfies ContextMenuItem<InboxThreadAction>[])),
    {
      id: "toggle-settled",
      label: input.section === "settled" ? "Move to active" : "Settle",
      ...(input.isBusy ? { disabled: true } : {}),
    },
    {
      id: "archive",
      label: "Archive",
      ...(input.isBusy ? { disabled: true } : {}),
    },
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  ];
}

function InboxThreadActionsMenu(props: {
  readonly thread: SidebarThreadSummary;
  readonly lifecycleThreadKey: string;
  readonly isBusy: boolean;
  readonly isDraft: boolean;
  readonly isPending: boolean;
  readonly isPinned: boolean;
  readonly section: InboxLifecycleSection;
  readonly onAction: InboxThreadRowProps["onAction"];
}) {
  const run = (action: InboxThreadAction) =>
    props.onAction(action, props.thread, props.lifecycleThreadKey);
  const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();

  if (props.isPending && !props.isDraft) {
    return null;
  }

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={`Actions for ${resolveSidebarThreadDisplayTitle(props.thread)}`}
              data-thread-selection-safe
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={stopPropagation}
              onClick={stopPropagation}
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Thread actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        {props.isDraft ? (
          <MenuItem variant="destructive" onClick={() => run("discard-draft")}>
            <Trash2Icon />
            Discard draft
          </MenuItem>
        ) : (
          <>
            <MenuItem onClick={() => run("toggle-pin")}>
              <PinIcon />
              {props.isPinned ? "Unpin" : "Pin"}
            </MenuItem>
            {props.section === "snoozed" ? (
              <MenuItem onClick={() => run("unsnooze")}>
                <AlarmClockOffIcon />
                Wake now
              </MenuItem>
            ) : (
              <>
                <MenuItem onClick={() => run("snooze-one-hour")}>
                  <AlarmClockIcon />
                  Snooze for 1 hour
                </MenuItem>
                <MenuItem onClick={() => run("snooze-tomorrow")}>
                  <AlarmClockIcon />
                  Snooze until tomorrow
                </MenuItem>
                <MenuItem onClick={() => run("snooze-one-week")}>
                  <AlarmClockIcon />
                  Snooze for 1 week
                </MenuItem>
              </>
            )}
            <MenuItem disabled={props.isBusy} onClick={() => run("toggle-settled")}>
              {props.section === "settled" ? <Undo2Icon /> : <CheckIcon />}
              {props.section === "settled" ? "Move to active" : "Settle"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={props.isBusy} onClick={() => run("archive")}>
              <ArchiveIcon />
              Archive
            </MenuItem>
            <MenuItem variant="destructive" onClick={() => run("delete")}>
              <Trash2Icon />
              Delete
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

const InboxThreadRow = memo(function InboxThreadRow(props: InboxThreadRowProps) {
  const { thread, depth, childCount } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const lifecycle = useInboxLifecycleStore(
    (state) => state.lifecycleByThreadKey[props.lifecycleThreadKey],
  );
  const isPinned = lifecycle?.pinnedAt !== null && lifecycle?.pinnedAt !== undefined;
  const isBusy =
    props.isPending ||
    (thread.session?.status === "running" && thread.session.activeTurnId != null);
  const displayTitle = resolveSidebarThreadDisplayTitle(thread);
  const lifecycleLabel =
    props.section === "snoozed" && lifecycle?.snoozedUntil
      ? formatRelativeTimeLabel(lifecycle.snoozedUntil)
      : props.section === "settled" && lifecycle?.settledAt
        ? formatRelativeTimeLabel(lifecycle.settledAt)
        : null;
  const lifecycleTitle =
    props.section === "snoozed" && lifecycleLabel
      ? `Wakes ${lifecycleLabel}`
      : props.section === "settled" && lifecycleLabel
        ? `Settled ${lifecycleLabel}`
        : undefined;
  const rowVariant = resolveInboxRowVariant(props.section);
  const projectName = props.projectIdentity?.displayName ?? "Unknown project";

  const handleActivate = useCallback(
    (_event: React.MouseEvent) => {
      props.onNavigate(threadRef);
    },
    [props, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
        return;
      }
      event.preventDefault();
      props.onNavigate(threadRef);
    },
    [props, threadRef],
  );
  const openContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const items = lifecycleActionItems({
        isBusy,
        isDraft: props.isDraft,
        isPending: props.isPending,
        isPinned,
        section: props.section,
      });
      if (items.length === 0) {
        return;
      }
      const clicked = await api.contextMenu.show(items, position);
      if (clicked) {
        props.onAction(clicked, thread, props.lifecycleThreadKey);
      }
    },
    [isBusy, isPinned, props, thread],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      void openContextMenu({ x: event.clientX, y: event.clientY });
    },
    [openContextMenu],
  );
  const {
    onClickCapture,
    onContextMenuCapture,
    onPointerCancelCapture,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
  } = useLongPressContextMenu<HTMLButtonElement>({
    enabled: !props.isPending || props.isDraft,
    onLongPress: openContextMenu,
  });
  const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();
  const toggleExpanded = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    props.onToggleExpanded(threadKey);
  };
  const expandControl =
    childCount > 0 ? (
      <button
        type="button"
        data-thread-selection-safe
        aria-label={props.isThreadExpanded ? `Collapse ${displayTitle}` : `Expand ${displayTitle}`}
        aria-expanded={props.isThreadExpanded}
        className="-ml-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onPointerDown={stopPropagation}
        onClick={toggleExpanded}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform duration-150",
            props.isThreadExpanded && "rotate-90",
          )}
        />
      </button>
    ) : null;
  const actionsSlot = (
    <div className="flex shrink-0 items-center gap-1 self-center">
      <span className="flex items-center gap-1 group-hover/inbox-row:hidden group-focus-within/inbox-row:hidden max-sm:hidden">
        {isPinned ? <PinIcon aria-label="Pinned" className="size-3 text-amber-600" /> : null}
        <ThreadRowTrailingStatus thread={thread} />
      </span>
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/inbox-row:opacity-100 group-focus-within/inbox-row:opacity-100 max-sm:opacity-100">
        {isPinned ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  aria-label={`Unpin ${displayTitle}`}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-amber-600 hover:bg-accent focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  onPointerDown={stopPropagation}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onAction("toggle-pin", thread, props.lifecycleThreadKey);
                  }}
                />
              }
            >
              <PinIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Unpin</TooltipPopup>
          </Tooltip>
        ) : null}
        <InboxThreadActionsMenu
          thread={thread}
          lifecycleThreadKey={props.lifecycleThreadKey}
          isBusy={isBusy}
          isDraft={props.isDraft}
          isPending={props.isPending}
          isPinned={isPinned}
          section={props.section}
          onAction={props.onAction}
        />
      </span>
    </div>
  );

  return (
    <SidebarMenuItem
      className="group/inbox-row list-none rounded-md py-0.5"
      data-thread-item
      data-testid={`inbox-thread-row-${thread.id}`}
    >
      <SidebarMenuButton
        render={<div role="button" tabIndex={0} />}
        isActive={props.isActive}
        className={cn(
          resolveThreadRowClassName({
            isActive: props.isActive,
            isSelected: false,
            isDraft: props.isDraft,
          }),
          rowVariant === "card"
            ? "h-auto min-h-[4.875rem] items-stretch rounded-md px-2.5 py-2"
            : "h-9 items-center gap-2 rounded-md px-2.5 py-1",
          props.section === "settled" && !props.isActive && "opacity-65",
        )}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        onClickCapture={onClickCapture}
        onContextMenuCapture={onContextMenuCapture}
        onPointerCancelCapture={onPointerCancelCapture}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={onPointerUpCapture}
      >
        {rowVariant === "card" ? (
          <div className={cn("flex min-w-0 flex-1 flex-col justify-center", depth > 0 && "pl-3")}>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/65">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectIdentity?.cwd ?? ""}
                className="size-4"
              />
              <span className="min-w-0 truncate">{projectName}</span>
              {props.projectIdentity?.environmentLabel ? (
                <span className="min-w-0 truncate">· {props.projectIdentity.environmentLabel}</span>
              ) : null}
              <div className="ml-auto">{actionsSlot}</div>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              {expandControl}
              {depth > 0 ? (
                <GitBranchIcon
                  aria-label="Subagent"
                  className="size-3 shrink-0 text-muted-foreground/55"
                />
              ) : null}
              <ThreadRowLeadingStatus thread={thread} />
              <span
                className="min-w-0 flex-1 truncate text-[13px] font-medium"
                title={displayTitle}
              >
                {displayTitle}
              </span>
              {props.isDraft ? (
                <span className="shrink-0 rounded-full border border-muted-foreground/25 px-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Draft
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex min-h-4 min-w-0 items-center gap-1.5 pl-0.5 text-[10px] text-muted-foreground/55">
              {thread.branch ? (
                <>
                  <GitBranchIcon className="size-3 shrink-0" />
                  <span className="truncate">{thread.branch}</span>
                </>
              ) : props.isDraft ? (
                <span>Unsent draft</span>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <ProjectFavicon
              environmentId={thread.environmentId}
              cwd={props.projectIdentity?.cwd ?? ""}
              className="size-4"
            />
            {expandControl}
            {depth > 0 ? (
              <GitBranchIcon
                aria-label="Subagent"
                className="size-3 shrink-0 text-muted-foreground/55"
              />
            ) : null}
            <ThreadRowLeadingStatus thread={thread} />
            <span className="min-w-8 flex-1 truncate text-[13px]" title={displayTitle}>
              {displayTitle}
            </span>
            <span
              className="max-w-16 shrink truncate text-[10px] text-muted-foreground/55"
              title={projectName}
            >
              {projectName}
            </span>
            {lifecycleLabel ? (
              <span
                className="shrink-0 text-[10px] text-muted-foreground/55"
                title={lifecycleTitle}
              >
                {lifecycleLabel}
              </span>
            ) : null}
            {actionsSlot}
          </>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});

function InboxShelf(props: {
  readonly title: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly tone: "snoozed" | "settled";
  readonly onToggle: () => void;
}) {
  if (props.count === 0) {
    return null;
  }
  return (
    <SidebarMenuItem className="list-none py-1.5">
      <button
        type="button"
        aria-expanded={props.expanded}
        data-testid={`inbox-${props.tone}-shelf-toggle`}
        className="flex w-full cursor-pointer items-center gap-2 px-2 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onClick={props.onToggle}
      >
        <span
          className={cn(
            "shrink-0 text-[10px] font-medium uppercase tracking-wider",
            props.tone === "snoozed" && "text-blue-600 dark:text-blue-400",
            props.tone === "settled" && "text-muted-foreground/55",
          )}
        >
          {inboxShelfLabel(props.title, props.count, props.expanded)}
        </span>
        <span
          className={cn(
            "h-px flex-1",
            props.tone === "snoozed" ? "bg-blue-500/35" : "bg-sidebar-border/70",
          )}
        />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            props.expanded && "rotate-180",
          )}
        />
      </button>
    </SidebarMenuItem>
  );
}

export default function InboxSidebar() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const serverThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const { threads, pendingThreadKeys, draftThreadKeys, draftIdByThreadKey } =
    useSidebarThreadPresentation(serverThreads);
  useSidebarLocalDispatchReconciliation(threads);
  const lifecycleByThreadKey = useInboxLifecycleStore((state) => state.lifecycleByThreadKey);
  const dispatchLifecycle = useInboxLifecycleStore((state) => state.dispatch);
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const confirmThreadArchive = useSettings((settings) => settings.confirmThreadArchive);
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const { archiveThread, deleteThread } = useThreadActions();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const toggleThreadExpanded = useUiStateStore((state) => state.toggleThreadExpanded);
  const threadExpandedById = useUiStateStore((state) => state.threadExpandedById);
  const openCommandPalette = useCommandPaletteStore((state) => state.setOpen);
  const openAddProject = useCommandPaletteStore((state) => state.openAddProject);
  const { handleNewThread } = useNewThreadHandler();
  const keybindings = useServerKeybindings();
  const modelPickerOpen = useModelPickerOpen();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftSession = useComposerDraftStore((state) =>
    routeTarget?.kind === "draft"
      ? (state.draftThreadsByThreadKey[routeTarget.draftId] ?? null)
      : null,
  );
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const routeThreadRef = useMemo(
    () =>
      routeTarget?.kind === "server"
        ? routeTarget.threadRef
        : routeDraftSession
          ? scopeThreadRef(routeDraftSession.environmentId, routeDraftSession.threadId)
          : null,
    [routeDraftSession, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    INBOX_SNOOZED_SHELF_EXPANDED_KEY,
    INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED,
    Schema.Boolean,
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    INBOX_SETTLED_SHELF_EXPANDED_KEY,
    INBOX_SETTLED_SHELF_DEFAULT_EXPANDED,
    Schema.Boolean,
  );

  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) =>
          savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ??
          savedEnvironmentRegistry[environmentId]?.label ??
          null,
      }).toSorted(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.projectKey.localeCompare(right.projectKey),
      ),
    [
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
    ],
  );
  const scopedProject = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectRefKeys = useMemo(
    () =>
      scopedProject === null
        ? null
        : new Set(scopedProject.memberProjectRefs.map((ref) => scopedProjectKey(ref))),
    [scopedProject],
  );
  const projectIdentityByScopedKey = useMemo(() => {
    const identities = new Map<string, InboxProjectIdentity>();
    for (const group of projectGroups) {
      for (const member of group.memberProjects) {
        identities.set(scopedProjectKey(scopeProjectRef(member.environmentId, member.id)), {
          cwd: member.cwd,
          displayName: group.displayName,
          environmentLabel:
            primaryEnvironmentId !== null && member.environmentId !== primaryEnvironmentId
              ? (member.environmentLabel ?? "Remote")
              : null,
        });
      }
    }
    return identities;
  }, [primaryEnvironmentId, projectGroups]);
  const scopedThreads = useMemo(
    () =>
      scopedProjectRefKeys === null
        ? threads
        : threads.filter((thread) =>
            scopedProjectRefKeys.has(
              scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
            ),
          ),
    [scopedProjectRefKeys, threads],
  );
  const partitions = useMemo(
    () =>
      partitionInboxThreads({ threads: scopedThreads, lifecycleByThreadKey, draftThreadKeys, now }),
    [draftThreadKeys, lifecycleByThreadKey, now, scopedThreads],
  );
  const lifecycleThreadKeyByThreadKey = useMemo(
    () => buildInboxLifecycleThreadKeyByThreadKey(scopedThreads),
    [scopedThreads],
  );
  const sectionItems = useMemo(() => {
    const flatten = (sectionThreads: readonly SidebarThreadSummary[]) =>
      flattenSidebarThreadTree(sectionThreads, {
        isThreadCollapsed: (thread) =>
          threadExpandedById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))] ===
          false,
      });
    return {
      drafts: flatten(partitions.drafts),
      pinned: flatten(partitions.pinned),
      active: flatten(partitions.active),
      snoozed: flatten(partitions.snoozed),
      settled: flatten(partitions.settled),
    };
  }, [partitions, threadExpandedById]);
  const visibleSnoozedItems = useMemo(
    () =>
      resolveInboxShelfItems({
        items: sectionItems.snoozed,
        expanded: snoozedShelfExpanded,
        activeKey: routeThreadKey,
        getKey: (item) =>
          scopedThreadKey(scopeThreadRef(item.thread.environmentId, item.thread.id)),
      }),
    [routeThreadKey, sectionItems.snoozed, snoozedShelfExpanded],
  );
  const visibleSettledItems = useMemo(
    () =>
      resolveInboxShelfItems({
        items: sectionItems.settled,
        expanded: settledShelfExpanded,
        activeKey: routeThreadKey,
        getKey: (item) =>
          scopedThreadKey(scopeThreadRef(item.thread.environmentId, item.thread.id)),
      }),
    [routeThreadKey, sectionItems.settled, settledShelfExpanded],
  );
  const orderedItems = useMemo(
    () => [
      ...sectionItems.drafts,
      ...sectionItems.pinned,
      ...sectionItems.active,
      ...visibleSnoozedItems,
      ...visibleSettledItems,
    ],
    [
      sectionItems.active,
      sectionItems.drafts,
      sectionItems.pinned,
      visibleSettledItems,
      visibleSnoozedItems,
    ],
  );
  const orderedThreadKeys = useMemo(
    () =>
      orderedItems.map((item) =>
        scopedThreadKey(scopeThreadRef(item.thread.environmentId, item.thread.id)),
      ),
    [orderedItems],
  );
  const threadByKey = useMemo(
    () =>
      new Map(
        scopedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [scopedThreads],
  );

  useEffect(() => {
    if (projectScopeKey !== null && scopedProject === null) {
      setProjectScopeKey(null);
    }
  }, [projectScopeKey, scopedProject]);
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);
  useEffect(() => {
    const nextWakeAtMs = getNextInboxWakeAtMs(lifecycleByThreadKey, now);
    if (nextWakeAtMs === null) {
      return;
    }
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, MAX_WAKE_TIMEOUT_MS);
    const timeout = window.setTimeout(() => setNow(new Date().toISOString()), delayMs);
    return () => window.clearTimeout(timeout);
  }, [lifecycleByThreadKey, now]);
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      const threadKey = scopedThreadKey(threadRef);
      clearSelection();
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      const draftId = draftIdByThreadKey.get(threadKey);
      if (draftId) {
        void navigate({ to: "/draft/$draftId", params: { draftId } });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, draftIdByThreadKey, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );
  const createThread = useCallback(() => {
    const projectRef =
      scopedProject?.memberProjectRefs.length === 1 ? scopedProject.memberProjectRefs[0] : null;
    if (!projectRef) {
      openCommandPalette(true);
      return;
    }
    if (isMobile) {
      setOpenMobile(false);
    }
    void handleNewThread(projectRef);
  }, [handleNewThread, isMobile, openCommandPalette, scopedProject, setOpenMobile]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      const terminalOpen = routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { terminalFocus: isTerminalFocused(), terminalOpen, modelPickerOpen },
      });
      const direction = threadTraversalDirectionFromCommand(command);
      const jumpIndex = direction === null ? threadJumpIndexFromCommand(command ?? "") : null;
      const targetKey =
        direction !== null
          ? resolveAdjacentThreadId({
              threadIds: orderedThreadKeys,
              currentThreadId: routeThreadKey,
              direction,
            })
          : jumpIndex === null
            ? null
            : (orderedThreadKeys[jumpIndex] ?? null);
      if (!targetKey) {
        return;
      }
      const target = threadByKey.get(targetKey);
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(target.environmentId, target.id));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    keybindings,
    modelPickerOpen,
    navigateToThread,
    orderedThreadKeys,
    routeThreadKey,
    routeThreadRef,
    threadByKey,
  ]);

  const handleAction = useCallback(
    async (action: InboxThreadAction, thread: SidebarThreadSummary, lifecycleThreadKey: string) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const currentLifecycle =
        useInboxLifecycleStore.getState().lifecycleByThreadKey[lifecycleThreadKey];
      const actionNow = new Date().toISOString();
      const snooze = (preset: InboxSnoozePreset) => {
        dispatchLifecycle({
          type: "snooze",
          threadKey: lifecycleThreadKey,
          until: resolveInboxSnoozeUntil(preset, actionNow),
        });
        setNow(actionNow);
      };

      switch (action) {
        case "toggle-pin":
          dispatchLifecycle(
            currentLifecycle?.pinnedAt
              ? { type: "unpin", threadKey: lifecycleThreadKey }
              : { type: "pin", threadKey: lifecycleThreadKey, at: actionNow },
          );
          return;
        case "snooze-one-hour":
          snooze("one-hour");
          return;
        case "snooze-tomorrow":
          snooze("tomorrow");
          return;
        case "snooze-one-week":
          snooze("one-week");
          return;
        case "unsnooze":
          dispatchLifecycle({ type: "unsnooze", threadKey: lifecycleThreadKey });
          setNow(actionNow);
          return;
        case "toggle-settled":
          dispatchLifecycle(
            currentLifecycle?.settledAt
              ? { type: "unsettle", threadKey: lifecycleThreadKey }
              : { type: "settle", threadKey: lifecycleThreadKey, at: actionNow },
          );
          return;
        case "discard-draft": {
          const draftId = draftIdByThreadKey.get(scopedThreadKey(threadRef));
          if (!draftId) {
            return;
          }
          if (confirmThreadDelete) {
            const confirmed = await readLocalApi()?.dialogs.confirm(
              `Discard draft "${resolveSidebarThreadDisplayTitle(thread)}"?`,
            );
            if (confirmed === false) {
              return;
            }
          }
          clearDraftThread(draftId);
          if (scopedThreadKey(threadRef) === lifecycleThreadKey) {
            dispatchLifecycle({ type: "remove", threadKey: lifecycleThreadKey });
          }
          return;
        }
        case "archive": {
          if (confirmThreadArchive) {
            const confirmed = await readLocalApi()?.dialogs.confirm(
              `Archive thread "${resolveSidebarThreadDisplayTitle(thread)}"?`,
            );
            if (confirmed === false) {
              return;
            }
          }
          try {
            await archiveThread(threadRef);
          } catch (error) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        case "delete": {
          if (!readEnvironmentApi(thread.environmentId)) {
            return;
          }
          if (confirmThreadDelete) {
            const confirmed = await readLocalApi()?.dialogs.confirm(
              [
                `Delete thread "${resolveSidebarThreadDisplayTitle(thread)}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
            );
            if (confirmed === false) {
              return;
            }
          }
          try {
            await deleteThread(threadRef);
            if (scopedThreadKey(threadRef) === lifecycleThreadKey) {
              dispatchLifecycle({ type: "remove", threadKey: lifecycleThreadKey });
            }
          } catch (error) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
      }
    },
    [
      archiveThread,
      clearDraftThread,
      confirmThreadArchive,
      confirmThreadDelete,
      deleteThread,
      dispatchLifecycle,
      draftIdByThreadKey,
    ],
  );
  const runAction = useCallback(
    (action: InboxThreadAction, thread: SidebarThreadSummary, lifecycleThreadKey: string) => {
      void handleAction(action, thread, lifecycleThreadKey);
    },
    [handleAction],
  );

  const renderRows = (
    items: readonly SidebarThreadTreeItem<SidebarThreadSummary>[],
    section: InboxLifecycleSection,
  ) =>
    items.map((item) => {
      const thread = item.thread;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return (
        <InboxThreadRow
          key={threadKey}
          thread={thread}
          depth={item.depth}
          childCount={item.childCount}
          section={section}
          projectIdentity={projectIdentityByScopedKey.get(projectKey) ?? null}
          lifecycleThreadKey={lifecycleThreadKeyByThreadKey.get(threadKey) ?? threadKey}
          isActive={routeThreadKey === threadKey}
          isDraft={draftThreadKeys.has(threadKey)}
          isPending={pendingThreadKeys.has(threadKey)}
          isThreadExpanded={threadExpandedById[threadKey] ?? true}
          onNavigate={navigateToThread}
          onAction={runAction}
          onToggleExpanded={toggleThreadExpanded}
        />
      );
    });

  const totalScopedThreads =
    sectionItems.drafts.length +
    sectionItems.pinned.length +
    sectionItems.active.length +
    sectionItems.snoozed.length +
    sectionItems.settled.length;

  return (
    <>
      <SidebarUsageBackgroundRefresh />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pt-2 pb-1">
          <div className="flex items-center gap-1">
            <SidebarMenu className="flex-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
                  data-testid="inbox-command-palette-trigger"
                  onClick={() => openCommandPalette(true)}
                >
                  <SearchIcon className="size-3.5" />
                  <span className="flex-1 truncate text-left text-[15px]">Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="New thread"
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={createThread}
                  />
                }
              >
                <SquarePenIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">New thread</TooltipPopup>
            </Tooltip>
          </div>
        </SidebarGroup>

        <SidebarGroup className="px-2 pt-1 pb-2">
          <div className="flex items-center gap-1">
            <Select
              value={projectScopeKey ?? ALL_PROJECTS_SCOPE}
              onValueChange={(value) =>
                setProjectScopeKey(value === ALL_PROJECTS_SCOPE ? null : value)
              }
            >
              <SelectTrigger
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-start px-2"
                aria-label="Inbox project scope"
              >
                {scopedProject ? (
                  <ProjectFavicon
                    environmentId={scopedProject.environmentId}
                    cwd={scopedProject.cwd}
                    className="size-4"
                  />
                ) : (
                  <FolderIcon className="size-4" />
                )}
                <SelectValue>{scopedProject?.displayName ?? "All projects"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false} className="max-w-72">
                <SelectItem hideIndicator value={ALL_PROJECTS_SCOPE}>
                  <FolderIcon className="size-4 text-muted-foreground" />
                  All projects
                </SelectItem>
                {projectGroups.map((project) => (
                  <SelectItem key={project.projectKey} hideIndicator value={project.projectKey}>
                    <ProjectFavicon
                      environmentId={project.environmentId}
                      cwd={project.cwd}
                      className="size-4"
                    />
                    {project.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={openAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>
        </SidebarGroup>

        <SidebarGroup className="px-2 pt-0 pb-3" data-testid="inbox-thread-list">
          <SidebarMenu className="gap-0">
            {renderRows(sectionItems.drafts, "drafts")}
            {sectionItems.drafts.length > 0 ? (
              <SidebarMenuItem
                aria-hidden="true"
                className="mx-2 my-1.5 h-px list-none bg-sidebar-border/70"
                data-testid="inbox-draft-divider"
              />
            ) : null}
            {renderRows(sectionItems.pinned, "pinned")}
            {sectionItems.pinned.length > 0 ? (
              <SidebarMenuItem
                aria-hidden="true"
                className="mx-2 my-1.5 h-px list-none bg-sidebar-border/70"
                data-testid="inbox-pinned-divider"
              />
            ) : null}
            {renderRows(sectionItems.active, "active")}
            <InboxShelf
              title="Snoozed"
              count={sectionItems.snoozed.length}
              expanded={snoozedShelfExpanded}
              tone="snoozed"
              onToggle={() => setSnoozedShelfExpanded((expanded) => !expanded)}
            />
            {renderRows(visibleSnoozedItems, "snoozed")}
            <InboxShelf
              title="Settled"
              count={sectionItems.settled.length}
              expanded={settledShelfExpanded}
              tone="settled"
              onToggle={() => setSettledShelfExpanded((expanded) => !expanded)}
            />
            {renderRows(visibleSettledItems, "settled")}
          </SidebarMenu>

          {totalScopedThreads === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-8 text-center text-xs text-muted-foreground/60">
              {projects.length === 0
                ? "No projects yet"
                : scopedProject
                  ? `No threads in ${scopedProject.displayName} yet`
                  : "No threads yet"}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
