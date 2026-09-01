import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

export interface BrowserIdleState {
  readonly subscriberCount: number;
  readonly agentConnectionCount: number;
  readonly lastCdpActivityAt: number;
  readonly noSubscribersSince: number | null;
}

export function browserIdleDeadline(
  state: BrowserIdleState,
  idleTimeoutMillis: number,
): number | null {
  if (
    state.subscriberCount > 0 ||
    state.agentConnectionCount > 0 ||
    state.noSubscribersSince === null
  ) {
    return null;
  }
  return Math.max(state.lastCdpActivityAt, state.noSubscribersSince) + idleTimeoutMillis;
}

export function browserIdleRecordCdpActivity(
  state: BrowserIdleState,
  now: number,
): BrowserIdleState {
  return { ...state, lastCdpActivityAt: now };
}

export function browserIdleSubscriberAdded(state: BrowserIdleState): BrowserIdleState {
  return {
    ...state,
    subscriberCount: state.subscriberCount + 1,
    noSubscribersSince: null,
  };
}

export function browserIdleSubscriberRemoved(
  state: BrowserIdleState,
  now: number,
): BrowserIdleState {
  const subscriberCount = Math.max(0, state.subscriberCount - 1);
  return {
    ...state,
    subscriberCount,
    noSubscribersSince: subscriberCount === 0 ? now : null,
  };
}

export function browserIdleAgentConnectionAdded(state: BrowserIdleState): BrowserIdleState {
  return {
    ...state,
    agentConnectionCount: state.agentConnectionCount + 1,
    noSubscribersSince: null,
  };
}

export function browserIdleAgentConnectionRemoved(
  state: BrowserIdleState,
  now: number,
): BrowserIdleState {
  const agentConnectionCount = Math.max(0, state.agentConnectionCount - 1);
  return {
    ...state,
    agentConnectionCount,
    noSubscribersSince: agentConnectionCount === 0 && state.subscriberCount === 0 ? now : null,
  };
}

export interface BrowserIdleController {
  readonly recordCdpActivity: Effect.Effect<void>;
  readonly subscriberAdded: Effect.Effect<void>;
  readonly subscriberRemoved: Effect.Effect<void>;
  readonly agentConnectionAdded: Effect.Effect<void>;
  readonly agentConnectionRemoved: Effect.Effect<void>;
  readonly awaitIdle: Effect.Effect<void>;
  readonly getState: Effect.Effect<BrowserIdleState>;
}

export const makeBrowserIdleController = Effect.fn("browserIdle.make")(function* (input: {
  readonly idleTimeoutMillis: number;
}) {
  const now = yield* Clock.currentTimeMillis;
  const stateRef = yield* Ref.make<BrowserIdleState>({
    subscriberCount: 0,
    agentConnectionCount: 0,
    lastCdpActivityAt: now,
    noSubscribersSince: now,
  });
  const wakeup = yield* Effect.acquireRelease(Queue.sliding<void>(1), (queue) =>
    Queue.shutdown(queue).pipe(Effect.asVoid),
  );
  const wake = Queue.offer(wakeup, undefined).pipe(Effect.asVoid);

  const updateAtCurrentTime = (
    update: (state: BrowserIdleState, now: number) => BrowserIdleState,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((currentTime) => Ref.update(stateRef, (state) => update(state, currentTime))),
      Effect.andThen(wake),
    );

  const awaitIdle: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const deadline = browserIdleDeadline(state, input.idleTimeoutMillis);
      if (deadline === null) {
        yield* Queue.take(wakeup);
        return yield* awaitIdle;
      }

      const currentTime = yield* Clock.currentTimeMillis;
      const remaining = deadline - currentTime;
      if (remaining <= 0) return;
      yield* Effect.raceFirst(Queue.take(wakeup), Effect.sleep(Duration.millis(remaining)));
      return yield* awaitIdle;
    }),
  );

  return {
    recordCdpActivity: updateAtCurrentTime(browserIdleRecordCdpActivity),
    subscriberAdded: Ref.update(stateRef, browserIdleSubscriberAdded).pipe(Effect.andThen(wake)),
    subscriberRemoved: updateAtCurrentTime(browserIdleSubscriberRemoved),
    agentConnectionAdded: Ref.update(stateRef, browserIdleAgentConnectionAdded).pipe(
      Effect.andThen(wake),
    ),
    agentConnectionRemoved: updateAtCurrentTime(browserIdleAgentConnectionRemoved),
    awaitIdle,
    getState: Ref.get(stateRef),
  } satisfies BrowserIdleController;
});
