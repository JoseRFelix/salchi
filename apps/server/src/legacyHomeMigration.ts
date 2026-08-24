import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import type {
  LegacyHomeMigrationProgress,
  LegacyHomeMigrationProgressListener,
  LegacyHomeMigrationSource,
} from "./legacyHomeMigrationProgress.ts";
import {
  DEFAULT_PROVIDER_LOG_MAX_AGE_MS,
  DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES,
  pruneProviderLogDirectories,
} from "./provider/ProviderLogRetention.ts";

export const LEGACY_T3_HOME_DIRECTORY = ".t3";
export const SALCHI_HOME_DIRECTORY = ".salchi";
export const LEGACY_HOME_MIGRATION_MARKER = ".t3-home-migration-complete";
export const LEGACY_HOME_STAGING_MARKER = ".salchi-owned-migration-staging";
export const LEGACY_HOME_STAGING_MARKER_CONTENT = "salchi-owned-t3-migration-staging-v1\n";

const ABANDONED_STAGING_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
const MIGRATION_STAGING_PREFIX = ".salchi-t3-migration-";

export type LegacyHomeMigrationResult =
  | { readonly status: "skipped-custom-home" }
  | { readonly status: "already-complete" }
  | { readonly status: "initialized-without-legacy-home" }
  | {
      readonly status: "migrated";
      readonly legacyHome: string;
      readonly salchiHome: string;
      readonly previousSalchiHomeBackup: string | undefined;
    };

export interface LegacyHomeMigrationOptions {
  readonly homeDirectory?: string;
  readonly onProgress?: LegacyHomeMigrationProgressListener;
  readonly abandonedStagingMinAgeMs?: number;
}

interface MigrationDirectory {
  readonly relativePath: string;
  readonly mode: number;
}

interface MigrationTree {
  readonly rootMode: number;
  readonly directories: ReadonlyArray<MigrationDirectory>;
  readonly files: ReadonlyArray<string>;
}

const notifyProgress = (
  listener: LegacyHomeMigrationProgressListener | undefined,
  progress: LegacyHomeMigrationProgress,
) =>
  Effect.sync(() => {
    try {
      listener?.(progress);
    } catch {
      // Presentation must never be able to make a durable migration fail.
    }
  });

const relativePathDepth = (relativePath: string): number => relativePath.split(/[/\\]/).length;

const scanMigrationTree = Effect.fn("legacyHomeMigration.scanTree")(function* (
  sourceRoot: string,
  source: LegacyHomeMigrationSource,
  onProgress: LegacyHomeMigrationProgressListener | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* notifyProgress(onProgress, { phase: "scanning", source });

  const rootInfo = yield* fs.stat(sourceRoot);
  const relativePaths = yield* fs.readDirectory(sourceRoot, { recursive: true });
  const entries = yield* Effect.forEach(
    relativePaths,
    (relativePath) =>
      Effect.gen(function* () {
        const sourcePath = path.join(sourceRoot, relativePath);
        const symbolicLink = yield* fs.readLink(sourcePath).pipe(
          Effect.match({
            onFailure: () => false,
            onSuccess: () => true,
          }),
        );
        if (symbolicLink) {
          return { relativePath, directory: false } as const;
        }

        const info = yield* fs.stat(sourcePath);
        return { relativePath, directory: info.type === "Directory", mode: info.mode } as const;
      }),
    { concurrency: 32 },
  );

  return {
    rootMode: rootInfo.mode,
    directories: entries
      .filter((entry) => entry.directory)
      .map((entry) => ({ relativePath: entry.relativePath, mode: entry.mode ?? 0o700 }))
      .toSorted(
        (left, right) =>
          relativePathDepth(left.relativePath) - relativePathDepth(right.relativePath),
      ),
    files: entries.filter((entry) => !entry.directory).map((entry) => entry.relativePath),
  } satisfies MigrationTree;
});

const isBlockedPath = (path: string, blockedPaths: ReadonlySet<string>): boolean => {
  for (const blockedPath of blockedPaths) {
    if (
      path === blockedPath ||
      path.startsWith(`${blockedPath}/`) ||
      path.startsWith(`${blockedPath}\\`)
    ) {
      return true;
    }
  }
  return false;
};

const copyMigrationTree = Effect.fn("legacyHomeMigration.copyTree")(function* (
  sourceRoot: string,
  destinationRoot: string,
  tree: MigrationTree,
  options: {
    readonly overwrite: boolean;
    readonly blockedPaths: ReadonlySet<string>;
    readonly onFileProcessed: (relativePath: string) => Effect.Effect<void>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blockedPaths = new Set(options.blockedPaths);

  const destinationRootExists = yield* fs.exists(destinationRoot);
  if (!destinationRootExists) {
    yield* fs.makeDirectory(destinationRoot, { recursive: true, mode: tree.rootMode });
  }
  if (options.overwrite || !destinationRootExists) {
    yield* fs.chmod(destinationRoot, tree.rootMode);
  }

  for (const directory of tree.directories) {
    const { relativePath } = directory;
    if (isBlockedPath(relativePath, blockedPaths)) {
      continue;
    }

    const destinationPath = path.join(destinationRoot, relativePath);
    if (yield* fs.exists(destinationPath)) {
      const destinationInfo = yield* fs.stat(destinationPath);
      if (destinationInfo.type !== "Directory") {
        blockedPaths.add(relativePath);
      }
      continue;
    }
    yield* fs.makeDirectory(destinationPath, { recursive: true, mode: directory.mode });
    yield* fs.chmod(destinationPath, directory.mode);
  }

  yield* Effect.forEach(
    tree.files,
    (relativePath) =>
      Effect.gen(function* () {
        if (!isBlockedPath(relativePath, blockedPaths)) {
          const sourcePath = path.join(sourceRoot, relativePath);
          const destinationPath = path.join(destinationRoot, relativePath);
          const destinationExists = yield* fs.exists(destinationPath);
          if (options.overwrite || !destinationExists) {
            yield* fs.copy(sourcePath, destinationPath, {
              overwrite: options.overwrite,
              preserveTimestamps: true,
            });
          }
        }
        yield* options.onFileProcessed(relativePath);
      }),
    { concurrency: 8, discard: true },
  );
});

const nextAvailableSiblingPath = Effect.fn("legacyHomeMigration.nextAvailableSiblingPath")(
  function* (homeDirectory: string, basename: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const seed = `${basename}-${String(process.pid)}-${String(now)}`;

    for (let suffix = 0; ; suffix += 1) {
      const candidate = path.join(homeDirectory, suffix === 0 ? seed : `${seed}-${String(suffix)}`);
      if (!(yield* fs.exists(candidate))) {
        return candidate;
      }
    }
  },
);

const writeMigrationMarker = Effect.fn("legacyHomeMigration.writeMarker")(function* (
  markerPath: string,
  message: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(markerPath, `${message}\n`);
});

const cleanupOwnedAbandonedStaging = Effect.fn("legacyHomeMigration.cleanupOwnedAbandonedStaging")(
  function* (homeDirectory: string, minAgeMs: number) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const entries = yield* fs.readDirectory(homeDirectory).pipe(Effect.orElseSucceed(() => []));

    for (const entry of entries.toSorted()) {
      if (!entry.startsWith(MIGRATION_STAGING_PREFIX) || path.basename(entry) !== entry) continue;
      const stagingPath = path.join(homeDirectory, entry);
      const stagingLink = yield* fs
        .readLink(stagingPath)
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      if (stagingLink) continue;
      const stagingInfo = yield* fs.stat(stagingPath).pipe(Effect.orElseSucceed(() => undefined));
      if (stagingInfo?.type !== "Directory") continue;

      const markerPath = path.join(stagingPath, LEGACY_HOME_STAGING_MARKER);
      const markerLink = yield* fs
        .readLink(markerPath)
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      if (markerLink) continue;
      const marker = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""));
      if (marker !== LEGACY_HOME_STAGING_MARKER_CONTENT) continue;
      const markerInfo = yield* fs.stat(markerPath).pipe(Effect.orElseSucceed(() => undefined));
      const modifiedAt = markerInfo
        ? Option.match(markerInfo.mtime, {
            onNone: () => now,
            onSome: (value) => value.getTime(),
          })
        : now;
      const effectiveMinAgeMs = Math.max(0, minAgeMs);
      if (effectiveMinAgeMs > 0 && now - modifiedAt < effectiveMinAgeMs) continue;

      yield* fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore);
    }
  },
);

function migrationExcludedPaths(path: Path.Path): ReadonlySet<string> {
  return new Set([
    "caches",
    "worktrees",
    "logs",
    path.join("userdata", "logs"),
    path.join("dev", "logs"),
  ]);
}

/**
 * Copies the legacy default `~/.t3` home into the default `~/.salchi` home.
 *
 * The source is intentionally retained so older T3 Code installations can
 * continue to use it. When a Salchi home already exists, legacy files win
 * conflicts, Salchi-only files are retained, and the previous Salchi tree is
 * kept as a sibling backup.
 */
export const migrateLegacyT3Home = Effect.fn("legacyHomeMigration.migrate")(function* (
  baseDir: string,
  options: LegacyHomeMigrationOptions = {},
): Effect.fn.Return<
  LegacyHomeMigrationResult,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
  const legacyHome = path.resolve(path.join(homeDirectory, LEGACY_T3_HOME_DIRECTORY));
  const salchiHome = path.resolve(path.join(homeDirectory, SALCHI_HOME_DIRECTORY));

  if (path.resolve(baseDir) !== salchiHome) {
    return { status: "skipped-custom-home" };
  }

  yield* cleanupOwnedAbandonedStaging(
    homeDirectory,
    options.abandonedStagingMinAgeMs ?? ABANDONED_STAGING_MIN_AGE_MS,
  );

  const markerPath = path.join(salchiHome, LEGACY_HOME_MIGRATION_MARKER);
  if (yield* fs.exists(markerPath)) {
    return { status: "already-complete" };
  }

  const legacyHomeExists = yield* fs.exists(legacyHome);
  if (!legacyHomeExists) {
    yield* fs.makeDirectory(salchiHome, { recursive: true });
    yield* writeMigrationMarker(
      markerPath,
      "Salchi initialized without a legacy ~/.t3 home to migrate.",
    );
    return { status: "initialized-without-legacy-home" };
  }

  yield* Effect.logInfo("Migrating legacy T3 Code home to Salchi", {
    legacyHome,
    salchiHome,
  });

  const salchiHomeExists = yield* fs.exists(salchiHome);
  yield* Effect.sync(() =>
    pruneProviderLogDirectories(
      [
        path.join(legacyHome, "userdata", "logs", "provider"),
        path.join(legacyHome, "dev", "logs", "provider"),
        path.join(salchiHome, "userdata", "logs", "provider"),
        path.join(salchiHome, "dev", "logs", "provider"),
      ],
      {
        maxTotalBytes: DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES,
        maxAgeMs: DEFAULT_PROVIDER_LOG_MAX_AGE_MS,
      },
    ),
  );
  const stagingPath = yield* nextAvailableSiblingPath(homeDirectory, ".salchi-t3-migration");
  const previousSalchiHomeBackup = salchiHomeExists
    ? yield* nextAvailableSiblingPath(homeDirectory, ".salchi-before-t3-migration")
    : undefined;

  let completedFiles = 0;
  let totalFiles = 0;

  const migration = Effect.gen(function* () {
    const legacyTree = yield* scanMigrationTree(legacyHome, "legacy", options.onProgress);
    const salchiTree = salchiHomeExists
      ? yield* scanMigrationTree(salchiHome, "salchi", options.onProgress)
      : undefined;
    totalFiles = legacyTree.files.length + (salchiTree?.files.length ?? 0);

    const recordFileProcessed = (source: LegacyHomeMigrationSource) => (relativePath: string) =>
      Effect.sync(() => {
        completedFiles += 1;
        try {
          options.onProgress?.({
            phase: "copying",
            source,
            completedFiles,
            totalFiles,
            currentPath: relativePath,
          });
        } catch {
          // Presentation must never be able to make a durable migration fail.
        }
      });

    const prepareStaging = Effect.gen(function* () {
      const excludedPaths = migrationExcludedPaths(path);
      yield* fs.makeDirectory(stagingPath, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(
        path.join(stagingPath, LEGACY_HOME_STAGING_MARKER),
        LEGACY_HOME_STAGING_MARKER_CONTENT,
      );
      yield* copyMigrationTree(legacyHome, stagingPath, legacyTree, {
        overwrite: true,
        blockedPaths: excludedPaths,
        onFileProcessed: recordFileProcessed("legacy"),
      });
      if (salchiTree !== undefined) {
        yield* copyMigrationTree(salchiHome, stagingPath, salchiTree, {
          overwrite: false,
          blockedPaths: new Set([...legacyTree.files, ...excludedPaths]),
          onFileProcessed: recordFileProcessed("salchi"),
        });
      }
      yield* writeMigrationMarker(
        path.join(stagingPath, LEGACY_HOME_MIGRATION_MARKER),
        `Copied from ${legacyHome}. The legacy home was retained.`,
      );
      yield* fs.remove(path.join(stagingPath, LEGACY_HOME_STAGING_MARKER), { force: true });
    }).pipe(
      Effect.tapError(() =>
        fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );

    yield* prepareStaging;
    yield* notifyProgress(options.onProgress, {
      phase: "finalizing",
      completedFiles,
      totalFiles,
    });

    if (previousSalchiHomeBackup !== undefined) {
      yield* fs.rename(salchiHome, previousSalchiHomeBackup);
      const swapExit = yield* Effect.exit(fs.rename(stagingPath, salchiHome));
      if (Exit.isFailure(swapExit)) {
        const restoreExit = yield* Effect.exit(fs.rename(previousSalchiHomeBackup, salchiHome));
        if (Exit.isFailure(restoreExit)) {
          yield* Effect.logError("Failed to restore the previous Salchi home after migration", {
            salchiHome,
            previousSalchiHomeBackup,
          });
        }
        return yield* Effect.failCause(swapExit.cause);
      }
    } else {
      yield* fs
        .rename(stagingPath, salchiHome)
        .pipe(
          Effect.tapError(() =>
            fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
    }

    yield* notifyProgress(options.onProgress, { phase: "complete", totalFiles });

    return {
      status: "migrated",
      legacyHome,
      salchiHome,
      previousSalchiHomeBackup,
    } as const;
  }).pipe(
    Effect.tapError(() =>
      notifyProgress(options.onProgress, {
        phase: "failed",
        completedFiles,
        totalFiles,
      }),
    ),
  );

  const result = yield* migration;

  yield* Effect.logInfo("Legacy T3 Code home migration completed", {
    legacyHome,
    salchiHome,
    previousSalchiHomeBackup,
  });

  return result;
});
