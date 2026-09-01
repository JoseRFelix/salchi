import type { BrowserInstallState, BrowserManagedVariant } from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { BrowserInstallerError } from "../Services/BrowserInstaller.ts";
import { makeBrowserInstallerWithOptions } from "./BrowserInstaller.ts";

const HEADLESS = "headless-shell" as const;

function initialStates(
  headless: BrowserInstallState = { status: "not-installed", variant: HEADLESS },
  chrome: BrowserInstallState = { status: "not-installed", variant: "chrome" },
): Record<BrowserManagedVariant, BrowserInstallState> {
  return { "headless-shell": headless, chrome };
}

it.effect("joins concurrent browser installation streams onto one in-flight install", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let runs = 0;
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: initialStates(),
        runInstall: ({ onProgress }) =>
          Effect.gen(function* () {
            runs += 1;
            yield* Deferred.succeed(started, undefined);
            yield* onProgress({
              phase: "downloading",
              percent: 50,
              downloadedBytes: 50,
              totalBytes: 100,
            });
            yield* Deferred.await(finish);
            return "/salchi/browsers/chromium";
          }),
      });
      const first = yield* installer.install(HEADLESS).pipe(Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* installer.install(HEADLESS).pipe(Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(runs, 1);

      yield* Deferred.succeed(finish, undefined);
      const [firstProgress, secondProgress] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ]);
      assert.equal(firstProgress.at(-1)?.phase, "complete");
      assert.equal(secondProgress.at(-1)?.phase, "complete");
      assert.deepEqual(yield* installer.getInstallState(HEADLESS), {
        status: "installed",
        variant: HEADLESS,
        executablePath: "/salchi/browsers/chromium",
        progress: {
          phase: "complete",
          percent: 100,
          downloadedBytes: 100,
          totalBytes: 100,
        },
      });
    }),
  ),
);

it.effect("cancel interrupts the shared browser install and resets its replayed state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: initialStates(),
        runInstall: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      const consumer = yield* installer.install(HEADLESS).pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(started);

      assert.deepEqual(yield* installer.cancel(HEADLESS), {
        status: "not-installed",
        variant: HEADLESS,
      });
      yield* Deferred.await(interrupted);
      const exit = yield* Fiber.await(consumer);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(yield* installer.getInstallState(HEADLESS), {
        status: "not-installed",
        variant: HEADLESS,
      });
    }),
  ),
);

it.effect("records a failed install reason and retries on the next install call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let runs = 0;
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: initialStates(),
        runInstall: () => {
          runs += 1;
          return runs === 1
            ? Effect.fail(new BrowserInstallerError({ message: "network unavailable" }))
            : Effect.succeed("/salchi/browsers/chromium");
        },
      });
      const first = yield* installer.install(HEADLESS).pipe(Stream.runDrain, Effect.exit);
      assert.isTrue(Exit.isFailure(first));
      assert.deepEqual(yield* installer.getInstallState(HEADLESS), {
        status: "failed",
        variant: HEADLESS,
        reason: "network unavailable",
      });

      yield* installer.install(HEADLESS).pipe(Stream.runDrain);
      assert.equal(runs, 2);
      assert.equal((yield* installer.getInstallState(HEADLESS)).status, "installed");
    }),
  ),
);

it.effect("tracks both variants independently and resolves the selected managed executable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installed = initialStates(
        {
          status: "installed",
          variant: HEADLESS,
          executablePath: "/salchi/browsers/headless-shell",
        },
        {
          status: "installed",
          variant: "chrome",
          executablePath: "/opt/google/chrome/chrome",
        },
      );
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: installed,
        runInstall: () => Effect.die("unexpected install"),
      });

      assert.equal(
        yield* installer.getManagedExecutablePath(HEADLESS),
        "/salchi/browsers/headless-shell",
      );
      assert.equal(
        yield* installer.getManagedExecutablePath("chrome"),
        "/opt/google/chrome/chrome",
      );
    }),
  ),
);

it.effect("installs a newly selected variant without replacing the other variant state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runs: BrowserManagedVariant[] = [];
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: initialStates(),
        runInstall: ({ variant }) => {
          runs.push(variant);
          return Effect.succeed(`/salchi/browsers/${variant}`);
        },
      });

      yield* installer.install(HEADLESS).pipe(Stream.runDrain);
      yield* installer.install("chrome").pipe(Stream.runDrain);

      assert.deepEqual(runs, [HEADLESS, "chrome"]);
      assert.equal(
        (yield* installer.getInstallState(HEADLESS)).executablePath,
        "/salchi/browsers/headless-shell",
      );
      assert.equal(
        (yield* installer.getInstallState("chrome")).executablePath,
        "/salchi/browsers/chrome",
      );
    }),
  ),
);

it.effect("does not spawn an installer for a variant that needs elevation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let runs = 0;
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: initialStates(undefined, {
          status: "needs-elevation",
          variant: "chrome",
          reason: "administrator install required",
          elevationCommand: "sudo playwright install chrome",
        }),
        runInstall: () => {
          runs += 1;
          return Effect.succeed("/opt/google/chrome/chrome");
        },
      });

      const exit = yield* installer.install("chrome").pipe(Stream.runDrain, Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(runs, 0);
      assert.equal((yield* installer.getInstallState("chrome")).status, "needs-elevation");
    }),
  ),
);

it.effect("re-resolves a NeedsElevation variant after system Chrome appears", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let chromeAvailable = false;
      const needsElevation: BrowserInstallState = {
        status: "needs-elevation",
        variant: "chrome",
        reason: "administrator install required",
        elevationCommand: "sudo playwright install chrome",
      };
      const installer = yield* makeBrowserInstallerWithOptions({
        initialStates: initialStates(undefined, needsElevation),
        refreshInstallState: (variant, current) =>
          Effect.succeed(
            variant === "chrome" && chromeAvailable
              ? {
                  status: "installed",
                  variant,
                  executablePath: "/opt/google/chrome/chrome",
                }
              : current,
          ),
        runInstall: () => Effect.die("unexpected install"),
      });

      assert.equal((yield* installer.getInstallState("chrome")).status, "needs-elevation");
      chromeAvailable = true;
      assert.deepEqual(yield* installer.getInstallState("chrome"), {
        status: "installed",
        variant: "chrome",
        executablePath: "/opt/google/chrome/chrome",
      });
    }),
  ),
);

it.effect("interrupts the installer process when its owning server scope closes", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make("sequential");
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const installer = yield* makeBrowserInstallerWithOptions({
      initialStates: initialStates(),
      runInstall: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope));
    yield* installer.install(HEADLESS).pipe(Stream.runDrain, Effect.forkChild);
    yield* Deferred.await(started);

    yield* Scope.close(ownerScope, Exit.void);
    yield* Deferred.await(interrupted);
    assert.isTrue(yield* Deferred.isDone(interrupted));
  }),
);
