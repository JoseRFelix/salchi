import type {
  BrowserSessionStatus,
  BrowserTab,
  BrowserViewportEvent,
  BrowserViewportFrame,
  ThreadId,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

interface VersionedViewportState {
  readonly status: BrowserSessionStatus;
  readonly statusError: string | undefined;
  readonly statusRevision: number;
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly tabsRevision: number;
  readonly frame: BrowserViewportFrame | undefined;
  readonly frameRevision: number;
}

interface SeenViewportRevisions {
  readonly status: number;
  readonly tabs: number;
  readonly frame: number;
}

export interface LatestViewportMailbox {
  readonly publishStatus: (status: BrowserSessionStatus, error?: string) => void;
  readonly publishTabs: (tabs: ReadonlyArray<BrowserTab>) => void;
  readonly publishFrame: (frame: BrowserViewportFrame) => void;
  readonly stream: Stream.Stream<BrowserViewportEvent>;
}

export const makeLatestViewportMailbox = Effect.fn("viewportMailbox.make")(function* (
  threadId: ThreadId,
) {
  const wakeup = yield* Effect.acquireRelease(
    PubSub.sliding<number>({ capacity: 1, replay: 1 }),
    PubSub.shutdown,
  );
  let revision = 2;
  let state: VersionedViewportState = {
    status: "stopped",
    statusError: undefined,
    statusRevision: 1,
    tabs: [],
    tabsRevision: 2,
    frame: undefined,
    frameRevision: 0,
  };
  yield* PubSub.publish(wakeup, revision);

  const signal = () => {
    // If a slow subscriber already has a signal queued, dropping this signal is
    // correct: that pull will read the newest immutable snapshot below.
    void PubSub.publishUnsafe(wakeup, revision);
  };

  const publishStatus = (status: BrowserSessionStatus, error?: string) => {
    revision += 1;
    state = {
      ...state,
      status,
      statusError: error,
      statusRevision: revision,
      ...(status === "running"
        ? {}
        : {
            frame: undefined,
            frameRevision: revision,
          }),
    };
    signal();
  };

  const publishTabs = (tabs: ReadonlyArray<BrowserTab>) => {
    revision += 1;
    state = {
      ...state,
      tabs: [...tabs],
      tabsRevision: revision,
    };
    signal();
  };

  const publishFrame = (frame: BrowserViewportFrame) => {
    revision += 1;
    state = {
      ...state,
      frame,
      frameRevision: revision,
    };
    signal();
  };

  const stream = Stream.fromPubSub(wakeup).pipe(
    Stream.map(() => state),
    Stream.mapAccum(
      (): SeenViewportRevisions => ({ status: 0, tabs: 0, frame: 0 }),
      (seen, snapshot) => {
        const events: BrowserViewportEvent[] = [];
        if (snapshot.statusRevision > seen.status) {
          events.push({
            _tag: "Status",
            threadId,
            status: snapshot.status,
            ...(snapshot.statusError === undefined ? {} : { error: snapshot.statusError }),
          });
        }
        if (snapshot.tabsRevision > seen.tabs) {
          events.push({ _tag: "Tabs", threadId, tabs: snapshot.tabs });
        }
        if (snapshot.frame !== undefined && snapshot.frameRevision > seen.frame) {
          events.push(snapshot.frame);
        }
        return [
          {
            status: snapshot.statusRevision,
            tabs: snapshot.tabsRevision,
            frame: snapshot.frameRevision,
          },
          events,
        ] as const;
      },
    ),
  );

  return {
    publishStatus,
    publishTabs,
    publishFrame,
    stream,
  } satisfies LatestViewportMailbox;
});
