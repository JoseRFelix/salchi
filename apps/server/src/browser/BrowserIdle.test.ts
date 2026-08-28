import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { makeBrowserIdleController } from "./BrowserIdle.ts";

it.effect("idles only after both CDP activity and viewport subscribers are absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const idle = yield* makeBrowserIdleController({ idleTimeoutMillis: 1_000 });
      const fiber = yield* idle.awaitIdle.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* TestClock.adjust("900 millis");
      yield* idle.recordCdpActivity;
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(fiber.pollUnsafe());

      yield* idle.subscriberAdded;
      yield* TestClock.adjust("5 seconds");
      assert.isUndefined(fiber.pollUnsafe());

      yield* idle.subscriberRemoved;
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 milli");
      yield* Fiber.join(fiber);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("interrupts the idle fiber when its owning session scope closes", () =>
  Effect.gen(function* () {
    const sessionScope = yield* Scope.make("sequential");
    const interrupted = yield* Deferred.make<void>();
    const idle = yield* makeBrowserIdleController({ idleTimeoutMillis: 60_000 }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
    );
    const fiber = yield* idle.awaitIdle.pipe(
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
      Effect.forkIn(sessionScope),
    );
    yield* Effect.yieldNow;

    yield* Scope.close(sessionScope, Exit.void);
    yield* Deferred.await(interrupted);
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.isTrue(Exit.hasInterrupts(exit));
  }),
);
