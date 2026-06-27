import { describe, expect, it } from "vitest";

import { MAPPED_TOKEN_NAMES, mapThemeToTokens, resolveThemeType } from "./themeMapping";

// Minimal fixtures shaped like Shiki/VS Code ThemeRegistration JSON. We keep
// them inline so the mapping stays unit-testable without loading any bundled
// theme module.
const nordLike = {
  name: "nord",
  type: "dark" as const,
  colors: {
    "editor.background": "#2e3440",
    "editor.foreground": "#d8dee9",
    "button.background": "#88c0d0ee",
    "button.foreground": "#2e3440",
    "list.activeSelectionBackground": "#88c0d0",
    focusBorder: "#3b4252",
    "sideBar.background": "#2e3440",
    "input.background": "#3b4252",
    "panel.border": "#3b4252",
    "editorError.foreground": "#bf616a",
  },
};

const githubLightLike = {
  name: "github-light",
  type: "light" as const,
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#24292e",
    "button.background": "#2ea44f",
  },
};

describe("mapThemeToTokens", () => {
  it("prefers explicit workbench keys over derivations", () => {
    const { tokens, type } = mapThemeToTokens(nordLike);
    expect(type).toBe("dark");
    expect(tokens["--background"]).toBe("#2e3440");
    expect(tokens["--foreground"]).toBe("#d8dee9");
    expect(tokens["--primary"]).toBe("#88c0d0ee");
    expect(tokens["--primary-foreground"]).toBe("#2e3440");
    expect(tokens["--accent"]).toBe("#88c0d0");
    expect(tokens["--border"]).toBe("#3b4252");
    // --input intentionally ignores input.background (themes often set it equal
    // to the editor background, hiding controls that fill with it) and always
    // derives a contrasting foreground overlay instead.
    expect(tokens["--input"]).toContain("color-mix");
    expect(tokens["--input"]).toContain("var(--foreground)");
    expect(tokens["--destructive"]).toBe("#bf616a");
  });

  it("falls back through the key chain (focusBorder -> --ring)", () => {
    const { tokens } = mapThemeToTokens(nordLike);
    // ring has no focusBorder-independent value, so it resolves focusBorder.
    expect(tokens["--ring"]).toBe("#3b4252");
  });

  it("derives missing tokens from resolved tokens via color-mix", () => {
    const { tokens } = mapThemeToTokens(githubLightLike);
    // No descriptionForeground / list selection / panel.border in the fixture.
    expect(tokens["--muted-foreground"]).toContain("color-mix");
    expect(tokens["--muted-foreground"]).toContain("var(--foreground)");
    expect(tokens["--accent"]).toContain("color-mix");
    expect(tokens["--border"]).toContain("color-mix");
    // ring with no focusBorder resolves button.background.
    expect(tokens["--ring"]).toBe("#2ea44f");
  });

  it("uses type-aware defaults when even the base keys are absent", () => {
    const empty = { name: "empty", type: "dark" as const, colors: {} };
    const { tokens } = mapThemeToTokens(empty);
    expect(tokens["--background"]).toBe("#1e1e1e");
    expect(tokens["--foreground"]).toBe("#e5e7eb");

    const emptyLight = { name: "empty-light", type: "light" as const, colors: {} };
    expect(mapThemeToTokens(emptyLight).tokens["--background"]).toBe("#ffffff");
  });

  it("always produces a value for every mapped token", () => {
    const { tokens } = mapThemeToTokens({ name: "x", type: "dark", colors: {} });
    for (const token of MAPPED_TOKEN_NAMES) {
      expect(tokens[token]).toBeTruthy();
    }
  });

  it("ignores blank workbench values and derives instead", () => {
    const blank = {
      name: "blank",
      type: "dark" as const,
      colors: { "editor.background": "  ", "editor.foreground": "#fff" },
    };
    const { tokens } = mapThemeToTokens(blank);
    expect(tokens["--background"]).toBe("#1e1e1e");
    expect(tokens["--foreground"]).toBe("#fff");
  });
});

describe("resolveThemeType", () => {
  it("treats only 'light' as light", () => {
    expect(resolveThemeType({ type: "light" })).toBe("light");
    expect(resolveThemeType({ type: "dark" })).toBe("dark");
    // Shiki also has a "css" variable type; anything non-light maps to dark.
    expect(resolveThemeType({ type: "css" as never })).toBe("dark");
  });
});
