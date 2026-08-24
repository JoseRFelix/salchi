// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@salchi/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  deleteProviderLogsForThread,
  findLegacyMigrationProviderLogDirectories,
  pruneProviderLogDirectories,
  pruneProviderLogs,
} from "./ProviderLogRetention.ts";

function writeSizedFile(filePath: string, size: number, mtimeMs: number): void {
  fs.writeFileSync(filePath, "x".repeat(size));
  // Node's utimes API requires Date values; this is a filesystem boundary test.
  // @effect-diagnostics-next-line globalDate:off
  const modifiedAt = new Date(mtimeMs);
  fs.utimesSync(filePath, modifiedAt, modifiedAt);
}

describe("ProviderLogRetention", () => {
  it("applies TTL first and then one deterministic global byte budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-retention-"));
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    // @effect-diagnostics-next-line globalDate:off
    const now = Date.now();

    try {
      writeSizedFile(path.join(firstDir, "expired.log"), 40, now - 8_000);
      writeSizedFile(path.join(firstDir, "oldest.log"), 40, now - 3_000);
      writeSizedFile(path.join(secondDir, "middle.log.1"), 40, now - 2_000);
      writeSizedFile(path.join(secondDir, "newest.log"), 40, now - 1_000);
      writeSizedFile(path.join(firstDir, "unmanaged.txt"), 500, now - 20_000);

      const result = pruneProviderLogDirectories([firstDir, secondDir], {
        maxAgeMs: 5_000,
        maxTotalBytes: 70,
        now,
      });

      assert.equal(result.scannedFiles, 4);
      assert.equal(result.deletedFiles, 3);
      assert.equal(result.deletedBytes, 120);
      assert.equal(result.remainingBytes, 40);
      assert.equal(fs.existsSync(path.join(firstDir, "expired.log")), false);
      assert.equal(fs.existsSync(path.join(firstDir, "oldest.log")), false);
      assert.equal(fs.existsSync(path.join(secondDir, "middle.log.1")), false);
      assert.equal(fs.existsSync(path.join(secondDir, "newest.log")), true);
      assert.equal(fs.existsSync(path.join(firstDir, "unmanaged.txt")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never follows a provider directory or entry symlink", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-path-safety-"));
    const providerDir = path.join(root, "provider");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(providerDir);
    fs.mkdirSync(outsideDir);
    const outsideFile = path.join(outsideDir, "outside.log");
    fs.writeFileSync(outsideFile, "must remain");

    try {
      fs.symlinkSync(outsideFile, path.join(providerDir, "linked.log"));
      const result = pruneProviderLogs(providerDir, { maxAgeMs: 0, maxTotalBytes: 0 });
      assert.equal(result.scannedFiles, 0);
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "must remain");

      const linkedDirectory = path.join(root, "linked-provider");
      fs.symlinkSync(outsideDir, linkedDirectory, "dir");
      pruneProviderLogs(linkedDirectory, { maxAgeMs: 0, maxTotalBytes: 0 });
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "must remain");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes only the exact sanitized family for a thread", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-delete-"));
    try {
      for (const name of [
        "thread-one.log",
        "thread-one.log.1",
        "thread-one-other.log",
        "thread-two.log",
      ]) {
        fs.writeFileSync(path.join(root, name), name);
      }

      const result = deleteProviderLogsForThread(root, ThreadId.make("thread-one"));
      assert.equal(result.deletedFiles, 2);
      assert.equal(fs.existsSync(path.join(root, "thread-one.log")), false);
      assert.equal(fs.existsSync(path.join(root, "thread-one.log.1")), false);
      assert.equal(fs.existsSync(path.join(root, "thread-one-other.log")), true);
      assert.equal(fs.existsSync(path.join(root, "thread-two.log")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers only exact, real provider directories in legacy migration staging", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-staging-"));
    const realProviderDir = path.join(
      root,
      ".salchi-t3-migration-old",
      "userdata",
      "logs",
      "provider",
    );
    const backupProviderDir = path.join(
      root,
      ".salchi-before-t3-migration-old",
      "dev",
      "logs",
      "provider",
    );
    fs.mkdirSync(realProviderDir, { recursive: true });
    fs.mkdirSync(backupProviderDir, { recursive: true });
    fs.mkdirSync(path.join(root, "possible-backup", "userdata", "logs", "provider"), {
      recursive: true,
    });

    try {
      if (process.platform !== "win32") {
        const outside = path.join(root, "outside");
        fs.mkdirSync(path.join(outside, "logs", "provider"), { recursive: true });
        const staged = path.join(root, ".salchi-t3-migration-linked-child");
        fs.mkdirSync(staged);
        fs.symlinkSync(outside, path.join(staged, "userdata"), "dir");
        fs.symlinkSync(outside, path.join(root, ".salchi-t3-migration-linked"), "dir");
      }

      assert.deepEqual(findLegacyMigrationProviderLogDirectories(root), [
        backupProviderDir,
        realProviderDir,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
