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
