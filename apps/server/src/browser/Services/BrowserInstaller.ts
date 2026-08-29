import type {
  BrowserInstallProgress,
  BrowserInstallState,
  BrowserManagedVariant,
} from "@salchi/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class BrowserInstallerError extends Data.TaggedError("BrowserInstallerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BrowserInstallerShape {
  readonly install: (
    variant: BrowserManagedVariant,
  ) => Stream.Stream<BrowserInstallProgress, BrowserInstallerError>;
  readonly getInstallState: (variant: BrowserManagedVariant) => Effect.Effect<BrowserInstallState>;
  readonly getManagedExecutablePath: (
    variant: BrowserManagedVariant,
  ) => Effect.Effect<string | undefined>;
  readonly cancel: (variant: BrowserManagedVariant) => Effect.Effect<BrowserInstallState>;
}

export class BrowserInstaller extends Context.Service<BrowserInstaller, BrowserInstallerShape>()(
  "salchi/browser/Services/BrowserInstaller",
) {}
