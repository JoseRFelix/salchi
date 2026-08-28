import { ThreadId, type BrowserRpcError, type BrowserSessionState } from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BrowserRuntime } from "../PlaywrightBrowserRuntime.ts";
import type { BrowserSessionManagerShape } from "../Services/BrowserSessionManager.ts";
import {
  makeBrowserSessionManagerWithOptions,
  type BrowserSessionManagerOptions,
} from "./BrowserSessionManager.ts";

const threadId = ThreadId.make("browser-manager-test");

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
    executable: {
      source: "channel",
      resolution: "chrome",
      executablePath: "/test/chrome",
    },
    processPid: 42,
    getTabs: Effect.succeed([]),
    setActiveTab: () => Effect.void,
    openTab: () => Effect.void,
    closeTab: () => Effect.void,
    setScreencastEnabled: () => Effect.void,
    ...overrides,
  };
}

function managerOptions(
  launchRuntime: BrowserSessionManagerOptions["launchRuntime"],
): BrowserSessionManagerOptions {
  return {
    threadExists: () => Effect.succeed(true),
    getLaunchConfig: () =>
      Effect.succeed({
        idleTimeoutMillis: 60 * 60 * 1_000,
        userDataDirectory: "/tmp/salchi-browser-test-profile",
        processRegistryDirectory: "/tmp/salchi-browser-test-processes",
        noSandbox: false,
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    launchRuntime,
  };
}

function waitForStatus(
  manager: BrowserSessionManagerShape,
  expected: "running" | "stopped" | "crashed",
  attempts = 100,
): Effect.Effect<BrowserSessionState, BrowserRpcError> {
  return Effect.gen(function* () {
    const state = yield* manager.getState(threadId);
    if (state.status === expected) return state;
    if (attempts <= 0) {
      return yield* Effect.die(`Timed out waiting for browser status ${expected}`);
    }
    yield* Effect.sleep("1 milli");
    return yield* waitForStatus(manager, expected, attempts - 1);
  });
}

it.effect("closes the owned browser runtime when the manager scope shuts down", () =>
  Effect.gen(function* () {
    const managerScope = yield* Scope.make("sequential");
    const closed = yield* Deferred.make<void>();
    const manager = yield* makeBrowserSessionManagerWithOptions(
      managerOptions(() =>
        Effect.acquireRelease(Effect.succeed(fakeRuntime()), () =>
          Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        ),
      ),
    ).pipe(Effect.provideService(Scope.Scope, managerScope));

    yield* manager.start(threadId);
    yield* Scope.close(managerScope, Exit.void);
    yield* Deferred.await(closed);
    assert.isTrue(yield* Deferred.isDone(closed));
  }),
);

it.effect("starts screencasting for a subscriber and stops it when the stream is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const enabled = yield* Deferred.make<void>();
      const disabled = yield* Deferred.make<void>();
      const calls: boolean[] = [];
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Effect.succeed(
            fakeRuntime({
              setScreencastEnabled: (value) =>
                Effect.sync(() => calls.push(value)).pipe(
                  Effect.andThen(
                    value
                      ? Deferred.succeed(enabled, undefined)
                      : Deferred.succeed(disabled, undefined),
                  ),
                  Effect.asVoid,
                ),
            }),
          ),
        ),
      );
      yield* manager.start(threadId);
      const subscription = yield* manager
        .subscribeViewport(threadId)
        .pipe(Stream.runDrain, Effect.forkScoped);

      yield* Deferred.await(enabled);
      yield* Fiber.interrupt(subscription);
      yield* Deferred.await(disabled);
      assert.deepEqual(calls, [true, false]);
    }),
  ),
);

it.effect("does not release another subscriber when acquisition fails before increment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let threadExists = true;
      const enabled = yield* Deferred.make<void>();
      const disabled = yield* Deferred.make<void>();
      const calls: boolean[] = [];
      const manager = yield* makeBrowserSessionManagerWithOptions({
        ...managerOptions(() =>
          Effect.succeed(
            fakeRuntime({
              setScreencastEnabled: (value) =>
                Effect.sync(() => calls.push(value)).pipe(
                  Effect.andThen(
                    value
                      ? Deferred.succeed(enabled, undefined)
                      : Deferred.succeed(disabled, undefined),
                  ),
                  Effect.asVoid,
                ),
            }),
          ),
        ),
        threadExists: () => Effect.succeed(threadExists),
      });
      yield* manager.start(threadId);
      const activeSubscription = yield* manager
        .subscribeViewport(threadId)
        .pipe(Stream.runDrain, Effect.forkScoped);
      yield* Deferred.await(enabled);

      threadExists = false;
      const failedSubscription = yield* manager
        .subscribeViewport(threadId)
        .pipe(Stream.runDrain, Effect.exit);

      assert.isTrue(Exit.isFailure(failedSubscription));
      assert.deepEqual(calls, [true]);

      yield* Fiber.interrupt(activeSubscription);
      yield* Deferred.await(disabled);
      assert.deepEqual(calls, [true, false]);
    }),
  ),
);

it.effect("keeps an explicit start owned by the manager when its caller is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const launchStarted = yield* Deferred.make<void>();
      const allowLaunch = yield* Deferred.make<void>();
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Deferred.succeed(launchStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowLaunch)),
            Effect.as(fakeRuntime()),
          ),
        ),
      );
      const caller = yield* manager.start(threadId).pipe(Effect.forkScoped);
      yield* Deferred.await(launchStarted);
      caller.interruptUnsafe();
      yield* Effect.yieldNow;
      assert.isDefined(caller.pollUnsafe());
      yield* Deferred.succeed(allowLaunch, undefined);

      const state = yield* waitForStatus(manager, "running");
      assert.equal(state.status, "running");
    }),
  ),
);

it.effect("interrupts an in-progress launch on explicit stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const launchStarted = yield* Deferred.make<void>();
      const launchInterrupted = yield* Deferred.make<void>();
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Deferred.succeed(launchStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(launchInterrupted, undefined).pipe(Effect.asVoid),
            ),
          ),
        ),
      );
      const startFiber = yield* manager.start(threadId).pipe(Effect.forkScoped);
      yield* Deferred.await(launchStarted);
      const stopped = yield* manager.stop(threadId);
      yield* Deferred.await(launchInterrupted);
      assert.equal(stopped.status, "stopped");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(startFiber)));
    }),
  ),
);

it.effect("records an unexpected process exit as crashed without restarting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let crash: ((message: string) => void) | undefined;
      let launchCount = 0;
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions((input) =>
          Effect.sync(() => {
            launchCount += 1;
            crash = input.callbacks.onCrashed;
            return fakeRuntime();
          }),
        ),
      );
      yield* manager.start(threadId);
      crash?.("test browser crash");

      const crashed = yield* waitForStatus(manager, "crashed");
      assert.equal(crashed.error, "test browser crash");
      assert.equal(launchCount, 1);

      yield* manager.start(threadId);
      assert.equal(launchCount, 2);
    }),
  ),
);

it.effect("does not restart a crashed session until its prior scope has closed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      let crash: ((message: string) => void) | undefined;
      let launchCount = 0;
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions((input) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              launchCount += 1;
              crash = input.callbacks.onCrashed;
              return fakeRuntime();
            }),
            () =>
              Deferred.succeed(closeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowClose)),
                Effect.asVoid,
              ),
          ),
        ),
      );
      yield* manager.start(threadId);
      crash?.("test browser crash");
      yield* Deferred.await(closeStarted);

      const restart = yield* manager.start(threadId).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(launchCount, 1);

      yield* Deferred.succeed(allowClose, undefined);
      yield* Fiber.join(restart);
      assert.equal(launchCount, 2);
    }),
  ),
);
