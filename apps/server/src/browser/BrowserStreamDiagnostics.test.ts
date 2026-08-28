import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  browserMonotonicMillis,
  installBrowserEventLoopLagMonitor,
  logBrowserHandlerTiming,
  observeBrowserHandlerTimings,
} from "./BrowserStreamDiagnostics.ts";

it.effect("exposes debug handler timing samples to a bounded benchmark observer", () =>
  Effect.gen(function* () {
    const previous = process.env.SALCHI_BROWSER_STREAM_DEBUG;
    process.env.SALCHI_BROWSER_STREAM_DEBUG = "1";
    const samples: Array<{ readonly label: string; readonly durationMillis: number }> = [];
    const stop = observeBrowserHandlerTimings((sample) => samples.push(sample));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stop();
        if (previous === undefined) delete process.env.SALCHI_BROWSER_STREAM_DEBUG;
        else process.env.SALCHI_BROWSER_STREAM_DEBUG = previous;
      }),
    );

    yield* logBrowserHandlerTiming("browser.test.sample", browserMonotonicMillis() - 5);
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.label, "browser.test.sample");
    assert.isAtLeast(samples[0]?.durationMillis ?? 0, 5);
  }),
);

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
