import type { ThemeTokenColor } from "@t3tools/contracts";

export const THEME_PREVIEW_COLOR_KEYS = {
  background: ["editor.background"],
  foreground: ["editor.foreground", "foreground"],
  chrome: ["titleBar.activeBackground", "editorGroupHeader.tabsBackground", "sideBar.background"],
  chromeForeground: ["titleBar.activeForeground", "sideBar.foreground", "foreground"],
  panel: ["sideBar.background", "editor.background"],
  tabActive: ["tab.activeBackground", "editor.background"],
  tabInactive: ["tab.inactiveBackground", "editorGroupHeader.tabsBackground", "sideBar.background"],
  border: ["panel.border", "editorGroup.border", "tab.border", "sideBar.border"],
  accent: ["button.background", "focusBorder", "activityBarBadge.background"],
  muted: ["descriptionForeground", "input.placeholderForeground"],
  activityBar: ["activityBar.background", "sideBar.background"],
  activityBarForeground: ["activityBar.foreground", "sideBar.foreground", "foreground"],
  statusBar: [
    "statusBar.background",
    "titleBar.activeBackground",
    "editorGroupHeader.tabsBackground",
  ],
  statusForeground: ["statusBar.foreground", "titleBar.activeForeground", "foreground"],
} as const;

export const THEME_PREVIEW_SWATCH_COLOR_KEYS = [
  "charts.blue",
  "charts.green",
  "charts.yellow",
  "charts.red",
  "terminal.ansiBlue",
  "terminal.ansiGreen",
  "terminal.ansiYellow",
  "terminal.ansiRed",
] as const;

export const THEME_PREVIEW_TOKEN_SCOPES = {
  keyword: ["keyword", "storage", "storage.type", "storage.modifier"],
  string: ["string", "constant.character"],
  function: ["entity.name.function", "support.function", "meta.function-call"],
  variable: ["variable", "variable.other", "variable.parameter"],
  property: ["variable.other.property", "support.type.property-name", "meta.object-literal.key"],
  number: ["constant.numeric", "constant.language"],
  comment: ["comment", "punctuation.definition.comment"],
  operator: ["keyword.operator", "punctuation.separator"],
  punctuation: ["punctuation", "meta.brace"],
} as const;

function normalizeColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "transparent" || trimmed === "#0000" || trimmed === "#00000000") {
    return undefined;
  }
  return trimmed;
}

function parseRuleScopes(scope: string | readonly string[] | undefined): readonly string[] {
  if (!scope) return [];
  const rawScopes = typeof scope === "string" ? scope.split(",") : scope;
  return rawScopes.map((value) => value.trim()).filter(Boolean);
}

export function themePreviewScopeMatches(ruleScope: string, requestedScope: string): boolean {
  return (
    ruleScope === requestedScope ||
    ruleScope.startsWith(`${requestedScope}.`) ||
    requestedScope.startsWith(`${ruleScope}.`)
  );
}

export function pruneThemePreviewColors(
  colors: Readonly<Record<string, string>>,
): Record<string, string> {
  const keys = new Set<string>();
  for (const candidates of Object.values(THEME_PREVIEW_COLOR_KEYS)) {
    for (const key of candidates) keys.add(key);
  }
  for (const key of THEME_PREVIEW_SWATCH_COLOR_KEYS) keys.add(key);

  const result: Record<string, string> = {};
  for (const key of keys) {
    const color = normalizeColor(colors[key]);
    if (color) result[key] = color;
  }
  return result;
}

export function pruneThemePreviewTokenColors(
  tokenColors: readonly ThemeTokenColor[],
): ThemeTokenColor[] {
  const requestedScopes = Object.values(THEME_PREVIEW_TOKEN_SCOPES).flat();
  return tokenColors.filter((rule) => {
    const foreground = normalizeColor(rule.settings.foreground);
    if (!foreground) return false;

    const ruleScopes = parseRuleScopes(rule.scope);
    return ruleScopes.some((ruleScope) =>
      requestedScopes.some((requestedScope) => themePreviewScopeMatches(ruleScope, requestedScope)),
    );
  });
}
