import { inflateRawSync } from "node:zlib";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  pruneThemePreviewColors,
  pruneThemePreviewTokenColors,
} from "@t3tools/shared/themePreview";

import {
  ThemeProviderError,
  type ImportedTheme,
  type ThemeImportInput,
  type ThemeImportResult,
  type ThemePreviewResult,
  type ThemePreviewTheme,
  type ThemeSearchInput,
  type ThemeSearchResult,
  type ThemeTokenColor,
} from "@t3tools/contracts";

/**
 * Open VSX (https://open-vsx.org) theme provider. The registry serves each
 * extension package as a VSIX. Imported themes are normalized into the same
 * `colors` shape the app's themeMapping consumes, with TextMate token colors
 * preserved for the preview route.
 */

const OPEN_VSX_API = "https://open-vsx.org/api";
const DEFAULT_SEARCH_SIZE = 25;
const MAX_SEARCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_VSIX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRY_EXPANDED_BYTES = 16 * 1024 * 1024;
const THEME_PREVIEW_CACHE_MIN_THEMES = 100;
const THEME_PREVIEW_CACHE_MAX_THEMES = 1_000;
const THEME_PREVIEW_CACHE_TARGET_BYTES = 12 * 1024 * 1024;
const THEME_IMPORT_CACHE_MIN_THEMES = 100;
const THEME_IMPORT_CACHE_MAX_THEMES = 250;
const THEME_IMPORT_CACHE_TARGET_BYTES = 25 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_COMPRESSION_STORED = 0;
const ZIP_COMPRESSION_DEFLATED = 8;

type ThemeOperation = "search" | "preview" | "import";

interface CacheableThemeResult {
  readonly themes: readonly unknown[];
}

interface CachedThemeResult<TResult extends CacheableThemeResult> {
  readonly result: TResult;
  readonly themeCount: number;
  readonly byteSize: number;
}

interface ThemeResultCache<TResult extends CacheableThemeResult> {
  readonly entries: Map<string, CachedThemeResult<TResult>>;
  themeCount: number;
  byteCount: number;
  readonly minThemes: number;
  readonly maxThemes: number;
  readonly targetBytes: number;
}

interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const themePreviewCache = createThemeResultCache<ThemePreviewResult>({
  minThemes: THEME_PREVIEW_CACHE_MIN_THEMES,
  maxThemes: THEME_PREVIEW_CACHE_MAX_THEMES,
  targetBytes: THEME_PREVIEW_CACHE_TARGET_BYTES,
});
const themeImportCache = createThemeResultCache<ThemeImportResult>({
  minThemes: THEME_IMPORT_CACHE_MIN_THEMES,
  maxThemes: THEME_IMPORT_CACHE_MAX_THEMES,
  targetBytes: THEME_IMPORT_CACHE_TARGET_BYTES,
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function trimToFallback(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : fallback;
}

function themeError(operation: ThemeOperation, detail: string, cause?: unknown) {
  return new ThemeProviderError({ operation, detail, cause });
}

function parseContentLength(headers: Readonly<Record<string, string | undefined>>): number | null {
  const value = headers["content-length"];
  if (value === undefined) return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

function assertBufferRange(
  buffer: Buffer,
  offset: number,
  byteLength: number,
  detail: string,
): void {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(byteLength) ||
    offset < 0 ||
    byteLength < 0 ||
    offset + byteLength > buffer.length
  ) {
    throw new Error(detail);
  }
}

/**
 * Tolerant JSON parser for VS Code theme files, which are frequently JSONC
 * (line/block comments and trailing commas). Strips comments and trailing
 * commas while preserving string contents, then parses.
 */
export function parseJsonc(input: string): unknown {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  const withoutTrailingCommas = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

const fetchJsonc = Effect.fn("openVsx.fetchJsonc")(function* (
  url: string,
  operation: ThemeOperation,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(REQUEST_TIMEOUT_MS),
    Effect.mapError((cause) => themeError(operation, `request failed for ${url}`, cause)),
  );
  if (Option.isNone(response)) {
    return yield* themeError(operation, `request timed out for ${url}`);
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return yield* themeError(operation, `HTTP ${httpResponse.status} for ${url}`);
  }
  const text = yield* httpResponse.text.pipe(
    Effect.mapError((cause) => themeError(operation, `failed reading ${url}`, cause)),
  );
  return yield* Effect.try({
    try: () => parseJsonc(text),
    catch: (cause) => themeError(operation, `invalid JSON from ${url}`, cause),
  });
});

const fetchBinary = Effect.fn("openVsx.fetchBinary")(function* (
  url: string,
  operation: ThemeOperation,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("accept", "application/octet-stream"),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(REQUEST_TIMEOUT_MS),
    Effect.mapError((cause) => themeError(operation, `request failed for ${url}`, cause)),
  );
  if (Option.isNone(response)) {
    return yield* themeError(operation, `request timed out for ${url}`);
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return yield* themeError(operation, `HTTP ${httpResponse.status} for ${url}`);
  }
  const contentLength = parseContentLength(httpResponse.headers);
  if (contentLength !== null && contentLength > MAX_VSIX_DOWNLOAD_BYTES) {
    return yield* themeError(
      operation,
      `VSIX download exceeded ${MAX_VSIX_DOWNLOAD_BYTES} bytes for ${url}`,
    );
  }
  const arrayBuffer = yield* httpResponse.arrayBuffer.pipe(
    Effect.mapError((cause) => themeError(operation, `failed reading ${url}`, cause)),
  );
  if (arrayBuffer.byteLength > MAX_VSIX_DOWNLOAD_BYTES) {
    return yield* themeError(
      operation,
      `VSIX download exceeded ${MAX_VSIX_DOWNLOAD_BYTES} bytes for ${url}`,
    );
  }
  return Buffer.from(arrayBuffer);
});

function findEndOfCentralDirectory(buffer: Buffer): number {
  const maxCommentLength = 0xffff;
  const minOffset = Math.max(0, buffer.length - maxCommentLength - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Zip end of central directory was not found");
}

function readZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, ZipEntry>();
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Invalid zip central directory header");
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.toString("utf8", nameStart, nameStart + fileNameLength);

    if (!name.endsWith("/")) {
      entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const localHeaderOffset = entry.localHeaderOffset;
  assertBufferRange(buffer, localHeaderOffset, 30, `Invalid zip local header for ${entry.name}`);
  if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid zip local header for ${entry.name}`);
  }
  if (entry.compressedSize > MAX_ZIP_ENTRY_COMPRESSED_BYTES) {
    throw new Error(
      `Compressed zip entry ${entry.name} exceeded ${MAX_ZIP_ENTRY_COMPRESSED_BYTES} bytes`,
    );
  }
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_EXPANDED_BYTES) {
    throw new Error(
      `Expanded zip entry ${entry.name} exceeded ${MAX_ZIP_ENTRY_EXPANDED_BYTES} bytes`,
    );
  }

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  assertBufferRange(
    buffer,
    dataStart,
    entry.compressedSize,
    `Invalid zip data range for ${entry.name}`,
  );
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === ZIP_COMPRESSION_STORED) {
    return Buffer.from(compressed);
  }
  if (entry.compressionMethod === ZIP_COMPRESSION_DEFLATED) {
    const inflated = inflateRawSync(compressed);
    if (inflated.byteLength > MAX_ZIP_ENTRY_EXPANDED_BYTES) {
      throw new Error(
        `Expanded zip entry ${entry.name} exceeded ${MAX_ZIP_ENTRY_EXPANDED_BYTES} bytes`,
      );
    }
    return inflated;
  }
  throw new Error(
    `Unsupported zip compression method ${entry.compressionMethod} for ${entry.name}`,
  );
}

export function readZipTextFile(buffer: Buffer, filePath: string): string | undefined {
  const entries = readZipEntries(buffer);
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const entry =
    entries.get(normalizedPath) ??
    [...entries.values()].find(
      (candidate) => candidate.name.toLowerCase() === normalizedPath.toLowerCase(),
    );
  if (!entry) return undefined;
  return readZipEntry(buffer, entry).toString("utf8");
}

function normalizeExtensionPath(filePath: string): string {
  const segments: string[] = [];
  for (const segment of filePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`Invalid extension path: ${filePath}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error(`Invalid extension path: ${filePath}`);
  }
  return segments.join("/");
}

function resolveThemeIncludePath(themePath: string, include: string): string {
  const normalizedThemePath = normalizeExtensionPath(themePath);
  const slashIndex = normalizedThemePath.lastIndexOf("/");
  const themeDir = slashIndex === -1 ? "" : normalizedThemePath.slice(0, slashIndex);
  return normalizeExtensionPath(themeDir.length === 0 ? include : `${themeDir}/${include}`);
}

function readExtensionJsonc(vsix: Buffer, filePath: string): unknown {
  const normalizedPath = normalizeExtensionPath(filePath);
  const text = readZipTextFile(vsix, `extension/${normalizedPath}`);
  if (text === undefined) {
    throw new Error(`Could not find ${normalizedPath} in VSIX`);
  }
  return parseJsonc(text);
}

function importCacheKey(namespace: string, name: string, version: string): string {
  return `${namespace}/${name}/${version}`;
}

function createThemeResultCache<TResult extends CacheableThemeResult>(options: {
  readonly minThemes: number;
  readonly maxThemes: number;
  readonly targetBytes: number;
}): ThemeResultCache<TResult> {
  return {
    entries: new Map(),
    themeCount: 0,
    byteCount: 0,
    minThemes: options.minThemes,
    maxThemes: options.maxThemes,
    targetBytes: options.targetBytes,
  };
}

function getCachedThemeResult<TResult extends CacheableThemeResult>(
  cache: ThemeResultCache<TResult>,
  key: string,
): TResult | undefined {
  const cached = cache.entries.get(key);
  if (!cached) return undefined;
  cache.entries.delete(key);
  cache.entries.set(key, cached);
  return cached.result;
}

function estimateCacheByteSize(result: CacheableThemeResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function pruneThemeResultCache<TResult extends CacheableThemeResult>(
  cache: ThemeResultCache<TResult>,
) {
  while (
    cache.themeCount > cache.minThemes &&
    (cache.themeCount > cache.maxThemes || cache.byteCount > cache.targetBytes)
  ) {
    const oldestKey = cache.entries.keys().next().value;
    if (oldestKey === undefined) return;
    const oldest = cache.entries.get(oldestKey);
    if (!oldest) {
      cache.entries.delete(oldestKey);
      continue;
    }
    cache.entries.delete(oldestKey);
    cache.themeCount -= oldest.themeCount;
    cache.byteCount -= oldest.byteSize;
  }
}

function setCachedThemeResult<TResult extends CacheableThemeResult>(
  cache: ThemeResultCache<TResult>,
  key: string,
  result: TResult,
) {
  const existing = cache.entries.get(key);
  if (existing) {
    cache.themeCount -= existing.themeCount;
    cache.byteCount -= existing.byteSize;
    cache.entries.delete(key);
  }

  const cached = {
    result,
    themeCount: result.themes.length,
    byteSize: estimateCacheByteSize(result),
  } satisfies CachedThemeResult<TResult>;
  cache.entries.set(key, cached);
  cache.themeCount += cached.themeCount;
  cache.byteCount += cached.byteSize;
  pruneThemeResultCache(cache);
}

function clearThemeResultCache<TResult extends CacheableThemeResult>(
  cache: ThemeResultCache<TResult>,
) {
  cache.entries.clear();
  cache.themeCount = 0;
  cache.byteCount = 0;
}

function getThemeResultCacheStats<TResult extends CacheableThemeResult>(
  cache: ThemeResultCache<TResult>,
) {
  return {
    extensionCount: cache.entries.size,
    themeCount: cache.themeCount,
    byteCount: cache.byteCount,
  };
}

function setCachedThemeImport(key: string, result: ThemeImportResult) {
  setCachedThemeResult(themeImportCache, key, result);
}

function setCachedThemePreview(key: string, result: ThemePreviewResult) {
  setCachedThemeResult(themePreviewCache, key, result);
}

export function getThemeImportCacheStats() {
  return getThemeResultCacheStats(themeImportCache);
}

export function getThemePreviewCacheStats() {
  return getThemeResultCacheStats(themePreviewCache);
}

export function clearThemeImportCacheForTests() {
  clearThemeResultCache(themeImportCache);
}

export function clearThemePreviewCacheForTests() {
  clearThemeResultCache(themePreviewCache);
}

export function setCachedThemeImportForTests(key: string, result: ThemeImportResult) {
  setCachedThemeImport(key, result);
}

export function setCachedThemePreviewForTests(key: string, result: ThemePreviewResult) {
  setCachedThemePreview(key, result);
}

interface OpenVsxSearchExtension {
  readonly namespace?: string;
  readonly name?: string;
  readonly version?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly downloadCount?: number;
}

interface OpenVsxSearchResponse {
  readonly totalSize?: number;
  readonly extensions?: OpenVsxSearchExtension[];
}

export function buildThemeSearchUrl(input: ThemeSearchInput): string {
  const query = input.query?.trim() ?? "";
  const size = clamp(input.size ?? DEFAULT_SEARCH_SIZE, 1, MAX_SEARCH_SIZE);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const sortBy = input.sortBy ?? (query.length > 0 ? "relevance" : "downloadCount");
  const params = new URLSearchParams({
    category: "Themes",
    size: String(size),
    offset: String(offset),
    sortBy,
    includeAllVersions: "false",
  });
  if (query.length > 0) {
    params.set("query", query);
  }
  return `${OPEN_VSX_API}/-/search?${params.toString()}`;
}

export const searchThemes = Effect.fn("openVsx.searchThemes")(function* (input: ThemeSearchInput) {
  const size = clamp(input.size ?? DEFAULT_SEARCH_SIZE, 1, MAX_SEARCH_SIZE);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const data = (yield* fetchJsonc(buildThemeSearchUrl(input), "search")) as OpenVsxSearchResponse;

  const items = (data.extensions ?? [])
    .filter((ext) => ext.namespace && ext.name && ext.version)
    .map((ext) => ({
      namespace: ext.namespace as string,
      name: ext.name as string,
      version: ext.version as string,
      displayName: trimToFallback(ext.displayName, ext.name as string),
      description: typeof ext.description === "string" ? ext.description : undefined,
      downloadCount:
        typeof ext.downloadCount === "number" ? Math.trunc(ext.downloadCount) : undefined,
    }));
  return {
    items,
    offset,
    size,
    totalSize: typeof data.totalSize === "number" ? Math.trunc(data.totalSize) : items.length,
  } satisfies ThemeSearchResult;
});

interface ContributedTheme {
  readonly label?: string;
  readonly uiTheme?: string;
  readonly path?: string;
}

interface OpenVsxExtensionMetadata {
  readonly version?: string;
  readonly files?: {
    readonly download?: string;
  };
}

function uiThemeToMode(uiTheme: string | undefined): "light" | "dark" {
  // VS Code: "vs"/"hc-light" = light, "vs-dark"/"hc-black" = dark.
  return uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
}

function extractColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const colors = (value as { colors?: unknown }).colors;
  if (!colors || typeof colors !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(colors as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim().length > 0) result[key] = raw.trim();
  }
  return result;
}

export function extractTokenColors(value: unknown): ThemeTokenColor[] {
  if (!value || typeof value !== "object") return [];
  const tokenColors = (value as { tokenColors?: unknown }).tokenColors;
  if (!Array.isArray(tokenColors)) return [];

  const result: ThemeTokenColor[] = [];
  for (const rawRule of tokenColors) {
    if (!rawRule || typeof rawRule !== "object") continue;

    const rawScope = (rawRule as { scope?: unknown }).scope;
    const scope =
      typeof rawScope === "string"
        ? rawScope.trim()
        : Array.isArray(rawScope)
          ? rawScope
              .map((item) => (typeof item === "string" ? item.trim() : ""))
              .filter((item) => item.length > 0)
          : undefined;
    const settings = (rawRule as { settings?: unknown }).settings;
    if (!settings || typeof settings !== "object") continue;

    const foreground = (settings as { foreground?: unknown }).foreground;
    if (typeof foreground !== "string" || foreground.trim().length === 0) continue;

    result.push({
      ...(scope === undefined || scope.length === 0 ? {} : { scope }),
      settings: { foreground: foreground.trim() },
    });
  }

  return result;
}

interface ThemeDefinition {
  readonly colors: Record<string, string>;
  readonly tokenColors: ThemeTokenColor[];
}

function extractThemeDefinition(value: unknown): ThemeDefinition {
  return {
    colors: extractColors(value),
    tokenColors: extractTokenColors(value),
  };
}

export function loadThemeDefinitionFromVsix(vsix: Buffer, themePath: string): ThemeDefinition {
  const includes: unknown[] = [];
  let currentPath = normalizeExtensionPath(themePath);
  const seen = new Set<string>();

  for (let depth = 0; depth < 10; depth += 1) {
    if (seen.has(currentPath)) {
      throw new Error(`Theme include cycle at ${currentPath}`);
    }
    seen.add(currentPath);

    const themeJson = readExtensionJsonc(vsix, currentPath);
    includes.push(themeJson);

    const include = (themeJson as { include?: unknown }).include;
    if (typeof include !== "string" || include.trim().length === 0) break;
    currentPath = resolveThemeIncludePath(currentPath, include);
  }

  let definition: ThemeDefinition = { colors: {}, tokenColors: [] };
  for (let index = includes.length - 1; index >= 0; index -= 1) {
    const includeDefinition = extractThemeDefinition(includes[index]);
    definition = {
      colors: { ...definition.colors, ...includeDefinition.colors },
      tokenColors: [...definition.tokenColors, ...includeDefinition.tokenColors],
    };
  }
  return definition;
}

function toThemePreviewTheme(theme: ImportedTheme): ThemePreviewTheme {
  const tokenColors = theme.tokenColors ? pruneThemePreviewTokenColors(theme.tokenColors) : [];
  return {
    id: theme.id,
    label: theme.label,
    type: theme.type,
    colors: pruneThemePreviewColors(theme.colors),
    ...(tokenColors.length === 0 ? {} : { tokenColors }),
  };
}

function toThemePreviewResult(result: ThemeImportResult): ThemePreviewResult {
  return {
    namespace: result.namespace,
    name: result.name,
    version: result.version,
    themes: result.themes.map(toThemePreviewTheme),
  };
}

const resolveLatestVersion = Effect.fn("openVsx.resolveLatestVersion")(function* (
  operation: Exclude<ThemeOperation, "search">,
  namespace: string,
  name: string,
) {
  const meta = (yield* fetchJsonc(
    `${OPEN_VSX_API}/${namespace}/${name}`,
    operation,
  )) as OpenVsxExtensionMetadata;
  if (!meta.version) {
    return yield* themeError(operation, `Could not resolve a version for ${namespace}.${name}`);
  }
  return meta.version;
});

const loadThemeImportResult = Effect.fn("openVsx.loadThemeImportResult")(function* (
  operation: Exclude<ThemeOperation, "search">,
  namespace: string,
  name: string,
  version: string,
) {
  const metadata = (yield* fetchJsonc(
    `${OPEN_VSX_API}/${namespace}/${name}/${version}`,
    operation,
  )) as OpenVsxExtensionMetadata;
  const downloadUrl = metadata.files?.download;
  if (!downloadUrl) {
    return yield* themeError(operation, `${namespace}.${name} has no VSIX download URL`);
  }

  const vsix = yield* fetchBinary(downloadUrl, operation);

  const manifestText = yield* Effect.try({
    try: () => readZipTextFile(vsix, "extension/package.json"),
    catch: (cause) => themeError(operation, `${namespace}.${name} VSIX could not be read`, cause),
  });
  if (manifestText === undefined) {
    return yield* themeError(operation, `${namespace}.${name} VSIX contains no package.json`);
  }
  const manifest = (yield* Effect.try({
    try: () => parseJsonc(manifestText),
    catch: (cause) => themeError(operation, `${namespace}.${name} package.json is invalid`, cause),
  })) as {
    displayName?: string;
    contributes?: { themes?: ContributedTheme[] };
  };
  const contributed = (manifest.contributes?.themes ?? []).filter(
    (theme) => typeof theme.path === "string",
  );
  if (contributed.length === 0) {
    return yield* themeError(operation, `${namespace}.${name} contributes no themes`);
  }

  const themes: ImportedTheme[] = [];
  for (const theme of contributed) {
    const themePath = theme.path as string;
    if (!themePath.toLowerCase().endsWith(".json")) continue;
    const definition = yield* Effect.try({
      try: () => loadThemeDefinitionFromVsix(vsix, themePath),
      catch: (cause) =>
        themeError(operation, `failed reading ${namespace}.${name} theme ${themePath}`, cause),
    });
    if (Object.keys(definition.colors).length === 0 && definition.tokenColors.length === 0) {
      continue;
    }
    const label = trimToFallback(theme.label, trimToFallback(manifest.displayName, name));
    themes.push({
      id: `${namespace}.${name}/${label}`,
      label,
      type: uiThemeToMode(theme.uiTheme),
      colors: definition.colors,
      ...(definition.tokenColors.length === 0 ? {} : { tokenColors: definition.tokenColors }),
    });
  }

  if (themes.length === 0) {
    return yield* themeError(operation, `${namespace}.${name} themes contained no usable colors`);
  }
  return { namespace, name, version, themes } satisfies ThemeImportResult;
});

export const previewTheme = Effect.fn("openVsx.previewTheme")(function* (input: ThemeImportInput) {
  const { namespace, name } = input;
  const version = input.version ?? (yield* resolveLatestVersion("preview", namespace, name));
  const cacheKey = importCacheKey(namespace, name, version);

  const cachedPreview = getCachedThemeResult(themePreviewCache, cacheKey);
  if (cachedPreview) return cachedPreview;

  const cachedImport = getCachedThemeResult(themeImportCache, cacheKey);
  if (cachedImport) {
    const preview = toThemePreviewResult(cachedImport);
    setCachedThemePreview(cacheKey, preview);
    return preview;
  }

  const result = yield* loadThemeImportResult("preview", namespace, name, version);
  const preview = toThemePreviewResult(result);
  setCachedThemePreview(cacheKey, preview);
  return preview;
});

export const importTheme = Effect.fn("openVsx.importTheme")(function* (input: ThemeImportInput) {
  const { namespace, name } = input;
  const version = input.version ?? (yield* resolveLatestVersion("import", namespace, name));
  const cacheKey = importCacheKey(namespace, name, version);
  const cached = getCachedThemeResult(themeImportCache, cacheKey);
  if (cached) return cached;

  const result = yield* loadThemeImportResult("import", namespace, name, version);
  setCachedThemeImport(cacheKey, result);
  return result;
});
