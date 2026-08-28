import {
  ThreadId,
  type BrowserInputEvent,
  type BrowserRpcError,
  type BrowserSessionState,
} from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
    cdpWebSocketUrl: "ws://127.0.0.1:12345/devtools/browser/test",
    getTabs: Effect.succeed([]),
    setActiveTab: () => Effect.void,
    openTab: () => Effect.void,
    navigate: () => Effect.void,
    navigateHistory: () => Effect.void,
    closeTab: () => Effect.void,
    dispatchInput: () => Effect.void,
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
    yield* Effect.yieldNow;
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

it.effect("navigates the requested tab through the running browser runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const navigations: Array<{ readonly targetId: string; readonly url: string }> = [];
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Effect.succeed(
            fakeRuntime({
              navigate: (targetId, url) =>
                Effect.sync(() => {
                  navigations.push({ targetId, url });
                }),
            }),
          ),
        ),
      );
      yield* manager.start(threadId);

      const state = yield* manager.navigate(threadId, "target-1", "https://example.com/");

      assert.deepEqual(navigations, [{ targetId: "target-1", url: "https://example.com/" }]);
      assert.equal(state.status, "running");
    }),
  ),
);

it.effect("dispatches input through the running browser runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatched: Array<{ readonly targetId: string; readonly event: BrowserInputEvent }> =
        [];
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Effect.succeed(
            fakeRuntime({
              dispatchInput: (targetId, event) =>
                Effect.sync(() => {
                  dispatched.push({ targetId, event });
                }),
            }),
          ),
        ),
      );
      yield* manager.start(threadId);
      const event = { _tag: "InsertText", text: "hello" } as const;

      yield* manager.dispatchInput(threadId, "target-1", event);

      assert.deepEqual(dispatched, [{ targetId: "target-1", event }]);
    }),
  ),
);

it.effect("dispatches input without waiting for the manager's per-thread operation lock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tabOperationStarted = yield* Deferred.make<void>();
      const releaseTabOperation = yield* Deferred.make<void>();
      const inputDispatched = yield* Deferred.make<void>();
      let getTabsCalls = 0;
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Effect.succeed(
            fakeRuntime({
              getTabs: Effect.sync(() => {
                getTabsCalls += 1;
                return [];
              }),
              setActiveTab: () =>
                Deferred.succeed(tabOperationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseTabOperation)),
                  Effect.asVoid,
                ),
              dispatchInput: () => Deferred.succeed(inputDispatched, undefined).pipe(Effect.asVoid),
            }),
          ),
        ),
      );
      yield* manager.start(threadId);
      const tabOperation = yield* manager
        .setActiveTab(threadId, "target-1")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(tabOperationStarted);

      yield* manager.dispatchInput(threadId, "target-1", {
        _tag: "PointerMove",
        x: 20,
        y: 30,
        button: "none",
        clickCount: 0,
      });
      yield* Deferred.await(inputDispatched);
      assert.equal(getTabsCalls, 1);

      yield* Deferred.succeed(releaseTabOperation, undefined);
      yield* Fiber.join(tabOperation);
    }),
  ),
);

it.effect("shares a root browser session while preserving the requested API thread ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rootThreadId = ThreadId.make("browser-root-test");
      const childThreadId = ThreadId.make("codex-tool:exec-browser-child");
      const existenceChecks: ThreadId[] = [];
      const launchThreadIds: ThreadId[] = [];
      const manager = yield* makeBrowserSessionManagerWithOptions({
        ...managerOptions((input) =>
          Effect.sync(() => {
            launchThreadIds.push(input.threadId);
            return fakeRuntime();
          }),
        ),
        resolveRootThreadId: (requestedThreadId) =>
          Effect.succeed(requestedThreadId === childThreadId ? rootThreadId : requestedThreadId),
        threadExists: (requestedThreadId) =>
          Effect.sync(() => {
            existenceChecks.push(requestedThreadId);
            return requestedThreadId === rootThreadId;
          }),
      });

      const started = yield* manager.start(childThreadId);
      const state = yield* manager.getState(childThreadId);
      const controlled = yield* manager.setActiveTab(childThreadId, "target-1");
      const events = yield* manager
        .subscribeViewport(childThreadId)
        .pipe(Stream.take(2), Stream.runCollect);

      assert.equal(started.threadId, childThreadId);
      assert.equal(state.threadId, childThreadId);
      assert.equal(controlled.threadId, childThreadId);
      assert.deepEqual(
        events.map((event) => event.threadId),
        [childThreadId, childThreadId],
      );
      assert.isTrue(existenceChecks.every((checkedThreadId) => checkedThreadId === rootThreadId));
      assert.deepEqual(launchThreadIds, [rootThreadId]);
    }),
  ),
);

it.effect("dispatches browser history controls to the requested tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<{ readonly action: string; readonly targetId: string }> = [];
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() =>
          Effect.succeed(
            fakeRuntime({
              navigateHistory: (targetId, action) =>
                Effect.sync(() => {
                  calls.push({ targetId, action });
                }),
            }),
          ),
        ),
      );

      yield* manager.start(threadId);
      yield* manager.navigateHistory(threadId, "target-1", "back");
      yield* manager.navigateHistory(threadId, "target-1", "forward");
      yield* manager.navigateHistory(threadId, "target-1", "reload");

      assert.deepEqual(calls, [
        { targetId: "target-1", action: "back" },
        { targetId: "target-1", action: "forward" },
        { targetId: "target-1", action: "reload" },
      ]);
    }),
  ),
);

it.effect("exposes the raw CDP endpoint only from getState and tracks proxy connections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* makeBrowserSessionManagerWithOptions(
        managerOptions(() => Effect.succeed(fakeRuntime())),
      );

      const started = yield* manager.start(threadId);
      assert.isUndefined(started.cdpWebSocketUrl);

      const state = yield* manager.getState(threadId);
      assert.equal(state.cdpWebSocketUrl, "ws://127.0.0.1:12345/devtools/browser/test");
      assert.equal(
        yield* manager.getCdpWebSocketUrl(threadId),
        "ws://127.0.0.1:12345/devtools/browser/test",
      );

      yield* manager.agentConnectionOpened(threadId, "agent-connection-1");
      yield* manager.recordAgentCdpActivity(threadId, "agent-connection-1");
      yield* manager.agentConnectionClosed(threadId, "agent-connection-1");

      const stopped = yield* manager.stop(threadId);
      assert.isUndefined(stopped.cdpWebSocketUrl);
    }),
  ),
);

it.effect("does not idle out while an agent CDP proxy remains connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const manager = yield* makeBrowserSessionManagerWithOptions({
        ...managerOptions(() =>
          Effect.acquireRelease(Effect.succeed(fakeRuntime()), () =>
            Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
          ),
        ),
        getLaunchConfig: () =>
          Effect.succeed({
            idleTimeoutMillis: 1_000,
            userDataDirectory: "/tmp/salchi-browser-test-profile",
            processRegistryDirectory: "/tmp/salchi-browser-test-processes",
            noSandbox: false,
            serverHost: "127.0.0.1",
            serverPort: 3773,
          }),
      });
      yield* manager.start(threadId);
      yield* manager.agentConnectionOpened(threadId, "agent-idle-hold");

      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* manager.getState(threadId)).status, "running");
      assert.isFalse(yield* Deferred.isDone(closed));

      yield* manager.recordAgentCdpActivity(threadId, "agent-idle-hold");
      yield* manager.agentConnectionClosed(threadId, "agent-idle-hold");
      yield* TestClock.adjust("999 millis");
      assert.equal((yield* manager.getState(threadId)).status, "running");
      yield* TestClock.adjust("1 milli");
      yield* Effect.yieldNow;

      assert.equal((yield* manager.getState(threadId)).status, "stopped");
      assert.isTrue(yield* Deferred.isDone(closed));
    }),
  ),
);

it.effect("resets the idle deadline when browser input records CDP activity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* makeBrowserSessionManagerWithOptions({
        ...managerOptions((input) =>
          Effect.succeed(
            fakeRuntime({
              dispatchInput: () => Effect.sync(input.callbacks.onCdpActivity),
            }),
          ),
        ),
        getLaunchConfig: () =>
          Effect.succeed({
            idleTimeoutMillis: 1_000,
            userDataDirectory: "/tmp/salchi-browser-test-profile",
            processRegistryDirectory: "/tmp/salchi-browser-test-processes",
            noSandbox: false,
            serverHost: "127.0.0.1",
            serverPort: 3773,
          }),
      });
      yield* manager.start(threadId);

      yield* TestClock.adjust("900 millis");
      yield* manager.dispatchInput(threadId, "target-1", {
        _tag: "PointerMove",
        x: 20,
        y: 30,
        button: "none",
        clickCount: 0,
      });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("999 millis");
      assert.equal((yield* manager.getState(threadId)).status, "running");

      yield* TestClock.adjust("1 milli");
      yield* Effect.yieldNow;
      assert.equal((yield* manager.getState(threadId)).status, "stopped");
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
      yield* manager.agentConnectionOpened(threadId, "agent-crash-connection");
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
