import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SELECTION_STORAGE_KEY = "t3code:colorTheme";

function createStyleStub(): CSSStyleDeclaration {
  return {
    removeProperty: vi.fn(),
    setProperty: vi.fn(),
  } as unknown as CSSStyleDeclaration;
}

function stubDom(storage: Storage) {
  const matchMedia = vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    matchMedia,
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
        toggle: vi.fn(),
      },
      offsetHeight: 0,
      style: createStyleStub(),
    },
  });
}

function createThrowingStorage(): Storage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("storage blocked");
    },
    removeItem: () => {
      throw new Error("storage blocked");
    },
    clear: vi.fn(),
    key: () => null,
    get length() {
      return 0;
    },
  };
}

function createSelectionStorage(selection: unknown): Storage {
  return {
    getItem: (key) => (key === SELECTION_STORAGE_KEY ? JSON.stringify(selection) : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: () => null,
    get length() {
      return 1;
    },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useColorTheme", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../themes");
    vi.doUnmock("../importedThemes");
    vi.doUnmock("./useTheme");
  });

  it("treats selection persistence as best effort", async () => {
    stubDom(createThrowingStorage());
    const { resetColorTheme, setColorTheme, setColorThemeSelection } =
      await import("./useColorTheme");

    expect(() => setColorTheme("light", "github-dark-default")).not.toThrow();
    expect(() =>
      setColorThemeSelection("github-light-default", "github-dark-default"),
    ).not.toThrow();
    expect(() => resetColorTheme()).not.toThrow();
  });

  it("handles rejected theme resolution without an unhandled rejection", async () => {
    const syncBrowserChromeTheme = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubDom(createSelectionStorage({ light: "broken-theme", dark: "default" }));
    vi.doMock("../themes", () => ({
      loadBundledTheme: vi.fn(async () => {
        throw new Error("theme load failed");
      }),
    }));
    vi.doMock("../importedThemes", () => ({
      getImportedTheme: vi.fn(() => undefined),
      subscribeImportedThemes: vi.fn(() => () => undefined),
    }));
    vi.doMock("./useTheme", () => ({
      getResolvedMode: vi.fn(() => "light"),
      registerResolvedModeListener: vi.fn(() => () => undefined),
      syncBrowserChromeTheme,
    }));

    await import("./useColorTheme");
    await flushPromises();

    expect(consoleWarn).toHaveBeenCalledWith("Failed to apply color theme.", expect.any(Error));
    expect(syncBrowserChromeTheme).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
