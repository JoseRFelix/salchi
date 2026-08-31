import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  DownloadIcon,
  GitBranchIcon,
  GlobeIcon,
  LibraryIcon,
  MoonIcon,
  PaletteIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import type {
  ThemeImportResult,
  ThemePreviewTheme,
  ThemeSearchItem,
  ThemeSortBy,
} from "@salchi/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@salchi/contracts/settings";

import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import {
  DEFAULT_THEME_SENTINEL,
  isColorThemeCustomized,
  useColorTheme,
} from "../hooks/useColorTheme";
import { useUpdateSettings } from "../hooks/useSettings";
import { useTheme, type Theme } from "../hooks/useTheme";
import {
  getImportedThemesSnapshot,
  importedThemeRecordsFromImportResult,
  importedThemeRecordToReference,
  saveImportedThemes,
  subscribeImportedThemes,
  type ImportedThemeRecord,
} from "../importedThemes";
import { ensureLocalApi } from "../localApi";
import {
  createDefaultThemePreview,
  createFallbackThemePreview,
  createThemePreview,
  type ThemePreviewData,
} from "../themePreview";
import { BUNDLED_THEMES, loadBundledTheme, type ThemeDescriptor } from "../themes";
import { VirtualizedList } from "../components/virtualization/VirtualizedList";
import { cn } from "~/lib/utils";
import type { ResolvedThemeType } from "~/themeMapping";

type ThemeCategory = "installed" | "online";
type ThemeFilter = "all" | ResolvedThemeType;

const ONLINE_THEME_PAGE_SIZE = 12;
const ONLINE_THEME_EXTENSION_SCAN_LIMIT = 60;
const THEME_PREVIEW_ROW_GAP_PX = 16;

// Stable keys for the placeholder cards/swatches shown while online themes load.
const THEME_PREVIEW_SKELETON_KEYS = [
  "sk-1",
  "sk-2",
  "sk-3",
  "sk-4",
  "sk-5",
  "sk-6",
  "sk-7",
  "sk-8",
  "sk-9",
] as const;
const THEME_PREVIEW_SWATCH_SKELETON_KEYS = [
  "sw-1",
  "sw-2",
  "sw-3",
  "sw-4",
  "sw-5",
  "sw-6",
] as const;

const THEME_CATEGORIES: ReadonlyArray<{
  readonly value: ThemeCategory;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "installed", label: "Installed", icon: LibraryIcon },
  { value: "online", label: "Online", icon: GlobeIcon },
];

const THEME_FILTERS: ReadonlyArray<{
  readonly value: ThemeFilter;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "all", label: "All", icon: SlidersHorizontalIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

const THEME_SORTS: ReadonlyArray<{
  readonly value: ThemeSortBy;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "downloadCount", label: "Downloads", icon: DownloadIcon },
  { value: "relevance", label: "Relevance", icon: SparklesIcon },
];

const THEME_SEGMENT_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 border-input px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background not-first:border-s sm:px-3 sm:text-sm";
const THEME_SEGMENT_BUTTON_ACTIVE_CLASS = "bg-primary text-primary-foreground";
const THEME_SEGMENT_BUTTON_INACTIVE_CLASS =
  "text-muted-foreground hover:bg-accent hover:text-foreground";

type CodeTokenKind = keyof ThemePreviewData["syntax"];

interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

interface CodeLine {
  readonly id: string;
  readonly tokens: readonly CodeToken[];
}

type PreviewThemeSource = ThemeDescriptor["source"] | "online" | "default";

interface OnlineThemeReference {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
}

type PreviewThemePayload = Pick<ThemePreviewTheme, "colors" | "tokenColors" | "type">;

interface PreviewTheme {
  readonly id: string;
  readonly label: string;
  readonly type: ResolvedThemeType;
  readonly source: PreviewThemeSource;
  readonly record?: ImportedThemeRecord;
  readonly preview?: PreviewThemePayload;
  readonly onlineReference?: OnlineThemeReference;
  readonly onlineExtension?: ThemeSearchItem;
  readonly downloadCount?: number;
}

interface SkeletonCell {
  readonly skeletonId: string;
}

type ThemeGridCell = PreviewTheme | SkeletonCell;

function isSkeletonCell(cell: ThemeGridCell): cell is SkeletonCell {
  return "skeletonId" in cell;
}

interface ThemePreviewGridRow {
  readonly id: string;
  readonly cells: readonly ThemeGridCell[];
}

const SAMPLE_CODE_LINES: readonly CodeLine[] = [
  {
    id: "const-btn",
    tokens: [
      { text: "const", kind: "keyword" },
      { text: " btn ", kind: "variable" },
      { text: "= ", kind: "operator" },
      { text: "document", kind: "variable" },
      { text: ".", kind: "punctuation" },
      { text: "getElementById", kind: "function" },
      { text: "(", kind: "punctuation" },
      { text: "'btn'", kind: "string" },
      { text: ");", kind: "punctuation" },
    ],
  },
  {
    id: "let-count",
    tokens: [
      { text: "let", kind: "keyword" },
      { text: " count ", kind: "variable" },
      { text: "= ", kind: "operator" },
      { text: "0", kind: "number" },
      { text: ";", kind: "punctuation" },
    ],
  },
  { id: "blank-after-count", tokens: [] },
  {
    id: "function-render",
    tokens: [
      { text: "function", kind: "keyword" },
      { text: " render", kind: "function" },
      { text: "() ", kind: "punctuation" },
      { text: "{", kind: "punctuation" },
    ],
  },
  {
    id: "inner-text",
    tokens: [
      { text: "  btn", kind: "variable" },
      { text: ".", kind: "punctuation" },
      { text: "innerText", kind: "property" },
      { text: " = ", kind: "operator" },
      { text: "`Count: ${count}`", kind: "string" },
      { text: ";", kind: "punctuation" },
    ],
  },
  { id: "close-render", tokens: [{ text: "}", kind: "punctuation" }] },
  { id: "blank-after-render", tokens: [] },
  {
    id: "click-listener",
    tokens: [
      { text: "btn", kind: "variable" },
      { text: ".", kind: "punctuation" },
      { text: "addEventListener", kind: "function" },
      { text: "(", kind: "punctuation" },
      { text: "'click'", kind: "string" },
      { text: ", () ", kind: "punctuation" },
      { text: "=>", kind: "operator" },
      { text: " {", kind: "punctuation" },
    ],
  },
  {
    id: "comment",
    tokens: [{ text: "  // Count from 1 to 10.", kind: "comment" }],
  },
  {
    id: "if-count",
    tokens: [
      { text: "  if", kind: "keyword" },
      { text: " (count ", kind: "punctuation" },
      { text: "< ", kind: "operator" },
      { text: "10", kind: "number" },
      { text: ") {", kind: "punctuation" },
    ],
  },
  {
    id: "increment",
    tokens: [
      { text: "    count ", kind: "variable" },
      { text: "+=", kind: "operator" },
      { text: " 1", kind: "number" },
      { text: ";", kind: "punctuation" },
    ],
  },
  {
    id: "call-render",
    tokens: [
      { text: "    render", kind: "function" },
      { text: "();", kind: "punctuation" },
    ],
  },
  { id: "close-if", tokens: [{ text: "  }", kind: "punctuation" }] },
  { id: "close-listener", tokens: [{ text: "});", kind: "punctuation" }] },
];

function useImportedThemes(): ReadonlyArray<ImportedThemeRecord> {
  return useSyncExternalStore(subscribeImportedThemes, getImportedThemesSnapshot, () => []);
}

function defaultThemePreview(type: ResolvedThemeType): PreviewTheme {
  return {
    id: DEFAULT_THEME_SENTINEL,
    label: type === "light" ? "Default Light" : "Default Dark",
    type,
    source: "default",
  };
}

function bundledThemePreview(theme: ThemeDescriptor): PreviewTheme {
  return {
    id: theme.id,
    label: theme.label,
    type: theme.type,
    source: theme.source,
  };
}

function importedThemePreview(record: ImportedThemeRecord): PreviewTheme {
  return {
    id: record.id,
    label: record.label,
    type: record.type,
    source: "imported",
    record,
  };
}

function onlineThemePreview(
  theme: ThemePreviewTheme,
  extension: ThemeSearchItem,
  reference: OnlineThemeReference,
): PreviewTheme {
  return {
    id: theme.id,
    label: theme.label,
    type: theme.type,
    source: "online",
    preview: {
      colors: theme.colors,
      type: theme.type,
      ...(theme.tokenColors === undefined ? {} : { tokenColors: theme.tokenColors }),
    },
    onlineReference: reference,
    onlineExtension: extension,
    ...(extension.downloadCount === undefined ? {} : { downloadCount: extension.downloadCount }),
  };
}

function themeSearchText(theme: PreviewTheme): string {
  return [
    theme.label,
    theme.id,
    theme.type,
    theme.source,
    theme.record?.namespace,
    theme.record?.name,
    theme.onlineReference?.namespace,
    theme.onlineReference?.name,
    theme.onlineExtension?.displayName,
    theme.onlineExtension?.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatDownloadCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`;
  }
  return String(count);
}

// A theme is the active one only when the user has committed to an explicit
// light/dark mode (not "system") and its id/type matches the current selection.
// Shared by the card's "Selected" badge and the installed-list ordering so the
// pinned-first theme is always the one rendered as selected.
function isSelectedTheme(
  theme: PreviewTheme,
  appearanceTheme: Theme,
  resolvedMode: ResolvedThemeType,
  activeThemeId: string,
): boolean {
  return appearanceTheme !== "system" && theme.type === resolvedMode && theme.id === activeThemeId;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return error instanceof Error ? error.message : fallback;
}

function syncImportedThemeRecords(
  records: ReadonlyArray<ImportedThemeRecord>,
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"],
  settingsPatch: Partial<UnifiedSettings> = {},
) {
  if (records.length === 0) return;
  saveImportedThemes(records);
  updateSettings({
    importedThemes: getImportedThemesSnapshot().map(importedThemeRecordToReference),
    ...settingsPatch,
  });
}

async function importOnlineThemeRecord(theme: PreviewTheme): Promise<ImportedThemeRecord> {
  if (!theme.onlineReference) {
    throw new Error("Theme has no Open VSX import reference.");
  }

  const result: ThemeImportResult = await ensureLocalApi().themes.import(theme.onlineReference);
  const records = importedThemeRecordsFromImportResult(result);
  const record = records.find((candidate) => candidate.id === theme.id);
  if (!record) {
    throw new Error(`${theme.label} was not found in the imported extension.`);
  }
  return record;
}

function themePreviewKey(theme: PreviewTheme): string {
  return `${theme.source}:${theme.type}:${theme.id}`;
}

// Cache resolved preview data so cards re-mounted by the virtualized list paint
// their final colors immediately instead of flashing the fallback while a
// bundled theme re-loads — that flash (and the height changes it caused) was the
// main source of scroll jank.
const previewDataCache = new Map<string, ThemePreviewData>();

function buildSyncPreview(theme: PreviewTheme): ThemePreviewData | null {
  if (theme.source === "default") return null;
  const source = theme.record ?? theme.preview;
  if (!source) return null;
  return createThemePreview({
    colors: source.colors,
    type: source.type,
    ...(source.tokenColors === undefined ? {} : { tokenColors: source.tokenColors }),
  });
}

function initialPreviewState(theme: PreviewTheme): {
  readonly preview: ThemePreviewData;
  readonly loading: boolean;
} {
  if (theme.source === "default") {
    return { preview: createDefaultThemePreview(theme.type), loading: false };
  }
  const cached = previewDataCache.get(themePreviewKey(theme));
  if (cached) return { preview: cached, loading: false };
  if (theme.source === "imported" || theme.source === "online") {
    const sync = buildSyncPreview(theme);
    if (sync) {
      previewDataCache.set(themePreviewKey(theme), sync);
      return { preview: sync, loading: false };
    }
  }
  return { preview: createFallbackThemePreview(theme.type), loading: theme.source === "bundled" };
}

function createThemePreviewRows(
  cells: ReadonlyArray<ThemeGridCell>,
  columnCount: number,
): ThemePreviewGridRow[] {
  const rows: ThemePreviewGridRow[] = [];
  const safeColumnCount = Math.max(1, Math.trunc(columnCount));
  for (let index = 0; index < cells.length; index += safeColumnCount) {
    const rowCells = cells.slice(index, index + safeColumnCount);
    rows.push({
      id: rowCells
        .map((cell) => (isSkeletonCell(cell) ? cell.skeletonId : themePreviewKey(cell)))
        .join("|"),
      cells: rowCells,
    });
  }
  return rows;
}

function getThemePreviewColumnCount(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 1;
  if (window.matchMedia("(min-width: 1280px)").matches) return 3;
  if (window.matchMedia("(min-width: 768px)").matches) return 2;
  return 1;
}

function useThemePreviewColumnCount(): number {
  const [columnCount, setColumnCount] = useState(getThemePreviewColumnCount);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const queries = [
      window.matchMedia("(min-width: 1280px)"),
      window.matchMedia("(min-width: 768px)"),
    ];
    const update = () => setColumnCount(getThemePreviewColumnCount());
    update();

    for (const query of queries) {
      query.addEventListener("change", update);
    }
    return () => {
      for (const query of queries) {
        query.removeEventListener("change", update);
      }
    };
  }, []);

  return columnCount;
}

function estimatedThemePreviewRowSize(columnCount: number): number {
  if (columnCount >= 3) return 360 + THEME_PREVIEW_ROW_GAP_PX;
  if (columnCount === 2) return 400 + THEME_PREVIEW_ROW_GAP_PX;
  return 380 + THEME_PREVIEW_ROW_GAP_PX;
}

function ThemePreviewRouteView() {
  const navigate = useNavigate();
  const importedThemes = useImportedThemes();
  const themePreviewColumnCount = useThemePreviewColumnCount();
  const { theme: appearanceTheme, setTheme } = useTheme();
  const { resolvedMode, activeThemeId, reset: resetColorTheme, selection } = useColorTheme();
  const { updateSettings } = useUpdateSettings();
  // Capture the active theme once on mount so it can be pinned to the top of the
  // installed list. We deliberately don't follow later selections — re-sorting
  // the grid out from under the user as they click themes is jarring.
  const [pinnedThemeKey] = useState(() =>
    appearanceTheme === "system" ? null : `${resolvedMode}:${activeThemeId}`,
  );
  const installedThemes = useMemo(
    () => [
      defaultThemePreview("light"),
      defaultThemePreview("dark"),
      ...importedThemes.map(importedThemePreview),
      ...BUNDLED_THEMES.map(bundledThemePreview),
    ],
    [importedThemes],
  );
  const activeThemeLabel =
    installedThemes.find((theme) => theme.type === resolvedMode && theme.id === activeThemeId)
      ?.label ?? activeThemeId;
  const followsSystemDefaults = appearanceTheme === "system" && !isColorThemeCustomized(selection);
  const handleFollowSystem = useCallback(() => {
    setTheme("system");
    resetColorTheme();
    updateSettings({
      themeMode: DEFAULT_UNIFIED_SETTINGS.themeMode,
      colorThemeLight: DEFAULT_UNIFIED_SETTINGS.colorThemeLight,
      colorThemeDark: DEFAULT_UNIFIED_SETTINGS.colorThemeDark,
    });
  }, [resetColorTheme, setTheme, updateSettings]);
  const [category, setCategory] = useState<ThemeCategory>("installed");
  const [installedQuery, setInstalledQuery] = useState("");
  const [onlineQuery, setOnlineQuery] = useState("");
  const [committedOnlineQuery, setCommittedOnlineQuery] = useState("");
  const [onlineSort, setOnlineSort] = useState<ThemeSortBy>("downloadCount");
  const [onlineThemes, setOnlineThemes] = useState<ReadonlyArray<PreviewTheme>>([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineLoaded, setOnlineLoaded] = useState(false);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [onlineNextOffset, setOnlineNextOffset] = useState(0);
  const [onlineTotalSize, setOnlineTotalSize] = useState(0);
  const [filter, setFilter] = useState<ThemeFilter>("all");
  const onlineLoadingRef = useRef(false);
  const seenOnlineKeysRef = useRef<Set<string>>(new Set());
  // Bumped whenever the online query resets the result list so an in-flight load
  // started against an older query can detect it is stale and discard its results.
  const onlineRequestRef = useRef(0);
  const normalizedInstalledQuery = installedQuery.trim().toLowerCase();

  // Append freshly-resolved online previews, skipping any already shown. Returns
  // how many were newly added so the loader can decide whether to keep scanning.
  const appendOnlineThemes = useCallback((previews: ReadonlyArray<PreviewTheme>): number => {
    const fresh = previews.filter(
      (preview) => !seenOnlineKeysRef.current.has(themePreviewKey(preview)),
    );
    if (fresh.length === 0) return 0;
    for (const preview of fresh) seenOnlineKeysRef.current.add(themePreviewKey(preview));
    setOnlineThemes((current) => [...current, ...fresh]);
    return fresh.length;
  }, []);

  const visibleInstalledThemes = useMemo(() => {
    const filtered = installedThemes.filter((theme) => {
      if (filter !== "all" && theme.type !== filter) return false;
      if (!normalizedInstalledQuery) return true;
      return themeSearchText(theme).includes(normalizedInstalledQuery);
    });
    // Pin the theme that was active on mount to the top so it's easy to spot
    // among many cards; later selections don't reorder the grid.
    const selectedIndex = pinnedThemeKey
      ? filtered.findIndex((theme) => `${theme.type}:${theme.id}` === pinnedThemeKey)
      : -1;
    const selected = selectedIndex > 0 ? filtered[selectedIndex] : undefined;
    if (!selected) return filtered;
    return [selected, ...filtered.slice(0, selectedIndex), ...filtered.slice(selectedIndex + 1)];
  }, [filter, installedThemes, normalizedInstalledQuery, pinnedThemeKey]);

  const visibleOnlineThemes = useMemo(
    () => onlineThemes.filter((theme) => filter === "all" || theme.type === filter),
    [filter, onlineThemes],
  );
  const visibleThemes = category === "online" ? visibleOnlineThemes : visibleInstalledThemes;
  const canLoadMoreOnline = !onlineError && (!onlineLoaded || onlineNextOffset < onlineTotalSize);
  const minimumVisibleOnlineThemeCount = Math.max(3, themePreviewColumnCount * 3);

  const loadMoreOnlineThemes = useCallback(async () => {
    if (onlineLoadingRef.current) return;
    if (onlineLoaded && onlineNextOffset >= onlineTotalSize) return;

    const requestId = onlineRequestRef.current;
    const startOffset = onlineNextOffset;
    onlineLoadingRef.current = true;
    setOnlineLoading(true);
    setOnlineError(null);
    let cursor = startOffset;
    let totalSize = onlineTotalSize;
    try {
      const api = ensureLocalApi();
      let addedCount = 0;
      let scannedExtensions = 0;

      while (
        addedCount < ONLINE_THEME_PAGE_SIZE &&
        scannedExtensions < ONLINE_THEME_EXTENSION_SCAN_LIMIT
      ) {
        const result = await api.themes.search({
          offset: cursor,
          size: ONLINE_THEME_PAGE_SIZE,
          sortBy: onlineSort,
          ...(committedOnlineQuery ? { query: committedOnlineQuery } : {}),
        });
        // The query changed (or reset) while this batch was in flight; drop the
        // stale results so they don't pollute the new query's grid.
        if (onlineRequestRef.current !== requestId) return;
        totalSize = result.totalSize;
        if (result.items.length === 0) {
          cursor = Math.min(result.offset + result.size, result.totalSize);
          break;
        }

        // Stream each extension's previews into the grid as they resolve rather
        // than blocking on the slowest VSIX download in the batch — the first
        // cards appear as soon as the first theme is parsed.
        const settled = await Promise.allSettled(
          result.items.map(async (item) => {
            const preview = await api.themes.preview({
              namespace: item.namespace,
              name: item.name,
              version: item.version,
            });
            const mapped = preview.themes.map((theme) =>
              onlineThemePreview(theme, item, {
                namespace: preview.namespace,
                name: preview.name,
                version: preview.version,
              }),
            );
            // Skip appends from a superseded query.
            if (onlineRequestRef.current !== requestId) return 0;
            return appendOnlineThemes(mapped);
          }),
        );
        if (onlineRequestRef.current !== requestId) return;

        for (const outcome of settled) {
          if (outcome.status === "fulfilled") addedCount += outcome.value;
        }
        scannedExtensions += result.items.length;
        cursor = Math.min(result.offset + result.size, result.totalSize);
        if (cursor >= result.totalSize) break;
      }

      setOnlineNextOffset(cursor);
      setOnlineTotalSize(totalSize);
      setOnlineLoaded(true);
    } catch (error) {
      if (onlineRequestRef.current !== requestId) return;
      const description = errorMessage(error, "Could not reach the Open VSX registry.");
      setOnlineError(description);
      toastManager.add({
        type: "error",
        title: "Theme page failed",
        description,
      });
    } finally {
      onlineLoadingRef.current = false;
      setOnlineLoading(false);
    }
  }, [
    appendOnlineThemes,
    committedOnlineQuery,
    onlineLoaded,
    onlineNextOffset,
    onlineSort,
    onlineTotalSize,
  ]);

  const handleThemeListEndReached = useCallback(() => {
    if (category !== "online" || onlineLoading || !canLoadMoreOnline) return;
    void loadMoreOnlineThemes();
  }, [canLoadMoreOnline, category, loadMoreOnlineThemes, onlineLoading]);

  // Debounce the marketplace query so we don't fire a search request per keystroke.
  useEffect(() => {
    const trimmed = onlineQuery.trim();
    if (trimmed === committedOnlineQuery) return;
    const handle = setTimeout(() => setCommittedOnlineQuery(trimmed), 300);
    return () => clearTimeout(handle);
  }, [committedOnlineQuery, onlineQuery]);

  // Start the online list over whenever the committed query or sort changes.
  // Bumping the request id invalidates any load still in flight against the
  // previous query/sort.
  useEffect(() => {
    onlineRequestRef.current += 1;
    seenOnlineKeysRef.current = new Set();
    setOnlineThemes([]);
    setOnlineNextOffset(0);
    setOnlineTotalSize(0);
    setOnlineLoaded(false);
    setOnlineError(null);
  }, [committedOnlineQuery, onlineSort]);

  useEffect(() => {
    if (category !== "online" || onlineLoaded || onlineLoading || onlineError) return;
    void loadMoreOnlineThemes();
  }, [category, loadMoreOnlineThemes, onlineError, onlineLoaded, onlineLoading]);

  useEffect(() => {
    if (
      category !== "online" ||
      !onlineLoaded ||
      onlineLoading ||
      onlineError ||
      !canLoadMoreOnline
    ) {
      return;
    }
    if (visibleOnlineThemes.length >= minimumVisibleOnlineThemeCount) return;
    void loadMoreOnlineThemes();
  }, [
    canLoadMoreOnline,
    category,
    loadMoreOnlineThemes,
    minimumVisibleOnlineThemeCount,
    onlineError,
    onlineLoaded,
    onlineLoading,
    visibleOnlineThemes.length,
  ]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5">
          <div className="flex min-h-8 items-center gap-2">
            <Button
              aria-label="Back"
              className="shrink-0 md:hidden"
              onClick={() => void navigate({ to: "/settings/general" })}
              size="icon-sm"
              variant="subtle-outline"
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <PaletteIcon className="size-4 text-muted-foreground" />
            <h1 className="min-w-0 truncate font-medium text-[15px] text-foreground md:text-sm">
              Themes
            </h1>
            <div className="ms-auto flex min-w-0 items-center gap-2">
              <span className="max-w-52 truncate text-xs text-muted-foreground max-sm:hidden">
                {followsSystemDefaults ? "Following system" : `Current: ${activeThemeLabel}`}
              </span>
              {!followsSystemDefaults ? (
                <Button onClick={handleFollowSystem} size="xs" variant="outline">
                  Follow system
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col py-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <div className="mx-auto w-full max-w-7xl shrink-0 px-3 sm:px-5 lg:px-8">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <div
                  aria-label="Theme category"
                  className="inline-flex w-fit overflow-hidden rounded-lg border border-input bg-background shadow-xs/5"
                  role="group"
                >
                  {THEME_CATEGORIES.map((item) => {
                    const Icon = item.icon;
                    const pressed = category === item.value;
                    return (
                      <button
                        aria-pressed={pressed}
                        className={cn(
                          THEME_SEGMENT_BUTTON_CLASS,
                          pressed
                            ? THEME_SEGMENT_BUTTON_ACTIVE_CLASS
                            : THEME_SEGMENT_BUTTON_INACTIVE_CLASS,
                        )}
                        key={item.value}
                        onClick={() => setCategory(item.value)}
                        type="button"
                      >
                        <Icon className="size-3.5" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>

                <div
                  aria-label="Theme type"
                  className="inline-flex w-fit overflow-hidden rounded-lg border border-input bg-background shadow-xs/5"
                  role="group"
                >
                  {THEME_FILTERS.map((item) => {
                    const Icon = item.icon;
                    const pressed = filter === item.value;
                    return (
                      <button
                        aria-pressed={pressed}
                        className={cn(
                          THEME_SEGMENT_BUTTON_CLASS,
                          pressed
                            ? THEME_SEGMENT_BUTTON_ACTIVE_CLASS
                            : THEME_SEGMENT_BUTTON_INACTIVE_CLASS,
                        )}
                        key={item.value}
                        onClick={() => setFilter(item.value)}
                        type="button"
                      >
                        <Icon className="size-3.5" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>

                {category === "online" ? (
                  <div
                    aria-label="Sort online themes"
                    className="inline-flex w-fit overflow-hidden rounded-lg border border-input bg-background shadow-xs/5"
                    role="group"
                  >
                    {THEME_SORTS.map((item) => {
                      const Icon = item.icon;
                      const pressed = onlineSort === item.value;
                      return (
                        <button
                          aria-pressed={pressed}
                          className={cn(
                            THEME_SEGMENT_BUTTON_CLASS,
                            pressed
                              ? THEME_SEGMENT_BUTTON_ACTIVE_CLASS
                              : THEME_SEGMENT_BUTTON_INACTIVE_CLASS,
                          )}
                          key={item.value}
                          onClick={() => setOnlineSort(item.value)}
                          type="button"
                        >
                          <Icon className="size-3.5" />
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <InputGroup className="w-full min-w-0 sm:max-w-md">
                <InputGroupAddon>
                  {category === "online" && onlineLoading ? (
                    <Spinner />
                  ) : (
                    <SearchIcon className="size-4" />
                  )}
                </InputGroupAddon>
                {category === "online" ? (
                  <InputGroupInput
                    aria-label="Search Open VSX themes"
                    nativeInput
                    onChange={(event) => setOnlineQuery(event.currentTarget.value)}
                    placeholder="Search the Open VSX marketplace..."
                    type="search"
                    value={onlineQuery}
                  />
                ) : (
                  <InputGroupInput
                    aria-label="Search themes"
                    nativeInput
                    onChange={(event) => setInstalledQuery(event.currentTarget.value)}
                    placeholder="Search themes..."
                    type="search"
                    value={installedQuery}
                  />
                )}
              </InputGroup>
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1">
            {category === "online" && onlineLoading && onlineThemes.length === 0 ? (
              <div className="h-full overflow-y-auto">
                <div className="mx-auto w-full max-w-7xl px-3 sm:px-5 lg:px-8">
                  <ThemePreviewSkeletonGrid count={themePreviewColumnCount * 3} />
                </div>
              </div>
            ) : visibleThemes.length > 0 ? (
              <div className="h-full">
                <ThemePreviewVirtualGrid
                  canLoadMore={category === "online" && canLoadMoreOnline}
                  columnCount={themePreviewColumnCount}
                  error={category === "online" ? onlineError : null}
                  loadingMore={category === "online" && onlineLoading && onlineThemes.length > 0}
                  onEndReached={handleThemeListEndReached}
                  onRetry={() => void loadMoreOnlineThemes()}
                  themes={visibleThemes}
                />
              </div>
            ) : (
              <div className="mx-auto w-full max-w-7xl px-3 sm:px-5 lg:px-8">
                <div className="flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/20 px-6 text-center text-muted-foreground text-sm">
                  {category === "online"
                    ? canLoadMoreOnline
                      ? "Looking for previewable themes."
                      : (onlineError ??
                        (committedOnlineQuery
                          ? `No themes found for "${committedOnlineQuery}".`
                          : "No previewable themes were found."))
                    : "No themes match your filters."}
                  {category === "online" && onlineError ? (
                    <Button
                      className="mt-3"
                      onClick={() => void loadMoreOnlineThemes()}
                      size="xs"
                      variant="outline"
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

function ThemePreviewSkeletonCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm/5">
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
      <div className="flex flex-col gap-2.5 p-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
        <Skeleton className="h-3 w-40" />
        <div className="flex items-center gap-1">
          {THEME_PREVIEW_SWATCH_SKELETON_KEYS.map((key) => (
            <Skeleton className="size-4 rounded-full" key={key} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThemePreviewSkeletonGrid({ count }: { readonly count: number }) {
  const keys = THEME_PREVIEW_SKELETON_KEYS.slice(
    0,
    Math.min(THEME_PREVIEW_SKELETON_KEYS.length, Math.max(1, count)),
  );
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {keys.map((key) => (
        <ThemePreviewSkeletonCard key={key} />
      ))}
    </div>
  );
}

function ThemePreviewVirtualGrid({
  canLoadMore,
  columnCount,
  error,
  loadingMore,
  onEndReached,
  onRetry,
  themes,
}: {
  readonly canLoadMore: boolean;
  readonly columnCount: number;
  readonly error: string | null;
  readonly loadingMore: boolean;
  readonly onEndReached: () => void;
  readonly onRetry: () => void;
  readonly themes: ReadonlyArray<PreviewTheme>;
}) {
  const safeColumnCount = Math.max(1, Math.trunc(columnCount));
  const estimatedRowSize = estimatedThemePreviewRowSize(columnCount);

  // While paging, append skeleton cells so they first complete the partial last
  // row and then fill a couple more rows — filling the empty space instead of
  // floating a lonely skeleton row below a gap.
  const remainderToFillLastRow =
    themes.length % safeColumnCount === 0 ? 0 : safeColumnCount - (themes.length % safeColumnCount);
  const skeletonCount = loadingMore
    ? Math.min(THEME_PREVIEW_SKELETON_KEYS.length, remainderToFillLastRow + safeColumnCount * 2)
    : 0;

  const cells = useMemo<ThemeGridCell[]>(() => {
    if (skeletonCount === 0) return [...themes];
    const skeletons = THEME_PREVIEW_SKELETON_KEYS.slice(0, skeletonCount).map((skeletonId) => ({
      skeletonId,
    }));
    return [...themes, ...skeletons];
  }, [skeletonCount, themes]);

  const rows = useMemo(
    () => createThemePreviewRows(cells, safeColumnCount),
    [cells, safeColumnCount],
  );

  const renderRow = useCallback(
    ({ item }: { readonly item: ThemePreviewGridRow; readonly index: number }) => (
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-4 px-3 pt-1 pb-3 sm:px-5 md:grid-cols-2 lg:px-8 xl:grid-cols-3">
        {item.cells.map((cell) =>
          isSkeletonCell(cell) ? (
            <ThemePreviewSkeletonCard key={cell.skeletonId} />
          ) : (
            <ThemePreviewCard key={themePreviewKey(cell)} theme={cell} />
          ),
        )}
      </div>
    ),
    [],
  );

  const footer = (
    <div className="mx-auto flex min-h-12 w-full max-w-7xl items-center justify-center px-3 pb-1 text-muted-foreground text-xs sm:px-5 lg:px-8">
      {error ? (
        <div className="flex items-center gap-2">
          <span>{error}</span>
          <Button onClick={onRetry} size="xs" variant="outline">
            Retry
          </Button>
        </div>
      ) : loadingMore ? null : canLoadMore ? (
        <span>Scroll for more themes</span>
      ) : (
        <span>End of results</span>
      )}
    </div>
  );

  return (
    <VirtualizedList<ThemePreviewGridRow>
      data={rows}
      keyExtractor={(row) => row.id}
      renderItem={renderRow}
      estimatedItemSize={estimatedRowSize}
      increaseViewportBy={estimatedRowSize * 2}
      minOverscanItemCount={2}
      {...(canLoadMore ? { onEndReached } : {})}
      className="scrollbar-gutter-both h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
      style={{ height: "100%" }}
      ListFooterComponent={footer}
      data-testid="theme-preview-virtual-grid"
    />
  );
}

function ThemePreviewCard({ theme }: { readonly theme: PreviewTheme }) {
  const { theme: appearanceTheme, setTheme } = useTheme();
  const { resolvedMode, activeThemeId, setThemeForMode } = useColorTheme();
  const initial = useMemo(() => initialPreviewState(theme), [theme]);
  const [preview, setPreview] = useState(initial.preview);
  const [loading, setLoading] = useState(initial.loading);
  const [saving, setSaving] = useState(false);
  const { updateSettings } = useUpdateSettings();
  const selected = isSelectedTheme(theme, appearanceTheme, resolvedMode, activeThemeId);

  useEffect(() => {
    if (theme.source === "default") {
      setPreview(createDefaultThemePreview(theme.type));
      setLoading(false);
      return;
    }

    const key = themePreviewKey(theme);
    const cached = previewDataCache.get(key);
    if (cached) {
      setPreview(cached);
      setLoading(false);
      return;
    }

    if (theme.source === "imported" || theme.source === "online") {
      const sync = buildSyncPreview(theme);
      if (!sync) {
        return;
      }
      previewDataCache.set(key, sync);
      setPreview(sync);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setPreview(createFallbackThemePreview(theme.type));
    setLoading(true);
    void (async () => {
      try {
        const bundled = await loadBundledTheme(theme.id);
        if (!bundled || cancelled) return;
        const built = createThemePreview(bundled);
        previewDataCache.set(key, built);
        setPreview(built);
      } catch {
        // Preview falls back to the placeholder colors on failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [theme]);

  const handleUseTheme = useCallback(async () => {
    if (theme.source === "online") {
      setSaving(true);
      try {
        const record = await importOnlineThemeRecord(theme);
        setTheme(theme.type);
        syncImportedThemeRecords(
          [record],
          updateSettings,
          theme.type === "light"
            ? { colorThemeLight: theme.id, themeMode: theme.type }
            : { colorThemeDark: theme.id, themeMode: theme.type },
        );
        setThemeForMode(theme.type, theme.id);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Import failed",
          description: errorMessage(error, "Could not import this theme."),
        });
      } finally {
        setSaving(false);
      }
      return;
    }

    setTheme(theme.type);
    setThemeForMode(theme.type, theme.id);
    updateSettings(
      theme.type === "light"
        ? { colorThemeLight: theme.id, themeMode: theme.type }
        : { colorThemeDark: theme.id, themeMode: theme.type },
    );
  }, [setTheme, setThemeForMode, theme, updateSettings]);

  const handleCardActivate = useCallback(() => {
    if (selected || saving) return;
    void handleUseTheme();
  }, [handleUseTheme, saving, selected]);

  return (
    <article
      aria-pressed={selected}
      className={cn(
        "cursor-pointer overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-foreground/24",
        saving ? "pointer-events-none opacity-80" : null,
      )}
      onClick={handleCardActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleCardActivate();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <ThemePreviewMockup preview={preview} />

      <div className={cn("h-0.5 shrink-0", loading ? "bg-primary/40" : "bg-transparent")} />

      <div className="flex flex-col gap-2.5 p-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate font-medium text-sm text-foreground">{theme.label}</h2>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 font-medium text-[11px]",
                theme.type === "light"
                  ? "border-warning/24 bg-warning/8 text-warning-foreground"
                  : "border-info/24 bg-info/8 text-info-foreground",
              )}
            >
              {theme.type}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {preview.swatches.slice(0, 6).map((color) => (
              <span
                aria-hidden="true"
                className="size-4 rounded-full border border-border shadow-xs/10"
                key={`${themePreviewKey(theme)}:${color}`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>

          <div className="flex items-center gap-2.5">
            {theme.downloadCount !== undefined ? (
              <span
                className="inline-flex items-center gap-1 text-muted-foreground text-xs tabular-nums"
                title={`${theme.downloadCount.toLocaleString()} downloads`}
              >
                <DownloadIcon className="size-3.5" />
                {formatDownloadCount(theme.downloadCount)}
              </span>
            ) : null}
            {selected || saving ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
                {selected ? (
                  <>
                    <CheckIcon className="size-3.5 text-primary" />
                    Selected
                  </>
                ) : (
                  <>
                    <Spinner className="size-3.5" />
                    Applying…
                  </>
                )}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

// Thread rows for the preview rail (real-looking titles, one active) so the
// mockup reads like the app's project/thread list rather than a VS Code rail.
const PREVIEW_THREAD_ROWS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly active?: boolean;
}> = [
  { id: "t1", title: "Fix diff theme", active: true },
  { id: "t2", title: "Theme previews" },
  { id: "salchi", title: "Usage polling" },
  { id: "t4", title: "Rename UI" },
];

// Sample lines flagged as added/removed so the code panel reads like the app's
// working-tree diff (left marker bar + tinted row), the surface themes most
// affect in practice.
const PREVIEW_ADDED_LINE_IDS = new Set(["increment", "call-render"]);
const PREVIEW_REMOVED_LINE_IDS = new Set(["let-count"]);

function previewTint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

// The app's brand mark — same cropped mascot the sidebar renders, scaled down.
function PreviewSalchiLogo() {
  return (
    <span aria-hidden="true" className="relative size-4 shrink-0 overflow-hidden">
      <img
        alt=""
        className="absolute max-w-none"
        src="/salchi-logo.png"
        style={{ width: 25, height: 25, top: -3.4, left: -4.5 }}
      />
    </span>
  );
}

function ThemePreviewMockup({ preview }: { readonly preview: ThemePreviewData }) {
  const palette = preview.palette;
  const lineStatus = (id: string): "added" | "removed" | null =>
    PREVIEW_ADDED_LINE_IDS.has(id) ? "added" : PREVIEW_REMOVED_LINE_IDS.has(id) ? "removed" : null;

  return (
    <div
      className="flex aspect-[16/9] overflow-hidden border-b font-mono text-[10px] leading-[1.6]"
      style={{
        backgroundColor: palette.background,
        borderColor: palette.border,
        color: palette.foreground,
      }}
    >
      {/* Sidebar: brand, search, thread list, status — mirrors the app rail. */}
      <div
        className="flex w-[36%] shrink-0 flex-col gap-1.5 border-r p-2"
        style={{ backgroundColor: palette.panel, borderColor: palette.border }}
      >
        <div className="flex items-center gap-1.5">
          <PreviewSalchiLogo />
          <span className="truncate font-medium" style={{ color: palette.foreground }}>
            Salchi
          </span>
        </div>

        <div className="flex items-center gap-1.5 px-1">
          <SearchIcon className="size-2.5 shrink-0" style={{ color: palette.muted }} />
          <span className="min-w-0 flex-1 truncate" style={{ color: palette.muted }}>
            Search
          </span>
          <span
            className="shrink-0 rounded-[3px] border px-1 text-[8px] leading-tight"
            style={{
              backgroundColor: previewTint(palette.foreground, 6),
              borderColor: palette.border,
              color: palette.muted,
            }}
          >
            ⌘K
          </span>
        </div>

        <div className="mt-0.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
          <span
            className="px-1 pb-0.5 text-[8px] uppercase tracking-wide"
            style={{ color: palette.muted }}
          >
            Projects
          </span>
          {PREVIEW_THREAD_ROWS.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-1.5 rounded-[5px] px-1 py-[3px]"
              style={
                row.active ? { backgroundColor: previewTint(palette.foreground, 10) } : undefined
              }
            >
              <GitBranchIcon className="size-2.5 shrink-0" style={{ color: palette.added }} />
              <span
                className="min-w-0 flex-1 truncate"
                style={{
                  color: row.active ? palette.foreground : previewTint(palette.foreground, 78),
                }}
              >
                {row.title}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5 px-1">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: palette.added }}
          />
          <span className="truncate" style={{ color: palette.muted }}>
            Connected
          </span>
        </div>
      </div>

      {/* Main: diff/file header + line-numbered, syntax-highlighted code. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex items-center justify-between gap-2 border-b px-2 py-1.5"
          style={{
            backgroundColor: palette.chrome,
            borderColor: palette.border,
            color: palette.chromeForeground,
          }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: palette.accent }}
            />
            <span className="truncate">main.ts</span>
          </div>
          <span
            className="shrink-0 rounded-full px-1.5 py-px font-medium text-[8px]"
            style={{ backgroundColor: previewTint(palette.added, 18), color: palette.added }}
          >
            +7
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden py-1">
          {SAMPLE_CODE_LINES.map((line, index) => {
            const status = lineStatus(line.id);
            return (
              <div
                key={line.id}
                className="flex items-stretch"
                style={
                  status
                    ? {
                        backgroundColor: previewTint(
                          status === "added" ? palette.added : palette.removed,
                          13,
                        ),
                      }
                    : undefined
                }
              >
                <span
                  className="w-[2px] shrink-0"
                  style={{
                    backgroundColor:
                      status === "added"
                        ? palette.added
                        : status === "removed"
                          ? palette.removed
                          : "transparent",
                  }}
                />
                <span
                  className="w-5 shrink-0 pr-1.5 text-right tabular-nums"
                  style={{ color: previewTint(palette.muted, 70) }}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 overflow-hidden whitespace-pre pr-2">
                  {line.tokens.length === 0
                    ? " "
                    : line.tokens.map((token) => (
                        <span
                          key={`${line.id}:${token.kind}:${token.text}`}
                          style={{ color: preview.syntax[token.kind] }}
                        >
                          {token.text}
                        </span>
                      ))}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/themes")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ThemePreviewRouteView,
});
