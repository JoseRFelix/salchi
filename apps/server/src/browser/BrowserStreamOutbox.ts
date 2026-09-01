import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

export const DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES = 256 * 1024;

type OutboundMessage<TFrame, TMeta> =
  | { readonly _tag: "Frame"; readonly value: TFrame }
  | { readonly _tag: "Meta"; readonly value: TMeta };

export interface BrowserStreamOutbox<TFrame, TMeta, E, TMetaKind extends PropertyKey = string> {
  readonly offerFrame: (frame: TFrame) => Effect.Effect<void>;
  readonly offerMeta: (kind: TMetaKind, meta: TMeta) => Effect.Effect<void>;
  readonly pendingMetaCount: Effect.Effect<number>;
  readonly run: Effect.Effect<void, E>;
}

export interface BrowserStreamOutboxOptions<TFrame, TMeta, E> {
  readonly writeFrame: (frame: TFrame) => Effect.Effect<void, E>;
  readonly writeMeta: (meta: TMeta) => Effect.Effect<void, E>;
  readonly getBufferedBytes: () => number;
  readonly bufferThresholdBytes?: number;
  readonly onFrameSkipped?: (frame: TFrame, bufferedBytes: number) => Effect.Effect<void>;
}

/**
 * A connection-owned writer pump. Frames use one latest-wins slot and META uses
 * one latest-wins slot per kind. A slow socket can therefore have one write in
 * progress, one newest frame, and a fixed number of metadata states waiting.
 */
export const makeBrowserStreamOutbox = Effect.fn("browserStream.outbox.make")(function* <
  TFrame,
  TMeta,
  E,
  TMetaKind extends PropertyKey = string,
>(options: BrowserStreamOutboxOptions<TFrame, TMeta, E>) {
  const wakeup = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
  const threshold = options.bufferThresholdBytes ?? DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES;
  let latestFrame: TFrame | undefined;
  let nextMetaOrder = 0;
  const metadata = new Map<TMetaKind, { readonly order: number; readonly value: TMeta }>();

  const signal = Queue.offer(wakeup, undefined).pipe(Effect.asVoid);
  const offerFrame = (frame: TFrame) =>
    Effect.sync(() => {
      latestFrame = frame;
    }).pipe(Effect.andThen(signal));
  const offerMeta = (kind: TMetaKind, meta: TMeta) =>
    Effect.sync(() => {
      metadata.set(kind, { order: ++nextMetaOrder, value: meta });
    }).pipe(Effect.andThen(signal));

  const takePending = Effect.sync((): OutboundMessage<TFrame, TMeta> | undefined => {
    let oldestKind: TMetaKind | undefined;
    let oldest: { readonly order: number; readonly value: TMeta } | undefined;
    for (const [kind, entry] of metadata) {
      if (oldest === undefined || entry.order < oldest.order) {
        oldestKind = kind;
        oldest = entry;
      }
    }
    if (oldestKind !== undefined && oldest !== undefined) {
      metadata.delete(oldestKind);
      return { _tag: "Meta", value: oldest.value };
    }
    const frame = latestFrame;
    latestFrame = undefined;
    return frame === undefined ? undefined : { _tag: "Frame", value: frame };
  });

  const drain = Effect.suspend(function drainPending(): Effect.Effect<void, E> {
    return takePending.pipe(
      Effect.flatMap((message) => {
        if (message === undefined) return Effect.void;
        if (message._tag === "Meta") {
          return options.writeMeta(message.value).pipe(Effect.andThen(drainPending));
        }

        const bufferedBytes = Math.max(0, options.getBufferedBytes());
        const write =
          bufferedBytes < threshold
            ? options.writeFrame(message.value)
            : (options.onFrameSkipped?.(message.value, bufferedBytes) ?? Effect.void);
        return write.pipe(Effect.andThen(drainPending));
      }),
    );
  });

  const run = Effect.forever(Queue.take(wakeup).pipe(Effect.andThen(drain)));

  return {
    offerFrame,
    offerMeta,
    pendingMetaCount: Effect.sync(() => metadata.size),
    run,
  } satisfies BrowserStreamOutbox<TFrame, TMeta, E, TMetaKind>;
});
