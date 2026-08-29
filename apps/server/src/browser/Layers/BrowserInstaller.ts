import {
  type BrowserInstallProgress,
  type BrowserInstallState,
  type BrowserManagedVariant,
} from "@salchi/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  MANAGED_BROWSER_MANIFESTS,
  MANAGED_BROWSER_NAMES,
  playwrightCliPath,
  resolvePlaywrightChromeExecutablePath,
  runBrowserInstallerProcess,
} from "../BrowserInstallerProcess.ts";
import {
  managedChromeInstallDisposition,
  readLinuxDistributionId,
} from "../BrowserManagedVariant.ts";
import {
  BrowserInstaller,
  BrowserInstallerError,
  type BrowserInstallerShape,
} from "../Services/BrowserInstaller.ts";

const BROWSER_MANAGED_VARIANTS = ["headless-shell", "chrome"] as const;

type BrowserInstallStates = Readonly<Record<BrowserManagedVariant, BrowserInstallState>>;

interface BrowserInstallRun {
  readonly generation: number;
  readonly variant: BrowserManagedVariant;
  readonly fiber: Fiber.Fiber<void, never> | undefined;
}

export interface BrowserInstallerOptions {
  readonly initialStates: BrowserInstallStates;
  readonly refreshInstallState?: (
    variant: BrowserManagedVariant,
    current: BrowserInstallState,
  ) => Effect.Effect<BrowserInstallState>;
  readonly runInstall: (input: {
    readonly variant: BrowserManagedVariant;
    readonly onProgress: (progress: BrowserInstallProgress) => Effect.Effect<void>;
  }) => Effect.Effect<string, BrowserInstallerError>;
}

const ManagedHeadlessShellManifest = Schema.Struct({
  version: Schema.Literal(1),
  browserName: Schema.Literal(MANAGED_BROWSER_NAMES["headless-shell"]),
  executablePath: Schema.NonEmptyString,
  playwrightVersion: Schema.String,
});

const completeProgress = (totalBytes = 0): BrowserInstallProgress => ({
  phase: "complete",
  percent: 100,
  downloadedBytes: totalBytes,
  totalBytes,
});

const decodeManagedHeadlessShellManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedHeadlessShellManifest),
);

const notInstalled = (variant: BrowserManagedVariant): BrowserInstallState => ({
  status: "not-installed",
  variant,
});

function installErrorMessage(cause: Cause.Cause<BrowserInstallerError>): string {
  const error = Cause.squash(cause);
  return error instanceof BrowserInstallerError
    ? error.message
    : Cause.hasInterruptsOnly(cause)
      ? "Browser installation was canceled."
      : "Managed browser installation failed.";
}

function replaceVariantState(
  states: BrowserInstallStates,
  variant: BrowserManagedVariant,
  state: BrowserInstallState,
): BrowserInstallStates {
  return { ...states, [variant]: state };
}

function sameInstallState(left: BrowserInstallState, right: BrowserInstallState): boolean {
  return (
    left.status === right.status &&
    left.variant === right.variant &&
    left.executablePath === right.executablePath &&
    left.reason === right.reason &&
    left.dependencyCommand === right.dependencyCommand &&
    left.elevationCommand === right.elevationCommand &&
    left.progress?.phase === right.progress?.phase &&
    left.progress?.percent === right.progress?.percent &&
    left.progress?.downloadedBytes === right.progress?.downloadedBytes &&
    left.progress?.totalBytes === right.progress?.totalBytes
  );
}

function probePlaywrightChromeExecutablePath(): string | undefined {
  try {
    return resolvePlaywrightChromeExecutablePath();
  } catch {
    return undefined;
  }
}

export const readManagedBrowserInstallState = Effect.fn("browserInstaller.readManagedState")(
  function* (browserDirectory: string, variant: BrowserManagedVariant) {
    if (variant === "chrome") {
      const executablePath = yield* Effect.sync(probePlaywrightChromeExecutablePath);
      if (executablePath) {
        return {
          status: "installed",
          variant,
          executablePath,
          progress: completeProgress(),
        } satisfies BrowserInstallState;
      }

      const disposition = managedChromeInstallDisposition({
        platform: process.platform,
        arch: process.arch,
        distributionId: process.platform === "linux" ? readLinuxDistributionId() : undefined,
        nodeExecutable: process.execPath,
        playwrightCli: playwrightCliPath(),
      });
      if (disposition._tag === "needs-elevation") {
        return {
          status: "needs-elevation",
          variant,
          reason: disposition.reason,
          elevationCommand: disposition.elevationCommand,
        } satisfies BrowserInstallState;
      }
      if (disposition._tag === "unsupported") {
        return {
          status: "failed",
          variant,
          reason: disposition.reason,
        } satisfies BrowserInstallState;
      }
      return notInstalled(variant);
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = path.join(browserDirectory, MANAGED_BROWSER_MANIFESTS[variant]);
    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
    const manifest = yield* decodeManagedHeadlessShellManifest(raw).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (manifest === undefined) return notInstalled(variant);

    const resolvedDirectory = path.resolve(browserDirectory);
    const resolvedExecutable = path.resolve(manifest.executablePath);
    if (
      resolvedExecutable !== resolvedDirectory &&
      !resolvedExecutable.startsWith(`${resolvedDirectory}${path.sep}`)
    ) {
      return notInstalled(variant);
    }
    const info = yield* fs.stat(resolvedExecutable).pipe(Effect.catch(() => Effect.succeed(null)));
    if (info === null || info.type !== "File" || (info.mode & 0o111) === 0) {
      return notInstalled(variant);
    }
    return {
      status: "installed",
      variant,
      executablePath: resolvedExecutable,
      progress: completeProgress(),
    } satisfies BrowserInstallState;
  },
);

export const makeBrowserInstallerWithOptions = Effect.fn("browserInstaller.makeWithOptions")(
  function* (options: BrowserInstallerOptions) {
    const ownerScope = yield* Scope.Scope;
    const stateRef = yield* SubscriptionRef.make(options.initialStates);
    const lock = yield* Semaphore.make(1);
    let generation = 0;
    let inFlight: BrowserInstallRun | undefined;

    const updateState = (variant: BrowserManagedVariant, state: BrowserInstallState) =>
      SubscriptionRef.update(stateRef, (states) => replaceVariantState(states, variant, state));

    const updateProgress = (
      runGeneration: number,
      variant: BrowserManagedVariant,
      progress: BrowserInstallProgress,
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (inFlight?.generation !== runGeneration || inFlight.variant !== variant) return;
          const current = (yield* SubscriptionRef.get(stateRef))[variant];
          if (
            current.status === "installing" &&
            current.progress?.phase === progress.phase &&
            current.progress.percent === progress.percent &&
            current.progress.downloadedBytes === progress.downloadedBytes &&
            current.progress.totalBytes === progress.totalBytes
          ) {
            return;
          }
          yield* updateState(variant, { status: "installing", variant, progress });
        }),
      );

    const finishRun = (
      runGeneration: number,
      variant: BrowserManagedVariant,
      state: BrowserInstallState,
    ): Effect.Effect<void> =>
      lock.withPermit(
        Effect.gen(function* () {
          if (inFlight?.generation !== runGeneration || inFlight.variant !== variant) return;
          inFlight = undefined;
          yield* updateState(variant, state);
        }),
      );

    const getInstallState: BrowserInstallerShape["getInstallState"] = (variant) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = (yield* SubscriptionRef.get(stateRef))[variant];
          if (
            options.refreshInstallState === undefined ||
            current.status === "installing" ||
            current.status === "failed"
          ) {
            return current;
          }
          const refreshed = yield* options.refreshInstallState(variant, current);
          if (!sameInstallState(current, refreshed)) yield* updateState(variant, refreshed);
          return refreshed;
        }),
      );

    const ensureStarted = (variant: BrowserManagedVariant) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = (yield* SubscriptionRef.get(stateRef))[variant];
          if (current.status === "installed") return;
          if (current.status === "needs-elevation") {
            return yield* new BrowserInstallerError({
              message: current.reason ?? "Google Chrome installation requires elevation.",
            });
          }
          if (inFlight !== undefined) {
            if (inFlight.variant === variant) return;
            return yield* new BrowserInstallerError({
              message: `A ${inFlight.variant} browser installation is already running.`,
            });
          }

          const runGeneration = ++generation;
          const preparing: BrowserInstallProgress = {
            phase: "preparing",
            percent: 0,
            downloadedBytes: 0,
            totalBytes: 0,
          };
          yield* updateState(variant, { status: "installing", variant, progress: preparing });
          inFlight = { generation: runGeneration, variant, fiber: undefined };
          const runner = options
            .runInstall({
              variant,
              onProgress: (progress) => updateProgress(runGeneration, variant, progress),
            })
            .pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  finishRun(
                    runGeneration,
                    variant,
                    Cause.hasInterruptsOnly(cause)
                      ? notInstalled(variant)
                      : {
                          status: "failed",
                          variant,
                          reason: installErrorMessage(cause),
                        },
                  ),
                onSuccess: (executablePath) =>
                  finishRun(runGeneration, variant, {
                    status: "installed",
                    variant,
                    executablePath,
                    progress: completeProgress(
                      SubscriptionRef.getUnsafe(stateRef)[variant].progress?.totalBytes ?? 0,
                    ),
                  }),
              }),
            );
          const fiber = yield* runner.pipe(Effect.forkIn(ownerScope));
          if (inFlight?.generation === runGeneration && inFlight.variant === variant) {
            inFlight = { generation: runGeneration, variant, fiber };
          }
        }),
      );

    const install: BrowserInstallerShape["install"] = (variant) =>
      Stream.unwrap(
        ensureStarted(variant).pipe(
          Effect.map(() =>
            SubscriptionRef.changes(stateRef).pipe(
              Stream.map((states) => states[variant]),
              Stream.takeUntil((state) => state.status !== "installing"),
              Stream.mapEffect((state) => {
                if (state.status === "failed" || state.status === "needs-elevation") {
                  return Effect.fail(
                    new BrowserInstallerError({
                      message: state.reason ?? "Managed browser installation failed.",
                    }),
                  );
                }
                if (state.status === "not-installed") {
                  return Effect.fail(
                    new BrowserInstallerError({ message: "Browser installation was canceled." }),
                  );
                }
                return Effect.succeed(
                  state.progress ?? completeProgress(state.status === "installed" ? 0 : undefined),
                );
              }),
            ),
          ),
        ),
      );

    const cancel: BrowserInstallerShape["cancel"] = (variant) =>
      Effect.gen(function* () {
        const result = yield* lock.withPermit(
          Effect.gen(function* () {
            const current = (yield* SubscriptionRef.get(stateRef))[variant];
            if (inFlight === undefined || inFlight.variant !== variant) {
              if (current.status === "failed") {
                const reset = notInstalled(variant);
                yield* updateState(variant, reset);
                return { fiber: undefined, state: reset };
              }
              return { fiber: undefined, state: current };
            }
            const activeFiber = inFlight.fiber;
            generation += 1;
            inFlight = undefined;
            const reset = notInstalled(variant);
            yield* updateState(variant, reset);
            return { fiber: activeFiber, state: reset };
          }),
        );
        if (result.fiber !== undefined) yield* Fiber.interrupt(result.fiber);
        return result.state;
      });

    return {
      install,
      getInstallState,
      getManagedExecutablePath: (variant) =>
        getInstallState(variant).pipe(
          Effect.map((state) => (state.status === "installed" ? state.executablePath : undefined)),
        ),
      cancel,
    } satisfies BrowserInstallerShape;
  },
);

const makeLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const browserDirectory = path.join(config.baseDir, "browsers");
  const processRegistryDirectory = path.join(
    config.providerStatusCacheDir,
    "browser-installer-processes",
  );
  yield* Effect.all([
    fs.makeDirectory(browserDirectory, { recursive: true, mode: 0o700 }),
    fs.makeDirectory(processRegistryDirectory, { recursive: true, mode: 0o700 }),
  ]).pipe(Effect.orDie);
  const initialStates = yield* Effect.all(
    Object.fromEntries(
      BROWSER_MANAGED_VARIANTS.map((variant) => [
        variant,
        readManagedBrowserInstallState(browserDirectory, variant),
      ]),
    ) as Record<BrowserManagedVariant, Effect.Effect<BrowserInstallState>>,
  );
  return yield* makeBrowserInstallerWithOptions({
    initialStates,
    refreshInstallState: (variant, current) =>
      current.status === "installing" || current.status === "failed"
        ? Effect.succeed(current)
        : readManagedBrowserInstallState(browserDirectory, variant).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
    runInstall: ({ variant, onProgress }) =>
      runBrowserInstallerProcess({
        browserDirectory,
        processRegistryDirectory,
        variant,
        onProgress,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) => new BrowserInstallerError({ message: cause.message, cause })),
      ),
  });
});

export const BrowserInstallerLive = Layer.effect(BrowserInstaller, makeLive);
