import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  BlocksIcon,
  CheckIcon,
  DownloadIcon,
  FilesIcon,
  GitBranchIcon,
  GlobeIcon,
  LibraryIcon,
  MoonIcon,
  PaletteIcon,
  PlayIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import type { ThemeImportResult, ThemePreviewTheme, ThemeSearchItem } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { useColorTheme } from "../hooks/useColorTheme";
import { useUpdateSettings } from "../hooks/useSettings";
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

type CodeTokenKind = keyof ThemePreviewData["syntax"];

interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

interface CodeLine {
  readonly id: string;
  readonly tokens: readonly CodeToken[];
}

type PreviewThemeSource = ThemeDescriptor["source"] | "online";

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

interface ThemePreviewGridRow {
  readonly id: string;
  readonly themes: readonly PreviewTheme[];
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

function themeSourceLabel(theme: PreviewTheme): string {
  if (theme.source === "online" && theme.onlineExtension) {
    return `Open VSX · ${theme.onlineExtension.namespace}.${theme.onlineExtension.name}`;
  }
  if (theme.source === "imported" && theme.record) {
    return `Imported from ${theme.record.namespace}.${theme.record.name}`;
  }
  return "Bundled Shiki theme";
}

function modeLabel(mode: ResolvedThemeType): string {
  return mode === "light" ? "light" : "dark";
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
  return `${theme.source}:${theme.id}`;
}

function createThemePreviewRows(
  themes: ReadonlyArray<PreviewTheme>,
  columnCount: number,
): ThemePreviewGridRow[] {
  const rows: ThemePreviewGridRow[] = [];
  const safeColumnCount = Math.max(1, Math.trunc(columnCount));
  for (let index = 0; index < themes.length; index += safeColumnCount) {
    const rowThemes = themes.slice(index, index + safeColumnCount);
    rows.push({
      id: rowThemes.map(themePreviewKey).join("|"),
      themes: rowThemes,
    });
  }
  return rows;
}

function getThemePreviewColumnCount(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 1;
  if (window.matchMedia("(min-width: 1536px)").matches) return 3;
  if (window.matchMedia("(min-width: 1024px)").matches) return 2;
  return 1;
}

function useThemePreviewColumnCount(): number {
  const [columnCount, setColumnCount] = useState(getThemePreviewColumnCount);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const queries = [
      window.matchMedia("(min-width: 1536px)"),
      window.matchMedia("(min-width: 1024px)"),
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
  if (columnCount >= 3) return 430 + THEME_PREVIEW_ROW_GAP_PX;
  if (columnCount === 2) return 500 + THEME_PREVIEW_ROW_GAP_PX;
  return 420 + THEME_PREVIEW_ROW_GAP_PX;
}

function ThemePreviewRouteView() {
  const importedThemes = useImportedThemes();
  const themePreviewColumnCount = useThemePreviewColumnCount();
  const installedThemes = useMemo(
    () => [...importedThemes.map(importedThemePreview), ...BUNDLED_THEMES.map(bundledThemePreview)],
    [importedThemes],
  );
  const [category, setCategory] = useState<ThemeCategory>("installed");
  const [installedQuery, setInstalledQuery] = useState("");
  const [onlineThemes, setOnlineThemes] = useState<ReadonlyArray<PreviewTheme>>([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineLoaded, setOnlineLoaded] = useState(false);
  const [onlineNextOffset, setOnlineNextOffset] = useState(0);
  const [onlineTotalSize, setOnlineTotalSize] = useState(0);
  const [filter, setFilter] = useState<ThemeFilter>("all");
  const onlineLoadingRef = useRef(false);
  const normalizedInstalledQuery = installedQuery.trim().toLowerCase();

  const visibleInstalledThemes = useMemo(
    () =>
      installedThemes.filter((theme) => {
        if (filter !== "all" && theme.type !== filter) return false;
        if (!normalizedInstalledQuery) return true;
        return themeSearchText(theme).includes(normalizedInstalledQuery);
      }),
    [filter, installedThemes, normalizedInstalledQuery],
  );

  const visibleOnlineThemes = useMemo(
    () => onlineThemes.filter((theme) => filter === "all" || theme.type === filter),
    [filter, onlineThemes],
  );
  const visibleThemes = category === "online" ? visibleOnlineThemes : visibleInstalledThemes;
  const totalThemes = category === "online" ? onlineTotalSize : installedThemes.length;
  const canLoadMoreOnline = !onlineLoaded || onlineNextOffset < onlineTotalSize;
  const minimumVisibleOnlineThemeCount = Math.max(3, themePreviewColumnCount * 3);
  const scannedOnlineCount = onlineLoaded
    ? Math.min(onlineNextOffset, onlineTotalSize)
    : onlineNextOffset;

  const loadMoreOnlineThemes = useCallback(async () => {
    if (onlineLoadingRef.current) return;
    if (onlineLoaded && onlineNextOffset >= onlineTotalSize) return;

    const startOffset = onlineNextOffset;
    onlineLoadingRef.current = true;
    setOnlineLoading(true);
    try {
      const api = ensureLocalApi();
      const previews: PreviewTheme[] = [];
      let cursor = startOffset;
      let totalSize = onlineTotalSize;
      let scannedExtensions = 0;

      while (
        previews.length < ONLINE_THEME_PAGE_SIZE &&
        scannedExtensions < ONLINE_THEME_EXTENSION_SCAN_LIMIT
      ) {
        const result = await api.themes.search({
          offset: cursor,
          size: ONLINE_THEME_PAGE_SIZE,
        });
        totalSize = result.totalSize;
        if (result.items.length === 0) {
          cursor = Math.min(result.offset + result.size, result.totalSize);
          break;
        }

        const importedResults = await Promise.allSettled(
          result.items.map(async (item) => {
            const preview = await api.themes.preview({
              namespace: item.namespace,
              name: item.name,
              version: item.version,
            });
            return preview.themes.map((theme) =>
              onlineThemePreview(theme, item, {
                namespace: preview.namespace,
                name: preview.name,
                version: preview.version,
              }),
            );
          }),
        );

        previews.push(
          ...importedResults.flatMap((resultItem) =>
            resultItem.status === "fulfilled" ? resultItem.value : [],
          ),
        );
        scannedExtensions += result.items.length;
        cursor = Math.min(result.offset + result.size, result.totalSize);
        if (cursor >= result.totalSize) break;
      }

      setOnlineThemes((currentThemes) => {
        if (previews.length === 0) return currentThemes;
        const seen = new Set(currentThemes.map(themePreviewKey));
        const nextThemes = [...currentThemes];
        for (const preview of previews) {
          const key = themePreviewKey(preview);
          if (seen.has(key)) continue;
          seen.add(key);
          nextThemes.push(preview);
        }
        return nextThemes;
      });
      setOnlineNextOffset(cursor);
      setOnlineTotalSize(totalSize);
      setOnlineLoaded(true);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Theme page failed",
        description: errorMessage(error, "Could not reach the Open VSX registry."),
      });
    } finally {
      onlineLoadingRef.current = false;
      setOnlineLoading(false);
    }
  }, [onlineLoaded, onlineNextOffset, onlineTotalSize]);

  const handleThemeListEndReached = useCallback(() => {
    if (category !== "online" || onlineLoading || !canLoadMoreOnline) return;
    void loadMoreOnlineThemes();
  }, [canLoadMoreOnline, category, loadMoreOnlineThemes, onlineLoading]);

  useEffect(() => {
    if (category !== "online" || onlineLoaded || onlineLoading) return;
    void loadMoreOnlineThemes();
  }, [category, loadMoreOnlineThemes, onlineLoaded, onlineLoading]);

  useEffect(() => {
    if (category !== "online" || !onlineLoaded || onlineLoading || !canLoadMoreOnline) return;
    if (visibleOnlineThemes.length >= minimumVisibleOnlineThemeCount) return;
    void loadMoreOnlineThemes();
  }, [
    canLoadMoreOnline,
    category,
    loadMoreOnlineThemes,
    minimumVisibleOnlineThemeCount,
    onlineLoaded,
    onlineLoading,
    visibleOnlineThemes.length,
  ]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <PaletteIcon className="size-4 text-muted-foreground" />
            <h1 className="min-w-0 truncate font-medium text-[15px] text-foreground md:text-sm">
              Theme previews
            </h1>
            <div className="ms-auto flex items-center gap-2">
              <Button render={<a href="/settings/general" />} size="xs" variant="outline">
                Settings
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:px-5 lg:px-8">
          <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
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
                        "inline-flex h-8 items-center gap-1.5 border-input px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background not-first:border-s",
                        pressed
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
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

              {category === "installed" ? (
                <InputGroup className="w-full min-w-0 xl:max-w-lg">
                  <InputGroupAddon>
                    <SearchIcon className="size-4" />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label="Search themes"
                    nativeInput
                    onChange={(event) => setInstalledQuery(event.currentTarget.value)}
                    placeholder="Search themes..."
                    type="search"
                    value={installedQuery}
                  />
                </InputGroup>
              ) : (
                <div className="flex w-full min-w-0 items-center text-muted-foreground text-xs xl:max-w-lg xl:justify-end">
                  <span className="min-w-0 truncate">
                    {onlineLoading && !onlineLoaded ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <Spinner />
                        <span className="truncate">Loading Open VSX</span>
                      </span>
                    ) : onlineLoaded ? (
                      `${onlineThemes.length} loaded · scanned ${scannedOnlineCount} of ${onlineTotalSize}`
                    ) : (
                      "Open VSX"
                    )}
                  </span>
                </div>
              )}

              <div className="flex flex-wrap gap-2 xl:justify-end">
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
                          "inline-flex h-8 items-center gap-1.5 border-input px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background not-first:border-s",
                          pressed
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
              <span>
                {category === "online"
                  ? `${visibleThemes.length} shown from loaded previews`
                  : `${visibleThemes.length} of ${totalThemes} themes`}
              </span>
            </div>

            {category === "online" && onlineLoading && onlineThemes.length === 0 ? (
              <div className="flex min-h-52 items-center justify-center rounded-lg border border-border bg-card/20 px-6 text-muted-foreground text-sm">
                <Spinner />
              </div>
            ) : visibleThemes.length > 0 ? (
              <div className="min-h-0 flex-1">
                <ThemePreviewVirtualGrid
                  canLoadMore={category === "online" && canLoadMoreOnline}
                  columnCount={themePreviewColumnCount}
                  loadingMore={category === "online" && onlineLoading && onlineThemes.length > 0}
                  onEndReached={handleThemeListEndReached}
                  themes={visibleThemes}
                />
              </div>
            ) : (
              <div className="flex min-h-52 items-center justify-center rounded-lg border border-dashed border-border bg-card/20 px-6 text-center text-muted-foreground text-sm">
                {category === "online"
                  ? canLoadMoreOnline
                    ? "Looking for previewable color themes."
                    : "No previewable color themes were found."
                  : "No themes match your filters."}
              </div>
            )}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

function ThemePreviewVirtualGrid({
  canLoadMore,
  columnCount,
  loadingMore,
  onEndReached,
  themes,
}: {
  readonly canLoadMore: boolean;
  readonly columnCount: number;
  readonly loadingMore: boolean;
  readonly onEndReached: () => void;
  readonly themes: ReadonlyArray<PreviewTheme>;
}) {
  const rows = useMemo(() => createThemePreviewRows(themes, columnCount), [columnCount, themes]);
  const estimatedRowSize = estimatedThemePreviewRowSize(columnCount);

  const renderRow = useCallback(
    ({ item }: { readonly item: ThemePreviewGridRow; readonly index: number }) => (
      <div className="grid grid-cols-1 gap-4 pb-4 lg:grid-cols-2 2xl:grid-cols-3">
        {item.themes.map((theme) => (
          <ThemePreviewCard key={themePreviewKey(theme)} theme={theme} />
        ))}
      </div>
    ),
    [],
  );

  const footer = (
    <div className="flex min-h-12 items-center justify-center pb-1 text-muted-foreground text-xs">
      {loadingMore ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner />
          Loading more themes
        </span>
      ) : canLoadMore ? (
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
  const [preview, setPreview] = useState(() => createFallbackThemePreview(theme.type));
  const [loading, setLoading] = useState(theme.source === "bundled");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const { selection, setThemeForMode } = useColorTheme();
  const { updateSettings } = useUpdateSettings();
  const selected = selection[theme.type] === theme.id;

  useEffect(() => {
    let cancelled = false;
    setPreview(createFallbackThemePreview(theme.type));
    setLoading(theme.source === "bundled");
    setFailed(false);

    const loadPreview = async () => {
      if (theme.source === "imported" || theme.source === "online") {
        const previewSource = theme.record ?? theme.preview;
        if (!previewSource) {
          setFailed(true);
          return;
        }
        setPreview(
          createThemePreview({
            colors: previewSource.colors,
            type: previewSource.type,
            ...(previewSource.tokenColors === undefined
              ? {}
              : { tokenColors: previewSource.tokenColors }),
          }),
        );
        return;
      }

      try {
        const bundled = await loadBundledTheme(theme.id);
        if (!bundled || cancelled) return;
        setPreview(createThemePreview(bundled));
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [theme.id, theme.preview, theme.record, theme.source, theme.type]);

  const handleUseTheme = useCallback(async () => {
    if (theme.source === "online") {
      setSaving(true);
      try {
        const record = await importOnlineThemeRecord(theme);
        syncImportedThemeRecords(
          [record],
          updateSettings,
          theme.type === "light" ? { colorThemeLight: theme.id } : { colorThemeDark: theme.id },
        );
        setThemeForMode(theme.type, theme.id);
        toastManager.add({
          type: "success",
          title: `Imported ${theme.label}`,
          description: `Using for ${modeLabel(theme.type)} mode.`,
        });
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

    setThemeForMode(theme.type, theme.id);
    updateSettings(
      theme.type === "light" ? { colorThemeLight: theme.id } : { colorThemeDark: theme.id },
    );
  }, [setThemeForMode, theme, updateSettings]);

  const handleImportTheme = useCallback(async () => {
    setSaving(true);
    try {
      const record =
        theme.source === "online" ? await importOnlineThemeRecord(theme) : theme.record;
      if (!record) return;
      syncImportedThemeRecords([record], updateSettings);
      toastManager.add({
        type: "success",
        title: `Imported ${theme.label}`,
        description: "Added to your installed themes.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Import failed",
        description: errorMessage(error, "Could not import this theme."),
      });
    } finally {
      setSaving(false);
    }
  }, [theme, updateSettings]);

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm/5">
      <ThemePreviewMockup preview={preview} themeName={theme.label} />

      <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate font-medium text-base text-foreground">
              {theme.label}
            </h2>
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
          <p className="mt-1 truncate text-muted-foreground text-sm">{themeSourceLabel(theme)}</p>
          {theme.downloadCount ? (
            <p className="mt-1 text-muted-foreground/70 text-xs">
              {theme.downloadCount.toLocaleString()} downloads
            </p>
          ) : null}
          {failed ? (
            <p className="mt-1 text-destructive text-xs">Preview colors could not be loaded.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <div className="flex items-center gap-1.5">
            {preview.swatches.map((color) => (
              <span
                aria-hidden="true"
                className="size-5 rounded-full border border-border shadow-xs/10"
                key={`${theme.id}:${color}`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>

          {theme.source === "online" ? (
            <Button disabled={saving} onClick={handleImportTheme} size="xs" variant="ghost">
              {saving ? <Spinner /> : <DownloadIcon className="size-3.5" />}
              Import
            </Button>
          ) : null}

          <Button
            disabled={selected || saving}
            onClick={handleUseTheme}
            size="xs"
            variant="outline"
          >
            {selected ? (
              <CheckIcon className="size-3.5" />
            ) : saving ? (
              <Spinner />
            ) : theme.type === "light" ? (
              <SunIcon className="size-3.5" />
            ) : (
              <MoonIcon className="size-3.5" />
            )}
            {selected ? "Selected" : `Use for ${modeLabel(theme.type)}`}
          </Button>
        </div>
      </div>

      {loading ? <div className="h-0.5 bg-primary/40" /> : null}
    </article>
  );
}

function ThemePreviewMockup({
  preview,
  themeName,
}: {
  readonly preview: ThemePreviewData;
  readonly themeName: string;
}) {
  const palette = preview.palette;
  return (
    <div
      className="aspect-[16/10] overflow-hidden border-b font-mono text-[11px] leading-5 sm:text-xs"
      style={{
        backgroundColor: palette.background,
        borderColor: palette.border,
        color: palette.foreground,
      }}
    >
      <div className="grid h-full grid-cols-[2.5rem_1fr] grid-rows-[1.7rem_1.7rem_1fr]">
        <div
          className="col-span-2 flex items-center justify-center border-b px-2 tracking-wide"
          style={{
            backgroundColor: palette.chrome,
            borderColor: palette.border,
            color: palette.chromeForeground,
          }}
        >
          <span className="max-w-full truncate">{themeName}</span>
        </div>

        <div
          className="row-span-2 flex flex-col items-center gap-3 border-r px-1.5 py-3"
          style={{
            backgroundColor: palette.activityBar,
            borderColor: palette.border,
            color: palette.activityBarForeground,
          }}
        >
          <FilesIcon className="size-4 opacity-90" />
          <SearchIcon className="size-4 opacity-60" />
          <span className="relative">
            <GitBranchIcon className="size-4 opacity-60" />
            <span
              className="-right-2 -top-1 absolute flex size-4 items-center justify-center rounded-full text-[9px]"
              style={{
                backgroundColor: palette.accent,
                color: palette.background,
              }}
            >
              3
            </span>
          </span>
          <PlayIcon className="size-4 opacity-60" />
          <BlocksIcon className="size-4 opacity-60" />
        </div>

        <div
          className="flex border-b"
          style={{
            backgroundColor: palette.tabInactive,
            borderColor: palette.border,
            color: palette.chromeForeground,
          }}
        >
          <div
            className="flex w-36 max-w-[45%] items-center justify-center border-r border-t-2 px-3"
            style={{
              backgroundColor: palette.tabActive,
              borderColor: palette.border,
              borderTopColor: palette.accent,
              color: palette.foreground,
            }}
          >
            main.js
          </div>
        </div>

        <div className="min-h-0 overflow-hidden px-4 py-3">
          <pre className="m-0 overflow-hidden whitespace-pre">
            {SAMPLE_CODE_LINES.map((line) => (
              <div key={line.id} className={line.tokens.length === 0 ? "h-5" : undefined}>
                {line.tokens.map((token) => (
                  <span
                    key={`${line.id}:${token.kind}:${token.text}`}
                    style={{ color: preview.syntax[token.kind] }}
                  >
                    {token.text}
                  </span>
                ))}
              </div>
            ))}
          </pre>
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
