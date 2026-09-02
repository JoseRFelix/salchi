import {
  AlarmClockIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  SquarePenIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@salchi/client-runtime";
import type { ScopedThreadRef, SidebarProjectGroupingMode } from "@salchi/contracts";
import type { TimestampFormat } from "@salchi/contracts/settings";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useSidebarThreadPresentation } from "../hooks/useSidebarThreadPresentation";
import { useSidebarLocalDispatchReconciliation } from "../hooks/useSidebarLocalDispatchReconciliation";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildInboxLifecycleThreadKeyByThreadKey,
  canSettleInboxThread,
  canSnoozeInboxThread,
  generateSpreadPinOrderKeys,
  getNextInboxWakeAtMs,
  partitionInboxThreads,
  pinOrderKeyBetween,
  planPinnedReorder,
  resolveInboxSnoozePresets,
  type InboxLifecycleSection,
} from "../inboxLifecycle";
import { inboxChangeRequestSettleSource } from "../inboxChangeRequest";
import { useInboxChangeRequestSnapshots } from "../inboxChangeRequestState";
import { classifyInboxBackgroundThread } from "../inboxThreadStatus";
import {
  buildInboxSearchListItems,
  buildInboxSidebarListItems,
  inboxSidebarListItemSize,
  inboxSidebarListItemType,
  shouldVirtualizeInboxList,
  type InboxSidebarListItem,
} from "../inboxSidebarList";
import {
  INBOX_SETTLED_INITIAL_COUNT,
  INBOX_SETTLED_PAGE_COUNT,
  INBOX_SETTLED_SHELF_DEFAULT_EXPANDED,
  INBOX_SETTLED_SHELF_EXPANDED_KEY,
  INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED,
  INBOX_SNOOZED_SHELF_EXPANDED_KEY,
  inboxShelfLabel,
  moveInboxSearchHighlightIndex,
  resolveInboxShelfItems,
  resolvePaginatedInboxShelfItems,
  resolveInboxSearchHighlight,
  resolveInboxParkForwardTarget,
  reconcileInboxTitleRegeneration,
} from "../inboxSidebarPresentation";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { newCommandId, cn } from "../lib/utils";
import {
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  resolveProjectGroupingMode,
  selectProjectGroupingSettings,
} from "../logicalProject";
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
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  flattenSidebarThreadTree,
  orderItemsByPreferredIds,
  resolveAdjacentThreadId,
  resolveSidebarThreadDisplayTitle,
  shouldCreateNewThreadInCurrentProject,
  sortLogicalProjectsForSidebar,
  type SidebarThreadTreeItem,
} from "./Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarUsageBackgroundRefresh } from "./sidebar/SidebarUsageIndicator";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Input } from "./ui/input";
import { useServerKeybindings } from "../rpc/serverState";
import { VirtualizedList } from "./virtualization/VirtualizedList";
import { InboxChangeRequestObserver } from "./inbox/InboxChangeRequestObservers";
import { InboxProjectPicker, ALL_PROJECTS_SCOPE } from "./inbox/InboxProjectPicker";
import {
  InboxThreadRow,
  snoozePresetIdFromInboxAction,
  type InboxProjectIdentity,
  type InboxThreadAction,
} from "./inbox/InboxThreadRow";
import { InboxSearchResultRow } from "./inbox/InboxSearchResultRow";
import {
  reorderPinnedThread,
  setThreadPinned,
  setThreadSettled,
  snoozeThread,
  supportsThreadLifecycleCapability,
  unsnoozeThread,
} from "../threadLifecycle";
import { getAcknowledgedCompletionTurnId } from "../threadCompletion";
import { setThreadCompletionAttention } from "../threadAttention";

const MAX_WAKE_TIMEOUT_MS = 2_147_483_647;

function InboxShelf(props: {
  readonly title: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly tone: "snoozed" | "settled";
  readonly virtualized?: boolean;
  readonly onToggle: () => void;
}) {
  if (props.count === 0) return null;
  return (
    <SidebarMenuItem
      {...(props.virtualized ? { render: <div role="listitem" /> } : {})}
      className="h-[27px] list-none"
    >
      <button
        type="button"
        aria-expanded={props.expanded}
        data-testid={`inbox-${props.tone}-shelf-toggle`}
        className="flex h-full w-full cursor-pointer items-center gap-2 px-2 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onClick={props.onToggle}
      >
        <span
          className={cn(
            "shrink-0 text-[10px] font-medium uppercase tracking-wider",
            props.tone === "snoozed"
              ? "text-blue-600 dark:text-blue-400"
              : "text-muted-foreground/55",
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
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            props.expanded && "rotate-180",
          )}
        />
      </button>
    </SidebarMenuItem>
  );
}

function InboxDivider(props: {
  readonly tone: "drafts" | "pinned";
  readonly virtualized?: boolean;
}) {
  return (
    <SidebarMenuItem
      {...(props.virtualized ? { render: <div role="separator" /> } : {})}
      aria-hidden
      className="h-[13px] list-none px-2 py-1.5"
    >
      <div
        className={cn(
          "h-px w-full",
          props.tone === "drafts" ? "bg-amber-500/25" : "bg-sidebar-border/70",
        )}
      />
    </SidebarMenuItem>
  );
}

function InboxSettledLoadMore(props: {
  readonly hiddenCount: number;
  readonly virtualized?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <SidebarMenuItem
      {...(props.virtualized ? { render: <div role="listitem" /> } : {})}
      className="h-9 list-none px-2 py-1"
    >
      <button
        type="button"
        className="flex h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-xs text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        onClick={props.onClick}
      >
        Show {Math.min(INBOX_SETTLED_PAGE_COUNT, props.hiddenCount)} more
      </button>
    </SidebarMenuItem>
  );
}

function InboxBulkSnoozeMenu(props: {
  readonly disabled: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onSelect: (snoozedUntil: string, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(
    () => (open ? resolveInboxSnoozePresets(new Date(), props.timestampFormat) : []),
    [open, props.timestampFormat],
  );
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Snooze selected threads"
              disabled={props.disabled}
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            />
          }
        >
          <AlarmClockIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Snooze selected</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() => props.onSelect(preset.snoozedUntil, preset.label)}
          >
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

function lifecycleErrorToast(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    }),
  );
}

function threadRefFromSummary(thread: SidebarThreadSummary): ScopedThreadRef {
  return scopeThreadRef(thread.environmentId, thread.id);
}

export default function InboxSidebar() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const serverThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const bootstrapComplete = useStore((state) => {
    const states = Object.values(state.environmentStateById);
    return states.length > 0 && states.every((environment) => environment.bootstrapComplete);
  });
  const {
    threads,
    pendingThreadKeys,
    draftThreadKeys,
    draftIdByThreadKey,
    activeLocalDispatchThreadKeys,
    activeLocalDispatchStartedAtByThreadKey,
  } = useSidebarThreadPresentation(serverThreads);
  useSidebarLocalDispatchReconciliation(threads);
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const { archiveThread, deleteThread } = useThreadActions();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const toggleThreadExpanded = useUiStateStore((state) => state.toggleThreadExpanded);
  const threadExpandedById = useUiStateStore((state) => state.threadExpandedById);
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const reorderProjects = useUiStateStore((state) => state.reorderProjects);
  const openAddProject = useCommandPaletteStore((state) => state.openAddProject);
  const openNewThreadIn = useCommandPaletteStore((state) => state.openNewThreadIn);
  const newThreadContext = useHandleNewThread();
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
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHighlightIndex, setSearchHighlightIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [renameTarget, setRenameTarget] = useState<SidebarThreadSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [regeneratingTitleByThreadKey, setRegeneratingTitleByThreadKey] = useState<
    Record<string, string>
  >({});
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
  const { snapshots: changeRequestSnapshots, recordObservation: recordChangeRequestObservation } =
    useInboxChangeRequestSnapshots();
  const settledPagingScopeKey = projectScopeKey ?? ALL_PROJECTS_SCOPE;
  const [settledPaging, setSettledPaging] = useState({
    scopeKey: settledPagingScopeKey,
    visibleCount: INBOX_SETTLED_INITIAL_COUNT,
  });
  const settledVisibleCount =
    settledPaging.scopeKey === settledPagingScopeKey
      ? settledPaging.visibleCount
      : INBOX_SETTLED_INITIAL_COUNT;
  const draggedPinnedKeyRef = useRef<string | null>(null);
  const [optimisticPinnedRootKeys, setOptimisticPinnedRootKeys] = useState<
    readonly string[] | null
  >(null);

  const orderedPhysicalProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects:
          settings.sidebarProjectSortOrder === "manual" ? orderedPhysicalProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) =>
          savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ??
          savedEnvironmentRegistry[environmentId]?.label ??
          null,
      }),
    [
      orderedPhysicalProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
      settings.sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        unsortedProjectGroups,
        threads,
        settings.sidebarProjectSortOrder,
      ),
    [settings.sidebarProjectSortOrder, threads, unsortedProjectGroups],
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
  const threadByKey = useMemo(
    () =>
      new Map(
        scopedThreads.map(
          (thread) => [scopedThreadKey(threadRefFromSummary(thread)), thread] as const,
        ),
      ),
    [scopedThreads],
  );
  useEffect(() => {
    setRegeneratingTitleByThreadKey((current) => {
      const next = reconcileInboxTitleRegeneration(
        current,
        new Map([...threadByKey].map(([key, thread]) => [key, thread.title])),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [threadByKey]);
  const lifecycleThreadKeyByThreadKey = useMemo(
    () => buildInboxLifecycleThreadKeyByThreadKey(scopedThreads),
    [scopedThreads],
  );
  const lifecycleThreadByThreadKey = useMemo(() => {
    const result = new Map<string, SidebarThreadSummary>();
    for (const thread of scopedThreads) {
      const ownKey = scopedThreadKey(threadRefFromSummary(thread));
      const lifecycleKey = lifecycleThreadKeyByThreadKey.get(ownKey) ?? ownKey;
      result.set(ownKey, threadByKey.get(lifecycleKey) ?? thread);
    }
    return result;
  }, [lifecycleThreadKeyByThreadKey, scopedThreads, threadByKey]);
  const changeRequestByThreadKey = useMemo(
    () =>
      new Map(
        Object.entries(changeRequestSnapshots).map(([key, snapshot]) => [
          key,
          inboxChangeRequestSettleSource(snapshot),
        ]),
      ),
    [changeRequestSnapshots],
  );
  const backgroundLivenessByLifecycleKey = useMemo(() => {
    const result = new Map<string, "working" | "monitoring">();
    for (const thread of scopedThreads) {
      const ownKey = scopedThreadKey(threadRefFromSummary(thread));
      const lifecycleKey = lifecycleThreadKeyByThreadKey.get(ownKey) ?? ownKey;
      if (
        lifecycleKey !== ownKey &&
        (thread.session?.status === "connecting" || thread.session?.status === "running")
      ) {
        const liveness = classifyInboxBackgroundThread(thread);
        if (liveness === "working" || !result.has(lifecycleKey)) {
          result.set(lifecycleKey, liveness);
        }
      }
    }
    return result;
  }, [lifecycleThreadKeyByThreadKey, scopedThreads]);
  const partitions = useMemo(
    () =>
      partitionInboxThreads({
        threads: scopedThreads,
        draftThreadKeys,
        now,
        autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
        autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
        changeRequestByThreadKey,
      }),
    [
      changeRequestByThreadKey,
      draftThreadKeys,
      now,
      scopedThreads,
      settings.sidebarAutoSettleAfterDays,
      settings.sidebarAutoSettleOnMerge,
    ],
  );
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const sectionItems = useMemo(() => {
    const flatten = (sectionThreads: readonly SidebarThreadSummary[]) =>
      flattenSidebarThreadTree(sectionThreads, {
        isThreadCollapsed: (thread) =>
          threadExpandedById[scopedThreadKey(threadRefFromSummary(thread))] === false,
      });
    return {
      drafts: flatten(partitions.drafts),
      pinned: flatten(partitions.pinned),
      active: flatten(partitions.active),
      snoozed: flatten(partitions.snoozed),
      settled: flatten(partitions.settled),
    };
  }, [partitions, threadExpandedById]);
  const searchResults = useMemo(() => {
    if (normalizedSearch.length === 0) return [];
    const flattenAll = (sectionThreads: readonly SidebarThreadSummary[]) =>
      flattenSidebarThreadTree(sectionThreads, { isThreadCollapsed: () => false });
    return (
      [
        ["drafts", flattenAll(partitions.drafts)],
        ["pinned", flattenAll(partitions.pinned)],
        ["active", flattenAll(partitions.active)],
        ["snoozed", flattenAll(partitions.snoozed)],
        ["settled", flattenAll(partitions.settled)],
      ] as const
    ).flatMap(([section, items]) =>
      items
        .filter((item) =>
          resolveSidebarThreadDisplayTitle(item.thread)
            .toLocaleLowerCase()
            .includes(normalizedSearch),
        )
        .map((item) => ({ section, item })),
    );
  }, [normalizedSearch, partitions]);
  const rootPinnedThreads = useMemo(
    () =>
      partitions.pinned.filter((thread) => {
        const key = scopedThreadKey(threadRefFromSummary(thread));
        return (lifecycleThreadKeyByThreadKey.get(key) ?? key) === key;
      }),
    [lifecycleThreadKeyByThreadKey, partitions.pinned],
  );
  const pinnedRootKeys = useMemo(
    () => rootPinnedThreads.map((thread) => scopedThreadKey(threadRefFromSummary(thread))),
    [rootPinnedThreads],
  );
  const effectivePinnedRootKeys = useMemo(() => {
    if (
      optimisticPinnedRootKeys !== null &&
      optimisticPinnedRootKeys.length === pinnedRootKeys.length &&
      optimisticPinnedRootKeys.every((key) => pinnedRootKeys.includes(key))
    ) {
      return optimisticPinnedRootKeys;
    }
    return pinnedRootKeys;
  }, [optimisticPinnedRootKeys, pinnedRootKeys]);
  const displayedPinnedItems = useMemo(() => {
    const rank = new Map(effectivePinnedRootKeys.map((key, index) => [key, index]));
    return sectionItems.pinned
      .map((item, index) => ({ item, index }))
      .toSorted((left, right) => {
        const leftKey = scopedThreadKey(threadRefFromSummary(left.item.thread));
        const rightKey = scopedThreadKey(threadRefFromSummary(right.item.thread));
        const leftRoot = lifecycleThreadKeyByThreadKey.get(leftKey) ?? leftKey;
        const rightRoot = lifecycleThreadKeyByThreadKey.get(rightKey) ?? rightKey;
        return (
          (rank.get(leftRoot) ?? rank.size) - (rank.get(rightRoot) ?? rank.size) ||
          left.index - right.index
        );
      })
      .map(({ item }) => item);
  }, [effectivePinnedRootKeys, lifecycleThreadKeyByThreadKey, sectionItems.pinned]);

  useEffect(() => {
    if (
      optimisticPinnedRootKeys !== null &&
      optimisticPinnedRootKeys.length === pinnedRootKeys.length &&
      optimisticPinnedRootKeys.every((key, index) => key === pinnedRootKeys[index])
    ) {
      setOptimisticPinnedRootKeys(null);
    }
  }, [optimisticPinnedRootKeys, pinnedRootKeys]);

  const visibleSnoozedItems = useMemo(
    () =>
      resolveInboxShelfItems({
        items: sectionItems.snoozed,
        expanded: snoozedShelfExpanded,
        activeKey: routeThreadKey,
        getKey: (item) => scopedThreadKey(threadRefFromSummary(item.thread)),
      }),
    [routeThreadKey, sectionItems.snoozed, snoozedShelfExpanded],
  );
  const visibleSettledItems = useMemo(
    () =>
      resolvePaginatedInboxShelfItems({
        items: sectionItems.settled,
        expanded: settledShelfExpanded,
        activeKey: routeThreadKey,
        visibleCount: settledVisibleCount,
        getKey: (item) => scopedThreadKey(threadRefFromSummary(item.thread)),
      }),
    [routeThreadKey, sectionItems.settled, settledShelfExpanded, settledVisibleCount],
  );
  const hiddenSettledCount = Math.max(0, sectionItems.settled.length - visibleSettledItems.length);
  const inboxListItems = useMemo(
    () =>
      buildInboxSidebarListItems({
        drafts: sectionItems.drafts,
        pinned: displayedPinnedItems,
        active: sectionItems.active,
        visibleSnoozed: visibleSnoozedItems,
        snoozedCount: sectionItems.snoozed.length,
        snoozedExpanded: snoozedShelfExpanded,
        visibleSettled: visibleSettledItems,
        settledCount: sectionItems.settled.length,
        settledExpanded: settledShelfExpanded,
        hiddenSettledCount,
      }),
    [
      displayedPinnedItems,
      hiddenSettledCount,
      sectionItems,
      settledShelfExpanded,
      snoozedShelfExpanded,
      visibleSettledItems,
      visibleSnoozedItems,
    ],
  );
  const searchListItems = useMemo(() => buildInboxSearchListItems(searchResults), [searchResults]);
  const renderedListItems = normalizedSearch.length > 0 ? searchListItems : inboxListItems;
  const shouldUseVirtualizedList = shouldVirtualizeInboxList({
    isMobile,
    itemCount: renderedListItems.length,
  });
  const orderedItems = useMemo(
    () => [
      ...sectionItems.drafts,
      ...displayedPinnedItems,
      ...sectionItems.active,
      ...visibleSnoozedItems,
      ...visibleSettledItems,
    ],
    [displayedPinnedItems, sectionItems, visibleSettledItems, visibleSnoozedItems],
  );
  const orderedThreadKeys = useMemo(
    () =>
      normalizedSearch.length > 0
        ? searchResults.map(({ item }) => scopedThreadKey(threadRefFromSummary(item.thread)))
        : orderedItems.map((item) => scopedThreadKey(threadRefFromSummary(item.thread))),
    [normalizedSearch, orderedItems, searchResults],
  );
  const parkForwardThreadKeys = useMemo(
    () =>
      [...sectionItems.drafts, ...displayedPinnedItems, ...sectionItems.active].map((item) =>
        scopedThreadKey(threadRefFromSummary(item.thread)),
      ),
    [displayedPinnedItems, sectionItems.active, sectionItems.drafts],
  );
  const highlightedSearchKey =
    normalizedSearch.length > 0
      ? resolveInboxSearchHighlight(orderedThreadKeys, searchHighlightIndex)
      : null;
  const highlightedSearchOptionId =
    normalizedSearch.length > 0 && searchResults.length > 0
      ? `inbox-search-option-${Math.min(searchHighlightIndex, searchResults.length - 1)}`
      : undefined;

  useEffect(() => {
    if (projectScopeKey !== null && scopedProject === null) setProjectScopeKey(null);
  }, [projectScopeKey, scopedProject]);
  useEffect(() => {
    clearSelection();
    setSearchHighlightIndex(0);
  }, [clearSelection, projectScopeKey]);
  useEffect(() => setSearchHighlightIndex(0), [normalizedSearch]);
  useEffect(() => {
    if (highlightedSearchOptionId === undefined) return;
    document.getElementById(highlightedSearchOptionId)?.scrollIntoView({ block: "nearest" });
  }, [highlightedSearchOptionId]);
  useEffect(() => {
    const nextWakeAtMs = getNextInboxWakeAtMs(scopedThreads, now);
    if (nextWakeAtMs === null) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, MAX_WAKE_TIMEOUT_MS);
    const timeout = window.setTimeout(() => setNow(new Date().toISOString()), delayMs);
    return () => window.clearTimeout(timeout);
  }, [now, scopedThreads]);

  const navigateToThread = useCallback(
    (
      threadRef: ScopedThreadRef,
      event?: Pick<ReactMouseEvent, "metaKey" | "ctrlKey" | "shiftKey">,
    ) => {
      const key = scopedThreadKey(threadRef);
      if (event?.metaKey || event?.ctrlKey) {
        toggleThreadSelection(key);
        return;
      }
      if (event?.shiftKey) {
        rangeSelectTo(key, orderedThreadKeys);
        return;
      }
      clearSelection();
      setSelectionAnchor(key);
      const lifecycleKey = lifecycleThreadKeyByThreadKey.get(key) ?? key;
      const lifecycleThread = threadByKey.get(lifecycleKey);
      if (lifecycleThread?.snoozedUntil && Date.parse(lifecycleThread.snoozedUntil) <= Date.now()) {
        void unsnoozeThread(threadRefFromSummary(lifecycleThread));
      }
      if (isMobile) setOpenMobile(false);
      const draftId = draftIdByThreadKey.get(key);
      if (draftId) {
        void navigate({ to: "/draft/$draftId", params: { draftId } });
      } else {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }
    },
    [
      clearSelection,
      draftIdByThreadKey,
      isMobile,
      lifecycleThreadKeyByThreadKey,
      navigate,
      orderedThreadKeys,
      rangeSelectTo,
      setOpenMobile,
      setSelectionAnchor,
      threadByKey,
      toggleThreadSelection,
    ],
  );
  const createThread = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!shouldCreateNewThreadInCurrentProject(event.shiftKey, projectGroups.length)) {
        openNewThreadIn();
        return;
      }
      if (isMobile) setOpenMobile(false);
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        defaultThreadEnvMode: settings.defaultThreadEnvMode,
        handleNewThread: newThreadContext.handleNewThread,
      });
    },
    [
      isMobile,
      newThreadContext,
      openNewThreadIn,
      projectGroups.length,
      setOpenMobile,
      settings.defaultThreadEnvMode,
    ],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        document.activeElement === searchInputRef.current
      ) {
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
      const target = targetKey ? threadByKey.get(targetKey) : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(threadRefFromSummary(target));
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

  const dispatchPinnedOrder = useCallback(
    async (orderedKeys: readonly string[], movedKey: string) => {
      const assignments = planPinnedReorder({
        orderedIds: orderedKeys,
        movedId: movedKey,
        keysById: new Map(
          rootPinnedThreads.map((thread) => [
            scopedThreadKey(threadRefFromSummary(thread)),
            thread.pinOrderKey,
          ]),
        ),
      });
      await Promise.all(
        assignments.map(({ id, orderKey }) => {
          const thread = threadByKey.get(id);
          return thread ? reorderPinnedThread(threadRefFromSummary(thread), orderKey) : false;
        }),
      );
    },
    [rootPinnedThreads, threadByKey],
  );
  const movePinned = useCallback(
    async (lifecycleKey: string, direction: -1 | 1) => {
      const from = effectivePinnedRootKeys.indexOf(lifecycleKey);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= effectivePinnedRootKeys.length) return;
      const next = [...effectivePinnedRootKeys];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      setOptimisticPinnedRootKeys(next);
      try {
        await dispatchPinnedOrder(next, lifecycleKey);
      } catch (error) {
        setOptimisticPinnedRootKeys(null);
        throw error;
      }
    },
    [dispatchPinnedOrder, effectivePinnedRootKeys],
  );

  const parkForward = useCallback(
    async (parkedLifecycleKey: string, parkedThread: SidebarThreadSummary) => {
      const routedKey = routeThreadKeyRef.current;
      if (
        routedKey === null ||
        (lifecycleThreadKeyByThreadKey.get(routedKey) ?? routedKey) !== parkedLifecycleKey
      ) {
        return;
      }
      const nextKey = resolveInboxParkForwardTarget({
        parkedLifecycleKey,
        orderedThreadKeys: parkForwardThreadKeys,
        lifecycleKeyByThreadKey: lifecycleThreadKeyByThreadKey,
      });
      const nextThread = nextKey === null ? null : (threadByKey.get(nextKey) ?? null);
      if (nextThread !== null) {
        navigateToThread(threadRefFromSummary(nextThread));
        return;
      }
      if (isMobile) setOpenMobile(false);
      await newThreadContext.handleNewThread(
        scopeProjectRef(parkedThread.environmentId, parkedThread.projectId),
      );
    },
    [
      isMobile,
      lifecycleThreadKeyByThreadKey,
      navigateToThread,
      newThreadContext,
      parkForwardThreadKeys,
      setOpenMobile,
      threadByKey,
    ],
  );

  const handleAction = useCallback(
    async (action: InboxThreadAction, thread: SidebarThreadSummary, lifecycleThreadKey: string) => {
      const threadRef = threadRefFromSummary(thread);
      const lifecycleThread = threadByKey.get(lifecycleThreadKey) ?? thread;
      const lifecycleRef = threadRefFromSummary(lifecycleThread);
      const snoozePresetId = snoozePresetIdFromInboxAction(action);
      try {
        if (snoozePresetId !== null) {
          const preset = resolveInboxSnoozePresets(new Date(), settings.timestampFormat).find(
            (candidate) => candidate.id === snoozePresetId,
          );
          if (!preset) return;
          const applied = await snoozeThread(lifecycleRef, preset.snoozedUntil);
          if (!applied) throw new Error("This environment does not support thread snoozing.");
          setNow(new Date().toISOString());
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed ${resolveSidebarThreadDisplayTitle(lifecycleThread)}`,
              description: `Wakes ${preset.whenLabel}`,
              actionProps: {
                children: "Undo",
                onClick: () => void unsnoozeThread(lifecycleRef),
              },
            }),
          );
          await parkForward(lifecycleThreadKey, lifecycleThread);
          return;
        }
        switch (action) {
          case "toggle-pin": {
            if (lifecycleThread.pinnedAt != null) {
              if (settings.confirmThreadUnpin) {
                const confirmed = await readLocalApi()?.dialogs.confirm(
                  `Unpin thread "${resolveSidebarThreadDisplayTitle(lifecycleThread)}"?`,
                );
                if (confirmed === false) return;
              }
              await setThreadPinned(lifecycleRef, false);
              return;
            }
            const firstKey = rootPinnedThreads[0]?.pinOrderKey ?? null;
            let orderKey: string | null | undefined = pinOrderKeyBetween(null, firstKey);
            if (orderKey === null) {
              const normalized = generateSpreadPinOrderKeys(rootPinnedThreads.length + 1);
              orderKey = normalized[0] ?? undefined;
              await Promise.all(
                rootPinnedThreads.map((pinned, index) => {
                  const key = normalized[index + 1];
                  return key
                    ? reorderPinnedThread(threadRefFromSummary(pinned), key)
                    : Promise.resolve(false);
                }),
              );
            }
            await setThreadPinned(lifecycleRef, true, orderKey ?? undefined);
            return;
          }
          case "unsnooze":
            await unsnoozeThread(lifecycleRef);
            setNow(new Date().toISOString());
            return;
          case "toggle-settled": {
            const settling =
              lifecycleThread.settledOverride !== "settled" && lifecycleThread.settledAt == null;
            await setThreadSettled(lifecycleRef, settling);
            if (settling) await parkForward(lifecycleThreadKey, lifecycleThread);
            return;
          }
          case "rename":
            setRenameTarget(thread);
            setRenameValue(resolveSidebarThreadDisplayTitle(thread));
            return;
          case "regenerate-title": {
            const api = readEnvironmentApi(thread.environmentId);
            if (!api) return;
            const key = scopedThreadKey(threadRef);
            setRegeneratingTitleByThreadKey((current) => ({
              ...current,
              [key]: thread.title,
            }));
            try {
              await api.orchestration.dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId: thread.id,
                regenerateTitle: true,
              });
            } catch (error) {
              setRegeneratingTitleByThreadKey((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
              throw error;
            }
            toastManager.add(
              stackedThreadToast({ type: "info", title: "Regenerating thread title…" }),
            );
            return;
          }
          case "mark-unread": {
            const turnId = getAcknowledgedCompletionTurnId(thread);
            if (!turnId) return;
            await setThreadCompletionAttention({
              operation: "mark-unread",
              environmentId: thread.environmentId,
              threadId: thread.id,
              turnId,
            });
            return;
          }
          case "create-on-branch":
            if (!thread.branch) return;
            if (isMobile) setOpenMobile(false);
            await newThreadContext.handleNewThread(
              scopeProjectRef(thread.environmentId, thread.projectId),
              {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
              },
            );
            return;
          case "copy-path":
          case "copy-branch":
          case "copy-thread-id": {
            const projectKey = scopedProjectKey(
              scopeProjectRef(thread.environmentId, thread.projectId),
            );
            const copyValue =
              action === "copy-path"
                ? (thread.worktreePath ?? projectIdentityByScopedKey.get(projectKey)?.cwd ?? "")
                : action === "copy-branch"
                  ? (thread.branch ?? "")
                  : thread.id;
            if (!copyValue) return;
            await navigator.clipboard.writeText(copyValue);
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title:
                  action === "copy-path"
                    ? "Path copied"
                    : action === "copy-branch"
                      ? "Branch copied"
                      : "Thread ID copied",
              }),
            );
            return;
          }
          case "copy-metadata":
            await navigator.clipboard.writeText(
              JSON.stringify(
                {
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                  projectId: thread.projectId,
                  title: thread.title,
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                  provider: thread.modelSelection?.instanceId ?? null,
                },
                null,
                2,
              ),
            );
            toastManager.add(
              stackedThreadToast({ type: "success", title: "Thread metadata copied" }),
            );
            return;
          case "move-pin-up":
            await movePinned(lifecycleThreadKey, -1);
            return;
          case "move-pin-down":
            await movePinned(lifecycleThreadKey, 1);
            return;
          case "discard-draft": {
            const draftId = draftIdByThreadKey.get(scopedThreadKey(threadRef));
            if (!draftId) return;
            if (settings.confirmThreadDelete) {
              const confirmed = await readLocalApi()?.dialogs.confirm(
                `Discard draft "${resolveSidebarThreadDisplayTitle(thread)}"?`,
              );
              if (confirmed === false) return;
            }
            clearDraftThread(draftId);
            return;
          }
          case "archive":
            if (settings.confirmThreadArchive) {
              const confirmed = await readLocalApi()?.dialogs.confirm(
                `Archive thread "${resolveSidebarThreadDisplayTitle(thread)}"?`,
              );
              if (confirmed === false) return;
            }
            await archiveThread(threadRef);
            return;
          case "delete":
            if (settings.confirmThreadDelete) {
              const confirmed = await readLocalApi()?.dialogs.confirm(
                `Delete thread "${resolveSidebarThreadDisplayTitle(thread)}"?\nThis permanently clears its conversation history.`,
              );
              if (confirmed === false) return;
            }
            await deleteThread(threadRef);
            return;
        }
      } catch (error) {
        lifecycleErrorToast("Thread action failed", error);
      }
    },
    [
      archiveThread,
      clearDraftThread,
      deleteThread,
      draftIdByThreadKey,
      isMobile,
      movePinned,
      newThreadContext,
      parkForward,
      projectIdentityByScopedKey,
      rootPinnedThreads,
      setOpenMobile,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.confirmThreadUnpin,
      settings.timestampFormat,
      threadByKey,
    ],
  );
  const runAction = useCallback(
    (action: InboxThreadAction, thread: SidebarThreadSummary, lifecycleThreadKey: string) => {
      void handleAction(action, thread, lifecycleThreadKey);
    },
    [handleAction],
  );

  const selectedThreads = useMemo(
    () =>
      [...selectedThreadKeys].flatMap((key) =>
        threadByKey.get(key) ? [threadByKey.get(key)!] : [],
      ),
    [selectedThreadKeys, threadByKey],
  );
  const selectedLifecycleThreads = useMemo(() => {
    const uniqueRoots = new Map<string, SidebarThreadSummary>();
    for (const thread of selectedThreads) {
      const ownKey = scopedThreadKey(threadRefFromSummary(thread));
      const rootKey = lifecycleThreadKeyByThreadKey.get(ownKey) ?? ownKey;
      uniqueRoots.set(rootKey, threadByKey.get(rootKey) ?? thread);
    }
    return [...uniqueRoots.entries()];
  }, [lifecycleThreadKeyByThreadKey, selectedThreads, threadByKey]);
  const selectedCanSnooze = selectedLifecycleThreads.every(
    ([, thread]) =>
      supportsThreadLifecycleCapability(thread.environmentId, "threadSnooze") &&
      canSnoozeInboxThread(thread, { now }),
  );
  const selectedCanSettle = selectedLifecycleThreads.every(
    ([, thread]) =>
      supportsThreadLifecycleCapability(thread.environmentId, "threadSettlement") &&
      canSettleInboxThread(thread, { now }),
  );
  const runBulkLifecycle = useCallback(
    async (operation: "settle" | "snooze", snoozedUntil?: string, snoozeLabel?: string) => {
      const results = await Promise.allSettled(
        selectedLifecycleThreads.map(([, thread]) =>
          operation === "settle"
            ? setThreadSettled(threadRefFromSummary(thread), true)
            : snoozedUntil
              ? snoozeThread(threadRefFromSummary(thread), snoozedUntil)
              : Promise.resolve(false),
        ),
      );
      const succeeded = selectedLifecycleThreads.filter(
        (_, index) => results[index]?.status === "fulfilled" && results[index]?.value === true,
      );
      const failedCount = results.length - succeeded.length;
      if (succeeded.length > 0) {
        clearSelection();
        if (operation === "snooze") {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed ${succeeded.length} ${succeeded.length === 1 ? "thread" : "threads"}`,
              description: snoozeLabel,
              actionProps: {
                children: "Undo",
                onClick: () =>
                  void Promise.all(
                    succeeded.map(([, thread]) => unsnoozeThread(threadRefFromSummary(thread))),
                  ),
              },
            }),
          );
        }
      }
      if (failedCount > 0) {
        lifecycleErrorToast(
          "Some thread actions failed",
          new Error(
            `${failedCount} ${failedCount === 1 ? "thread was" : "threads were"} not updated.`,
          ),
        );
      }
    },
    [clearSelection, selectedLifecycleThreads],
  );
  const runBulkArchive = useCallback(async () => {
    try {
      if (settings.confirmThreadArchive) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          `Archive ${selectedThreads.length} selected ${selectedThreads.length === 1 ? "thread" : "threads"}?`,
        );
        if (confirmed === false) return;
      }
      await Promise.all(
        selectedThreads.map((thread) => archiveThread(threadRefFromSummary(thread))),
      );
      clearSelection();
    } catch (error) {
      lifecycleErrorToast("Bulk archive failed", error);
    }
  }, [archiveThread, clearSelection, selectedThreads, settings.confirmThreadArchive]);

  const runBulkRegenerateTitles = useCallback(async () => {
    await Promise.all(
      selectedThreads.map((thread) => {
        const ownKey = scopedThreadKey(threadRefFromSummary(thread));
        const lifecycleKey = lifecycleThreadKeyByThreadKey.get(ownKey) ?? ownKey;
        return handleAction("regenerate-title", thread, lifecycleKey);
      }),
    );
    clearSelection();
  }, [clearSelection, handleAction, lifecycleThreadKeyByThreadKey, selectedThreads]);

  const runBulkMarkUnread = useCallback(async () => {
    await Promise.all(
      selectedThreads.flatMap((thread) => {
        const turnId = getAcknowledgedCompletionTurnId(thread);
        return turnId
          ? [
              setThreadCompletionAttention({
                operation: "mark-unread",
                environmentId: thread.environmentId,
                threadId: thread.id,
                turnId,
              }),
            ]
          : [];
      }),
    );
    clearSelection();
  }, [clearSelection, selectedThreads]);

  const runBulkDelete = useCallback(async () => {
    if (settings.confirmThreadDelete) {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        `Delete ${selectedThreads.length} selected ${selectedThreads.length === 1 ? "thread" : "threads"}?\nThis permanently clears their conversation history.`,
      );
      if (confirmed === false) return;
    }
    await Promise.all(selectedThreads.map((thread) => deleteThread(threadRefFromSummary(thread))));
    clearSelection();
  }, [clearSelection, deleteThread, selectedThreads, settings.confirmThreadDelete]);

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSearchHighlightIndex((current) =>
          moveInboxSearchHighlightIndex(current, orderedThreadKeys.length, direction),
        );
        return;
      }
      if (event.key === "Enter") {
        const key = highlightedSearchKey;
        const target = key ? threadByKey.get(key) : null;
        if (target) {
          event.preventDefault();
          navigateToThread(threadRefFromSummary(target));
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSearchQuery("");
        searchInputRef.current?.blur();
      }
    },
    [highlightedSearchKey, navigateToThread, orderedThreadKeys.length, threadByKey],
  );
  const showMoreSettled = useCallback(() => {
    setSettledPaging((current) => ({
      scopeKey: settledPagingScopeKey,
      visibleCount:
        (current.scopeKey === settledPagingScopeKey
          ? current.visibleCount
          : INBOX_SETTLED_INITIAL_COUNT) + INBOX_SETTLED_PAGE_COUNT,
    }));
  }, [settledPagingScopeKey]);

  const commitRename = useCallback(() => {
    const target = renameTarget;
    const title = renameValue.trim();
    if (!target || !title) return;
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    void api.orchestration
      .dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: target.id,
        title,
      })
      .then(() => setRenameTarget(null))
      .catch((error) => lifecycleErrorToast("Could not rename thread", error));
  }, [renameTarget, renameValue]);

  const renderThreadRow = (
    item: SidebarThreadTreeItem<SidebarThreadSummary>,
    section: InboxLifecycleSection,
    listPosition?: { readonly index: number; readonly size: number },
  ) => {
    const thread = item.thread;
    const threadKey = scopedThreadKey(threadRefFromSummary(thread));
    const lifecycleThreadKey = lifecycleThreadKeyByThreadKey.get(threadKey) ?? threadKey;
    const lifecycleThread = lifecycleThreadByThreadKey.get(threadKey) ?? thread;
    const rootIndex = effectivePinnedRootKeys.indexOf(lifecycleThreadKey);
    const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const projectIdentity = projectIdentityByScopedKey.get(projectKey) ?? null;
    return (
      <Fragment key={threadKey}>
        <InboxChangeRequestObserver
          environmentId={thread.environmentId}
          cwd={thread.worktreePath ?? projectIdentity?.cwd ?? null}
          threadKey={threadKey}
          branch={thread.branch}
          onObservation={recordChangeRequestObservation}
        />
        <InboxThreadRow
          thread={thread}
          lifecycleThread={lifecycleThread}
          depth={item.depth}
          childCount={item.childCount}
          section={section}
          projectIdentity={projectIdentity}
          lifecycleThreadKey={lifecycleThreadKey}
          isLifecycleRoot={threadKey === lifecycleThreadKey}
          isActive={routeThreadKey === threadKey}
          isDraft={draftThreadKeys.has(threadKey)}
          draftId={draftIdByThreadKey.get(threadKey) ?? null}
          isSelected={selectedThreadKeys.has(threadKey) || highlightedSearchKey === threadKey}
          hasActiveLocalDispatch={activeLocalDispatchThreadKeys.has(threadKey)}
          localDispatchStartedAt={activeLocalDispatchStartedAtByThreadKey.get(threadKey) ?? null}
          backgroundLiveness={backgroundLivenessByLifecycleKey.get(lifecycleThreadKey) ?? null}
          isPending={pendingThreadKeys.has(threadKey)}
          isThreadExpanded={threadExpandedById[threadKey] ?? true}
          now={now}
          timestampFormat={settings.timestampFormat}
          lastVisitedAt={threadLastVisitedAtById[lifecycleThreadKey] ?? null}
          canPin={supportsThreadLifecycleCapability(lifecycleThread.environmentId, "threadPinning")}
          canSnooze={
            supportsThreadLifecycleCapability(lifecycleThread.environmentId, "threadSnooze") &&
            canSnoozeInboxThread(lifecycleThread, { now })
          }
          canSettle={
            supportsThreadLifecycleCapability(lifecycleThread.environmentId, "threadSettlement") &&
            (section === "settled" || canSettleInboxThread(lifecycleThread, { now }))
          }
          canReorderPinned={supportsThreadLifecycleCapability(
            lifecycleThread.environmentId,
            "threadPinReorder",
          )}
          canRegenerateTitle={supportsThreadLifecycleCapability(
            thread.environmentId,
            "threadTitleRegeneration",
          )}
          canMarkUnread={getAcknowledgedCompletionTurnId(thread) !== null}
          canMovePinUp={rootIndex > 0}
          canMovePinDown={rootIndex >= 0 && rootIndex < effectivePinnedRootKeys.length - 1}
          changeRequestSnapshot={changeRequestSnapshots[threadKey] ?? null}
          isRenaming={
            renameTarget !== null &&
            scopedThreadKey(threadRefFromSummary(renameTarget)) === threadKey
          }
          renameValue={renameValue}
          isRegeneratingTitle={regeneratingTitleByThreadKey[threadKey] !== undefined}
          onNavigate={navigateToThread}
          onAction={runAction}
          onToggleExpanded={toggleThreadExpanded}
          onPinnedDragStart={(key) => {
            draggedPinnedKeyRef.current = key;
          }}
          onPinnedDrop={(targetKey) => {
            const movedKey = draggedPinnedKeyRef.current;
            draggedPinnedKeyRef.current = null;
            if (!movedKey || movedKey === targetKey) return;
            const next = effectivePinnedRootKeys.filter((key) => key !== movedKey);
            const targetIndex = next.indexOf(targetKey);
            if (targetIndex < 0) return;
            next.splice(targetIndex, 0, movedKey);
            setOptimisticPinnedRootKeys(next);
            void dispatchPinnedOrder(next, movedKey).catch((error) => {
              setOptimisticPinnedRootKeys(null);
              lifecycleErrorToast("Could not reorder pinned threads", error);
            });
          }}
          onAcknowledgeWoke={(wokeAt) =>
            useUiStateStore.getState().markThreadVisited(lifecycleThreadKey, wokeAt)
          }
          onStartRename={() => {
            setRenameTarget(thread);
            setRenameValue(resolveSidebarThreadDisplayTitle(thread));
          }}
          onRenameValueChange={setRenameValue}
          onCommitRename={commitRename}
          onCancelRename={() => setRenameTarget(null)}
          {...(listPosition
            ? {
                virtualized: true,
                listPosition: listPosition.index + 1,
                listSize: listPosition.size,
              }
            : {})}
        />
      </Fragment>
    );
  };

  const renderSearchRow = (
    item: Extract<InboxSidebarListItem, { readonly kind: "search" }>,
    listPosition?: { readonly index: number; readonly size: number },
  ) => {
    const thread = item.item.thread;
    const threadKey = scopedThreadKey(threadRefFromSummary(thread));
    const lifecycleKey = lifecycleThreadKeyByThreadKey.get(threadKey) ?? threadKey;
    const lifecycleThread = lifecycleThreadByThreadKey.get(threadKey) ?? thread;
    const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const projectIdentity = projectIdentityByScopedKey.get(projectKey) ?? null;
    return (
      <Fragment key={item.key}>
        <InboxChangeRequestObserver
          environmentId={thread.environmentId}
          cwd={thread.worktreePath ?? projectIdentity?.cwd ?? null}
          threadKey={threadKey}
          branch={thread.branch}
          onObservation={recordChangeRequestObservation}
        />
        <InboxSearchResultRow
          optionId={`inbox-search-option-${item.index}`}
          thread={thread}
          lifecycleThread={lifecycleThread}
          projectIdentity={projectIdentity}
          isDraft={draftThreadKeys.has(threadKey)}
          isActive={routeThreadKey === threadKey}
          isHighlighted={highlightedSearchKey === threadKey}
          hasActiveLocalDispatch={activeLocalDispatchThreadKeys.has(threadKey)}
          backgroundLiveness={backgroundLivenessByLifecycleKey.get(lifecycleKey) ?? null}
          now={now}
          lastVisitedAt={threadLastVisitedAtById[lifecycleKey] ?? null}
          changeRequestSnapshot={changeRequestSnapshots[threadKey] ?? null}
          onNavigate={navigateToThread}
          onHighlight={() => setSearchHighlightIndex(item.index)}
          {...(listPosition
            ? {
                virtualized: true,
                listPosition: listPosition.index + 1,
                listSize: listPosition.size,
              }
            : {})}
        />
      </Fragment>
    );
  };

  const renderListItem = (item: InboxSidebarListItem, index: number, virtualized: boolean) => {
    const listPosition = virtualized ? { index, size: renderedListItems.length } : undefined;
    switch (item.kind) {
      case "thread":
        return renderThreadRow(item.item, item.section, listPosition);
      case "search":
        return renderSearchRow(item, listPosition);
      case "divider":
        return <InboxDivider key={item.key} tone={item.tone} virtualized={virtualized} />;
      case "shelf":
        return (
          <InboxShelf
            key={item.key}
            title={item.section === "snoozed" ? "Snoozed" : "Settled"}
            count={item.count}
            expanded={item.expanded}
            tone={item.section}
            virtualized={virtualized}
            onToggle={
              item.section === "snoozed"
                ? () => setSnoozedShelfExpanded((expanded) => !expanded)
                : () => setSettledShelfExpanded((expanded) => !expanded)
            }
          />
        );
      case "load-more":
        return (
          <InboxSettledLoadMore
            key={item.key}
            hiddenCount={item.count}
            virtualized={virtualized}
            onClick={showMoreSettled}
          />
        );
    }
  };

  const totalVisibleThreads =
    normalizedSearch.length > 0
      ? searchResults.length
      : sectionItems.drafts.length +
        sectionItems.pinned.length +
        sectionItems.active.length +
        sectionItems.snoozed.length +
        sectionItems.settled.length;
  const totalScopedThreads =
    partitions.drafts.length +
    partitions.pinned.length +
    partitions.active.length +
    partitions.snoozed.length +
    partitions.settled.length;

  return (
    <>
      <SidebarUsageBackgroundRefresh />
      <SidebarChromeHeader isElectron={isElectron} />
      <div className="flex min-h-0 flex-1 flex-col">
        <SidebarGroup className="px-2 pt-2 pb-1">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
              <Input
                ref={searchInputRef}
                aria-label="Search thread titles"
                aria-controls="inbox-thread-list"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={normalizedSearch.length > 0}
                aria-activedescendant={highlightedSearchOptionId}
                className="h-8 border-transparent bg-transparent pr-8 pl-7 text-[14px] shadow-none hover:bg-accent/50 focus-visible:border-ring focus-visible:bg-background"
                placeholder="Search threads"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {searchQuery ? (
                <button
                  type="button"
                  aria-label="Clear thread search"
                  className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : null}
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="New thread"
                    disabled={projects.length === 0}
                    className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={createThread}
                  />
                }
              >
                <SquarePenIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="right">
                {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </SidebarGroup>

        <SidebarGroup className="px-2 pt-1 pb-2">
          <InboxProjectPicker
            projects={projectGroups}
            selectedProject={scopedProject}
            selectedKey={projectScopeKey}
            sortOrder={settings.sidebarProjectSortOrder}
            resolveGroupingMode={(project) =>
              resolveProjectGroupingMode(
                project.memberProjects[0] ?? project,
                projectGroupingSettings,
              )
            }
            onSelect={setProjectScopeKey}
            onAddProject={openAddProject}
            onSortOrderChange={(sortOrder) =>
              updateSettings({ sidebarProjectSortOrder: sortOrder })
            }
            onMoveProject={(project, direction) => {
              const index = projectGroups.findIndex(
                (candidate) => candidate.projectKey === project.projectKey,
              );
              const target = projectGroups[index + direction];
              if (!target) return;
              reorderProjects(
                project.memberProjects.map(getProjectOrderKey),
                target.memberProjects.map(getProjectOrderKey),
              );
            }}
            onGroupingModeChange={(project, mode: SidebarProjectGroupingMode) => {
              const overrides = { ...settings.sidebarProjectGroupingOverrides };
              for (const member of project.memberProjects) {
                overrides[deriveProjectGroupingOverrideKey(member)] = mode;
              }
              updateSettings({ sidebarProjectGroupingOverrides: overrides });
            }}
            onOpenGeneralSettings={() => void navigate({ to: "/settings/general" })}
          />
        </SidebarGroup>

        {selectedThreadKeys.size > 0 ? (
          <div className="sticky top-0 z-10 mx-2 mb-2 flex items-center gap-1 rounded-lg border bg-popover/95 px-2 py-1.5 shadow-sm backdrop-blur-sm">
            <span className="mr-auto text-xs font-medium">{selectedThreadKeys.size} selected</span>
            <InboxBulkSnoozeMenu
              disabled={!selectedCanSnooze}
              timestampFormat={settings.timestampFormat}
              onSelect={(snoozedUntil, label) =>
                void runBulkLifecycle("snooze", snoozedUntil, label)
              }
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Settle selected threads"
                    disabled={!selectedCanSettle}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void runBulkLifecycle("settle")}
                  />
                }
              >
                <CheckIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Settle</TooltipPopup>
            </Tooltip>
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      aria-label="More actions for selected threads"
                      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>More actions</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" side="bottom" className="min-w-48">
                <MenuItem onClick={() => void runBulkRegenerateTitles()}>
                  <RefreshCwIcon />
                  Regenerate titles
                </MenuItem>
                <MenuItem onClick={() => void runBulkMarkUnread()}>
                  <Undo2Icon />
                  Mark unread
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => void runBulkDelete()}>
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Archive selected threads"
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => void runBulkArchive()}
                  />
                }
              >
                <ArchiveIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Archive</TooltipPopup>
            </Tooltip>
            <button
              type="button"
              aria-label="Clear selection"
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={clearSelection}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ) : null}

        {shouldUseVirtualizedList ? (
          <VirtualizedList
            id="inbox-thread-list"
            data-testid="inbox-thread-list"
            data={renderedListItems}
            keyExtractor={(item) => item.key}
            getItemType={(item) => inboxSidebarListItemType(item)}
            getFixedItemSize={(item) => inboxSidebarListItemSize(item)}
            renderItem={({ item, index }) => renderListItem(item, index, true)}
            estimatedItemSize={82}
            minOverscanItemCount={isMobile ? 4 : 8}
            maintainVisibleContentPosition={{ data: true, size: true }}
            role={normalizedSearch.length > 0 ? "listbox" : "list"}
            aria-label={normalizedSearch.length > 0 ? "Thread search results" : "Inbox threads"}
            className="min-h-0 flex-1 overflow-x-hidden px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          />
        ) : (
          <SidebarContent className="gap-0">
            <SidebarGroup className="px-2 pt-0 pb-3">
              <SidebarMenu
                id="inbox-thread-list"
                data-testid="inbox-thread-list"
                className="gap-0"
                role={normalizedSearch.length > 0 ? "listbox" : undefined}
                aria-label={normalizedSearch.length > 0 ? "Thread search results" : undefined}
              >
                {renderedListItems.map((item, index) => renderListItem(item, index, false))}
              </SidebarMenu>

              {!bootstrapComplete && totalScopedThreads === 0 ? (
                <div className="space-y-2 px-2 py-3" aria-label="Loading inbox">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="h-[4.5rem] animate-pulse rounded-md bg-muted/45" />
                  ))}
                </div>
              ) : normalizedSearch.length > 0 && totalVisibleThreads === 0 ? (
                <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
                  <SearchIcon className="size-5 text-muted-foreground/40" />
                  <span className="text-sm font-medium">No matching threads</span>
                  <span className="text-xs text-muted-foreground">Try another title.</span>
                </div>
              ) : totalScopedThreads === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                  <span className="text-sm text-muted-foreground">
                    {projects.length === 0
                      ? "No projects yet"
                      : scopedProject
                        ? `No threads in ${scopedProject.displayName} yet`
                        : "No threads yet"}
                  </span>
                  {projects.length === 0 ? (
                    <Button size="sm" variant="outline" onClick={openAddProject}>
                      Add project
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </SidebarGroup>
          </SidebarContent>
        )}
      </div>
      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
