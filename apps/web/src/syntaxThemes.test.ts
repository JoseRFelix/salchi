import { resolveThemes } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import type { ImportedThemeRecord } from "./importedThemes";
import {
  buildImportedSyntaxThemeName,
  buildImportedSyntaxThemeRegistration,
  resolveSelectedSyntaxTheme,
} from "./syntaxThemes";

function importedTheme(overrides: Partial<ImportedThemeRecord> = {}): ImportedThemeRecord {
  return {
    id: "test.theme/theme-one",
    label: "Theme One",
    type: "dark",
    namespace: "test.theme",
    name: "theme-one",
    version: "1.0.0",
    colors: {
      "editor.background": "#101010",
      "editor.foreground": "#f0f0f0",
    },
    tokenColors: [
      {
        scope: "keyword",
        settings: {
          foreground: "#ff0000",
        },
      },
    ],
    ...overrides,
  };
}

describe("syntaxThemes", () => {
  it("maps the default light and dark modes to Pierre themes", () => {
    expect(
      resolveSelectedSyntaxTheme({
        activeThemeId: "default",
        resolvedMode: "light",
      }),
    ).toMatchObject({
      themeName: "pierre-light",
      themeType: "light",
      sourceThemeId: "default",
    });
    expect(
      resolveSelectedSyntaxTheme({
        activeThemeId: "default",
        resolvedMode: "dark",
      }),
    ).toMatchObject({
      themeName: "pierre-dark",
      themeType: "dark",
      sourceThemeId: "default",
    });
  });

  it("uses bundled Shiki theme ids directly", () => {
    expect(
      resolveSelectedSyntaxTheme({
        activeThemeId: "github-dark-default",
        resolvedMode: "dark",
      }),
    ).toEqual({
      themeName: "github-dark-default",
      themeType: "dark",
      sourceThemeId: "github-dark-default",
      cacheKey: "bundled:github-dark-default",
    });
  });

  it("registers imported themes under a generated name that resolves through diffs", async () => {
    const record = importedTheme();
    const selected = resolveSelectedSyntaxTheme({
      activeThemeId: record.id,
      resolvedMode: "dark",
      importedTheme: record,
    });

    expect(selected.themeName).toMatch(/^t3code-imported-/);
    expect(selected.cacheKey).toBe(`imported:${selected.themeName}`);

    const [resolvedTheme] = await resolveThemes([selected.themeName]);
    expect(resolvedTheme).toMatchObject({
      name: selected.themeName,
      type: "dark",
    });
  });

  it("includes imported theme content and version in generated names", () => {
    const first = importedTheme();
    const changedColors = importedTheme({
      colors: {
        ...first.colors,
        "editor.foreground": "#00ff00",
      },
    });
    const changedVersion = importedTheme({ version: "1.0.1" });

    expect(buildImportedSyntaxThemeName(first)).not.toBe(
      buildImportedSyntaxThemeName(changedColors),
    );
    expect(buildImportedSyntaxThemeName(first)).not.toBe(
      buildImportedSyntaxThemeName(changedVersion),
    );
  });

  it("falls back when imported theme JSON is missing locally", () => {
    expect(
      resolveSelectedSyntaxTheme({
        activeThemeId: "missing.imported/theme",
        resolvedMode: "dark",
      }),
    ).toMatchObject({
      themeName: "pierre-dark",
      themeType: "dark",
      sourceThemeId: "default",
    });
  });

  it("preserves imported token color rules in the custom theme registration", () => {
    const record = importedTheme();
    const registration = buildImportedSyntaxThemeRegistration(record, "test-imported-theme");

    expect(registration).toMatchObject({
      name: "test-imported-theme",
      type: "dark",
      colors: record.colors,
      tokenColors: record.tokenColors,
    });
  });
});
