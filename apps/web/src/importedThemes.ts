import type { ResolvedThemeType } from "./themeMapping";

/**
 * Local store of themes imported from Open VSX. Per the hybrid persistence
 * model, the heavy color JSON lives here (localStorage), while the lightweight
 * id pair + import references sync via ClientSettings. When a synced selection
 * points at an imported id whose colors aren't cached on this device, the UI can
 * re-import from Open VSX using the synced reference.
 */

export interface ImportedThemeRecord {
  readonly id: string;
  readonly label: string;
  readonly type: ResolvedThemeType;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly colors: Readonly<Record<string, string>>;
}

const STORAGE_KEY = "t3code:colorTheme:imported";

let listeners: Array<() => void> = [];
let snapshot: ReadonlyArray<ImportedThemeRecord> | null = null;

function hasStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function readAll(): Record<string, ImportedThemeRecord> {
  if (!hasStorage()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ImportedThemeRecord>) : {};
  } catch {
    return {};
  }
}

function writeAll(records: Record<string, ImportedThemeRecord>) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Best-effort; ignore quota/serialization failures.
  }
}

function emitChange() {
  snapshot = null;
  for (const listener of listeners) listener();
}

export function getImportedTheme(id: string): ImportedThemeRecord | undefined {
  return readAll()[id];
}

export function listImportedThemes(): ReadonlyArray<ImportedThemeRecord> {
  if (snapshot) return snapshot;
  snapshot = Object.values(readAll()).sort((a, b) => a.label.localeCompare(b.label));
  return snapshot;
}

export function saveImportedThemes(records: ReadonlyArray<ImportedThemeRecord>) {
  if (records.length === 0) return;
  const all = readAll();
  for (const record of records) all[record.id] = record;
  writeAll(all);
  emitChange();
}

export function removeImportedTheme(id: string) {
  const all = readAll();
  if (!(id in all)) return;
  delete all[id];
  writeAll(all);
  emitChange();
}

export function subscribeImportedThemes(listener: () => void): () => void {
  listeners.push(listener);
  if (hasStorage()) {
    window.addEventListener("storage", onStorageEvent);
  }
  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0 && hasStorage()) {
      window.removeEventListener("storage", onStorageEvent);
    }
  };
}

function onStorageEvent(event: StorageEvent) {
  if (event.key === STORAGE_KEY) emitChange();
}

export function getImportedThemesSnapshot(): ReadonlyArray<ImportedThemeRecord> {
  return listImportedThemes();
}
