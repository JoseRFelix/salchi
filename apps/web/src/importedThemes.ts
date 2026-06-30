import type { ImportedTheme as ContractImportedTheme, ThemeImportResult } from "@t3tools/contracts";

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
  readonly tokenColors?: ContractImportedTheme["tokenColors"];
}

export interface ImportedThemeReference {
  readonly id: string;
  readonly label: string;
  readonly type: ResolvedThemeType;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
}

const STORAGE_KEY = "t3code:colorTheme:imported";

let listeners: Array<() => void> = [];
let snapshot: ReadonlyArray<ImportedThemeRecord> | null = null;

function hasStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isImportedThemeRecord(value: unknown): value is ImportedThemeRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.type === "light" || value.type === "dark") &&
    typeof value.namespace === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    isStringRecord(value.colors) &&
    (value.tokenColors === undefined || Array.isArray(value.tokenColors))
  );
}

function readAll(): Record<string, ImportedThemeRecord> {
  if (!hasStorage()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const valid: Record<string, ImportedThemeRecord> = {};
    for (const value of Object.values(parsed)) {
      if (isImportedThemeRecord(value)) valid[value.id] = value;
    }
    return valid;
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
  if (!listeners.includes(listener)) listeners.push(listener);
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

export function importedThemeRecordToReference(
  record: ImportedThemeRecord,
): ImportedThemeReference {
  return {
    id: record.id,
    label: record.label,
    type: record.type,
    namespace: record.namespace,
    name: record.name,
    version: record.version,
  };
}

export function importedThemeRecordsFromImportResult(
  result: ThemeImportResult,
): ImportedThemeRecord[] {
  return result.themes.map((theme) => ({
    id: theme.id,
    label: theme.label,
    type: theme.type,
    namespace: result.namespace,
    name: result.name,
    version: result.version,
    colors: theme.colors,
    ...(theme.tokenColors === undefined ? {} : { tokenColors: theme.tokenColors }),
  }));
}
