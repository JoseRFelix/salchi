import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeBrowserAgentActivityController } from "./BrowserAgentActivity.ts";

it.effect("emits debounced agent activity transitions without flapping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* makeBrowserAgentActivityController({
        activeWindowMillis: 4_000,
        endDebounceMillis: 2_000,
      });
      const eventsFiber = yield* activity.changes.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* activity.recordCommand;
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(yield* activity.getActive);

      yield* activity.recordCommand;
      yield* TestClock.adjust("5999 millis");
      assert.isTrue(yield* activity.getActive);
      yield* TestClock.adjust("1 millis");

      assert.deepEqual(Array.from(yield* Fiber.join(eventsFiber)), [false, true, false]);
    }),
  ),
);

it.effect("interrupts the activity monitor and subscriptions with their owning scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const activity = yield* makeBrowserAgentActivityController().pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const subscriber = yield* activity.changes.pipe(
      Stream.drop(1),
      Stream.runDrain,
      Effect.forkIn(scope),
    );

    yield* Scope.close(scope, Exit.void);

    const exit = subscriber.pollUnsafe();
    assert.isDefined(exit);
    if (exit !== undefined) assert.isTrue(Exit.isFailure(exit));
  }),
);
