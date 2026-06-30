import { describe, expect, it } from "vitest";

import {
  createDefaultThemePreview,
  createFallbackThemePreview,
  createThemePreview,
} from "./themePreview";

describe("theme preview", () => {
  it("uses workbench colors for preview chrome", () => {
    const preview = createThemePreview({
      type: "dark",
      colors: {
        "editor.background": "#101216",
        "editor.foreground": "#d7dde8",
        "sideBar.background": "#171a21",
        "activityBar.background": "#090b10",
        "activityBar.foreground": "#f5f7fb",
        "button.background": "#5b8cff",
        "panel.border": "#2a3140",
      },
    });

    expect(preview.palette.background).toBe("#101216");
    expect(preview.palette.foreground).toBe("#d7dde8");
    expect(preview.palette.panel).toBe("#171a21");
    expect(preview.palette.activityBar).toBe("#090b10");
    expect(preview.palette.activityBarForeground).toBe("#f5f7fb");
    expect(preview.palette.accent).toBe("#5b8cff");
    expect(preview.palette.border).toBe("#2a3140");
  });

  it("uses token colors for bundled-theme syntax previews", () => {
    const preview = createThemePreview({
      type: "dark",
      colors: {
        "editor.background": "#101216",
        "editor.foreground": "#d7dde8",
      },
      tokenColors: [
        {
          scope: ["keyword", "storage.type"],
          settings: { foreground: "#ff708a" },
        },
        {
          scope: "entity.name.function",
          settings: { foreground: "#b392ff" },
        },
        {
          scope: "comment.line",
          settings: { foreground: "#657085" },
        },
      ],
    });

    expect(preview.syntax.keyword).toBe("#ff708a");
    expect(preview.syntax.function).toBe("#b392ff");
    expect(preview.syntax.comment).toBe("#657085");
  });

  it("prefers an exact scope rule over an unrelated narrow sub-scope (Gitpod Dark)", () => {
    // Gitpod Dark colors `keyword`/`storage` with #569CD6 but also defines a
    // late, narrow `keyword.operator.quantifier.regexp` rule (#D7BA7D). The
    // preview must paint keywords the same blue the highlighter renders, not the
    // regexp mustard.
    const preview = createThemePreview({
      type: "dark",
      colors: {
        "editor.background": "#12100c",
        "editor.foreground": "#d4d4d4",
      },
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#569cd6" } },
        { scope: "storage", settings: { foreground: "#569cd6" } },
        { scope: "storage.type", settings: { foreground: "#569cd6" } },
        { scope: "keyword.operator.quantifier.regexp", settings: { foreground: "#d7ba7d" } },
      ],
    });

    expect(preview.syntax.keyword).toBe("#569cd6");
  });

  it("uses a narrow sub-scope only when no broader rule applies", () => {
    const preview = createThemePreview({
      type: "dark",
      colors: { "editor.background": "#101216", "editor.foreground": "#d7dde8" },
      tokenColors: [{ scope: "keyword.control.flow", settings: { foreground: "#ff708a" } }],
    });

    expect(preview.syntax.keyword).toBe("#ff708a");
  });

  it("falls back to UI-derived syntax colors when token colors are unavailable", () => {
    const preview = createThemePreview({
      type: "light",
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#23272f",
        descriptionForeground: "#697386",
      },
    });

    expect(preview.syntax.plain).toBe("#23272f");
    expect(preview.syntax.comment).toBe("#697386");
    expect(preview.syntax.keyword).not.toBe("");
  });

  it("creates a complete fallback preview without theme colors", () => {
    const preview = createFallbackThemePreview("dark");

    expect(preview.palette.background).toBeTruthy();
    expect(preview.syntax.keyword).toBeTruthy();
    expect(preview.swatches.length).toBeGreaterThan(0);
  });

  it("keeps default light and dark previews mode-specific", () => {
    const light = createDefaultThemePreview("light");
    const dark = createDefaultThemePreview("dark");

    expect(light.palette.background).toBe("#ffffff");
    expect(dark.palette.background).not.toBe(light.palette.background);
    expect(light.syntax.keyword).not.toBe(dark.syntax.keyword);
    expect(light.swatches.length).toBeGreaterThan(0);
    expect(dark.swatches.length).toBeGreaterThan(0);
  });
});
