import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { installBrowserEventLoopLagMonitor } from "./BrowserStreamDiagnostics.ts";

it.live("stops the event-loop lag sampler when its owning scope closes", () =>
  Effect.gen(function* () {
    const monitorScope = yield* Scope.make("sequential");
    const firstSample = yield* Deferred.make<void>();
    let samples = 0;
    yield* installBrowserEventLoopLagMonitor({
      enabled: true,
      intervalMillis: 10,
      onSample: () =>
        Effect.sync(() => {
          samples += 1;
          Deferred.doneUnsafe(firstSample, Effect.void);
        }),
    }).pipe(Effect.provideService(Scope.Scope, monitorScope));

    yield* Deferred.await(firstSample);
    yield* Scope.close(monitorScope, Exit.void);
    const samplesAtClose = samples;
    yield* Effect.sleep("40 millis");

    assert.equal(samples, samplesAtClose);
  }),
);
