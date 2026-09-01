import { ThreadId, type OrchestrationThread } from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isBrowserRootThread } from "./BrowserThreadRoot.ts";

export interface BrowserProfileDirectory {
  readonly directoryName: string;
  readonly path: string;
  readonly threadId: ThreadId | undefined;
}

export function browserProfileRoot(baseDir: string, path: Path.Path): string {
  return path.join(baseDir, "userdata", "browser-profiles");
}

export function browserProfileDirectoryName(threadId: ThreadId): string {
  return encodeURIComponent(threadId);
}

export function browserProfileThreadIdFromDirectory(
  profileDirectory: string,
): ThreadId | undefined {
  try {
    const decoded = decodeURIComponent(profileDirectory);
    return decoded.trim().length > 0 ? ThreadId.make(decoded) : undefined;
  } catch {
    return undefined;
  }
}

export function liveBrowserRootThreadIds(
  threads: ReadonlyArray<Pick<OrchestrationThread, "deletedAt" | "id" | "parentThreadId">>,
): ReadonlySet<string> {
  return new Set(
    threads
      .filter((thread) => thread.deletedAt === null && isBrowserRootThread(thread))
      .map((thread) => thread.id),
  );
}

export const listOrphanedBrowserProfiles = Effect.fn("browserProfiles.listOrphaned")(
  function* (input: {
    readonly profileRoot: string;
    readonly liveRootThreadIds: ReadonlySet<string>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(input.profileRoot, { recursive: true });
    const directoryNames = yield* fileSystem.readDirectory(input.profileRoot, { recursive: false });
    const profiles = yield* Effect.forEach(directoryNames, (directoryName) =>
      Effect.gen(function* () {
        const profilePath = path.join(input.profileRoot, directoryName);
        const info = yield* fileSystem.stat(profilePath);
        if (info.type !== "Directory" && info.type !== "SymbolicLink") return undefined;
        return {
          directoryName,
          path: profilePath,
          threadId: browserProfileThreadIdFromDirectory(directoryName),
        } satisfies BrowserProfileDirectory;
      }),
    );
    return profiles
      .filter((profile): profile is BrowserProfileDirectory => profile !== undefined)
      .filter(
        (profile) =>
          profile.threadId === undefined || !input.liveRootThreadIds.has(profile.threadId),
      )
      .toSorted((left, right) => left.directoryName.localeCompare(right.directoryName));
  },
);

export const deleteBrowserProfileDirectory = Effect.fn("browserProfiles.deleteDirectory")(
  function* (profile: BrowserProfileDirectory) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(profile.path, { recursive: true, force: true });
  },
);

export const deleteBrowserProfileForThread = Effect.fn("browserProfiles.deleteForThread")(
  function* (input: { readonly profileRoot: string; readonly threadId: ThreadId }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.remove(
      path.join(input.profileRoot, browserProfileDirectoryName(input.threadId)),
      { recursive: true, force: true },
    );
  },
);
