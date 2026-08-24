// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import path from "node:path";

import type { ThreadId } from "@salchi/contracts";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

export const DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const DEFAULT_PROVIDER_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_PROVIDER_LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PROVIDER_LOG_MAX_FILES_PER_THREAD = 2;
export const DEFAULT_PROVIDER_LOG_MAX_RECORD_BYTES = 64 * 1024;
export const DEFAULT_PROVIDER_LOG_MAX_STRING_BYTES = 16 * 1024;

const MANAGED_PROVIDER_LOG_NAME = /^[a-z0-9_-]{1,160}\.log(?:\.\d+)?(?:\.tmp)?$/i;
const LEGACY_MIGRATION_ARTIFACT_NAME = /^\.salchi-(?:t3-migration|before-t3-migration)-.+$/;

export interface ProviderLogRetentionPolicy {
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly now?: number;
}

export interface ProviderLogPruneResult {
  readonly scannedFiles: number;
  readonly deletedFiles: number;
  readonly deletedBytes: number;
  readonly remainingBytes: number;
  readonly errors: number;
}

interface ProviderLogFile {
  readonly directory: string;
  readonly name: string;
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function isRealDirectory(directory: string): boolean {
  try {
    return fs.lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function resolveNestedRealDirectory(
  root: string,
  segments: ReadonlyArray<string>,
): string | undefined {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!isRealDirectory(current)) return undefined;
  }
  return current;
}

/**
 * Finds only known provider-log directories inside legacy migration staging
 * and pre-migration backup siblings. The surrounding trees are preserved unless
 * separate ownership proof permits migration cleanup.
 */
export function findLegacyMigrationProviderLogDirectories(
  homeDirectory: string,
): ReadonlyArray<string> {
  const resolvedHome = path.resolve(homeDirectory);
  if (!isRealDirectory(resolvedHome)) return [];

  let entries: Array<string>;
  try {
    entries = fs.readdirSync(resolvedHome);
  } catch {
    return [];
  }

  const providerDirectories: Array<string> = [];
  for (const entry of entries.toSorted()) {
    if (path.basename(entry) !== entry || !LEGACY_MIGRATION_ARTIFACT_NAME.test(entry)) continue;
    const stagingDirectory = path.join(resolvedHome, entry);
    if (!isRealDirectory(stagingDirectory)) continue;

    for (const stateDirectory of ["userdata", "dev"]) {
      const providerDirectory = resolveNestedRealDirectory(stagingDirectory, [
        stateDirectory,
        "logs",
        "provider",
      ]);
      if (providerDirectory) providerDirectories.push(providerDirectory);
    }
  }
  return providerDirectories;
}

function tightenPrivateMode(
  targetPath: string,
  mode: number,
  expected: "directory" | "file",
): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(targetPath);
    if (
      (expected === "directory" && !before.isDirectory()) ||
      (expected === "file" && !before.isFile())
    ) {
      return;
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const directoryOnly = expected === "directory" ? (fs.constants.O_DIRECTORY ?? 0) : 0;
    descriptor = fs.openSync(targetPath, fs.constants.O_RDONLY | noFollow | directoryOnly);
    const opened = fs.fstatSync(descriptor);
    if (
      (expected === "directory" && opened.isDirectory()) ||
      (expected === "file" && opened.isFile())
    ) {
      fs.fchmodSync(descriptor, mode);
    }
  } catch {
    // Permissions are best-effort and must not prevent retention.
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best-effort permission tightening must not prevent retention.
      }
    }
  }
}

function listManagedProviderLogFiles(directories: ReadonlyArray<string>): {
  readonly files: Array<ProviderLogFile>;
  readonly errors: number;
} {
  const files: Array<ProviderLogFile> = [];
  let errors = 0;
  const uniqueDirectories = [...new Set(directories.map((directory) => path.resolve(directory)))];

  for (const directory of uniqueDirectories) {
    if (!isRealDirectory(directory)) {
      continue;
    }
    tightenPrivateMode(directory, 0o700, "directory");

    let names: Array<string>;
    try {
      names = fs.readdirSync(directory);
    } catch {
      errors += 1;
      continue;
    }

    for (const name of names) {
      if (
        path.basename(name) !== name ||
        name === "." ||
        name === ".." ||
        !MANAGED_PROVIDER_LOG_NAME.test(name)
      ) {
        continue;
      }

      const filePath = path.join(directory, name);
      try {
        // lstat is intentional: provider directories and entries must never be
        // followed through symlinks during retention cleanup.
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile()) {
          continue;
        }
        tightenPrivateMode(filePath, 0o600, "file");
        files.push({ directory, name, filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A writer may rotate or remove a file between readdir and lstat.
        errors += 1;
      }
    }
  }

  return { files, errors };
}

function deleteManagedFile(file: ProviderLogFile): boolean {
  const expectedPath = path.join(file.directory, file.name);
  if (path.resolve(expectedPath) !== path.resolve(file.filePath)) {
    return false;
  }

  try {
    // unlink removes a raced symlink itself and never follows it to its target.
    fs.unlinkSync(expectedPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies one deterministic age and byte budget across explicitly supplied,
 * exact provider-log directories. It never recurses and never follows symlinks.
 */
export function pruneProviderLogDirectories(
  directories: ReadonlyArray<string>,
  policy: ProviderLogRetentionPolicy,
): ProviderLogPruneResult {
  // This filesystem-only utility also runs outside Effect during sink flushes.
  // @effect-diagnostics-next-line globalDate:off
  const now = policy.now ?? Date.now();
  const maxAgeMs = Math.max(0, policy.maxAgeMs);
  const maxTotalBytes = Math.max(0, policy.maxTotalBytes);
  const cutoff = now - maxAgeMs;
  const listed = listManagedProviderLogFiles(directories);
  const retained: Array<ProviderLogFile> = [];
  let deletedFiles = 0;
  let deletedBytes = 0;
  let errors = listed.errors;

  for (const file of listed.files) {
    if (file.mtimeMs < cutoff) {
      if (deleteManagedFile(file)) {
        deletedFiles += 1;
        deletedBytes += file.size;
      } else {
        errors += 1;
        retained.push(file);
      }
    } else {
      retained.push(file);
    }
  }

  let remainingBytes = retained.reduce((total, file) => total + file.size, 0);
  const oldestFirst = retained.toSorted(
    (left, right) =>
      left.mtimeMs - right.mtimeMs ||
      left.directory.localeCompare(right.directory) ||
      left.name.localeCompare(right.name),
  );

  for (const file of oldestFirst) {
    if (remainingBytes <= maxTotalBytes) {
      break;
    }
    if (deleteManagedFile(file)) {
      deletedFiles += 1;
      deletedBytes += file.size;
      remainingBytes -= file.size;
    } else {
      errors += 1;
    }
  }

  return {
    scannedFiles: listed.files.length,
    deletedFiles,
    deletedBytes,
    remainingBytes,
    errors,
  };
}

export function pruneProviderLogs(
  providerLogsDir: string,
  policy: ProviderLogRetentionPolicy,
): ProviderLogPruneResult {
  return pruneProviderLogDirectories([providerLogsDir], policy);
}

/** Removes only the exact, sanitized log family belonging to one thread. */
export function deleteProviderLogsForThread(
  providerLogsDir: string,
  threadId: ThreadId,
): ProviderLogPruneResult {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (!segment || !isRealDirectory(path.resolve(providerLogsDir))) {
    return { scannedFiles: 0, deletedFiles: 0, deletedBytes: 0, remainingBytes: 0, errors: 0 };
  }

  const familyPattern = new RegExp(
    `^${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.log(?:\\.\\d+)?(?:\\.tmp)?$`,
  );
  const listed = listManagedProviderLogFiles([providerLogsDir]);
  let deletedFiles = 0;
  let deletedBytes = 0;
  let errors = listed.errors;
  let remainingBytes = 0;

  for (const file of listed.files) {
    if (!familyPattern.test(file.name)) {
      remainingBytes += file.size;
      continue;
    }
    if (deleteManagedFile(file)) {
      deletedFiles += 1;
      deletedBytes += file.size;
    } else {
      errors += 1;
      remainingBytes += file.size;
    }
  }

  return {
    scannedFiles: listed.files.length,
    deletedFiles,
    deletedBytes,
    remainingBytes,
    errors,
  };
}
