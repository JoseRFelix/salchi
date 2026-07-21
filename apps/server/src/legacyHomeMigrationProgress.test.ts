import { expect, it } from "@effect/vitest";

import {
  createLegacyHomeMigrationProgressReporter,
  formatLegacyHomeMigrationProgress,
} from "./legacyHomeMigrationProgress.ts";

it("formats copy progress with a bar, processed count, and remaining files", () => {
  const output = formatLegacyHomeMigrationProgress({
    phase: "copying",
    source: "legacy",
    completedFiles: 25,
    totalFiles: 100,
    currentPath: "userdata/sessions/session-25.json",
  });

  expect(output).toContain("25%");
  expect(output).toContain("25/100 files");
  expect(output).toContain("75 remaining");
  expect(output).toContain("copying T3 data");
  expect(output).toContain("userdata/sessions/session-25.json");
  expect(output).toContain("█");
});

it("renders in-place terminal progress and terminates the completed line", () => {
  const writes: Array<string> = [];
  const report = createLegacyHomeMigrationProgressReporter({
    isTTY: true,
    write: (text) => writes.push(text),
  });

  report({ phase: "scanning", source: "legacy" });
  report({
    phase: "copying",
    source: "legacy",
    completedFiles: 2,
    totalFiles: 2,
    currentPath: "settings.json",
  });
  report({ phase: "complete", totalFiles: 2 });

  expect(writes.join("")).toContain("\rMigrating T3 data: scanning ~/.t3");
  expect(writes.join("")).toContain("2/2 files");
  expect(writes.at(-1)).toBe("\n");
});

it("limits redirected copy output to progress milestones", () => {
  const writes: Array<string> = [];
  const report = createLegacyHomeMigrationProgressReporter({
    isTTY: false,
    write: (text) => writes.push(text),
  });

  for (let completedFiles = 1; completedFiles <= 100; completedFiles += 1) {
    report({
      phase: "copying",
      source: "legacy",
      completedFiles,
      totalFiles: 100,
      currentPath: `file-${String(completedFiles)}.json`,
    });
  }

  expect(writes.length).toBeLessThanOrEqual(12);
  expect(writes.join("")).toContain("100/100 files");
});
