import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  type DiffsHighlighter,
  type DiffsThemeNames,
  type SupportedLanguages,
} from "@pierre/diffs";

import { fnv1a32 } from "./lib/diffRendering";
import { LRUCache } from "./lib/lruCache";

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

export const FILE_PREVIEW_HIGHLIGHT_MAX_BYTES = 256 * 1024;
export const CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH = 1_000;

const highlightedCodeHtmlCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function normalizeCodeHighlightLanguage(language: string | null | undefined): string {
  const raw = language?.trim().toLowerCase();
  if (!raw || raw === "plain" || raw === "plaintext") return "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685).
  if (raw === "gitignore") return "ini";
  return raw;
}

export function resolveCodeHighlightLanguageFromFenceClass(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return normalizeCodeHighlightLanguage(match?.[1]);
}

export function resolveCodeHighlightLanguageFromPath(path: string): string {
  const basename = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
  if (basename === ".gitignore") return "ini";

  try {
    return normalizeCodeHighlightLanguage(getFiletypeFromFileName(path));
  } catch {
    return "text";
  }
}

export function createCodeHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffsThemeNames,
  scope = "code",
): string {
  return `${scope}:${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

export function estimateHighlightedHtmlSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

export function getCachedHighlightedCodeHtml(cacheKey: string): string | null {
  return highlightedCodeHtmlCache.get(cacheKey);
}

export function setCachedHighlightedCodeHtml(cacheKey: string, html: string, code: string): void {
  highlightedCodeHtmlCache.set(cacheKey, html, estimateHighlightedHtmlSize(html, code));
}

export function getCodeHighlighterPromise(
  language: string,
  themeName: DiffsThemeNames,
): Promise<DiffsHighlighter> {
  const normalizedLanguage = normalizeCodeHighlightLanguage(language);
  const cacheKey = `${normalizedLanguage}\u0000${themeName}`;
  const cached = highlighterPromiseCache.get(cacheKey);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [themeName],
    langs: [normalizedLanguage as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(cacheKey);
    if (normalizedLanguage === "text") {
      throw err;
    }
    return getCodeHighlighterPromise("text", themeName);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  return promise;
}

export function highlightCodeToHtml(input: {
  highlighter: DiffsHighlighter;
  code: string;
  language: string;
  themeName: DiffsThemeNames;
}): string {
  const language = normalizeCodeHighlightLanguage(input.language);
  try {
    return input.highlighter.codeToHtml(input.code, {
      lang: language as SupportedLanguages,
      theme: input.themeName,
    });
  } catch (error) {
    console.warn(
      `Code highlighting failed for language "${language}", falling back to plain text.`,
      error instanceof Error ? error.message : error,
    );
    return input.highlighter.codeToHtml(input.code, { lang: "text", theme: input.themeName });
  }
}
