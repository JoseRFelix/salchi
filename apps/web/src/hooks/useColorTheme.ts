import { useCallback, useSyncExternalStore } from "react";

import {
  applyThemeTokens,
  clearThemeTokens,
  mapThemeToTokens,
  type MappedTheme,
  type ResolvedThemeType,
} from "../themeMapping";
import { loadBundledTheme } from "../themes";
import { getImportedTheme, subscribeImportedThemes } from "../importedThemes";
import { getResolvedMode, registerResolvedModeListener, syncBrowserChromeTheme } from "./useTheme";

/**
 * Color-theme layer: selects which VS Code/Shiki theme paints the app chrome,
 * independently of the light/dark *mode* (owned by useTheme, which toggles the
 * `.dark` class). A selection is a pair — one theme for light mode, one for
 * dark mode — so "system" auto-switching keeps working: the resolved mode picks
 * which theme of the pair is active.
 *
 * The sentinel id "default" means "use the built-in `:root` palette" (no inline
 * tokens), so existing users see no change until they opt in.
 *
 * Persistence (slice 1) is localStorage; slice 2 syncs the id pair through
 * server settings and caches imported theme JSON. The resolved token maps are
 * cached locally for flash-free boot.
 */

export const DEFAULT_THEME_SENTINEL = "default";

export interface ColorThemeSelection {
  readonly light: string;
  readonly dark: string;
}

export const DEFAULT_COLOR_THEME_SELECTION: ColorThemeSelection = {
  light: DEFAULT_THEME_SENTINEL,
  dark: DEFAULT_THEME_SENTINEL,
};

const SELECTION_STORAGE_KEY = "salchi:colorTheme";
// Bump the version suffix whenever the token derivation in themeMapping changes
// so already-cached resolutions don't pin users to the old mapping.
const TOKEN_CACHE_STORAGE_KEY = "salchi:colorTheme:tokens:v2";

function hasStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function rootElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const element = document.documentElement;
  return element.style ? element : null;
}

// --- selection persistence -------------------------------------------------

let selectionSnapshot: ColorThemeSelection | null = null;
let selectionListeners: Array<() => void> = [];

function readSelection(): ColorThemeSelection {
  if (!hasStorage()) return DEFAULT_COLOR_THEME_SELECTION;
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return DEFAULT_COLOR_THEME_SELECTION;
    const parsed = JSON.parse(raw) as Partial<ColorThemeSelection>;
    return {
      light: typeof parsed.light === "string" ? parsed.light : DEFAULT_THEME_SENTINEL,
      dark: typeof parsed.dark === "string" ? parsed.dark : DEFAULT_THEME_SENTINEL,
    };
  } catch {
    return DEFAULT_COLOR_THEME_SELECTION;
  }
}

function getSelectionSnapshot(): ColorThemeSelection {
  if (selectionSnapshot) return selectionSnapshot;
  selectionSnapshot = readSelection();
  return selectionSnapshot;
}

function emitSelectionChange() {
  selectionSnapshot = null;
  for (const listener of selectionListeners) listener();
}

// --- resolved token cache (for flash-free boot) ----------------------------

const memoryTokenCache = new Map<string, MappedTheme>();
const inflight = new Map<string, Promise<MappedTheme | null>>();

function readTokenCacheFromStorage(): Record<string, MappedTheme> {
  if (!hasStorage()) return {};
  try {
    const raw = localStorage.getItem(TOKEN_CACHE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, MappedTheme>) : {};
  } catch {
    return {};
  }
}

function persistTokenCacheEntry(id: string, mapped: MappedTheme) {
  if (!hasStorage()) return;
  try {
    const current = readTokenCacheFromStorage();
    current[id] = mapped;
    localStorage.setItem(TOKEN_CACHE_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Cache is best-effort; ignore quota/serialization failures.
  }
}

function getCachedTokens(id: string): MappedTheme | undefined {
  const fromMemory = memoryTokenCache.get(id);
  if (fromMemory) return fromMemory;
  const fromStorage = readTokenCacheFromStorage()[id];
  if (fromStorage) {
    memoryTokenCache.set(id, fromStorage);
    return fromStorage;
  }
  return undefined;
}

function clearResolvedTokenCache() {
  memoryTokenCache.clear();
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(TOKEN_CACHE_STORAGE_KEY);
  } catch {
    // Best-effort cache invalidation.
  }
}

/**
 * Resolve a theme id to a mappable `{ colors, type }`. Bundled themes load from
 * Shiki; imported (Open VSX) themes resolve from the local import cache.
 */
async function loadThemeRegistration(id: string) {
  const bundled = await loadBundledTheme(id);
  if (bundled) return bundled;
  const imported = getImportedTheme(id);
  if (imported) {
    return { name: id, type: imported.type, colors: { ...imported.colors } };
  }
  return null;
}

async function ensureMappedTheme(id: string): Promise<MappedTheme | null> {
  if (id === DEFAULT_THEME_SENTINEL) return null;
  const cached = memoryTokenCache.get(id);
  if (cached) return cached;

  const existing = inflight.get(id);
  if (existing) return existing;

  const promise = (async () => {
    const registration = await loadThemeRegistration(id);
    if (!registration) return null;
    const mapped = mapThemeToTokens(registration);
    memoryTokenCache.set(id, mapped);
    persistTokenCacheEntry(id, mapped);
    return mapped;
  })().finally(() => inflight.delete(id));

  inflight.set(id, promise);
  return promise;
}

// --- apply -----------------------------------------------------------------

function applyMappedOrDefault(id: string, mapped: MappedTheme | null) {
  const root = rootElement();
  if (!root) return;
  if (id === DEFAULT_THEME_SENTINEL || !mapped) {
    clearThemeTokens(root);
    return;
  }
  applyThemeTokens(root, mapped);
}

/**
 * Apply the active theme for a resolved mode. Synchronously applies cached
 * tokens (or clears for "default") to avoid a flash, then asynchronously loads
 * and refines if the theme has not been mapped yet.
 */
function applyForMode(mode: ResolvedThemeType) {
  const selection = getSelectionSnapshot();
  const id = selection[mode];

  applyMappedOrDefault(id, id === DEFAULT_THEME_SENTINEL ? null : (getCachedTokens(id) ?? null));

  if (id === DEFAULT_THEME_SENTINEL) {
    syncBrowserChromeTheme();
    return;
  }

  void ensureMappedTheme(id)
    .then((mapped) => {
      // Guard against a race: the active mode/selection may have changed while
      // the dynamic import was in flight.
      if (getResolvedMode() !== mode) return;
      if (getSelectionSnapshot()[mode] !== id) return;
      applyMappedOrDefault(id, mapped);
      syncBrowserChromeTheme();
    })
    .catch((cause) => {
      if (getResolvedMode() !== mode) return;
      if (getSelectionSnapshot()[mode] !== id) return;
      console.warn("Failed to apply color theme.", cause);
      applyMappedOrDefault(id, null);
      syncBrowserChromeTheme();
    });
}

let initialized = false;

/** Idempotently wire the color-theme layer to mode changes and apply on boot. */
export function initColorTheme() {
  if (initialized || typeof document === "undefined") return;
  initialized = true;
  registerResolvedModeListener((mode) => applyForMode(mode));
  subscribeImportedThemes(() => {
    clearResolvedTokenCache();
    applyForMode(getResolvedMode());
  });
  applyForMode(getResolvedMode());

  if (hasStorage()) {
    window.addEventListener("storage", (event) => {
      if (event.key === SELECTION_STORAGE_KEY) {
        emitSelectionChange();
        applyForMode(getResolvedMode());
      }
    });
  }
}

// Apply immediately on module load to minimize flash.
initColorTheme();

function writeSelection(next: ColorThemeSelection): boolean {
  if (!hasStorage()) return false;
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

function removeSelection(): boolean {
  if (!hasStorage()) return false;
  try {
    localStorage.removeItem(SELECTION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function setColorTheme(mode: ResolvedThemeType, id: string) {
  const next: ColorThemeSelection = { ...getSelectionSnapshot(), [mode]: id };
  if (!writeSelection(next)) return;
  emitSelectionChange();
  // Re-apply only when the change affects the currently active mode.
  if (getResolvedMode() === mode) applyForMode(mode);
}

/**
 * Apply a full selection without writing back to server settings — used to
 * reconcile a synced selection from another device into the local fast path.
 */
export function setColorThemeSelection(light: string, dark: string) {
  const current = getSelectionSnapshot();
  if (current.light === light && current.dark === dark) return;
  if (!writeSelection({ light, dark })) return;
  emitSelectionChange();
  applyForMode(getResolvedMode());
}

export function resetColorTheme() {
  if (!removeSelection()) return;
  emitSelectionChange();
  applyForMode(getResolvedMode());
}

export function isColorThemeCustomized(selection: ColorThemeSelection): boolean {
  return selection.light !== DEFAULT_THEME_SENTINEL || selection.dark !== DEFAULT_THEME_SENTINEL;
}

// --- hook ------------------------------------------------------------------

function subscribeSelection(listener: () => void): () => void {
  selectionListeners.push(listener);
  return () => {
    selectionListeners = selectionListeners.filter((l) => l !== listener);
  };
}

function subscribeMode(listener: () => void): () => void {
  return registerResolvedModeListener(() => listener());
}

function getServerMode(): ResolvedThemeType {
  return "light";
}

export function useColorTheme() {
  const selection = useSyncExternalStore(
    subscribeSelection,
    getSelectionSnapshot,
    () => DEFAULT_COLOR_THEME_SELECTION,
  );
  const resolvedMode = useSyncExternalStore(subscribeMode, getResolvedMode, getServerMode);

  const setThemeForMode = useCallback((mode: ResolvedThemeType, id: string) => {
    setColorTheme(mode, id);
  }, []);

  return {
    selection,
    resolvedMode,
    activeThemeId: selection[resolvedMode],
    setThemeForMode,
    reset: resetColorTheme,
  } as const;
}
