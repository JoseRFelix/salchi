import type { ThemeRegistration } from "@pierre/diffs";
import {
  THEME_PREVIEW_COLOR_KEYS,
  THEME_PREVIEW_SWATCH_COLOR_KEYS,
  THEME_PREVIEW_TOKEN_SCOPES,
  scoreThemePreviewScopeMatch,
} from "@t3tools/shared/themePreview";

import { resolveThemeType, type ResolvedThemeType } from "./themeMapping";

type ThemePreviewInput = Pick<ThemeRegistration, "colors" | "type"> & {
  readonly tokenColors?: readonly TokenColorRule[];
};

interface TokenColorRule {
  readonly scope?: string | readonly string[] | undefined;
  readonly settings?:
    | {
        readonly foreground?: string | undefined;
      }
    | undefined;
}

export interface ThemePreviewPalette {
  readonly background: string;
  readonly foreground: string;
  readonly chrome: string;
  readonly chromeForeground: string;
  readonly panel: string;
  readonly tabActive: string;
  readonly tabInactive: string;
  readonly border: string;
  readonly accent: string;
  readonly muted: string;
  readonly activityBar: string;
  readonly activityBarForeground: string;
  readonly statusBar: string;
  readonly statusForeground: string;
  readonly added: string;
  readonly removed: string;
}

export interface ThemePreviewSyntax {
  readonly plain: string;
  readonly keyword: string;
  readonly string: string;
  readonly function: string;
  readonly variable: string;
  readonly property: string;
  readonly number: string;
  readonly comment: string;
  readonly operator: string;
  readonly punctuation: string;
}

export interface ThemePreviewData {
  readonly type: ResolvedThemeType;
  readonly palette: ThemePreviewPalette;
  readonly syntax: ThemePreviewSyntax;
  readonly swatches: readonly string[];
}

const LIGHT_FALLBACKS: ThemePreviewPalette = {
  background: "#ffffff",
  foreground: "#24292f",
  chrome: "#f6f8fa",
  chromeForeground: "#57606a",
  panel: "#ffffff",
  tabActive: "#ffffff",
  tabInactive: "#f6f8fa",
  border: "#d0d7de",
  accent: "#0969da",
  muted: "#6e7781",
  activityBar: "#f6f8fa",
  activityBarForeground: "#57606a",
  statusBar: "#f6f8fa",
  statusForeground: "#57606a",
  added: "#1a7f37",
  removed: "#cf222e",
};

const DARK_FALLBACKS: ThemePreviewPalette = {
  background: "#24292e",
  foreground: "#d1d5da",
  chrome: "#1f2428",
  chromeForeground: "#adbac7",
  panel: "#24292e",
  tabActive: "#24292e",
  tabInactive: "#1f2428",
  border: "#444d56",
  accent: "#f78166",
  muted: "#768390",
  activityBar: "#1f2428",
  activityBarForeground: "#adbac7",
  statusBar: "#1f2428",
  statusForeground: "#adbac7",
  added: "#3fb950",
  removed: "#f85149",
};

const DEFAULT_APP_PREVIEW_PALETTES: Record<ResolvedThemeType, ThemePreviewPalette> = {
  light: {
    background: "#ffffff",
    foreground: "#262626",
    chrome: "#ffffff",
    chromeForeground: "#525252",
    panel: "#ffffff",
    tabActive: "#ffffff",
    tabInactive: "rgba(0, 0, 0, 0.04)",
    border: "rgba(0, 0, 0, 0.08)",
    accent: "oklch(0.488 0.217 264)",
    muted: "#525252",
    activityBar: "#ffffff",
    activityBarForeground: "#525252",
    statusBar: "oklch(0.488 0.217 264)",
    statusForeground: "#ffffff",
    added: "#1a7f37",
    removed: "#cf222e",
  },
  dark: {
    background: "#141414",
    foreground: "#f5f5f5",
    chrome: "#141414",
    chromeForeground: "#a3a3a3",
    panel: "#161616",
    tabActive: "#161616",
    tabInactive: "rgba(255, 255, 255, 0.04)",
    border: "rgba(255, 255, 255, 0.06)",
    accent: "oklch(0.588 0.217 264)",
    muted: "#a3a3a3",
    activityBar: "#161616",
    activityBarForeground: "#a3a3a3",
    statusBar: "oklch(0.588 0.217 264)",
    statusForeground: "#ffffff",
    added: "#3fb950",
    removed: "#f85149",
  },
};

const FALLBACK_SYNTAX_BY_TYPE: Record<ResolvedThemeType, ThemePreviewSyntax> = {
  light: {
    plain: LIGHT_FALLBACKS.foreground,
    keyword: "#cf222e",
    string: "#0a3069",
    function: "#8250df",
    variable: "#953800",
    property: "#0550ae",
    number: "#0550ae",
    comment: LIGHT_FALLBACKS.muted,
    operator: "#cf222e",
    punctuation: LIGHT_FALLBACKS.foreground,
  },
  dark: {
    plain: DARK_FALLBACKS.foreground,
    keyword: "#ff7b72",
    string: "#a5d6ff",
    function: "#d2a8ff",
    variable: "#ffa657",
    property: "#79c0ff",
    number: "#79c0ff",
    comment: DARK_FALLBACKS.muted,
    operator: "#ff7b72",
    punctuation: DARK_FALLBACKS.foreground,
  },
};

function fallbackPalette(type: ResolvedThemeType): ThemePreviewPalette {
  return type === "light" ? LIGHT_FALLBACKS : DARK_FALLBACKS;
}

function normalizeColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "transparent" || trimmed === "#0000" || trimmed === "#00000000") return undefined;
  return trimmed;
}

function firstColor(
  colors: Readonly<Record<string, string>>,
  keys: readonly string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = normalizeColor(colors[key]);
    if (value) return value;
  }
  return fallback;
}

function parseRuleScopes(scope: string | readonly string[] | undefined): readonly string[] {
  if (!scope) return [];
  const rawScopes = typeof scope === "string" ? scope.split(",") : scope;
  return rawScopes.map((value) => value.trim()).filter(Boolean);
}

function tokenColor(
  rules: readonly TokenColorRule[] | undefined,
  requestedScopes: readonly string[],
): string | undefined {
  if (!rules) return undefined;

  // Pick the rule that best applies to the requested scopes by TextMate-like
  // precedence (exact > ancestor > shallowest descendant) instead of the first
  // loose match. A loose "last match wins" pass would let an unrelated narrow
  // sub-scope (e.g. `keyword.operator.quantifier.regexp`) hijack a generic kind
  // like `keyword`, so the preview painted colors the real highlighter never
  // uses. Ties prefer the earlier (more representative) requested scope, then a
  // later rule in the array (TextMate's last-wins on equal specificity).
  let best: { score: number; requestedIndex: number; ruleIndex: number; color: string } | undefined;

  rules.forEach((rule, ruleIndex) => {
    const foreground = normalizeColor(rule?.settings?.foreground);
    if (!foreground) return;

    for (const ruleScope of parseRuleScopes(rule?.scope)) {
      requestedScopes.forEach((requestedScope, requestedIndex) => {
        const score = scoreThemePreviewScopeMatch(ruleScope, requestedScope);
        if (score === null) return;
        if (
          best === undefined ||
          score > best.score ||
          (score === best.score && requestedIndex < best.requestedIndex) ||
          (score === best.score &&
            requestedIndex === best.requestedIndex &&
            ruleIndex > best.ruleIndex)
        ) {
          best = { score, requestedIndex, ruleIndex, color: foreground };
        }
      });
    }
  });

  return best?.color;
}

function previewPalette(theme: ThemePreviewInput, type: ResolvedThemeType): ThemePreviewPalette {
  const colors = (theme.colors ?? {}) as Readonly<Record<string, string>>;
  const fallback = fallbackPalette(type);
  return {
    background: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.background, fallback.background),
    foreground: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.foreground, fallback.foreground),
    chrome: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.chrome, fallback.chrome),
    chromeForeground: firstColor(
      colors,
      THEME_PREVIEW_COLOR_KEYS.chromeForeground,
      fallback.chromeForeground,
    ),
    panel: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.panel, fallback.panel),
    tabActive: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.tabActive, fallback.tabActive),
    tabInactive: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.tabInactive, fallback.tabInactive),
    border: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.border, fallback.border),
    accent: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.accent, fallback.accent),
    muted: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.muted, fallback.muted),
    activityBar: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.activityBar, fallback.activityBar),
    activityBarForeground: firstColor(
      colors,
      THEME_PREVIEW_COLOR_KEYS.activityBarForeground,
      fallback.activityBarForeground,
    ),
    statusBar: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.statusBar, fallback.statusBar),
    statusForeground: firstColor(
      colors,
      THEME_PREVIEW_COLOR_KEYS.statusForeground,
      fallback.statusForeground,
    ),
    added: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.added, fallback.added),
    removed: firstColor(colors, THEME_PREVIEW_COLOR_KEYS.removed, fallback.removed),
  };
}

function previewSyntax(theme: ThemePreviewInput, palette: ThemePreviewPalette): ThemePreviewSyntax {
  const type = resolveThemeType(theme);
  const fallbacks = FALLBACK_SYNTAX_BY_TYPE[type];
  const rules = theme.tokenColors;

  return {
    plain: palette.foreground,
    keyword: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.keyword) ?? fallbacks.keyword,
    string: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.string) ?? fallbacks.string,
    function: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.function) ?? fallbacks.function,
    variable: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.variable) ?? fallbacks.variable,
    property: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.property) ?? fallbacks.property,
    number: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.number) ?? fallbacks.number,
    comment: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.comment) ?? palette.muted,
    operator: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.operator) ?? fallbacks.operator,
    punctuation: tokenColor(rules, THEME_PREVIEW_TOKEN_SCOPES.punctuation) ?? palette.foreground,
  };
}

function previewSwatches(
  theme: ThemePreviewInput,
  palette: ThemePreviewPalette,
): readonly string[] {
  const colors = (theme.colors ?? {}) as Readonly<Record<string, string>>;
  const candidates = [
    palette.background,
    palette.chrome,
    palette.panel,
    palette.accent,
    ...THEME_PREVIEW_SWATCH_COLOR_KEYS.map((key) => colors[key]),
    palette.foreground,
  ];

  const swatches: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const color = normalizeColor(candidate);
    if (!color) continue;
    const key = color.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    swatches.push(color);
    if (swatches.length >= 8) break;
  }

  return swatches;
}

export function createFallbackThemePreview(type: ResolvedThemeType): ThemePreviewData {
  const palette = fallbackPalette(type);
  return {
    type,
    palette,
    syntax: FALLBACK_SYNTAX_BY_TYPE[type],
    swatches: previewSwatches({ colors: {}, type }, palette),
  };
}

export function createDefaultThemePreview(type: ResolvedThemeType): ThemePreviewData {
  const palette = DEFAULT_APP_PREVIEW_PALETTES[type];
  const fallback = createFallbackThemePreview(type);

  return {
    type,
    palette,
    syntax: fallback.syntax,
    swatches: previewSwatches({ colors: {}, type }, palette),
  };
}

export function createThemePreview(theme: ThemePreviewInput): ThemePreviewData {
  const type = resolveThemeType(theme);
  const palette = previewPalette(theme, type);
  return {
    type,
    palette,
    syntax: previewSyntax(theme, palette),
    swatches: previewSwatches(theme, palette),
  };
}
