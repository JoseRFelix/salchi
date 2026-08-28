import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export const BROWSER_AGENT_ACTIVE_WINDOW_MILLIS = 4_000;
export const BROWSER_AGENT_ACTIVITY_END_DEBOUNCE_MILLIS = 2_000;

interface BrowserAgentActivityState {
  readonly active: boolean;
  readonly lastCommandAt: number | null;
}

export interface BrowserAgentActivityController {
  readonly recordCommand: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
  readonly changes: Stream.Stream<boolean>;
  readonly getActive: Effect.Effect<boolean>;
}

export const makeBrowserAgentActivityController = Effect.fn("browserAgentActivity.make")(
  function* (options?: {
    readonly activeWindowMillis?: number;
    readonly endDebounceMillis?: number;
  }) {
    const activeWindowMillis = options?.activeWindowMillis ?? BROWSER_AGENT_ACTIVE_WINDOW_MILLIS;
    const endDebounceMillis =
      options?.endDebounceMillis ?? BROWSER_AGENT_ACTIVITY_END_DEBOUNCE_MILLIS;
    const stateRef = yield* Ref.make<BrowserAgentActivityState>({
      active: false,
      lastCommandAt: null,
    });
    const wakeup = yield* Effect.acquireRelease(Queue.sliding<void>(1), (queue) =>
      Queue.shutdown(queue).pipe(Effect.asVoid),
    );
    const activity = yield* Effect.acquireRelease(
      PubSub.sliding<boolean>({ capacity: 1, replay: 1 }),
      PubSub.shutdown,
    );
    yield* PubSub.publish(activity, false);

    const wake = Queue.offer(wakeup, undefined).pipe(Effect.asVoid);
    const publish = (active: boolean) => PubSub.publish(activity, active).pipe(Effect.asVoid);

    const recordCommand = Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.modify(
          stateRef,
          (state) => [!state.active, { active: true, lastCommandAt: now }] as const,
        ),
      ),
      Effect.flatMap((transitioned) => (transitioned ? publish(true) : Effect.void)),
      Effect.andThen(wake),
    );

    const reset = Ref.modify(
      stateRef,
      (state) => [state.active, { active: false, lastCommandAt: null }] as const,
    ).pipe(
      Effect.flatMap((transitioned) => (transitioned ? publish(false) : Effect.void)),
      Effect.andThen(wake),
    );

    const monitor = (): Effect.Effect<never> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          if (!state.active || state.lastCommandAt === null) {
            yield* Queue.take(wakeup);
            return yield* monitor();
          }

          const now = yield* Clock.currentTimeMillis;
          const remaining = state.lastCommandAt + activeWindowMillis + endDebounceMillis - now;
          if (remaining > 0) {
            yield* Effect.raceFirst(Queue.take(wakeup), Effect.sleep(Duration.millis(remaining)));
            return yield* monitor();
          }

          const transitioned = yield* Ref.modify(stateRef, (current) => {
            if (
              !current.active ||
              current.lastCommandAt === null ||
              current.lastCommandAt + activeWindowMillis + endDebounceMillis > now
            ) {
              return [false, current] as const;
            }
            return [true, { active: false, lastCommandAt: current.lastCommandAt }] as const;
          });
          if (transitioned) yield* publish(false);
          return yield* monitor();
        }),
      );

    yield* Effect.forkScoped(monitor(), { startImmediately: true });

    return {
      recordCommand,
      reset,
      changes: Stream.fromPubSub(activity),
      getActive: Ref.get(stateRef).pipe(Effect.map((state) => state.active)),
    } satisfies BrowserAgentActivityController;
  },
);
