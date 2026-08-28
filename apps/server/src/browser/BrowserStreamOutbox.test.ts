import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vitest";

import {
  DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES,
  makeBrowserStreamOutbox,
} from "./BrowserStreamOutbox.ts";

describe("BrowserStreamOutbox", () => {
  it.effect("replaces a stale frame while a socket write is slow", () =>
    Effect.gen(function* () {
      const firstWriteStarted = yield* Deferred.make<void>();
      const releaseFirstWrite = yield* Deferred.make<void>();
      const received: number[] = [];
      const outbox = yield* makeBrowserStreamOutbox<number, string, never>({
        getBufferedBytes: () => 0,
        writeFrame: (seq) =>
          Effect.gen(function* () {
            received.push(seq);
            if (seq === 1) {
              yield* Deferred.succeed(firstWriteStarted, undefined);
              yield* Deferred.await(releaseFirstWrite);
            }
          }),
        writeMeta: () => Effect.void,
      });
      const writer = yield* Effect.forkScoped(outbox.run);

      yield* outbox.offerFrame(1);
      yield* Deferred.await(firstWriteStarted);
      yield* outbox.offerFrame(2);
      yield* outbox.offerFrame(3);
      yield* Deferred.succeed(releaseFirstWrite, undefined);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(received).toEqual([1, 3]);
      yield* Fiber.interrupt(writer);
    }).pipe(Effect.scoped),
  );

  it.effect("skips frames above the socket threshold and sends the next newest frame", () =>
    Effect.gen(function* () {
      let bufferedBytes = DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES;
      const received: number[] = [];
      const skipped: number[] = [];
      const outbox = yield* makeBrowserStreamOutbox<number, string, never>({
        getBufferedBytes: () => bufferedBytes,
        writeFrame: (seq) => Effect.sync(() => received.push(seq)),
        writeMeta: () => Effect.void,
        onFrameSkipped: (seq) => Effect.sync(() => skipped.push(seq)),
      });
      const writer = yield* Effect.forkScoped(outbox.run);

      yield* outbox.offerFrame(10);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      bufferedBytes = 0;
      yield* outbox.offerFrame(11);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(skipped).toEqual([10]);
      expect(received).toEqual([11]);
      yield* Fiber.interrupt(writer);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an in-flight writer when its connection scope closes", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      const writeInterrupted = yield* Deferred.make<void>();
      const outbox = yield* makeBrowserStreamOutbox<number, string, never>({
        getBufferedBytes: () => 0,
        writeFrame: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(writeInterrupted, undefined)),
          ),
        writeMeta: () => Effect.void,
      });
      const writer = yield* Effect.forkScoped(outbox.run);

      yield* outbox.offerFrame(1);
      yield* Deferred.await(writeStarted);
      yield* Fiber.interrupt(writer);
      expect(yield* Deferred.isDone(writeInterrupted)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps only the newest metadata state per kind for a stalled consumer", () =>
    Effect.gen(function* () {
      const firstWriteStarted = yield* Deferred.make<void>();
      const releaseFirstWrite = yield* Deferred.make<void>();
      const received: number[] = [];
      const outbox = yield* makeBrowserStreamOutbox<number, number, never, "tabs" | "status">({
        getBufferedBytes: () => 0,
        writeFrame: () => Effect.void,
        writeMeta: (value) =>
          Effect.gen(function* () {
            received.push(value);
            if (value === 0) {
              yield* Deferred.succeed(firstWriteStarted, undefined);
              yield* Deferred.await(releaseFirstWrite);
            }
          }),
      });
      const writer = yield* Effect.forkScoped(outbox.run);

      yield* outbox.offerMeta("tabs", 0);
      yield* Deferred.await(firstWriteStarted);
      for (let value = 1; value <= 1_000; value += 1) {
        yield* outbox.offerMeta("tabs", value);
      }
      yield* outbox.offerMeta("status", -1);
      expect(yield* outbox.pendingMetaCount).toBe(2);

      yield* Deferred.succeed(releaseFirstWrite, undefined);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(received).toEqual([0, 1_000, -1]);
      expect(yield* outbox.pendingMetaCount).toBe(0);
      yield* Fiber.interrupt(writer);
    }).pipe(Effect.scoped),
  );
});
