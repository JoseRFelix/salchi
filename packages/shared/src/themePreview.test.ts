import { describe, expect, it } from "vitest";

import { pruneThemePreviewColors, pruneThemePreviewTokenColors } from "./themePreview.ts";

describe("theme preview pruning", () => {
  it("keeps only colors used by preview rendering", () => {
    expect(
      pruneThemePreviewColors({
        "editor.background": "#101010",
        "editor.foreground": "#f0f0f0",
        "terminal.ansiBlue": "#5599ff",
        "diffEditor.insertedTextBackground": "#00ff0033",
      }),
    ).toEqual({
      "editor.background": "#101010",
      "editor.foreground": "#f0f0f0",
      "terminal.ansiBlue": "#5599ff",
    });
  });

  it("keeps only token colors that can affect preview syntax", () => {
    expect(
      pruneThemePreviewTokenColors([
        { scope: "keyword.control", settings: { foreground: "#ff0000" } },
        { scope: ["entity.name.function.ts", "invalid"], settings: { foreground: "#00ff00" } },
        { scope: "markup.heading", settings: { foreground: "#0000ff" } },
        { settings: { foreground: "#ffffff" } },
      ]),
    ).toEqual([
      { scope: "keyword.control", settings: { foreground: "#ff0000" } },
      { scope: ["entity.name.function.ts", "invalid"], settings: { foreground: "#00ff00" } },
    ]);
  });
});
