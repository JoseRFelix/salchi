import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  buildThemeSearchUrl,
  clearThemeImportCacheForTests,
  clearThemePreviewCacheForTests,
  extractTokenColors,
  getThemeImportCacheStats,
  getThemePreviewCacheStats,
  loadThemeDefinitionFromVsix,
  parseJsonc,
  readZipTextFile,
  setCachedThemeImportForTests,
  setCachedThemePreviewForTests,
} from "./openVsxProvider.ts";
import type { ThemeImportResult, ThemePreviewResult } from "@t3tools/contracts";

function makeZip(files: Readonly<Record<string, string>>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentsBuffer = Buffer.from(contents, "utf8");
    const compressed = deflateRawSync(contentsBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contentsBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contentsBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localFiles = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localFiles.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localFiles, centralDirectory, eocd]);
}

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("strips line and block comments", () => {
    const input = `{
      // a line comment
      "name": "Night Owl", /* inline */
      /* block
         comment */
      "type": "dark"
    }`;
    expect(parseJsonc(input)).toEqual({ name: "Night Owl", type: "dark" });
  });

  it("tolerates trailing commas", () => {
    expect(parseJsonc('{"colors":{"editor.background":"#000",},}')).toEqual({
      colors: { "editor.background": "#000" },
    });
  });

  it("preserves comment-like sequences inside strings", () => {
    const input = '{"url":"https://example.com//path","glob":"/* not a comment */"}';
    expect(parseJsonc(input)).toEqual({
      url: "https://example.com//path",
      glob: "/* not a comment */",
    });
  });

  it("handles escaped quotes within strings", () => {
    expect(parseJsonc('{"q":"a \\"quoted\\" word"}')).toEqual({ q: 'a "quoted" word' });
  });
});

describe("buildThemeSearchUrl", () => {
  it("builds a paginated category browse URL without a query", () => {
    const url = new URL(buildThemeSearchUrl({ size: 12, offset: 24 }));

    expect(url.searchParams.get("category")).toBe("Themes");
    expect(url.searchParams.get("size")).toBe("12");
    expect(url.searchParams.get("offset")).toBe("24");
    expect(url.searchParams.get("sortBy")).toBe("downloadCount");
    expect(url.searchParams.has("query")).toBe(false);
  });

  it("keeps query searches sorted by relevance", () => {
    const url = new URL(buildThemeSearchUrl({ query: "catppuccin", size: 8, offset: 16 }));

    expect(url.searchParams.get("query")).toBe("catppuccin");
    expect(url.searchParams.get("offset")).toBe("16");
    expect(url.searchParams.get("sortBy")).toBe("relevance");
  });
});

describe("extractTokenColors", () => {
  it("keeps foreground token rules and trims unsupported fields", () => {
    expect(
      extractTokenColors({
        tokenColors: [
          { scope: " keyword ", settings: { foreground: " #ff0000 ", fontStyle: "bold" } },
          {
            scope: [" string.quoted ", "", 42],
            settings: { foreground: "#00ff00" },
          },
          { scope: "comment", settings: { fontStyle: "italic" } },
          "invalid",
        ],
      }),
    ).toEqual([
      { scope: "keyword", settings: { foreground: "#ff0000" } },
      { scope: ["string.quoted"], settings: { foreground: "#00ff00" } },
    ]);
  });
});

describe("VSIX zip theme loading", () => {
  it("reads deflated files from a VSIX archive", () => {
    const vsix = makeZip({
      "extension/package.json": '{"name":"sample"}',
    });

    expect(readZipTextFile(vsix, "extension/package.json")).toBe('{"name":"sample"}');
  });

  it("loads theme colors and token colors through include chains", () => {
    const vsix = makeZip({
      "extension/themes/base.json": JSON.stringify({
        colors: {
          "editor.background": "#101010",
          "editor.foreground": "#dddddd",
          "button.background": "#336699",
        },
        tokenColors: [
          {
            scope: "keyword",
            settings: { foreground: "#ff0000" },
          },
        ],
      }),
      "extension/themes/theme.json": JSON.stringify({
        include: "./base.json",
        colors: {
          "button.background": "#4477aa",
        },
        tokenColors: [
          {
            scope: "string",
            settings: { foreground: "#00ff00" },
          },
        ],
      }),
    });

    expect(loadThemeDefinitionFromVsix(vsix, "./themes/theme.json")).toEqual({
      colors: {
        "editor.background": "#101010",
        "editor.foreground": "#dddddd",
        "button.background": "#4477aa",
      },
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#ff0000" } },
        { scope: "string", settings: { foreground: "#00ff00" } },
      ],
    });
  });
});

describe("theme import cache", () => {
  it("keeps at least 100 cached full themes while pruning old entries", () => {
    clearThemeImportCacheForTests();

    for (let index = 0; index < 300; index += 1) {
      const result = {
        namespace: "test",
        name: `theme-${index}`,
        version: "1.0.0",
        themes: [
          {
            id: `test.theme-${index}/Theme`,
            label: "Theme",
            type: "dark",
            colors: {
              "editor.background": "#000000",
              "editor.foreground": "#ffffff",
            },
          },
        ],
      } satisfies ThemeImportResult;
      setCachedThemeImportForTests(`test/theme-${index}/1.0.0`, result);
    }

    const stats = getThemeImportCacheStats();
    expect(stats.themeCount).toBeGreaterThanOrEqual(100);
    expect(stats.themeCount).toBeLessThanOrEqual(250);
    clearThemeImportCacheForTests();
  });
});

describe("theme preview cache", () => {
  it("keeps preview and full import cache entries independent", () => {
    clearThemeImportCacheForTests();
    clearThemePreviewCacheForTests();

    for (let index = 0; index < 1_200; index += 1) {
      const result = {
        namespace: "test",
        name: `preview-${index}`,
        version: "1.0.0",
        themes: [
          {
            id: `test.preview-${index}/Theme`,
            label: "Theme",
            type: "dark",
            colors: {
              "editor.background": "#000000",
              "editor.foreground": "#ffffff",
            },
          },
        ],
      } satisfies ThemePreviewResult;
      setCachedThemePreviewForTests(`test/preview-${index}/1.0.0`, result);
    }

    const previewStats = getThemePreviewCacheStats();
    const importStats = getThemeImportCacheStats();
    expect(previewStats.themeCount).toBeGreaterThanOrEqual(100);
    expect(previewStats.themeCount).toBeLessThanOrEqual(1_000);
    expect(importStats.themeCount).toBe(0);

    clearThemeImportCacheForTests();
    clearThemePreviewCacheForTests();
  });
});
