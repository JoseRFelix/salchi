import * as React from "react";
import type { ScopedProjectRef } from "@salchi/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@salchi/contracts/settings";
import { sortThreads, type ThreadSortInput } from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { hasActiveSessionWork, isLatestTurnSettled } from "../session-logic";
import { resolveThreadDisplayTitle } from "../threadTitle";
import { hasUnseenCompletion as hasUnseenThreadCompletion } from "../threadCompletion";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;

export function shouldEnableSidebarListAnimations(
  environmentStates: ReadonlyArray<{ readonly bootstrapComplete: boolean }>,
): boolean {
  return (
    environmentStates.length > 0 &&
    environmentStates.every((environmentState) => environmentState.bootstrapComplete)
  );
}

// Sidebar rows are backed by shell snapshots. Keep detail prewarm disabled so
// reloads do not hydrate conversation pages for threads the user has not opened.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 0;
export type SidebarNewThreadEnvMode = "local" | "worktree";
export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "seenCompletionTurnId"
  | "session"
> & {
  hasActiveLocalDispatch?: boolean;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  return hasUnseenThreadCompletion(thread);
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function sortLogicalProjectsForSidebar<
  TProject extends {
    readonly projectKey: string;
    readonly displayName: string;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
    readonly memberProjectRefs: readonly ScopedProjectRef[];
  },
  TThread extends {
    readonly environmentId: string;
    readonly projectId: string;
    readonly archivedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt?: string | undefined;
  },
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") return [...projects];

  const projectKeyByRef = new Map<string, string>(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}\0${ref.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const latestTimestampByProjectKey = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = projectKeyByRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const candidate = Date.parse(
      sortOrder === "created_at" ? thread.createdAt : (thread.updatedAt ?? thread.createdAt),
    );
    if (Number.isNaN(candidate)) continue;
    latestTimestampByProjectKey.set(
      projectKey,
      Math.max(latestTimestampByProjectKey.get(projectKey) ?? Number.NEGATIVE_INFINITY, candidate),
    );
  }

  const projectFallback = (project: TProject) => {
    const value =
      sortOrder === "created_at" ? project.createdAt : (project.updatedAt ?? project.createdAt);
    const parsed = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...projects].toSorted((left, right) => {
    const leftAt = latestTimestampByProjectKey.get(left.projectKey) ?? projectFallback(left);
    const rightAt = latestTimestampByProjectKey.get(right.projectKey) ?? projectFallback(right);
    return (
      rightAt - leftAt ||
      left.displayName.localeCompare(right.displayName) ||
      left.projectKey.localeCompare(right.projectKey)
    );
  });
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export interface SidebarThreadTreeItem<TThread> {
  readonly thread: TThread;
  readonly depth: number;
  readonly rootThreadId: string;
  readonly childCount: number;
}

export function flattenSidebarThreadTree<
  TThread extends {
    readonly id: string;
    readonly parentThreadId?: string | null;
    readonly hiddenFromThreadList?: boolean;
  },
>(
  threads: readonly TThread[],
  options: {
    readonly collapsedThreadIds?: ReadonlySet<string>;
    readonly isThreadCollapsed?: (thread: TThread) => boolean;
  } = {},
): SidebarThreadTreeItem<TThread>[] {
  const visibleThreads = threads.filter((thread) => thread.hiddenFromThreadList !== true);
  const byId = new Map(visibleThreads.map((thread) => [thread.id, thread] as const));
  const childrenByParentId = new Map<string, TThread[]>();
  const roots: TThread[] = [];

  for (const thread of visibleThreads) {
    if (thread.parentThreadId && byId.has(thread.parentThreadId)) {
      const children = childrenByParentId.get(thread.parentThreadId) ?? [];
      children.push(thread);
      childrenByParentId.set(thread.parentThreadId, children);
      continue;
    }
    roots.push(thread);
  }

  const flattened: SidebarThreadTreeItem<TThread>[] = [];
  const appendThread = (
    thread: TThread,
    depth: number,
    rootThreadId: string,
    visited: Set<string>,
  ) => {
    if (visited.has(thread.id)) {
      return;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(thread.id);
    const children = childrenByParentId.get(thread.id) ?? [];
    flattened.push({ thread, depth, rootThreadId, childCount: children.length });
    if (options.collapsedThreadIds?.has(thread.id) || options.isThreadCollapsed?.(thread)) {
      return;
    }
    for (const child of children) {
      appendThread(child, depth + 1, rootThreadId, nextVisited);
    }
  };

  for (const root of roots) {
    appendThread(root, 0, root.id, new Set());
  }

  return flattened;
}

export function countSidebarRootThreadItems<TThread>(
  items: readonly SidebarThreadTreeItem<TThread>[],
): number {
  return items.reduce((count, item) => (item.depth === 0 ? count + 1 : count), 0);
}

export function getSidebarPreviewRootThreadIds<TThread>(
  items: readonly SidebarThreadTreeItem<TThread>[],
  previewLimit: number,
): string[] {
  if (previewLimit <= 0) {
    return [];
  }
  const rootThreadIds: string[] = [];
  for (const item of items) {
    if (item.depth === 0) {
      rootThreadIds.push(item.rootThreadId);
    }
    if (rootThreadIds.length >= previewLimit) {
      break;
    }
  }
  return rootThreadIds;
}

export function resolveSidebarThreadDisplayTitle(
  thread: Pick<
    SidebarThreadSummary,
    "parentThreadId" | "subagentNickname" | "subagentRole" | "title"
  >,
): string {
  return resolveThreadDisplayTitle(thread);
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
  isDraft?: boolean;
}): string {
  const baseClassName = cn(
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    input.isDraft && "border border-dashed border-muted-foreground/45",
  );

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function shouldShowProjectDraftBadge(input: {
  projectExpanded: boolean;
  hasDraftThread: boolean;
}): boolean {
  return !input.projectExpanded && input.hasDraftThread;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  isActiveThread?: boolean;
}): ThreadStatusPill | null {
  const { isActiveThread = false, thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.hasActiveLocalDispatch) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    hasActiveSessionWork(thread.latestTurn, thread.session) ||
    (thread.session?.status === "running" && thread.latestTurn === null)
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan &&
    hasUnseenCompletion(thread);
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread) && !isActiveThread) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
