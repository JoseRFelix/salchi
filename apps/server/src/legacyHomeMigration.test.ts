import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { LEGACY_HOME_MIGRATION_MARKER, migrateLegacyT3Home } from "./legacyHomeMigration.ts";
import type { LegacyHomeMigrationProgress } from "./legacyHomeMigrationProgress.ts";

it.layer(NodeServices.layer)("legacy home migration", (it) => {
  it.effect("copies ~/.t3 to ~/.salchi once and retains the legacy home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-legacy-home-migration-",
      });
      const legacyHome = path.join(homeDirectory, ".t3");
      const salchiHome = path.join(homeDirectory, ".salchi");
      const legacySettings = path.join(legacyHome, "userdata", "settings.json");
      const migratedSettings = path.join(salchiHome, "userdata", "settings.json");
      const progress: Array<LegacyHomeMigrationProgress> = [];

      yield* fs.makeDirectory(path.dirname(legacySettings), { recursive: true });
      yield* fs.chmod(legacyHome, 0o700);
      yield* fs.writeFileString(legacySettings, "legacy settings");

      const result = yield* migrateLegacyT3Home(salchiHome, {
        homeDirectory,
        onProgress: (event) => progress.push(event),
      });

      assert.equal(result.status, "migrated");
      expect(yield* fs.readFileString(migratedSettings)).toBe("legacy settings");
      expect(yield* fs.readFileString(legacySettings)).toBe("legacy settings");
      expect(Number((yield* fs.stat(salchiHome)).mode) & 0o777).toBe(0o700);
      expect(yield* fs.exists(path.join(salchiHome, LEGACY_HOME_MIGRATION_MARKER))).toBe(true);
      expect(progress[0]).toEqual({ phase: "scanning", source: "legacy" });
      expect(progress).toContainEqual({
        phase: "copying",
        source: "legacy",
        completedFiles: 1,
        totalFiles: 1,
        currentPath: path.join("userdata", "settings.json"),
      });
      expect(progress.at(-2)).toEqual({
        phase: "finalizing",
        completedFiles: 1,
        totalFiles: 1,
      });
      expect(progress.at(-1)).toEqual({ phase: "complete", totalFiles: 1 });

      yield* fs.writeFileString(legacySettings, "changed after migration");
      const repeatedResult = yield* migrateLegacyT3Home(salchiHome, { homeDirectory });

      assert.equal(repeatedResult.status, "already-complete");
      expect(yield* fs.readFileString(migratedSettings)).toBe("legacy settings");
    }),
  );

  it.effect("lets legacy files win conflicts and backs up an existing Salchi home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-existing-home-migration-",
      });
      const legacyHome = path.join(homeDirectory, ".t3");
      const salchiHome = path.join(homeDirectory, ".salchi");
      const relativeConflict = path.join("userdata", "state.sqlite");
      const relativeLegacyOnly = path.join("userdata", "legacy-only.txt");
      const relativeSalchiOnly = path.join("caches", "salchi-only.txt");

      yield* fs.makeDirectory(path.join(legacyHome, "userdata"), { recursive: true });
      yield* fs.makeDirectory(path.join(salchiHome, "userdata"), { recursive: true });
      yield* fs.makeDirectory(path.join(salchiHome, "caches"), { recursive: true });
      yield* fs.writeFileString(path.join(legacyHome, relativeConflict), "legacy database");
      yield* fs.writeFileString(path.join(legacyHome, relativeLegacyOnly), "legacy only");
      yield* fs.writeFileString(path.join(salchiHome, relativeConflict), "new database");
      yield* fs.writeFileString(path.join(salchiHome, relativeSalchiOnly), "salchi only");

      const result = yield* migrateLegacyT3Home(salchiHome, { homeDirectory });

      assert.equal(result.status, "migrated");
      if (result.status !== "migrated") return;
      expect(result.previousSalchiHomeBackup).toBeDefined();
      expect(yield* fs.readFileString(path.join(salchiHome, relativeConflict))).toBe(
        "legacy database",
      );
      expect(yield* fs.readFileString(path.join(salchiHome, relativeLegacyOnly))).toBe(
        "legacy only",
      );
      expect(yield* fs.readFileString(path.join(salchiHome, relativeSalchiOnly))).toBe(
        "salchi only",
      );
      expect(
        yield* fs.readFileString(
          path.join(result.previousSalchiHomeBackup ?? "", relativeConflict),
        ),
      ).toBe("new database");
      expect(yield* fs.readFileString(path.join(legacyHome, relativeConflict))).toBe(
        "legacy database",
      );
    }),
  );

  it.effect("marks a native Salchi home so a later ~/.t3 does not replace it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-native-home-migration-",
      });
      const legacyHome = path.join(homeDirectory, ".t3");
      const salchiHome = path.join(homeDirectory, ".salchi");

      const result = yield* migrateLegacyT3Home(salchiHome, { homeDirectory });
      assert.equal(result.status, "initialized-without-legacy-home");

      yield* fs.makeDirectory(legacyHome, { recursive: true });
      yield* fs.writeFileString(path.join(legacyHome, "late.txt"), "late legacy data");

      const repeatedResult = yield* migrateLegacyT3Home(salchiHome, { homeDirectory });
      assert.equal(repeatedResult.status, "already-complete");
      expect(yield* fs.exists(path.join(salchiHome, "late.txt"))).toBe(false);
    }),
  );

  it.effect("does not migrate into an explicitly selected custom home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-custom-home-migration-",
      });
      const legacyHome = path.join(homeDirectory, ".t3");
      const customHome = path.join(homeDirectory, "custom-salchi");
      yield* fs.makeDirectory(legacyHome, { recursive: true });
      yield* fs.writeFileString(path.join(legacyHome, "legacy.txt"), "legacy data");

      const result = yield* migrateLegacyT3Home(customHome, { homeDirectory });

      assert.equal(result.status, "skipped-custom-home");
      expect(yield* fs.exists(customHome)).toBe(false);
      expect(yield* fs.readFileString(path.join(legacyHome, "legacy.txt"))).toBe("legacy data");
    }),
  );
});
