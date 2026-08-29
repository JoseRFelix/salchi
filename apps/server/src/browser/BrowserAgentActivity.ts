import type { BrowserAgentActivity, ThreadId } from "@salchi/contracts";
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
  readonly originThreadId: ThreadId;
}

export interface BrowserAgentActivityController {
  readonly recordCommand: (originThreadId: ThreadId) => Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
  readonly changes: Stream.Stream<BrowserAgentActivity>;
  readonly getActive: Effect.Effect<boolean>;
}

export const makeBrowserAgentActivityController = Effect.fn("browserAgentActivity.make")(function* (
  threadId: ThreadId,
  options?: {
    readonly activeWindowMillis?: number;
    readonly endDebounceMillis?: number;
    readonly onTransition?: (active: boolean) => Effect.Effect<void>;
  },
) {
  const activeWindowMillis = options?.activeWindowMillis ?? BROWSER_AGENT_ACTIVE_WINDOW_MILLIS;
  const endDebounceMillis =
    options?.endDebounceMillis ?? BROWSER_AGENT_ACTIVITY_END_DEBOUNCE_MILLIS;
  const stateRef = yield* Ref.make<BrowserAgentActivityState>({
    active: false,
    lastCommandAt: null,
    originThreadId: threadId,
  });
  const wakeup = yield* Effect.acquireRelease(Queue.sliding<void>(1), (queue) =>
    Queue.shutdown(queue).pipe(Effect.asVoid),
  );
  const activity = yield* Effect.acquireRelease(
    PubSub.sliding<BrowserAgentActivity>({ capacity: 1, replay: 1 }),
    PubSub.shutdown,
  );
  yield* PubSub.publish(activity, { threadId, agentActive: false });

  const wake = Queue.offer(wakeup, undefined).pipe(Effect.asVoid);
  const publish = (event: BrowserAgentActivity) =>
    (options?.onTransition?.(event.agentActive) ?? Effect.void).pipe(
      Effect.andThen(PubSub.publish(activity, event)),
      Effect.asVoid,
    );

  const recordCommand = (originThreadId: ThreadId) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.modify(stateRef, (state) => {
          const event =
            !state.active || state.originThreadId !== originThreadId
              ? ({ threadId: originThreadId, agentActive: true } satisfies BrowserAgentActivity)
              : null;
          return [event, { active: true, lastCommandAt: now, originThreadId }] as const;
        }),
      ),
      Effect.flatMap((event) => (event === null ? Effect.void : publish(event))),
      Effect.andThen(wake),
    );

  const reset = Ref.modify(
    stateRef,
    (state) =>
      [
        state.active
          ? ({
              threadId: state.originThreadId,
              agentActive: false,
            } satisfies BrowserAgentActivity)
          : null,
        { ...state, active: false, lastCommandAt: null },
      ] as const,
  ).pipe(
    Effect.flatMap((event) => (event === null ? Effect.void : publish(event))),
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

        const transition = yield* Ref.modify(stateRef, (current) => {
          if (
            !current.active ||
            current.lastCommandAt === null ||
            current.lastCommandAt + activeWindowMillis + endDebounceMillis > now
          ) {
            return [null, current] as const;
          }
          return [
            {
              threadId: current.originThreadId,
              agentActive: false,
            } satisfies BrowserAgentActivity,
            { ...current, active: false },
          ] as const;
        });
        if (transition !== null) yield* publish(transition);
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
});
