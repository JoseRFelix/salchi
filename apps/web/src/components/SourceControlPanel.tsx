import { useParams } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestArrowIcon,
  ListTreeIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useMemo, useState } from "react";

import { useGitStatus, refreshGitStatus } from "~/lib/gitStatusState";
import { cn } from "~/lib/utils";
import { useStore, selectProjectByRef } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import {
  useSetSourceControlCommitMessage,
  useSourceControlPanelState,
} from "../sourceControlPanelState";
import {
  buildSourceControlTree,
  statusBadge,
  type SourceControlTreeNode,
} from "./sourceControlTree";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type SourceControlPanelMode = "sidebar" | "sheet";

interface SourceControlPanelProps {
  mode?: SourceControlPanelMode;
  onClose: () => void;
}

/**
 * VS Code-style "Source Control" panel.
 *
 * NOTE: this is the presentational shell. The git mutations (commit / push /
 * pull / publish / create PR) are intentionally left as TODO stubs so the
 * behaviour can be wired up separately.
 */
export default function SourceControlPanel({ mode = "sidebar", onClose }: SourceControlPanelProps) {
  const { commitMessage } = useSourceControlPanelState();
  const setCommitMessage = useSetSourceControlCommitMessage();
  const [viewMode, setViewMode] = useState<"tree" | "list">("tree");
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());

  // Resolve the active thread/draft so we can read its git status for display.
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const draftSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const serverRouteDraftSession = useComposerDraftStore((store) =>
    routeThreadRef ? store.getDraftSessionByRef(routeThreadRef) : null,
  );
  const context = serverThread ?? serverRouteDraftSession ?? draftSession ?? null;
  const environmentId = context?.environmentId ?? null;
  const projectId = context?.projectId ?? null;
  const worktreePath = context?.worktreePath ?? null;
  const project = useStore((store) =>
    environmentId && projectId
      ? selectProjectByRef(store, { environmentId, projectId })
      : undefined,
  );
  const cwd = worktreePath ?? project?.cwd ?? null;

  const { data: gitStatus = null } = useGitStatus({ environmentId, cwd });
  const branchName = gitStatus?.refName ?? null;
  const files = gitStatus?.workingTree.files ?? [];
  const fileCount = files.length;
  const insertions = gitStatus?.workingTree.insertions ?? 0;
  const deletions = gitStatus?.workingTree.deletions ?? 0;

  const tree = useMemo<SourceControlTreeNode[]>(() => {
    if (viewMode === "list") {
      return [...files]
        .toSorted((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({
          type: "file" as const,
          path: file.path,
          name: file.path,
          file,
        }));
    }
    return buildSourceControlTree(files);
  }, [files, viewMode]);

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleRefresh = useCallback(() => {
    if (!environmentId || !cwd) return;
    void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
  }, [environmentId, cwd]);

  // TODO: wire up the real git mutations (commit / push / pull / PR / publish).
  const handleCommit = useCallback(() => {
    /* logic added later */
  }, []);
  const handleCommitAndPush = useCallback(() => {
    /* logic added later */
  }, []);
  const handlePush = useCallback(() => {
    /* logic added later */
  }, []);
  const handlePull = useCallback(() => {
    /* logic added later */
  }, []);
  const handleCreatePullRequest = useCallback(() => {
    /* logic added later */
  }, []);

  const handleCommitMessageKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        handleCommit();
      }
    },
    [handleCommit],
  );

  const hasChanges = fileCount > 0;
  const commitDisabled = !hasChanges;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar" ? "h-full w-full border-l border-border/70" : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Source Control
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={viewMode === "tree" ? "View as list" : "View as tree"}
                  className="text-muted-foreground/60 hover:text-foreground/80"
                  onClick={() => setViewMode((value) => (value === "tree" ? "list" : "tree"))}
                />
              }
            >
              <ListTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {viewMode === "tree" ? "View as list" : "View as tree"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Refresh"
                  className="text-muted-foreground/60 hover:text-foreground/80"
                  onClick={handleRefresh}
                />
              }
            >
              <RefreshCwIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Refresh</TooltipPopup>
          </Tooltip>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close source control panel"
            className="text-muted-foreground/60 hover:text-foreground/80"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Commit composer */}
      <div className="shrink-0 space-y-2 border-b border-border/50 p-3">
        <Textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={handleCommitMessageKeyDown}
          size="sm"
          placeholder={
            branchName ? `Message (Ctrl+Enter to commit on "${branchName}")` : "Message"
          }
          aria-label="Commit message"
        />
        <div className="flex items-stretch">
          <Button
            size="sm"
            className="flex-1 rounded-e-none"
            disabled={commitDisabled}
            onClick={handleCommit}
          >
            <CheckIcon className="size-3.5" />
            Commit
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  aria-label="More commit actions"
                  disabled={commitDisabled}
                  className="rounded-s-none border-s border-primary-foreground/20 px-1.5"
                />
              }
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-48">
              <MenuItem onClick={handleCommit}>
                <GitCommitIcon className="size-4" />
                Commit
              </MenuItem>
              <MenuItem onClick={handleCommitAndPush}>
                <CloudUploadIcon className="size-4" />
                Commit &amp; Push
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={handlePush}>
                <CloudUploadIcon className="size-4" />
                Push
              </MenuItem>
              <MenuItem onClick={handlePull}>
                <RefreshCwIcon className="size-4" />
                Pull
              </MenuItem>
              <MenuItem onClick={handleCreatePullRequest}>
                <GitPullRequestArrowIcon className="size-4" />
                Create Pull Request
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        {branchName ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <GitBranchIcon className="size-3" />
            <span className="truncate">{branchName}</span>
          </div>
        ) : null}
      </div>

      {/* Changes */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5">
          <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs font-medium text-muted-foreground">
            <span className="uppercase tracking-wide">Changes</span>
            <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {fileCount}
            </span>
          </div>
          {hasChanges ? (
            <div className="mt-0.5">
              {tree.map((node) => (
                <SourceControlTreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={toggleDir}
                />
              ))}
            </div>
          ) : (
            <p className="px-1.5 py-6 text-center text-xs text-muted-foreground/60">
              No changes detected.
            </p>
          )}
        </div>
      </ScrollArea>

      {hasChanges ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-3 py-1.5 font-mono text-[11px]">
          <span className="text-emerald-500">+{insertions}</span>
          <span className="text-muted-foreground/50">/</span>
          <span className="text-destructive">-{deletions}</span>
        </div>
      ) : null}
    </div>
  );
}

function SourceControlTreeRow({
  node,
  depth,
  collapsedDirs,
  onToggleDir,
}: {
  node: SourceControlTreeNode;
  depth: number;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
}) {
  const indentStyle = { paddingLeft: `${depth * 12 + 6}px` };

  if (node.type === "dir") {
    const collapsed = collapsedDirs.has(node.path);
    return (
      <>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          style={indentStyle}
          className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-accent/50"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {collapsed
          ? null
          : node.children.map((child) => (
              <SourceControlTreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                collapsedDirs={collapsedDirs}
                onToggleDir={onToggleDir}
              />
            ))}
      </>
    );
  }

  const badge = statusBadge(node.file.status);
  return (
    <button
      type="button"
      style={indentStyle}
      title={node.path}
      // TODO: open this file's diff when clicked (logic added later).
      className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-accent/50"
    >
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{node.name}</span>
      <span
        className={cn(
          "shrink-0 text-[11px] font-semibold tabular-nums",
          badge.className,
        )}
        aria-label={badge.label}
        title={badge.label}
      >
        {badge.letter}
      </span>
    </button>
  );
}
