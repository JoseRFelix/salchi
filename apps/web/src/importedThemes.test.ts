import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "t3code:colorTheme:imported";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function stubStorage(storage = createStorage()) {
  const storageListeners = new Set<(event: StorageEvent) => void>();
  const testWindow = {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "storage" && typeof listener === "function") {
        storageListeners.add(listener as (event: StorageEvent) => void);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "storage" && typeof listener === "function") {
        storageListeners.delete(listener as (event: StorageEvent) => void);
      }
    }),
  };
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", storage);
  return { storage, storageListeners };
}

describe("importedThemes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filters malformed persisted records before returning imported themes", async () => {
    const { storage } = stubStorage();
    const validRecord = {
      id: "sample.publisher/Sample",
      label: "Sample",
      type: "dark",
      namespace: "sample",
      name: "publisher",
      version: "1.0.0",
      colors: {
        "editor.background": "#101010",
      },
    };
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        valid: validRecord,
        invalidColors: {
          ...validRecord,
          id: "invalid.colors",
          colors: null,
        },
        invalidType: {
          ...validRecord,
          id: "invalid.type",
          type: "system",
        },
      }),
    );

    const { getImportedTheme, listImportedThemes } = await import("./importedThemes");

    expect(listImportedThemes()).toEqual([validRecord]);
    expect(getImportedTheme("invalid.colors")).toBeUndefined();
    expect(getImportedTheme("invalid.type")).toBeUndefined();
  });

  it("does not register the same imported-theme listener twice", async () => {
    const { storageListeners } = stubStorage();
    const { subscribeImportedThemes } = await import("./importedThemes");
    const listener = vi.fn();

    subscribeImportedThemes(listener);
    subscribeImportedThemes(listener);
    for (const storageListener of storageListeners) {
      storageListener({ key: STORAGE_KEY } as StorageEvent);
    }

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
