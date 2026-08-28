import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  browserProfileRoot,
  deleteBrowserProfileDirectory,
  listOrphanedBrowserProfiles,
  liveBrowserRootThreadIds,
  type BrowserProfileDirectory,
} from "../browser/BrowserProfiles.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const BrowserProfileCliRuntimeLive = Layer.mergeAll(
  WorkspacePathsLive,
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

function formatProfile(profile: BrowserProfileDirectory): string {
  return profile.threadId === undefined
    ? `- ${profile.path} (invalid encoded thread id)`
    : `- ${profile.path} (thread ${profile.threadId})`;
}

function formatPruneOutput(
  profiles: ReadonlyArray<BrowserProfileDirectory>,
  confirmed: boolean,
): string {
  if (profiles.length === 0) return "No orphaned browser profiles found.";
  const heading = confirmed
    ? `Deleted ${String(profiles.length)} orphaned browser profile${profiles.length === 1 ? "" : "s"}:`
    : `Found ${String(profiles.length)} orphaned browser profile${profiles.length === 1 ? "" : "s"}:`;
  const confirmation = confirmed
    ? ""
    : "\nRun `salchi browser prune-profiles --confirm` to delete the listed profiles.";
  return `${heading}\n${profiles.map(formatProfile).join("\n")}${confirmation}`;
}

const pruneProfilesCommand = Command.make("prune-profiles", {
  ...projectLocationFlags,
  confirm: Flag.boolean("confirm").pipe(
    Flag.withDescription("Delete every listed orphaned browser profile."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("List browser profiles with no corresponding live root thread."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      yield* Effect.gen(function* () {
        const path = yield* Path.Path;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getCommandReadModel();
        const profiles = yield* listOrphanedBrowserProfiles({
          profileRoot: browserProfileRoot(config.baseDir, path),
          liveRootThreadIds: liveBrowserRootThreadIds(snapshot.threads),
        });
        if (flags.confirm) {
          yield* Effect.forEach(profiles, deleteBrowserProfileDirectory, { discard: true });
        }
        yield* Console.log(formatPruneOutput(profiles, flags.confirm));
      }).pipe(
        Effect.provide(
          BrowserProfileCliRuntimeLive.pipe(
            Layer.provide(Layer.succeed(ServerConfig, config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);

export const browserCommand = Command.make("browser").pipe(
  Command.withDescription("Manage server-owned browser data."),
  Command.withSubcommands([pruneProfilesCommand]),
);
