import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

import { terminateChildProcess } from "./childProcess.ts";

function makeProcessHandle(input: {
  readonly kill: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly unref?: ChildProcessSpawner.ChildProcessHandle["unref"];
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: input.kill,
    unref: input.unref ?? Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.effect("escalates a TERM-resistant child and bounds the force-kill wait", () =>
  Effect.gen(function* () {
    const signals: string[] = [];
    const unreferenced = yield* Deferred.make<void>();
    const child = makeProcessHandle({
      kill: (options) =>
        Effect.sync(() => {
          signals.push(options?.killSignal ?? "SIGTERM");
        }).pipe(Effect.andThen(Effect.never)),
      unref: Deferred.succeed(unreferenced, undefined).pipe(Effect.as(Effect.void)),
    });

    const cleanup = yield* terminateChildProcess(child, {
      gracefulTimeout: "100 millis",
      forceTimeout: "100 millis",
    }).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepEqual(signals, ["SIGTERM"]);

    yield* TestClock.adjust("100 millis");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    yield* TestClock.adjust("100 millis");

    yield* Fiber.join(cleanup);
    assert.equal(yield* Deferred.isDone(unreferenced), true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("remains bounded when used from an uninterruptible scope finalizer", () =>
  Effect.gen(function* () {
    const signals: string[] = [];
    const unreferenced = yield* Deferred.make<void>();
    const child = makeProcessHandle({
      kill: (options) =>
        Effect.sync(() => {
          signals.push(options?.killSignal ?? "SIGTERM");
        }).pipe(Effect.andThen(Effect.never)),
      unref: Deferred.succeed(unreferenced, undefined).pipe(Effect.as(Effect.void)),
    });
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(
      scope,
      terminateChildProcess(child, {
        gracefulTimeout: "100 millis",
        forceTimeout: "100 millis",
      }),
    );

    const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepEqual(signals, ["SIGTERM"]);
    yield* TestClock.adjust("100 millis");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    yield* TestClock.adjust("100 millis");

    yield* Fiber.join(closeFiber);
    assert.equal(yield* Deferred.isDone(unreferenced), true);
  }).pipe(Effect.provide(TestClock.layer())),
);
