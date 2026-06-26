import type { ThemeRegistration } from "@pierre/diffs";

/**
 * Maps a VS Code / Shiki theme (`ThemeRegistration`) onto the app's semantic
 * design tokens (the CSS custom properties declared in `:root` in index.css).
 *
 * VS Code themes expose ~300 workbench color keys (`editor.background`,
 * `button.background`, ...). We pick a small, curated subset and resolve each
 * semantic token from an ordered fallback chain of workbench keys. Themes omit
 * many keys, so when none of the chain is present we derive a value with a CSS
 * `color-mix()` expression referencing already-resolved tokens — the same
 * technique `:root` already uses (e.g. `--border` as an alpha of the
 * foreground). Nothing here is hardcoded per-theme: every value comes from the
 * theme JSON or is derived from it.
 */

export type ResolvedThemeType = "light" | "dark";

export interface MappedTheme {
  /** CSS custom property name (including the leading `--`) -> value. */
  readonly tokens: Readonly<Record<string, string>>;
  readonly type: ResolvedThemeType;
}

interface DeriveContext {
  readonly type: ResolvedThemeType;
}

interface TokenSource {
  /** Workbench color keys tried in order; first present one wins. */
  readonly keys: readonly string[];
  /** Fallback when no key is present. Receives the resolved theme type. */
  readonly derive?: (ctx: DeriveContext) => string;
}

/**
 * Token -> workbench-key resolution table. Derivations reference other tokens
 * via `var(--token)`, which the browser resolves regardless of declaration
 * order, so the chains are free to point at one another.
 */
const TOKEN_SOURCES: Readonly<Record<string, TokenSource>> = {
  "--background": {
    keys: ["editor.background"],
    derive: ({ type }) => (type === "light" ? "#ffffff" : "#1e1e1e"),
  },
  "--foreground": {
    keys: ["editor.foreground", "foreground"],
    derive: ({ type }) => (type === "light" ? "#1f2937" : "#e5e7eb"),
  },
  "--card": {
    keys: ["editorWidget.background", "sideBar.background", "editor.background"],
    derive: () => "var(--background)",
  },
  "--card-foreground": {
    keys: ["editor.foreground", "foreground"],
    derive: () => "var(--foreground)",
  },
  "--popover": {
    keys: [
      "editorWidget.background",
      "dropdown.background",
      "menu.background",
      "editor.background",
    ],
    derive: () => "var(--background)",
  },
  "--popover-foreground": {
    keys: ["editorWidget.foreground", "menu.foreground", "foreground", "editor.foreground"],
    derive: () => "var(--foreground)",
  },
  "--primary": {
    keys: ["button.background", "focusBorder", "activityBarBadge.background"],
    derive: ({ type }) => (type === "light" ? "#2563eb" : "#3b82f6"),
  },
  "--primary-foreground": {
    keys: ["button.foreground"],
    derive: () => "#ffffff",
  },
  "--secondary": {
    keys: ["button.secondaryBackground"],
    derive: () => "color-mix(in srgb, var(--foreground) 6%, transparent)",
  },
  "--secondary-foreground": {
    keys: ["button.secondaryForeground", "foreground", "editor.foreground"],
    derive: () => "var(--foreground)",
  },
  "--muted": {
    keys: [],
    derive: () => "color-mix(in srgb, var(--foreground) 6%, transparent)",
  },
  "--muted-foreground": {
    keys: ["descriptionForeground", "input.placeholderForeground"],
    derive: () => "color-mix(in srgb, var(--foreground) 60%, var(--background))",
  },
  "--accent": {
    keys: ["list.activeSelectionBackground", "list.hoverBackground", "editor.selectionBackground"],
    derive: () => "color-mix(in srgb, var(--foreground) 8%, transparent)",
  },
  "--accent-foreground": {
    keys: ["list.activeSelectionForeground", "foreground", "editor.foreground"],
    derive: () => "var(--foreground)",
  },
  "--destructive": {
    keys: ["errorForeground", "editorError.foreground", "inputValidation.errorBorder"],
    derive: () => "#ef4444",
  },
  "--destructive-foreground": {
    keys: ["errorForeground", "editorError.foreground"],
    derive: () => "#ef4444",
  },
  "--border": {
    keys: ["panel.border", "editorGroup.border", "input.border"],
    derive: () => "color-mix(in srgb, var(--foreground) 12%, transparent)",
  },
  "--input": {
    keys: ["input.background", "dropdown.background"],
    derive: () => "color-mix(in srgb, var(--foreground) 12%, transparent)",
  },
  "--ring": {
    keys: ["focusBorder", "button.background"],
    derive: () => "var(--primary)",
  },
  "--info": {
    keys: ["editorInfo.foreground", "charts.blue", "notificationsInfoIcon.foreground"],
    derive: () => "#3b82f6",
  },
  "--info-foreground": {
    keys: ["editorInfo.foreground", "charts.blue"],
    derive: () => "var(--info)",
  },
  "--success": {
    keys: ["charts.green", "gitDecoration.addedResourceForeground", "terminal.ansiGreen"],
    derive: () => "#10b981",
  },
  "--success-foreground": {
    keys: ["charts.green", "gitDecoration.addedResourceForeground", "terminal.ansiGreen"],
    derive: () => "var(--success)",
  },
  "--warning": {
    keys: ["editorWarning.foreground", "charts.yellow", "list.warningForeground"],
    derive: () => "#f59e0b",
  },
  "--warning-foreground": {
    keys: ["editorWarning.foreground", "charts.yellow"],
    derive: () => "var(--warning)",
  },
};

/** Semantic token names this mapping produces (with leading `--`). */
export const MAPPED_TOKEN_NAMES = Object.freeze(Object.keys(TOKEN_SOURCES));

export function resolveThemeType(theme: Pick<ThemeRegistration, "type">): ResolvedThemeType {
  // Shiki types are "light" | "dark" | "css"; treat anything non-light as dark
  // since the app only has light/dark chrome surfaces.
  return theme.type === "light" ? "light" : "dark";
}

function firstPresent(
  colors: Readonly<Record<string, string>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = colors[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Resolve a VS Code theme into the app's semantic tokens. Missing workbench
 * keys fall back to a derived CSS expression so every token always has a value.
 */
export function mapThemeToTokens(theme: ThemeRegistration): MappedTheme {
  const colors = (theme.colors ?? {}) as Readonly<Record<string, string>>;
  const type = resolveThemeType(theme);
  const ctx: DeriveContext = { type };
  const tokens: Record<string, string> = {};

  for (const [token, source] of Object.entries(TOKEN_SOURCES)) {
    const value = firstPresent(colors, source.keys) ?? source.derive?.(ctx);
    if (value !== undefined) tokens[token] = value;
  }

  return { tokens, type };
}

/** Apply mapped tokens as inline custom properties on an element (usually `<html>`). */
export function applyThemeTokens(element: HTMLElement, mapped: MappedTheme): void {
  for (const [token, value] of Object.entries(mapped.tokens)) {
    element.style.setProperty(token, value);
  }
}

/** Remove any inline tokens this mapping may have set, reverting to `:root`/`.dark`. */
export function clearThemeTokens(element: HTMLElement): void {
  for (const token of MAPPED_TOKEN_NAMES) {
    element.style.removeProperty(token);
  }
}
