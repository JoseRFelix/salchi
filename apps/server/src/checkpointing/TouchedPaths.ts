import type { ProviderRuntimeEvent } from "@salchi/contracts";

import { parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

export const MAX_TOUCHED_PATHS_PER_EVENT = 50;

export type TouchedPathSnapshotKind = "edit-snapshot" | "path-only";

export interface ExtractedTouchedPath {
  readonly path: string;
  readonly snapshotKind: TouchedPathSnapshotKind;
}

const PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "notebook_path",
  "relativePath",
  "filename",
  "newPath",
  "oldPath",
] as const;

const NESTED_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
  "locations",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushPath(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized) || target.length >= MAX_TOUCHED_PATHS_PER_EVENT) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectTouchedPaths(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= MAX_TOUCHED_PATHS_PER_EVENT) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTouchedPaths(entry, target, seen, depth + 1);
      if (target.length >= MAX_TOUCHED_PATHS_PER_EVENT) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const key of PATH_KEYS) {
    pushPath(target, seen, record[key]);
  }

  for (const key of NESTED_KEYS) {
    if (!(key in record)) {
      continue;
    }
    collectTouchedPaths(record[key], target, seen, depth + 1);
    if (target.length >= MAX_TOUCHED_PATHS_PER_EVENT) {
      return;
    }
  }
}

function extractPathsFromValues(values: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    collectTouchedPaths(value, paths, seen, 0);
    if (paths.length >= MAX_TOUCHED_PATHS_PER_EVENT) {
      break;
    }
  }
  return paths;
}

function isFileChangeApprovalRequest(requestType: string): boolean {
  return requestType === "file_change_approval" || requestType === "apply_patch_approval";
}

export function extractTouchedPathsFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): ReadonlyArray<ExtractedTouchedPath> {
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.payload.itemType === "file_change"
  ) {
    return extractPathsFromValues([event.payload.data, event.payload]).map((pathValue) => ({
      path: pathValue,
      snapshotKind: "edit-snapshot" as const,
    }));
  }

  if (
    (event.type === "request.opened" || event.type === "request.resolved") &&
    isFileChangeApprovalRequest(event.payload.requestType)
  ) {
    const values =
      event.type === "request.opened"
        ? [event.payload.args, event.payload]
        : [event.payload.resolution, event.payload];
    return extractPathsFromValues(values).map((pathValue) => ({
      path: pathValue,
      snapshotKind: "edit-snapshot" as const,
    }));
  }

  if (event.type === "turn.diff.updated") {
    return parseTurnDiffFilesFromUnifiedDiff(event.payload.unifiedDiff)
      .slice(0, MAX_TOUCHED_PATHS_PER_EVENT)
      .map((file) => ({
        path: file.path,
        snapshotKind: "path-only" as const,
      }));
  }

  return [];
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

function relativeToWorkspace(absolutePath: string, cwd: string): string | null {
  const normalizedPath = normalizeSlashes(absolutePath);
  const normalizedCwd = normalizeSlashes(cwd).replace(/\/+$/, "");
  if (normalizedPath === normalizedCwd) {
    return "";
  }
  const cwdPrefix = `${normalizedCwd}/`;
  return normalizedPath.startsWith(cwdPrefix) ? normalizedPath.slice(cwdPrefix.length) : null;
}

function normalizePosixRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function normalizeTouchedPath(pathValue: string, cwd: string): string | null {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0 || trimmed.includes("\n") || trimmed.includes("\0")) {
    return null;
  }

  const relativePath = isAbsolutePath(trimmed) ? relativeToWorkspace(trimmed, cwd) : trimmed;
  if (relativePath === null) {
    return null;
  }
  const slashPath = normalizeSlashes(relativePath).replace(/^\.\/+/, "");
  const normalized = normalizePosixRelativePath(slashPath);
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  return normalized;
}
