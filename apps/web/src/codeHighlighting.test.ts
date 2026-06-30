import { describe, expect, it } from "vitest";

import {
  createCodeHighlightCacheKey,
  getCodeHighlighterPromise,
  normalizeCodeHighlightLanguage,
  resolveCodeHighlightLanguageFromFenceClass,
  resolveCodeHighlightLanguageFromPath,
} from "./codeHighlighting";

describe("codeHighlighting", () => {
  it("normalizes plain text and gitignore language aliases", () => {
    expect(normalizeCodeHighlightLanguage(undefined)).toBe("text");
    expect(normalizeCodeHighlightLanguage("plaintext")).toBe("text");
    expect(normalizeCodeHighlightLanguage("gitignore")).toBe("ini");
  });

  it("extracts markdown fence language classes", () => {
    expect(resolveCodeHighlightLanguageFromFenceClass("language-tsx")).toBe("tsx");
    expect(resolveCodeHighlightLanguageFromFenceClass("foo language-gitignore bar")).toBe("ini");
    expect(resolveCodeHighlightLanguageFromFenceClass(undefined)).toBe("text");
  });

  it("infers highlight language from file paths", () => {
    expect(resolveCodeHighlightLanguageFromPath("src/App.tsx")).toBe("tsx");
    expect(resolveCodeHighlightLanguageFromPath("package.json")).toBe("json");
    expect(resolveCodeHighlightLanguageFromPath(".gitignore")).toBe("ini");
  });

  it("includes scope, content, language, and theme in cache keys", () => {
    const base = createCodeHighlightCacheKey("const x = 1;", "ts", "pierre-dark", "preview");
    expect(base).toBe(createCodeHighlightCacheKey("const x = 1;", "ts", "pierre-dark", "preview"));
    expect(base).not.toBe(
      createCodeHighlightCacheKey("const y = 1;", "ts", "pierre-dark", "preview"),
    );
    expect(base).not.toBe(
      createCodeHighlightCacheKey("const x = 1;", "tsx", "pierre-dark", "preview"),
    );
    expect(base).not.toBe(
      createCodeHighlightCacheKey("const x = 1;", "ts", "pierre-light", "preview"),
    );
    expect(base).not.toBe(createCodeHighlightCacheKey("const x = 1;", "ts", "pierre-dark", "chat"));
  });

  it("caches highlighter promises by language and theme", async () => {
    const darkPromise = getCodeHighlighterPromise("text", "pierre-dark");
    expect(getCodeHighlighterPromise("text", "pierre-dark")).toBe(darkPromise);

    const lightPromise = getCodeHighlighterPromise("text", "pierre-light");
    expect(lightPromise).not.toBe(darkPromise);

    await Promise.all([darkPromise, lightPromise]);
  });
});
