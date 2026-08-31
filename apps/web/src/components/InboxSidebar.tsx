import {
  AlarmClockIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  SearchIcon,
  SquarePenIcon,
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
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  generateSpreadPinOrderKeys,
  getNextInboxWakeAtMs,
  partitionInboxThreads,
  pinOrderKeyBetween,
  planPinnedReorder,
  resolveInboxSnoozePresets,
  type InboxLifecycleSection,
} from "../inboxLifecycle";
import { classifyInboxBackgroundThread } from "../inboxThreadStatus";
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
  shouldVirtualizeInboxActiveThreads,
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { useServerKeybindings } from "../rpc/serverState";
import { useFixedSharedScrollVirtualizer } from "./virtualization/useSharedScrollVirtualizer";
import { InboxProjectPicker, ALL_PROJECTS_SCOPE } from "./inbox/InboxProjectPicker";
import {
  InboxThreadRow,
  snoozePresetIdFromInboxAction,
  type InboxProjectIdentity,
  type InboxThreadAction,
} from "./inbox/InboxThreadRow";
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
const INBOX_CARD_ROW_STRIDE = 82;
const INBOX_SLIM_ROW_STRIDE = 40;
const INBOX_ACTIVE_VIRTUALIZATION_MOBILE_INITIAL_COUNT = 8;
const INBOX_ACTIVE_VIRTUALIZATION_DESKTOP_INITIAL_COUNT = 12;
const INBOX_ACTIVE_VIRTUALIZATION_MOBILE_OVERSCAN = INBOX_CARD_ROW_STRIDE * 3;
const INBOX_ACTIVE_VIRTUALIZATION_DESKTOP_OVERSCAN = INBOX_CARD_ROW_STRIDE * 6;
const INBOX_SETTLED_VIRTUALIZATION_OVERSCAN = INBOX_SLIM_ROW_STRIDE * 4;

function InboxShelf(props: {
  readonly title: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly tone: "snoozed" | "settled";
  readonly onToggle: () => void;
}) {
  if (props.count === 0) return null;
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
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHighlightIndex, setSearchHighlightIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [renameTarget, setRenameTarget] = useState<SidebarThreadSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
  const settledPagingScopeKey = projectScopeKey ?? ALL_PROJECTS_SCOPE;
  const [settledPaging, setSettledPaging] = useState({
    scopeKey: settledPagingScopeKey,
    visibleCount: INBOX_SETTLED_INITIAL_COUNT,
  });
  const settledVisibleCount =
    settledPaging.scopeKey === settledPagingScopeKey
      ? settledPaging.visibleCount
      : INBOX_SETTLED_INITIAL_COUNT;
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const activeListRef = useRef<HTMLUListElement | null>(null);
  const settledListRef = useRef<HTMLUListElement | null>(null);
  const draggedPinnedKeyRef = useRef<string | null>(null);

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
    () => partitionInboxThreads({ threads: scopedThreads, draftThreadKeys, now }),
    [draftThreadKeys, now, scopedThreads],
  );
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const sectionItems = useMemo(() => {
    const flatten = (sectionThreads: readonly SidebarThreadSummary[]) =>
      flattenSidebarThreadTree(sectionThreads, {
        isThreadCollapsed: (thread) =>
          normalizedSearch.length === 0 &&
          threadExpandedById[scopedThreadKey(threadRefFromSummary(thread))] === false,
      }).filter(
        (item) =>
          normalizedSearch.length === 0 ||
          resolveSidebarThreadDisplayTitle(item.thread)
            .toLocaleLowerCase()
            .includes(normalizedSearch),
      );
    return {
      drafts: flatten(partitions.drafts),
      pinned: flatten(partitions.pinned),
      active: flatten(partitions.active),
      snoozed: flatten(partitions.snoozed),
      settled: flatten(partitions.settled),
    };
  }, [normalizedSearch, partitions, threadExpandedById]);
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

  const shouldVirtualizeActive =
    normalizedSearch.length === 0 && shouldVirtualizeInboxActiveThreads(sectionItems.active.length);
  const activeVirtualRange = useFixedSharedScrollVirtualizer({
    enabled: shouldVirtualizeActive,
    itemCount: sectionItems.active.length,
    itemStride: INBOX_CARD_ROW_STRIDE,
    overscan: isMobile
      ? INBOX_ACTIVE_VIRTUALIZATION_MOBILE_OVERSCAN
      : INBOX_ACTIVE_VIRTUALIZATION_DESKTOP_OVERSCAN,
    initialRenderCount: isMobile
      ? INBOX_ACTIVE_VIRTUALIZATION_MOBILE_INITIAL_COUNT
      : INBOX_ACTIVE_VIRTUALIZATION_DESKTOP_INITIAL_COUNT,
    listRef: activeListRef,
    scrollViewportRef,
  });
  const visibleActiveItems = shouldVirtualizeActive
    ? sectionItems.active.slice(activeVirtualRange.startIndex, activeVirtualRange.endIndex)
    : sectionItems.active;
  const activeListHeight = sectionItems.active.length * INBOX_CARD_ROW_STRIDE;
  const visibleSnoozedItems = useMemo(
    () =>
      normalizedSearch.length > 0
        ? sectionItems.snoozed
        : resolveInboxShelfItems({
            items: sectionItems.snoozed,
            expanded: snoozedShelfExpanded,
            activeKey: routeThreadKey,
            getKey: (item) => scopedThreadKey(threadRefFromSummary(item.thread)),
          }),
    [normalizedSearch, routeThreadKey, sectionItems.snoozed, snoozedShelfExpanded],
  );
  const visibleSettledItems = useMemo(
    () =>
      normalizedSearch.length > 0
        ? sectionItems.settled
        : resolvePaginatedInboxShelfItems({
            items: sectionItems.settled,
            expanded: settledShelfExpanded,
            activeKey: routeThreadKey,
            visibleCount: settledVisibleCount,
            getKey: (item) => scopedThreadKey(threadRefFromSummary(item.thread)),
          }),
    [
      normalizedSearch,
      routeThreadKey,
      sectionItems.settled,
      settledShelfExpanded,
      settledVisibleCount,
    ],
  );
  const hiddenSettledCount = Math.max(0, sectionItems.settled.length - visibleSettledItems.length);
  const shouldVirtualizeSettled =
    normalizedSearch.length === 0 &&
    isMobile &&
    settledShelfExpanded &&
    visibleSettledItems.length > 0 &&
    !visibleSettledItems.some(
      (item) => scopedThreadKey(threadRefFromSummary(item.thread)) === routeThreadKey,
    );
  const settledVirtualRange = useFixedSharedScrollVirtualizer({
    enabled: shouldVirtualizeSettled,
    itemCount: visibleSettledItems.length,
    itemStride: INBOX_SLIM_ROW_STRIDE,
    overscan: INBOX_SETTLED_VIRTUALIZATION_OVERSCAN,
    initialRenderCount: 0,
    listRef: settledListRef,
    scrollViewportRef,
  });
  const renderedSettledItems = shouldVirtualizeSettled
    ? visibleSettledItems.slice(settledVirtualRange.startIndex, settledVirtualRange.endIndex)
    : visibleSettledItems;
  const settledListHeight = visibleSettledItems.length * INBOX_SLIM_ROW_STRIDE;
  const orderedItems = useMemo(
    () => [
      ...sectionItems.drafts,
      ...sectionItems.pinned,
      ...sectionItems.active,
      ...visibleSnoozedItems,
      ...visibleSettledItems,
    ],
    [sectionItems, visibleSettledItems, visibleSnoozedItems],
  );
  const orderedThreadKeys = useMemo(
    () => orderedItems.map((item) => scopedThreadKey(threadRefFromSummary(item.thread))),
    [orderedItems],
  );
  const highlightedSearchKey =
    normalizedSearch.length > 0
      ? resolveInboxSearchHighlight(orderedThreadKeys, searchHighlightIndex)
      : null;

  useEffect(() => {
    if (projectScopeKey !== null && scopedProject === null) setProjectScopeKey(null);
  }, [projectScopeKey, scopedProject]);
  useEffect(() => {
    clearSelection();
    setSearchHighlightIndex(0);
  }, [clearSelection, projectScopeKey]);
  useEffect(() => setSearchHighlightIndex(0), [normalizedSearch]);
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
      const from = pinnedRootKeys.indexOf(lifecycleKey);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= pinnedRootKeys.length) return;
      const next = [...pinnedRootKeys];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      await dispatchPinnedOrder(next, lifecycleKey);
    },
    [dispatchPinnedOrder, pinnedRootKeys],
  );

  const handleAction = useCallback(
    async (action: InboxThreadAction, thread: SidebarThreadSummary, lifecycleThreadKey: string) => {
      const threadRef = threadRefFromSummary(thread);
      const lifecycleThread = threadByKey.get(lifecycleThreadKey) ?? thread;
      const lifecycleRef = threadRefFromSummary(lifecycleThread);
      const snoozePresetId = snoozePresetIdFromInboxAction(action);
      try {
        if (snoozePresetId !== null) {
          const preset = resolveInboxSnoozePresets(new Date()).find(
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
          return;
        }
        switch (action) {
          case "toggle-pin": {
            if (lifecycleThread.pinnedAt != null) {
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
          case "toggle-settled":
            await setThreadSettled(
              lifecycleRef,
              lifecycleThread.settledOverride !== "settled" && lifecycleThread.settledAt == null,
            );
            return;
          case "rename":
            setRenameTarget(thread);
            setRenameValue(resolveSidebarThreadDisplayTitle(thread));
            return;
          case "regenerate-title": {
            const api = readEnvironmentApi(thread.environmentId);
            if (!api) return;
            await api.orchestration.dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: thread.id,
              regenerateTitle: true,
            });
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
      rootPinnedThreads,
      setOpenMobile,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
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
  const runBulkLifecycle = useCallback(
    async (operation: "settle" | "snooze") => {
      const uniqueRoots = new Map<string, SidebarThreadSummary>();
      for (const thread of selectedThreads) {
        const ownKey = scopedThreadKey(threadRefFromSummary(thread));
        const rootKey = lifecycleThreadKeyByThreadKey.get(ownKey) ?? ownKey;
        const root = threadByKey.get(rootKey) ?? thread;
        uniqueRoots.set(rootKey, root);
      }
      try {
        if (operation === "settle") {
          await Promise.all(
            [...uniqueRoots.values()].map((thread) =>
              setThreadSettled(threadRefFromSummary(thread), true),
            ),
          );
        } else {
          const tomorrow = resolveInboxSnoozePresets(new Date()).find(
            (preset) => preset.id === "tomorrow",
          );
          if (tomorrow) {
            await Promise.all(
              [...uniqueRoots.values()].map((thread) =>
                snoozeThread(threadRefFromSummary(thread), tomorrow.snoozedUntil),
              ),
            );
          }
        }
        clearSelection();
      } catch (error) {
        lifecycleErrorToast("Bulk action failed", error);
      }
    },
    [clearSelection, lifecycleThreadKeyByThreadKey, selectedThreads, threadByKey],
  );
  const runBulkArchive = useCallback(async () => {
    try {
      await Promise.all(
        selectedThreads.map((thread) => archiveThread(threadRefFromSummary(thread))),
      );
      clearSelection();
    } catch (error) {
      lifecycleErrorToast("Bulk archive failed", error);
    }
  }, [archiveThread, clearSelection, selectedThreads]);

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
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

  const renderRows = (
    items: readonly SidebarThreadTreeItem<SidebarThreadSummary>[],
    section: InboxLifecycleSection,
    virtualRange?: {
      readonly startIndex: number;
      readonly setSize: number;
      readonly stride: number;
    },
  ) =>
    items.map((item, itemIndex) => {
      const thread = item.thread;
      const threadKey = scopedThreadKey(threadRefFromSummary(thread));
      const lifecycleThreadKey = lifecycleThreadKeyByThreadKey.get(threadKey) ?? threadKey;
      const lifecycleThread = lifecycleThreadByThreadKey.get(threadKey) ?? thread;
      const rootIndex = pinnedRootKeys.indexOf(lifecycleThreadKey);
      const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return (
        <InboxThreadRow
          key={threadKey}
          thread={thread}
          lifecycleThread={lifecycleThread}
          depth={item.depth}
          childCount={item.childCount}
          section={section}
          projectIdentity={projectIdentityByScopedKey.get(projectKey) ?? null}
          lifecycleThreadKey={lifecycleThreadKey}
          isLifecycleRoot={threadKey === lifecycleThreadKey}
          isActive={routeThreadKey === threadKey}
          isDraft={draftThreadKeys.has(threadKey)}
          draftId={draftIdByThreadKey.get(threadKey) ?? null}
          isSelected={selectedThreadKeys.has(threadKey) || highlightedSearchKey === threadKey}
          hasActiveLocalDispatch={activeLocalDispatchThreadKeys.has(threadKey)}
          backgroundLiveness={backgroundLivenessByLifecycleKey.get(lifecycleThreadKey) ?? null}
          isPending={pendingThreadKeys.has(threadKey)}
          isThreadExpanded={threadExpandedById[threadKey] ?? true}
          now={now}
          canPin={supportsThreadLifecycleCapability(lifecycleThread.environmentId, "threadPinning")}
          canSnooze={supportsThreadLifecycleCapability(
            lifecycleThread.environmentId,
            "threadSnooze",
          )}
          canSettle={supportsThreadLifecycleCapability(
            lifecycleThread.environmentId,
            "threadSettlement",
          )}
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
          canMovePinDown={rootIndex >= 0 && rootIndex < pinnedRootKeys.length - 1}
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
            const next = pinnedRootKeys.filter((key) => key !== movedKey);
            const targetIndex = next.indexOf(targetKey);
            if (targetIndex < 0) return;
            next.splice(targetIndex, 0, movedKey);
            void dispatchPinnedOrder(next, movedKey).catch((error) =>
              lifecycleErrorToast("Could not reorder pinned threads", error),
            );
          }}
          {...(virtualRange
            ? {
                virtualIndex: virtualRange.startIndex + itemIndex,
                virtualSetSize: virtualRange.setSize,
                virtualStride: virtualRange.stride,
              }
            : {})}
        />
      );
    });

  const totalVisibleThreads =
    sectionItems.drafts.length +
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
      <SidebarContent className="gap-0" scrollViewportRef={scrollViewportRef}>
        <SidebarGroup className="px-2 pt-2 pb-1">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
              <Input
                ref={searchInputRef}
                aria-label="Search thread titles"
                aria-controls="inbox-thread-list"
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Snooze selected threads"
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => void runBulkLifecycle("snooze")}
                  />
                }
              >
                <AlarmClockIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Snooze until tomorrow</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Settle selected threads"
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => void runBulkLifecycle("settle")}
                  />
                }
              >
                <CheckIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Settle</TooltipPopup>
            </Tooltip>
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

        <SidebarGroup
          id="inbox-thread-list"
          className="px-2 pt-0 pb-3"
          data-testid="inbox-thread-list"
        >
          <SidebarMenu className="gap-0">
            {renderRows(sectionItems.drafts, "drafts")}
            {sectionItems.drafts.length > 0 ? (
              <SidebarMenuItem aria-hidden className="mx-2 my-1.5 h-px list-none bg-amber-500/25" />
            ) : null}
            {renderRows(sectionItems.pinned, "pinned")}
            {sectionItems.pinned.length > 0 ? (
              <SidebarMenuItem
                aria-hidden
                className="mx-2 my-1.5 h-px list-none bg-sidebar-border/70"
              />
            ) : null}
            {sectionItems.active.length > 0 ? (
              <SidebarMenuItem className="list-none">
                <SidebarMenu
                  ref={activeListRef}
                  aria-label="Active threads"
                  className={cn("gap-0", shouldVirtualizeActive && "relative block")}
                  style={shouldVirtualizeActive ? { height: activeListHeight } : undefined}
                >
                  {renderRows(
                    visibleActiveItems,
                    "active",
                    shouldVirtualizeActive
                      ? {
                          startIndex: activeVirtualRange.startIndex,
                          setSize: sectionItems.active.length,
                          stride: INBOX_CARD_ROW_STRIDE,
                        }
                      : undefined,
                  )}
                </SidebarMenu>
              </SidebarMenuItem>
            ) : null}
            <InboxShelf
              title="Snoozed"
              count={sectionItems.snoozed.length}
              expanded={normalizedSearch.length > 0 || snoozedShelfExpanded}
              tone="snoozed"
              onToggle={() => setSnoozedShelfExpanded((expanded) => !expanded)}
            />
            {renderRows(visibleSnoozedItems, "snoozed")}
            <InboxShelf
              title="Settled"
              count={sectionItems.settled.length}
              expanded={normalizedSearch.length > 0 || settledShelfExpanded}
              tone="settled"
              onToggle={() => setSettledShelfExpanded((expanded) => !expanded)}
            />
            {visibleSettledItems.length > 0 ? (
              <SidebarMenuItem className="list-none">
                <SidebarMenu
                  ref={settledListRef}
                  aria-label="Settled threads"
                  className={cn("gap-0", shouldVirtualizeSettled && "relative block")}
                  style={shouldVirtualizeSettled ? { height: settledListHeight } : undefined}
                >
                  {renderRows(
                    renderedSettledItems,
                    "settled",
                    shouldVirtualizeSettled
                      ? {
                          startIndex: settledVirtualRange.startIndex,
                          setSize: visibleSettledItems.length,
                          stride: INBOX_SLIM_ROW_STRIDE,
                        }
                      : undefined,
                  )}
                </SidebarMenu>
              </SidebarMenuItem>
            ) : null}
            {normalizedSearch.length === 0 && settledShelfExpanded && hiddenSettledCount > 0 ? (
              <SidebarMenuItem className="list-none px-2 py-1">
                <button
                  type="button"
                  className="flex h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-xs text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  onClick={showMoreSettled}
                >
                  Show {Math.min(INBOX_SETTLED_PAGE_COUNT, hiddenSettledCount)} more
                </button>
              </SidebarMenuItem>
            ) : null}
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
      <SidebarSeparator />
      <SidebarChromeFooter />

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
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
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename thread</DialogTitle>
              <DialogDescription>Give this thread a concise, recognizable title.</DialogDescription>
            </DialogHeader>
            <div className="px-6 pb-6">
              <Input
                autoFocus
                aria-label="Thread title"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renameValue.trim().length === 0}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
