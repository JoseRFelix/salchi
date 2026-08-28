// @effect-diagnostics nodeBuiltinImport:off
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const SLOW_HANDLER_MILLIS = 50;
const EVENT_LOOP_SAMPLE_INTERVAL_MILLIS = 5_000;

export interface BrowserFrameTiming {
  readonly cdpReceivedAtMonotonicMillis: number;
  readonly mailboxPublishedAtMonotonicMillis: number;
}

export interface BrowserEventLoopLagSample {
  readonly p50Millis: number;
  readonly p99Millis: number;
}

export interface BrowserHandlerTimingSample {
  readonly durationMillis: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly label: string;
}

const frameTimings = new WeakMap<object, BrowserFrameTiming>();
const handlerTimingObservers = new Set<(sample: BrowserHandlerTimingSample) => void>();

export function browserStreamDebugEnabled(): boolean {
  return process.env.SALCHI_BROWSER_STREAM_DEBUG === "1";
}

export function browserMonotonicMillis(): number {
  return performance.now();
}

export function recordBrowserFrameTiming(frame: object, timing: BrowserFrameTiming): void {
  frameTimings.set(frame, timing);
}

export function getBrowserFrameTiming(frame: object): BrowserFrameTiming | undefined {
  return frameTimings.get(frame);
}

/** Test/benchmark seam for the same samples emitted by debug logging. */
export function observeBrowserHandlerTimings(
  observer: (sample: BrowserHandlerTimingSample) => void,
): () => void {
  handlerTimingObservers.add(observer);
  return () => handlerTimingObservers.delete(observer);
}

export function logBrowserHandlerTiming(
  label: string,
  startedAtMonotonicMillis: number,
  fields: Readonly<Record<string, unknown>> = {},
): Effect.Effect<void> {
  if (!browserStreamDebugEnabled()) return Effect.void;
  const durationMillis = Math.max(0, browserMonotonicMillis() - startedAtMonotonicMillis);
  const sample = { label, durationMillis, fields } satisfies BrowserHandlerTimingSample;
  const annotations = { label, durationMillis, ...fields };
  const notifyObservers = Effect.forEach(
    [...handlerTimingObservers],
    (observer) => Effect.sync(() => observer(sample)).pipe(Effect.ignore),
    { discard: true },
  );
  return notifyObservers.pipe(
    Effect.andThen(
      durationMillis > SLOW_HANDLER_MILLIS
        ? Effect.logWarning("browser handler exceeded 50ms", annotations)
        : Effect.logDebug("browser handler timing", annotations),
    ),
  );
}

export function installBrowserEventLoopLagMonitor(options?: {
  readonly enabled?: boolean;
  readonly intervalMillis?: number;
  readonly onSample?: (sample: BrowserEventLoopLagSample) => Effect.Effect<void>;
}): Effect.Effect<void, never, Scope.Scope> {
  const enabled = options?.enabled ?? browserStreamDebugEnabled();
  if (!enabled) return Effect.void;

  return Effect.gen(function* () {
    const histogram = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const value = monitorEventLoopDelay({ resolution: 10 });
        value.enable();
        return value;
      }),
      (value) =>
        Effect.sync(() => {
          value.disable();
        }),
    );
    const onSample =
      options?.onSample ??
      ((sample: BrowserEventLoopLagSample) =>
        Effect.logDebug("browser event-loop lag", {
          intervalMillis: options?.intervalMillis ?? EVENT_LOOP_SAMPLE_INTERVAL_MILLIS,
          ...sample,
        }));
    const sample = Effect.sleep(options?.intervalMillis ?? EVENT_LOOP_SAMPLE_INTERVAL_MILLIS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const sample = {
            p50Millis: histogram.percentile(50) / 1_000_000,
            p99Millis: histogram.percentile(99) / 1_000_000,
          } satisfies BrowserEventLoopLagSample;
          histogram.reset();
          return sample;
        }),
      ),
      Effect.flatMap(onSample),
    );
    yield* Effect.forever(sample).pipe(Effect.forkScoped);
  });
}
