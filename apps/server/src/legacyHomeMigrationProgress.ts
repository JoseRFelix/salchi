export type LegacyHomeMigrationSource = "legacy" | "salchi";

export type LegacyHomeMigrationProgress =
  | {
      readonly phase: "scanning";
      readonly source: LegacyHomeMigrationSource;
    }
  | {
      readonly phase: "copying";
      readonly source: LegacyHomeMigrationSource;
      readonly completedFiles: number;
      readonly totalFiles: number;
      readonly currentPath: string;
    }
  | {
      readonly phase: "finalizing";
      readonly completedFiles: number;
      readonly totalFiles: number;
    }
  | {
      readonly phase: "complete";
      readonly totalFiles: number;
    }
  | {
      readonly phase: "failed";
      readonly completedFiles: number;
      readonly totalFiles: number;
    };

export type LegacyHomeMigrationProgressListener = (progress: LegacyHomeMigrationProgress) => void;

export interface LegacyHomeMigrationProgressOutput {
  readonly isTTY?: boolean;
  readonly write: (text: string) => unknown;
}

const progressBar = (completed: number, total: number, width = 24): string => {
  const ratio = total === 0 ? 1 : Math.min(1, Math.max(0, completed / total));
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
};

const abbreviatePath = (value: string, maxLength = 48): string =>
  value.length <= maxLength ? value : `…${value.slice(-(maxLength - 1))}`;

export const formatLegacyHomeMigrationProgress = (
  progress: LegacyHomeMigrationProgress,
): string => {
  switch (progress.phase) {
    case "scanning":
      return progress.source === "legacy"
        ? "Migrating T3 data: scanning ~/.t3…"
        : "Migrating T3 data: scanning existing ~/.salchi data…";
    case "copying": {
      const percent =
        progress.totalFiles === 0
          ? 100
          : Math.floor((progress.completedFiles / progress.totalFiles) * 100);
      const remaining = Math.max(0, progress.totalFiles - progress.completedFiles);
      const operation = progress.source === "legacy" ? "copying T3 data" : "merging Salchi data";
      return [
        `Migrating T3 data ${progressBar(progress.completedFiles, progress.totalFiles)}`,
        `${String(percent).padStart(3, " ")}%`,
        `${String(progress.completedFiles)}/${String(progress.totalFiles)} files`,
        `${String(remaining)} remaining`,
        operation,
        abbreviatePath(progress.currentPath),
      ].join(" • ");
    }
    case "finalizing":
      return `Migrating T3 data: finalizing ${String(progress.completedFiles)}/${String(progress.totalFiles)} files…`;
    case "complete":
      return `Migrating T3 data: complete • ${String(progress.totalFiles)} files processed.`;
    case "failed":
      return `Migrating T3 data: failed after ${String(progress.completedFiles)}/${String(progress.totalFiles)} files.`;
  }
};

const shouldAlwaysRender = (progress: LegacyHomeMigrationProgress): boolean =>
  progress.phase !== "copying" || progress.completedFiles === progress.totalFiles;

/**
 * Writes an in-place progress bar for terminals and sparse milestone lines for
 * redirected output. The callback is intentionally synchronous so migration
 * progress cannot outlive or reorder the file operation it describes.
 */
export const createLegacyHomeMigrationProgressReporter = (
  output: LegacyHomeMigrationProgressOutput = process.stderr,
): LegacyHomeMigrationProgressListener => {
  let lastLineLength = 0;
  let lastTtyCompletedFiles = -1;
  let lastNonTtyBucket = -1;
  let lastPhase: LegacyHomeMigrationProgress["phase"] | undefined;

  return (progress) => {
    if (output.isTTY) {
      if (progress.phase === "copying" && !shouldAlwaysRender(progress)) {
        const updateInterval = Math.max(1, Math.ceil(progress.totalFiles / 200));
        if (progress.completedFiles - lastTtyCompletedFiles < updateInterval) {
          return;
        }
        lastTtyCompletedFiles = progress.completedFiles;
      }

      const line = formatLegacyHomeMigrationProgress(progress);
      output.write(`\r${line.padEnd(lastLineLength, " ")}`);
      lastLineLength = line.length;
      if (progress.phase === "complete" || progress.phase === "failed") {
        output.write("\n");
        lastLineLength = 0;
      }
      return;
    }

    const bucket =
      progress.phase === "copying" && progress.totalFiles > 0
        ? Math.floor((progress.completedFiles / progress.totalFiles) * 10)
        : -1;
    if (
      progress.phase === lastPhase &&
      progress.phase === "copying" &&
      bucket === lastNonTtyBucket &&
      !shouldAlwaysRender(progress)
    ) {
      return;
    }

    output.write(`${formatLegacyHomeMigrationProgress(progress)}\n`);
    lastPhase = progress.phase;
    lastNonTtyBucket = bucket;
  };
};
