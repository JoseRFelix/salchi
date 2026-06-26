import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  ThemeProviderError,
  type ImportedTheme,
  type ThemeImportInput,
  type ThemeImportResult,
  type ThemeSearchInput,
  type ThemeSearchResult,
} from "@t3tools/contracts";

/**
 * Open VSX (https://open-vsx.org) theme provider. The registry serves each
 * extension file individually, so we fetch `package.json` and the referenced
 * theme JSON directly — no `.vsix` download/zip extraction. Imported themes are
 * normalized into the same `colors` shape the app's themeMapping consumes.
 */

const OPEN_VSX_API = "https://open-vsx.org/api";
const DEFAULT_SEARCH_SIZE = 25;
const MAX_SEARCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;

type ThemeOperation = "search" | "import";

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

interface OpenVsxSearchExtension {
  readonly namespace?: string;
  readonly name?: string;
  readonly version?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly downloadCount?: number;
}

export const searchThemes = Effect.fn("openVsx.searchThemes")(function* (input: ThemeSearchInput) {
  const query = input.query.trim();
  if (query.length === 0) return { items: [] } satisfies ThemeSearchResult;

  const size = clamp(input.size ?? DEFAULT_SEARCH_SIZE, 1, MAX_SEARCH_SIZE);
  const url =
    `${OPEN_VSX_API}/-/search?query=${encodeURIComponent(query)}` +
    `&category=Themes&size=${size}&sortBy=relevance&includeAllVersions=false`;
  const data = (yield* fetchJsonc(url, "search")) as { extensions?: OpenVsxSearchExtension[] };

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
  return { items } satisfies ThemeSearchResult;
});

interface ContributedTheme {
  readonly label?: string;
  readonly uiTheme?: string;
  readonly path?: string;
}

function uiThemeToMode(uiTheme: string | undefined): "light" | "dark" {
  // VS Code: "vs"/"hc-light" = light, "vs-dark"/"hc-black" = dark.
  return uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
}

function joinExtensionPath(themePath: string): string {
  return themePath
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveIncludePath(themePath: string, include: string): string {
  const dir = themePath.replace(/^\.\//, "").split("/").slice(0, -1);
  return [...dir, include.replace(/^\.\//, "")].join("/");
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

const loadThemeColors = Effect.fn("openVsx.loadThemeColors")(function* (
  fileBase: string,
  themePath: string,
) {
  const themeJson = yield* fetchJsonc(`${fileBase}/${joinExtensionPath(themePath)}`, "import");
  let colors: Record<string, string> = {};
  // Resolve a single level of `include` (themes often extend a base file).
  const include = (themeJson as { include?: unknown }).include;
  if (typeof include === "string") {
    const includePath = resolveIncludePath(themePath, include);
    const baseJson = yield* fetchJsonc(`${fileBase}/${joinExtensionPath(includePath)}`, "import");
    colors = extractColors(baseJson);
  }
  return { ...colors, ...extractColors(themeJson) };
});

const resolveLatestVersion = Effect.fn("openVsx.resolveLatestVersion")(function* (
  namespace: string,
  name: string,
) {
  const meta = (yield* fetchJsonc(`${OPEN_VSX_API}/${namespace}/${name}`, "import")) as {
    version?: string;
  };
  if (!meta.version) {
    return yield* themeError("import", `Could not resolve a version for ${namespace}.${name}`);
  }
  return meta.version;
});

export const importTheme = Effect.fn("openVsx.importTheme")(function* (input: ThemeImportInput) {
  const { namespace, name } = input;
  const version = input.version ?? (yield* resolveLatestVersion(namespace, name));
  const fileBase = `${OPEN_VSX_API}/${namespace}/${name}/${version}/file`;

  const manifest = (yield* fetchJsonc(`${fileBase}/package.json`, "import")) as {
    displayName?: string;
    contributes?: { themes?: ContributedTheme[] };
  };
  const contributed = (manifest.contributes?.themes ?? []).filter(
    (theme) => typeof theme.path === "string",
  );
  if (contributed.length === 0) {
    return yield* themeError("import", `${namespace}.${name} contributes no themes`);
  }

  const themes: ImportedTheme[] = [];
  for (const theme of contributed) {
    const colors = yield* loadThemeColors(fileBase, theme.path as string);
    if (Object.keys(colors).length === 0) continue;
    const label = trimToFallback(theme.label, trimToFallback(manifest.displayName, name));
    themes.push({
      id: `${namespace}.${name}/${label}`,
      label,
      type: uiThemeToMode(theme.uiTheme),
      colors,
    });
  }

  if (themes.length === 0) {
    return yield* themeError("import", `${namespace}.${name} themes contained no usable colors`);
  }
  return { namespace, name, version, themes } satisfies ThemeImportResult;
});
