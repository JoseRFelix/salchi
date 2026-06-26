import type { ThemeRegistration } from "@pierre/diffs";

import { BUNDLED_THEME_INFO, BUNDLED_THEME_LOADERS } from "./themesGenerated";
import type { ResolvedThemeType } from "./themeMapping";

/**
 * Registry of color themes the app can apply. A "theme" is a VS Code / Shiki
 * theme that drives both the editor highlighting and (via themeMapping) the app
 * chrome. Bundled themes ship with Shiki and are loaded on demand; imported
 * themes (Open VSX, slice 2) layer onto the same registry shape.
 *
 * The metadata + lazy loaders live in the generated `themesGenerated.ts`
 * (see scripts/generate-theme-registry.mjs) so we can list and group all themes
 * without pulling the full `shiki` package at runtime.
 */

export type ThemeSource = "bundled" | "imported";

export interface ThemeDescriptor {
  /** Stable id, also used as the Shiki highlighter theme name. */
  readonly id: string;
  readonly label: string;
  readonly type: ResolvedThemeType;
  readonly source: ThemeSource;
}

const BUNDLED_IDS = new Set(BUNDLED_THEME_INFO.map((info) => info.id));

/** All bundled themes, sorted by light/dark then label for stable picker UIs. */
export const BUNDLED_THEMES: ReadonlyArray<ThemeDescriptor> = BUNDLED_THEME_INFO.map(
  (info): ThemeDescriptor => ({ ...info, source: "bundled" }),
).sort((a, b) =>
  a.type === b.type ? a.label.localeCompare(b.label) : a.type === "light" ? -1 : 1,
);

/** Sensible defaults that match the current hand-authored light/dark palette. */
export const DEFAULT_LIGHT_THEME_ID = "github-light";
export const DEFAULT_DARK_THEME_ID = "github-dark-default";

function normalizeThemeModule(mod: { default: ThemeRegistration }): ThemeRegistration {
  // Shiki theme modules use `export default`, occasionally double-wrapped under
  // an interop `.default.default` depending on the bundler.
  const candidate = mod.default;
  return ((candidate as { default?: ThemeRegistration }).default ?? candidate) as ThemeRegistration;
}

/**
 * Load a bundled theme's `ThemeRegistration` JSON on demand. Returns `null` for
 * unknown ids (e.g. an imported id that is not bundled) so callers can fall
 * back to the imported-theme cache.
 */
export async function loadBundledTheme(id: string): Promise<ThemeRegistration | null> {
  const loader = BUNDLED_THEME_LOADERS[id];
  if (!loader) return null;
  return normalizeThemeModule(await loader());
}

export function isBundledThemeId(id: string): boolean {
  return BUNDLED_IDS.has(id);
}

export function findBundledTheme(id: string): ThemeDescriptor | undefined {
  return BUNDLED_THEMES.find((theme) => theme.id === id);
}
