import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

export const DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES = 256 * 1024;

type OutboundMessage<TFrame, TMeta> =
  | { readonly _tag: "Frame"; readonly value: TFrame }
  | { readonly _tag: "Meta"; readonly value: TMeta };

export interface BrowserStreamOutbox<TFrame, TMeta, E> {
  readonly offerFrame: (frame: TFrame) => Effect.Effect<void>;
  readonly offerMeta: (meta: TMeta) => Effect.Effect<void>;
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
 * A connection-owned writer pump. META messages retain their order, while the
 * frame slot is overwritten on every offer. A slow socket can therefore have
 * one write in progress and one newest frame waiting, never a frame backlog.
 */
export const makeBrowserStreamOutbox = Effect.fn("browserStream.outbox.make")(function* <
  TFrame,
  TMeta,
  E,
>(options: BrowserStreamOutboxOptions<TFrame, TMeta, E>) {
  const wakeup = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
  const threshold = options.bufferThresholdBytes ?? DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES;
  let latestFrame: TFrame | undefined;
  const metadata: TMeta[] = [];

  const signal = Queue.offer(wakeup, undefined).pipe(Effect.asVoid);
  const offerFrame = (frame: TFrame) =>
    Effect.sync(() => {
      latestFrame = frame;
    }).pipe(Effect.andThen(signal));
  const offerMeta = (meta: TMeta) =>
    Effect.sync(() => {
      metadata.push(meta);
    }).pipe(Effect.andThen(signal));

  const takePending = Effect.sync((): OutboundMessage<TFrame, TMeta> | undefined => {
    const meta = metadata.shift();
    if (meta !== undefined) return { _tag: "Meta", value: meta };
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

  return { offerFrame, offerMeta, run } satisfies BrowserStreamOutbox<TFrame, TMeta, E>;
});
