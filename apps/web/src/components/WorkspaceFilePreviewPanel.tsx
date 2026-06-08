import {
  File,
  FileDiff,
  Virtualizer,
  VirtualizerContext,
  type FileContents,
  type LineAnnotation,
} from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  FolderTreeIcon,
  PanelRightCloseIcon,
  PlusIcon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import {
  CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH,
  createCodeHighlightCacheKey,
  FILE_PREVIEW_HIGHLIGHT_MAX_BYTES,
  resolveCodeHighlightLanguageFromPath,
} from "../codeHighlighting";
import { readEnvironmentApi } from "../environmentApi";
import { useFilePreviewWordWrapPreference } from "../filePreviewPreferences";
import { formatWorkspaceRelativePath } from "../filePathDisplay";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useTheme } from "../hooks/useTheme";
import { DIFF_MOBILE_TEXT_FLOOR_UNSAFE_CSS, resolveDiffThemeName } from "../lib/diffRendering";
import { gitWorkingTreeDiffQueryOptions } from "../lib/gitReactQuery";
import { useGitStatus } from "../lib/gitStatusState";
import type {
  WorkspaceFilePanelHistoryEntry,
  WorkspaceFilePreviewTarget,
} from "../workspaceFilePreview";
import {
  closeWorkspaceFilePreview,
  workspaceFilePanelBackButtonLabel,
} from "../workspaceFilePreview";
import {
  isWorkspaceImagePreviewPath,
  resolveWorkspaceImagePreviewUrl,
} from "../workspaceImagePreview";
import {
  buildWorkspaceFileDiffMarkers,
  type WorkspaceFileDiffLineMarker,
  type WorkspaceFileDiffMarkerKind,
  type WorkspaceFileInlineDiffHunk,
} from "../workspace-file-diff-markers";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";

const FILE_PREVIEW_LINE_HEIGHT = 20;
const FILE_PREVIEW_VIRTUALIZER_CLASS_NAME = "workspace-file-preview-virtualizer";
const FILE_PREVIEW_INLINE_DIFF_SELECTOR = '[data-workspace-file-inline-diff="true"]';
// A tap counts as a click as long as the finger barely moves; anything larger is a scroll.
const FILE_PREVIEW_GUTTER_TAP_SLOP_PX = 10;

const FILE_PREVIEW_RENDER_STYLE = {
  "--diffs-bg": "var(--background)",
  "--diffs-light-bg": "var(--background)",
  "--diffs-dark-bg": "var(--background)",
  "--diffs-bg-buffer-override": "var(--background)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": `${FILE_PREVIEW_LINE_HEIGHT}px`,
  "--diffs-font-family":
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  backgroundColor: "var(--background)",
} as CSSProperties;

const FILE_PREVIEW_UNSAFE_CSS = `
[data-file],
[data-virtualizer-buffer] {
  --diffs-bg: var(--background) !important;
  --diffs-light-bg: var(--background) !important;
  --diffs-dark-bg: var(--background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: var(--background);
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-buffer-override: var(--background);
  background-color: var(--background) !important;
}

[data-file] {
  --diffs-grid-number-column-width: 3.5rem;
  color: color-mix(in srgb, var(--foreground) 85%, transparent);
}

[data-column-number] {
  padding-right: 0.75rem !important;
  color: color-mix(in srgb, var(--muted-foreground) 45%, transparent) !important;
  user-select: none;
}

[data-line],
[data-column-number],
[data-gutter-buffer] {
  min-height: ${FILE_PREVIEW_LINE_HEIGHT}px;
}

[data-line][data-selected-line],
[data-column-number][data-selected-line] {
  --diffs-line-bg: color-mix(in srgb, var(--background) 88%, var(--primary)) !important;
}
`;

const FILE_PREVIEW_INLINE_DIFF_UNSAFE_CSS = `
${FILE_PREVIEW_UNSAFE_CSS}

[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--background) 96%, var(--foreground)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--background) 96%, var(--foreground)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--background) 96%, var(--foreground)) !important;
  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 91%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 87%, var(--success));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 91%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 87%, var(--destructive));
  background-color: var(--diffs-bg) !important;
}

[data-diffs-header],
[data-file-info] {
  display: none !important;
}

${DIFF_MOBILE_TEXT_FLOOR_UNSAFE_CSS}
`;

interface WorkspaceFileInlineDiffAnnotation {
  readonly hunkId: string;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
}

function countPreviewLines(contents: string): number {
  if (contents.length === 0) {
    return 0;
  }
  const lineCount = contents.split("\n").length;
  return contents.endsWith("\n") ? lineCount - 1 : lineCount;
}

function markerColor(kind: WorkspaceFileDiffMarkerKind): string {
  switch (kind) {
    case "added":
      return "var(--success)";
    case "modified":
      return "var(--warning)";
    case "deleted":
      return "var(--destructive)";
  }
}

function buildFilePreviewMarkerUnsafeCss(
  markers: ReadonlyArray<WorkspaceFileDiffLineMarker>,
): string {
  if (markers.length === 0) {
    return "";
  }

  return markers
    .map((marker) => {
      const lineNumber = String(marker.lineNumber);
      const color = markerColor(marker.kind);
      const numberSelector = `[data-column-number="${lineNumber}"]`;

      return `
${numberSelector} {
  cursor: pointer !important;
  touch-action: manipulation !important;
  background-image: linear-gradient(${color}, ${color}) !important;
  background-position: left top !important;
  background-repeat: no-repeat !important;
  background-size: 4px 100% !important;
  transition: background-size 120ms ease;
}

/* Gate the grow-on-hover behind a real hover pointer. On touch the first tap would
   otherwise only apply :hover (the badge "protrudes") and the browser withholds the
   click, so the inline diff never opens. */
@media (hover: hover) {
  ${numberSelector}:hover {
    background-size: 6px 100% !important;
  }
}
`;
    })
    .join("\n");
}

// Resolves the line number of the line-number gutter cell (where the change badge is
// painted) under a pointer event, piercing the renderer's shadow DOM via composedPath.
// Returns null for taps on the code content or anywhere outside the gutter.
function resolveGutterLineNumberFromEvent(event: PointerEvent): number | null {
  const path = event.composedPath();

  for (const target of path) {
    if (
      target instanceof Element &&
      (target.matches(FILE_PREVIEW_INLINE_DIFF_SELECTOR) ||
        target.closest(FILE_PREVIEW_INLINE_DIFF_SELECTOR) !== null)
    ) {
      // Taps inside an expanded inline diff carry their own gutter; ignore them.
      return null;
    }
  }

  for (const target of path) {
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    const value = target.getAttribute("data-column-number");
    if (value === null) {
      continue;
    }
    const lineNumber = Number(value);
    if (Number.isInteger(lineNumber) && lineNumber > 0) {
      return lineNumber;
    }
  }

  return null;
}

function buildWorkingTreeSignature(
  files:
    | ReadonlyArray<{
        readonly deletions: number;
        readonly insertions: number;
        readonly path: string;
        readonly status: string;
      }>
    | undefined,
): string {
  if (!files || files.length === 0) {
    return "";
  }
  return files
    .map((file) => `${file.path}:${file.status}:${file.insertions}:${file.deletions}`)
    .toSorted()
    .join("|");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizePreviewContents(contents: string): string {
  return contents.replace(/\r\n/g, "\n");
}

function workspaceFilePreviewQueryOptions(
  target: WorkspaceFilePreviewTarget | null,
  shouldReadFile: boolean,
) {
  return {
    queryKey: [
      "workspaceFilePreview",
      target?.environmentId ?? null,
      target?.cwd ?? null,
      target?.relativePath ?? null,
    ],
    enabled: target !== null && shouldReadFile,
    queryFn: async () => {
      if (!target) {
        throw new Error("No file selected.");
      }
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        throw new Error("Environment API not found.");
      }
      return api.projects.readFile({
        cwd: target.cwd,
        relativePath: target.relativePath,
      });
    },
  };
}

function getFilePreviewScrollElement(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`.${FILE_PREVIEW_VIRTUALIZER_CLASS_NAME}`) ?? null;
}

function useFilePreviewVirtualizerLayoutRevision({
  enabled,
  layoutKey,
  rootRef,
}: {
  enabled: boolean;
  layoutKey: string | null;
  rootRef: RefObject<HTMLElement | null>;
}): number {
  const [revisionState, setRevisionState] = useState<{ key: string | null; revision: number }>({
    key: null,
    revision: 0,
  });
  const refreshedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // When the panel is hidden (e.g. a preserved preview reopened via swipe), the
    // virtualizer keeps its stale 0-height measurements. Forget the refreshed key so
    // the next time the panel becomes visible we re-run the layout bump and remount
    // the virtualizer against real dimensions instead of rendering a blank page.
    if (!enabled) {
      refreshedKeyRef.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || layoutKey === null) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;
    let cancelled = false;

    const cancelScheduledFrames = () => {
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
        firstFrameId = null;
      }
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
        secondFrameId = null;
      }
    };

    const refreshAfterLayoutSettles = () => {
      if (cancelled || refreshedKeyRef.current === layoutKey || firstFrameId !== null) {
        return;
      }

      firstFrameId = window.requestAnimationFrame(() => {
        firstFrameId = null;
        secondFrameId = window.requestAnimationFrame(() => {
          secondFrameId = null;
          if (cancelled || refreshedKeyRef.current === layoutKey) {
            return;
          }

          const rect = root.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return;
          }

          refreshedKeyRef.current = layoutKey;
          setRevisionState((current) =>
            current.key === layoutKey
              ? { key: layoutKey, revision: current.revision + 1 }
              : { key: layoutKey, revision: 1 },
          );
        });
      });
    };

    refreshAfterLayoutSettles();

    const resizeObserver = new ResizeObserver(() => refreshAfterLayoutSettles());
    resizeObserver.observe(root);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      cancelScheduledFrames();
    };
  }, [enabled, layoutKey, rootRef]);

  return revisionState.key === layoutKey ? revisionState.revision : 0;
}

function WorkspaceInlineDiffAnnotation(props: {
  hunk: WorkspaceFileInlineDiffHunk;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  options: {
    diffThemeName: string;
    resolvedTheme: "dark" | "light" | "system";
    wordWrap: boolean;
  };
}) {
  const { hunk } = props;
  const hasPrev = hunk.position > 1;
  const hasNext = hunk.position < hunk.totalHunks;
  return (
    <div
      className="border-y border-border/70 bg-muted/30"
      data-testid="workspace-file-inline-diff"
      data-workspace-file-inline-diff="true"
    >
      <div className="flex h-7 items-center justify-between gap-2 border-b border-border/50 bg-muted/60 pl-3 pr-1">
        <p className="truncate text-[15px] font-medium text-muted-foreground md:text-[11px]">
          Working tree change {hunk.position} of {hunk.totalHunks}
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous change"
            title="Previous change"
            disabled={!hasPrev}
            onClick={() => props.onNavigate("prev")}
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next change"
            title="Next change"
            disabled={!hasNext}
            onClick={() => props.onNavigate("next")}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close inline diff"
            title="Close inline diff"
            onClick={props.onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="max-h-[min(28rem,45vh)] overflow-y-auto overscroll-contain">
        <VirtualizerContext.Provider value={undefined}>
          <FileDiff
            className="workspace-file-preview-inline-diff min-w-full"
            fileDiff={hunk.fileDiff}
            style={FILE_PREVIEW_RENDER_STYLE}
            options={{
              diffStyle: "unified",
              disableFileHeader: true,
              hunkSeparators: "simple",
              lineDiffType: "word",
              overflow: props.options.wordWrap ? "wrap" : "scroll",
              theme: props.options.diffThemeName,
              themeType: props.options.resolvedTheme,
              tokenizeMaxLineLength: CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH,
              unsafeCSS: FILE_PREVIEW_INLINE_DIFF_UNSAFE_CSS,
            }}
          />
        </VirtualizerContext.Provider>
      </div>
    </div>
  );
}

function WorkspaceImagePreview(props: { src: string; alt: string }) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    setLoadState("loading");
  }, [props.src]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-auto bg-background">
      {loadState === "loading" ? (
        <div className="absolute inset-0 flex">
          <DiffPanelLoadingState label="Loading image preview..." />
        </div>
      ) : null}
      {loadState === "error" ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-destructive">
          Unable to load image preview.
        </div>
      ) : null}
      <div className="flex min-h-full min-w-full items-center justify-center p-4">
        <img
          src={props.src}
          alt={props.alt}
          draggable={false}
          aria-hidden={loadState !== "loaded"}
          className={
            loadState === "loaded"
              ? "max-h-full max-w-full object-contain"
              : "pointer-events-none max-h-full max-w-full object-contain opacity-0"
          }
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("error")}
        />
      </div>
    </div>
  );
}

export function WorkspaceFilePreviewPanel(props: {
  backTarget?: WorkspaceFilePanelHistoryEntry | null | undefined;
  mode: DiffPanelMode;
  panelOpen?: boolean;
  target: WorkspaceFilePreviewTarget | null;
  onAddFileToInput?: (relativePath: string) => void;
  onBack?: (() => void) | undefined;
  onShowExplorer?: () => void;
  showExplorerButton?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [wordWrap, setWordWrap] = useFilePreviewWordWrapPreference();
  const [expandedDiffHunkId, setExpandedDiffHunkId] = useState<string | null>(null);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const lastAutoScrollKeyRef = useRef<string | null>(null);
  const lastWorkingTreeSignatureRef = useRef<string | null>(null);
  const panelOpen = props.panelOpen ?? true;
  const isImagePreviewTarget = useMemo(
    () => (props.target ? isWorkspaceImagePreviewPath(props.target.relativePath) : false),
    [props.target],
  );
  const imagePreviewUrl = useMemo(() => {
    if (!props.target) {
      return null;
    }
    return resolveWorkspaceImagePreviewUrl({
      environmentId: props.target.environmentId,
      cwd: props.target.cwd,
      relativePath: props.target.relativePath,
    });
  }, [props.target]);
  const gitStatus = useGitStatus({
    environmentId: props.target?.environmentId ?? null,
    cwd: props.target?.cwd ?? null,
  });
  const query = useQuery(workspaceFilePreviewQueryOptions(props.target, !isImagePreviewTarget));
  const fileContents = query.data?.contents ?? "";
  const previewContents = useMemo(() => normalizePreviewContents(fileContents), [fileContents]);
  const previewLineCount = useMemo(() => countPreviewLines(previewContents), [previewContents]);
  const targetRelativePath = props.target?.relativePath ?? null;
  const normalizedTargetPath = useMemo(
    () => (targetRelativePath ? normalizeWorkspacePath(targetRelativePath) : null),
    [targetRelativePath],
  );
  const changedWorkingTreeFile = useMemo(() => {
    if (!gitStatus.data?.isRepo || normalizedTargetPath === null) {
      return null;
    }

    return (
      gitStatus.data.workingTree.files.find(
        (file) =>
          file.status !== "deleted" && normalizeWorkspacePath(file.path) === normalizedTargetPath,
      ) ?? null
    );
  }, [gitStatus.data, normalizedTargetPath]);
  const previewDiffFilePaths = useMemo(
    () => (targetRelativePath ? [targetRelativePath] : null),
    [targetRelativePath],
  );
  const shouldQueryPreviewDiff =
    props.target !== null &&
    query.data !== undefined &&
    !isImagePreviewTarget &&
    gitStatus.data?.isRepo === true &&
    changedWorkingTreeFile !== null;
  const previewDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      environmentId: props.target?.environmentId ?? null,
      cwd: props.target?.cwd ?? null,
      target: "all",
      ignoreWhitespace: false,
      filePaths: previewDiffFilePaths,
      enabled: shouldQueryPreviewDiff,
    }),
  );
  const previewDiffDataUpdatedAt = previewDiffQuery.dataUpdatedAt;
  const previewDiffErrorUpdatedAt = previewDiffQuery.errorUpdatedAt;
  const refetchPreviewDiff = previewDiffQuery.refetch;
  const workingTreeSignature = useMemo(
    () => buildWorkingTreeSignature(gitStatus.data?.workingTree.files),
    [gitStatus.data?.workingTree.files],
  );
  const diffMarkers = useMemo(
    () =>
      buildWorkspaceFileDiffMarkers({
        diff: previewDiffQuery.data?.diff,
        lineCount: previewLineCount,
        relativePath: props.target?.relativePath ?? "",
      }),
    [previewDiffQuery.data?.diff, previewLineCount, props.target?.relativePath],
  );
  const previewUnsafeCss = useMemo(
    () => `${FILE_PREVIEW_UNSAFE_CSS}\n${buildFilePreviewMarkerUnsafeCss(diffMarkers.markers)}`,
    [diffMarkers.markers],
  );
  const expandedDiffHunk = expandedDiffHunkId
    ? (diffMarkers.hunksById.get(expandedDiffHunkId) ?? null)
    : null;
  const lineAnnotations = useMemo<LineAnnotation<WorkspaceFileInlineDiffAnnotation>[]>(
    () =>
      expandedDiffHunk
        ? [
            {
              lineNumber: expandedDiffHunk.anchorLine,
              metadata: { hunkId: expandedDiffHunk.id },
            },
          ]
        : [],
    [expandedDiffHunk],
  );
  const highlightLanguage = useMemo(
    () => (props.target ? resolveCodeHighlightLanguageFromPath(props.target.relativePath) : "text"),
    [props.target],
  );
  const highlightEnabled =
    query.data !== undefined && query.data.sizeBytes <= FILE_PREVIEW_HIGHLIGHT_MAX_BYTES;
  const renderLanguage = highlightEnabled ? highlightLanguage : "text";
  const previewFile = useMemo<FileContents | null>(
    () =>
      query.data
        ? {
            name: query.data.relativePath,
            contents: previewContents,
            lang: renderLanguage,
            cacheKey: createCodeHighlightCacheKey(
              previewContents,
              renderLanguage,
              diffThemeName,
              "file-preview",
            ),
          }
        : null,
    [diffThemeName, previewContents, query.data, renderLanguage],
  );
  const selectedLines = useMemo<{ start: number; end: number } | null>(
    () => (props.target?.line ? { start: props.target.line, end: props.target.line } : null),
    [props.target?.line],
  );
  const previewVirtualizerLayoutKey = useMemo(() => {
    if (!props.target || !query.data || !previewFile || isImagePreviewTarget) {
      return null;
    }

    return [
      props.target.environmentId,
      props.target.cwd,
      props.target.relativePath,
      query.data.relativePath,
      query.data.sizeBytes,
      previewFile.cacheKey ?? previewFile.name,
    ].join("\u0000");
  }, [isImagePreviewTarget, previewFile, props.target, query.data]);
  const virtualizerLayoutRevision = useFilePreviewVirtualizerLayoutRevision({
    enabled: panelOpen && query.data !== undefined && !isImagePreviewTarget,
    layoutKey: previewVirtualizerLayoutKey,
    rootRef: scrollRootRef,
  });
  const previewVirtualizerKey =
    previewVirtualizerLayoutKey === null
      ? undefined
      : `${previewVirtualizerLayoutKey}\u0000${virtualizerLayoutRevision}`;
  const targetLine = props.target?.line ?? null;
  const displayPath = props.target
    ? formatWorkspaceRelativePath(props.target.relativePath, props.target.cwd)
    : "No file selected";
  const title = props.target ? basenameOfPath(props.target.relativePath) : "File preview";
  const subtitle = props.target?.displayPath ?? displayPath;
  const returnButtonLabel = props.backTarget
    ? workspaceFilePanelBackButtonLabel(props.backTarget)
    : "Back";

  useEffect(() => {
    if (!targetLine || !props.target || !query.data) {
      return;
    }
    const autoScrollKey = [
      props.target.environmentId,
      props.target.cwd,
      query.data.relativePath,
      targetLine,
      query.data.sizeBytes,
      previewContents.length,
      virtualizerLayoutRevision,
    ].join(":");
    if (lastAutoScrollKeyRef.current === autoScrollKey) {
      return;
    }
    lastAutoScrollKeyRef.current = autoScrollKey;

    const scrollElement = getFilePreviewScrollElement(scrollRootRef.current);
    if (!scrollElement) {
      return;
    }

    scrollElement.scrollTop = Math.max(0, (targetLine - 1) * FILE_PREVIEW_LINE_HEIGHT);

    let secondFrameId: number | null = null;
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        const element = scrollElement.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
        element?.scrollIntoView({ block: "center" });
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
      }
    };
  }, [previewContents.length, props.target, query.data, targetLine, virtualizerLayoutRevision]);

  useEffect(() => {
    setExpandedDiffHunkId(null);
  }, [props.target?.cwd, props.target?.environmentId, props.target?.relativePath]);

  useEffect(() => {
    if (expandedDiffHunkId !== null && !diffMarkers.hunksById.has(expandedDiffHunkId)) {
      setExpandedDiffHunkId(null);
    }
  }, [diffMarkers.hunksById, expandedDiffHunkId]);

  useEffect(() => {
    const hasFetchedPreviewDiff = previewDiffDataUpdatedAt > 0 || previewDiffErrorUpdatedAt > 0;
    if (!shouldQueryPreviewDiff) {
      lastWorkingTreeSignatureRef.current = workingTreeSignature;
      return;
    }

    if (lastWorkingTreeSignatureRef.current === null) {
      lastWorkingTreeSignatureRef.current = workingTreeSignature;
      return;
    }

    if (lastWorkingTreeSignatureRef.current === workingTreeSignature) {
      return;
    }

    lastWorkingTreeSignatureRef.current = workingTreeSignature;
    if (hasFetchedPreviewDiff) {
      void refetchPreviewDiff();
    }
  }, [
    previewDiffDataUpdatedAt,
    previewDiffErrorUpdatedAt,
    refetchPreviewDiff,
    shouldQueryPreviewDiff,
    workingTreeSignature,
  ]);

  const toggleInlineDiffForLineNumber = useCallback(
    (lineNumber: number): void => {
      const marker = diffMarkers.markersByLine.get(lineNumber);
      if (!marker) {
        return;
      }

      setExpandedDiffHunkId((currentHunkId) =>
        currentHunkId === marker.hunkId ? null : marker.hunkId,
      );
    },
    [diffMarkers.markersByLine],
  );

  // Toggle the inline diff from a pointer tap on the gutter badge. We deliberately use
  // pointerdown/pointerup instead of the renderer's `onLineNumberClick` (a `click`
  // listener): on touch a synthesized `click` is unreliable, so the badge would protrude
  // on tap but never open the diff. Pointer events fire consistently for mouse and touch.
  useEffect(() => {
    const element = scrollRootRef.current;
    if (!element) {
      return;
    }

    let pending: { x: number; y: number; lineNumber: number } | null = null;

    const handlePointerDown = (event: PointerEvent) => {
      const lineNumber = resolveGutterLineNumberFromEvent(event);
      pending = lineNumber === null ? null : { x: event.clientX, y: event.clientY, lineNumber };
    };

    const handlePointerUp = (event: PointerEvent) => {
      const start = pending;
      pending = null;
      if (
        start === null ||
        Math.abs(event.clientX - start.x) > FILE_PREVIEW_GUTTER_TAP_SLOP_PX ||
        Math.abs(event.clientY - start.y) > FILE_PREVIEW_GUTTER_TAP_SLOP_PX ||
        resolveGutterLineNumberFromEvent(event) !== start.lineNumber
      ) {
        return;
      }
      toggleInlineDiffForLineNumber(start.lineNumber);
    };

    const handlePointerCancel = () => {
      pending = null;
    };

    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("pointerup", handlePointerUp);
    element.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("pointerup", handlePointerUp);
      element.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [toggleInlineDiffForLineNumber]);

  const sortedDiffHunks = useMemo(
    () => [...diffMarkers.hunksById.values()].toSorted((a, b) => a.position - b.position),
    [diffMarkers.hunksById],
  );

  const scrollToHunkAnchor = useCallback((anchorLine: number) => {
    const scrollElement = getFilePreviewScrollElement(scrollRootRef.current);
    if (!scrollElement) {
      return;
    }
    scrollElement.scrollTop = Math.max(0, (anchorLine - 1) * FILE_PREVIEW_LINE_HEIGHT);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const element = scrollElement.querySelector<HTMLElement>(`[data-line="${anchorLine}"]`);
        element?.scrollIntoView({ block: "center" });
      });
    });
  }, []);

  const handleNavigateInlineDiff = useCallback(
    (direction: "prev" | "next") => {
      if (sortedDiffHunks.length === 0) {
        return;
      }
      const currentIndex = sortedDiffHunks.findIndex((hunk) => hunk.id === expandedDiffHunkId);
      const targetIndex =
        currentIndex === -1
          ? 0
          : direction === "next"
            ? Math.min(currentIndex + 1, sortedDiffHunks.length - 1)
            : Math.max(currentIndex - 1, 0);
      const targetHunk = sortedDiffHunks[targetIndex];
      if (!targetHunk || targetHunk.id === expandedDiffHunkId) {
        return;
      }
      setExpandedDiffHunkId(targetHunk.id);
      scrollToHunkAnchor(targetHunk.anchorLine);
    },
    [expandedDiffHunkId, scrollToHunkAnchor, sortedDiffHunks],
  );

  const renderInlineDiffAnnotation = useCallback(
    (annotation: LineAnnotation<WorkspaceFileInlineDiffAnnotation>) => {
      const hunk = diffMarkers.hunksById.get(annotation.metadata.hunkId);
      if (!hunk) {
        return null;
      }

      return (
        <WorkspaceInlineDiffAnnotation
          hunk={hunk}
          onClose={() => setExpandedDiffHunkId(null)}
          onNavigate={handleNavigateInlineDiff}
          options={{ diffThemeName, resolvedTheme, wordWrap }}
        />
      );
    },
    [diffMarkers.hunksById, diffThemeName, handleNavigateInlineDiff, resolvedTheme, wordWrap],
  );

  const copyFile = useCallback(() => {
    if (!query.data) return;
    copyToClipboard(query.data.contents);
  }, [copyToClipboard, query.data]);

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {props.backTarget && props.onBack ? (
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={returnButtonLabel}
            title={returnButtonLabel}
            onClick={props.onBack}
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
        ) : null}
        {props.target ? (
          <VscodeEntryIcon
            pathValue={props.target.relativePath}
            kind="file"
            theme={resolvedTheme}
            className="size-4 shrink-0 text-muted-foreground/80"
          />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground/70">{subtitle}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {props.showExplorerButton && props.onShowExplorer ? (
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Show file explorer"
            title="Show file explorer"
            onClick={props.onShowExplorer}
          >
            <FolderTreeIcon className="size-3.5" />
          </Button>
        ) : null}
        {props.target && props.onAddFileToInput ? (
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Add ${props.target.relativePath} to chat input`}
            title={`Add ${props.target.relativePath} to chat input`}
            onClick={() => {
              if (props.target) {
                props.onAddFileToInput?.(props.target.relativePath);
              }
            }}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        ) : null}
        {!isImagePreviewTarget ? (
          <>
            <Toggle
              size="xs"
              variant="outline"
              aria-label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              pressed={wordWrap}
              onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
            >
              <TextWrapIcon className="size-3" />
            </Toggle>
            <Button
              size="icon-xs"
              variant="outline"
              disabled={!query.data}
              aria-label={isCopied ? "Copied file" : "Copy file"}
              title={isCopied ? "Copied" : "Copy file"}
              onClick={copyFile}
            >
              {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
          </>
        ) : null}
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Close file preview"
          title="Close file preview"
          onClick={closeWorkspaceFilePreview}
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={props.mode} header={header}>
      {isImagePreviewTarget && imagePreviewUrl ? (
        <WorkspaceImagePreview src={imagePreviewUrl} alt={`${subtitle} preview`} />
      ) : isImagePreviewTarget ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-destructive">
          Unable to resolve image preview URL.
        </div>
      ) : query.isLoading ? (
        <DiffPanelLoadingState label="Loading file preview..." />
      ) : query.error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load file."}
        </div>
      ) : query.data ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {query.data.truncated ? (
            <div className="border-b border-border/60 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              Preview truncated. File size: {formatBytes(query.data.sizeBytes)}.
            </div>
          ) : null}
          <div ref={scrollRootRef} className="min-h-0 flex-1 bg-background">
            {previewFile ? (
              <Virtualizer
                key={previewVirtualizerKey}
                className={`${FILE_PREVIEW_VIRTUALIZER_CLASS_NAME} h-full min-h-0 overflow-auto`}
                contentClassName="min-w-full py-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  className="workspace-file-preview-render min-w-full"
                  file={previewFile}
                  lineAnnotations={lineAnnotations}
                  renderAnnotation={renderInlineDiffAnnotation}
                  selectedLines={selectedLines}
                  style={FILE_PREVIEW_RENDER_STYLE}
                  options={{
                    disableFileHeader: true,
                    lineHoverHighlight: "number",
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: diffThemeName,
                    themeType: resolvedTheme,
                    tokenizeMaxLineLength: CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH,
                    unsafeCSS: previewUnsafeCss,
                  }}
                />
              </Virtualizer>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          No file selected.
        </div>
      )}
    </DiffPanelShell>
  );
}
