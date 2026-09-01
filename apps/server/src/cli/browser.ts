import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import {
  browserProfileRoot,
  deleteBrowserProfileDirectory,
  listOrphanedBrowserProfiles,
  liveBrowserRootThreadIds,
  type BrowserProfileDirectory,
} from "../browser/BrowserProfiles.ts";
import { BrowserInstallerLive } from "../browser/Layers/BrowserInstaller.ts";
import { BrowserInstaller } from "../browser/Services/BrowserInstaller.ts";
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

function formatInstallProgress(input: {
  readonly phase: string;
  readonly percent: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
}): string {
  const bytes =
    input.totalBytes > 0
      ? ` (${(input.downloadedBytes / (1024 * 1024)).toFixed(1)} / ${(input.totalBytes / (1024 * 1024)).toFixed(1)} MB)`
      : "";
  return `${input.phase}: ${String(Math.round(input.percent))}%${bytes}`;
}

const installCommand = Command.make("install", {
  ...projectLocationFlags,
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Install without an interactive confirmation."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Install Salchi's managed Chromium browser."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      if (!flags.yes) {
        const confirmed = yield* Prompt.confirm({
          message: `Install Chromium into ${config.baseDir}/browsers?`,
          initial: false,
        });
        if (!confirmed) {
          yield* Console.log("Browser installation canceled.");
          return;
        }
      }
      yield* Effect.gen(function* () {
        const installer = yield* BrowserInstaller;
        const variant = "headless-shell" as const;
        const existing = yield* installer.getInstallState(variant);
        if (existing.status === "installed") {
          yield* Console.log(
            `Managed Chromium is already installed at ${existing.executablePath}.`,
          );
          return;
        }
        yield* Console.log("Installing managed Chromium…");
        yield* installer
          .install(variant)
          .pipe(Stream.runForEach((progress) => Console.log(formatInstallProgress(progress))));
        const installed = yield* installer.getInstallState(variant);
        yield* Console.log(
          installed.status === "installed"
            ? `Managed Chromium installed at ${installed.executablePath}.`
            : "Managed Chromium installation did not complete.",
        );
      }).pipe(
        Effect.provide(
          BrowserInstallerLive.pipe(
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
  Command.withSubcommands([installCommand, pruneProfilesCommand]),
);
