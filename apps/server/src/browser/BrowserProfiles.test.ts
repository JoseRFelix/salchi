import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@salchi/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vitest";

import {
  browserProfileDirectoryName,
  deleteBrowserProfileDirectory,
  deleteBrowserProfileForThread,
  listOrphanedBrowserProfiles,
} from "./BrowserProfiles.ts";

describe("browser profile lifecycle", () => {
  it.effect(
    "lists only profile directories without a live root thread and deletes explicitly",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "salchi-browser-profiles-",
        });
        const liveThreadId = ThreadId.make("live/thread");
        const orphanThreadId = ThreadId.make("deleted/thread");
        const livePath = path.join(profileRoot, browserProfileDirectoryName(liveThreadId));
        const orphanPath = path.join(profileRoot, browserProfileDirectoryName(orphanThreadId));
        const malformedPath = path.join(profileRoot, "%not-an-encoding");
        const ordinaryFile = path.join(profileRoot, "not-a-profile.txt");
        yield* Effect.all([
          fileSystem.makeDirectory(livePath),
          fileSystem.makeDirectory(orphanPath),
          fileSystem.makeDirectory(malformedPath),
          fileSystem.writeFileString(ordinaryFile, "leave me alone"),
        ]);

        const orphaned = yield* listOrphanedBrowserProfiles({
          profileRoot,
          liveRootThreadIds: new Set([liveThreadId]),
        });

        expect(orphaned.map((profile) => profile.path)).toEqual([orphanPath, malformedPath].sort());
        yield* Effect.forEach(orphaned, deleteBrowserProfileDirectory, { discard: true });
        expect(yield* fileSystem.exists(livePath)).toBe(true);
        expect(yield* fileSystem.exists(orphanPath)).toBe(false);
        expect(yield* fileSystem.exists(malformedPath)).toBe(false);
        expect(yield* fileSystem.exists(ordinaryFile)).toBe(true);

        yield* deleteBrowserProfileForThread({ profileRoot, threadId: liveThreadId });
        expect(yield* fileSystem.exists(livePath)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
