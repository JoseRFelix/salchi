import { registerCustomTheme, type DiffsThemeNames, type ThemeRegistration } from "@pierre/diffs";
import { useMemo, useSyncExternalStore } from "react";

import { DEFAULT_THEME_SENTINEL, useColorTheme } from "./hooks/useColorTheme";
import {
  getImportedThemesSnapshot,
  subscribeImportedThemes,
  type ImportedThemeRecord,
} from "./importedThemes";
import { fnv1a32, resolveDiffThemeName } from "./lib/diffRendering";
import type { ResolvedThemeType } from "./themeMapping";
import { findBundledTheme, isBundledThemeId } from "./themes";

export type SyntaxThemeName = DiffsThemeNames;

export interface SelectedSyntaxTheme {
  readonly themeName: SyntaxThemeName;
  readonly themeType: "light" | "dark";
  readonly sourceThemeId: string;
  readonly cacheKey: string;
}

const IMPORTED_SYNTAX_THEME_PREFIX = "salchi-imported";
const REGISTERED_IMPORTED_SYNTAX_THEME_NAMES_KEY = "__salchiRegisteredImportedSyntaxThemeNames";

type RegisteredSyntaxThemeGlobal = typeof globalThis & {
  [REGISTERED_IMPORTED_SYNTAX_THEME_NAMES_KEY]?: Set<string>;
};

const registeredImportedSyntaxThemeNames = (() => {
  const target = globalThis as RegisteredSyntaxThemeGlobal;
  target[REGISTERED_IMPORTED_SYNTAX_THEME_NAMES_KEY] ??= new Set<string>();
  return target[REGISTERED_IMPORTED_SYNTAX_THEME_NAMES_KEY];
})();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function cloneImportedThemeTokenColors(
  tokenColors: ImportedThemeRecord["tokenColors"],
): NonNullable<ImportedThemeRecord["tokenColors"]> | undefined {
  return tokenColors?.map((rule) => ({
    ...(rule.scope === undefined
      ? {}
      : { scope: Array.isArray(rule.scope) ? [...rule.scope] : rule.scope }),
    settings:
      rule.settings.foreground === undefined ? {} : { foreground: rule.settings.foreground },
  }));
}

export function buildImportedSyntaxThemeFingerprint(record: ImportedThemeRecord): string {
  const serialized = stableStringify({
    colors: record.colors,
    id: record.id,
    label: record.label,
    name: record.name,
    namespace: record.namespace,
    tokenColors: record.tokenColors ?? null,
    type: record.type,
    version: record.version,
  });
  const primary = fnv1a32(serialized).toString(36);
  const secondary = fnv1a32(`${serialized.length}:${serialized}`).toString(36);
  return `${primary}-${secondary}`;
}

export function buildImportedSyntaxThemeName(record: ImportedThemeRecord): SyntaxThemeName {
  return `${IMPORTED_SYNTAX_THEME_PREFIX}-${buildImportedSyntaxThemeFingerprint(record)}`;
}

export function buildImportedSyntaxThemeRegistration(
  record: ImportedThemeRecord,
  themeName: SyntaxThemeName = buildImportedSyntaxThemeName(record),
): ThemeRegistration {
  const tokenColors = cloneImportedThemeTokenColors(record.tokenColors);
  return {
    name: themeName,
    type: record.type,
    colors: { ...record.colors },
    ...(tokenColors === undefined ? {} : { tokenColors }),
  } as ThemeRegistration;
}

export function ensureImportedSyntaxThemeRegistered(
  record: ImportedThemeRecord,
  themeName: SyntaxThemeName = buildImportedSyntaxThemeName(record),
): SyntaxThemeName {
  if (!registeredImportedSyntaxThemeNames.has(themeName)) {
    const registration = buildImportedSyntaxThemeRegistration(record, themeName);
    registerCustomTheme(themeName, () => Promise.resolve(registration));
    registeredImportedSyntaxThemeNames.add(themeName);
  }
  return themeName;
}

export function resolveFallbackSyntaxTheme(mode: ResolvedThemeType): SelectedSyntaxTheme {
  const themeName = resolveDiffThemeName(mode);
  return {
    themeName,
    themeType: mode,
    sourceThemeId: DEFAULT_THEME_SENTINEL,
    cacheKey: `default:${mode}:${themeName}`,
  };
}

export function resolveSelectedSyntaxTheme(input: {
  readonly activeThemeId: string;
  readonly resolvedMode: ResolvedThemeType;
  readonly importedTheme?: ImportedThemeRecord | undefined;
}): SelectedSyntaxTheme {
  if (input.activeThemeId === DEFAULT_THEME_SENTINEL) {
    return resolveFallbackSyntaxTheme(input.resolvedMode);
  }

  if (isBundledThemeId(input.activeThemeId)) {
    const bundledTheme = findBundledTheme(input.activeThemeId);
    const themeType = bundledTheme?.type ?? input.resolvedMode;
    return {
      themeName: input.activeThemeId,
      themeType,
      sourceThemeId: input.activeThemeId,
      cacheKey: `bundled:${input.activeThemeId}`,
    };
  }

  if (input.importedTheme) {
    const themeName = ensureImportedSyntaxThemeRegistered(input.importedTheme);
    return {
      themeName,
      themeType: input.importedTheme.type,
      sourceThemeId: input.importedTheme.id,
      cacheKey: `imported:${themeName}`,
    };
  }

  return resolveFallbackSyntaxTheme(input.resolvedMode);
}

export function useSelectedSyntaxTheme(): SelectedSyntaxTheme {
  const { activeThemeId, resolvedMode } = useColorTheme();
  const importedThemes = useSyncExternalStore(
    subscribeImportedThemes,
    getImportedThemesSnapshot,
    () => [],
  );
  const importedTheme = useMemo(
    () => importedThemes.find((theme) => theme.id === activeThemeId),
    [activeThemeId, importedThemes],
  );
  return useMemo(
    () =>
      resolveSelectedSyntaxTheme({
        activeThemeId,
        resolvedMode,
        importedTheme,
      }),
    [activeThemeId, importedTheme, resolvedMode],
  );
}
