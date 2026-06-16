/**
 * In-memory PreviewManager implementation.
 *
 * Sessions are keyed by `(threadId, tabId)`; a single thread can host
 * multiple tabs (browser-style). `open` always creates a new tab — tab
 * lifecycle is owned by the renderer.
 *
 * Events are published via Effect's `PubSub`, so subscriber failures are
 * isolated from the publishing call (a closed WS subscriber queue cannot
 * fail an in-progress `navigate()`).
 */
import {
  type PreviewCloseInput,
  type PreviewEvent,
  type PreviewError,
  type PreviewHistoryInput,
  PreviewInvalidUrlError,
  type PreviewKeyboardInput,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  PreviewRemoteHostUnavailableError,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  newPreviewTabId,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
} from "@t3tools/shared/preview";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  PubSub,
  type Scope,
  Stream,
  SynchronizedRef,
} from "effect";

import { SteelBrowser, type SteelBrowserNavigationState } from "./SteelBrowser.ts";

export interface PreviewManagerShape {
  readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly navigate: (
    input: PreviewNavigateInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly reportStatus: (input: PreviewReportStatusInput) => Effect.Effect<void, PreviewError>;
  readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
  readonly goBack: (
    input: PreviewHistoryInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly goForward: (
    input: PreviewHistoryInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly keyboardInput: (input: PreviewKeyboardInput) => Effect.Effect<void, PreviewError>;
  readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
  readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
  readonly events: Stream.Stream<PreviewEvent>;
  readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "salchi/preview/Manager/PreviewManager",
) {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
  readonly steel: SteelSessionState | null;
}

interface SteelSessionState {
  readonly sessionId: string;
  readonly websocketUrl: string;
  readonly viewportSize?: PreviewSessionViewportSize | undefined;
}

interface PreviewSessionViewportSize {
  readonly width: number;
  readonly height: number;
}

const viewportSizesEqual = (
  left: PreviewSessionViewportSize | undefined,
  right: PreviewSessionViewportSize | undefined,
): boolean => left?.width === right?.width && left?.height === right?.height;

const buildSteelHost = (input: {
  readonly sessionId: string;
  readonly viewerUrl: string;
  readonly viewportSize?: PreviewSessionViewportSize | undefined;
}): Extract<PreviewSessionSnapshot["host"], { _tag: "Steel" }> => ({
  _tag: "Steel",
  sessionId: input.sessionId,
  viewerUrl: input.viewerUrl,
  ...(input.viewportSize !== undefined ? { viewportSize: input.viewportSize } : {}),
});

interface ManagerState {
  /** All sessions across every thread, keyed by `${threadId}\u0000${tabId}`. */
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
}

const initialState: ManagerState = { sessions: new Map() };

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

const sessionsForThread = (
  state: ManagerState,
  threadId: string,
): ReadonlyArray<PreviewSessionState> => {
  const out: PreviewSessionState[] = [];
  for (const session of state.sessions.values()) {
    if (session.threadId === threadId) out.push(session);
  }
  return out;
};

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) =>
      new PreviewInvalidUrlError({
        rawUrl,
        detail:
          cause instanceof PreviewUrlNormalizationError
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : String(cause),
      }),
  });

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const buildLoadingSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Loading", url: input.url, title: input.title },
  canGoBack: false,
  canGoForward: false,
  updatedAt: input.updatedAt,
});

const buildSuccessSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly host?: PreviewSessionSnapshot["host"];
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  ...(input.host !== undefined ? { host: input.host } : {}),
  navStatus: { _tag: "Success", url: input.url, title: input.title },
  canGoBack: input.canGoBack ?? false,
  canGoForward: input.canGoForward ?? false,
  updatedAt: input.updatedAt,
});

const buildIdleSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: input.updatedAt,
});

const make = Effect.gen(function* PreviewManagerMake() {
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  const steelBrowser = yield* SteelBrowser;
  // Unbounded PubSub is fine here — events are tiny and we don't want to
  // block publishers if a subscriber is slow. WS clients backpressure on
  // their own queues downstream.
  const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>();
  const events: Stream.Stream<PreviewEvent> = Stream.fromPubSub(eventsPubSub);

  /**
   * Atomic read-modify-write over the session for `(threadId, tabId)`. The
   * mutator runs under the SynchronizedRef so concurrent writers cannot
   * interleave. Lookup failures travel through the modify result so both
   * branches yield the same `[A, S]` shape `modifyEffect` requires.
   *
   * The event is published INSIDE the lock so observers see events in the
   * same order as the underlying state transitions. Publishing an unbounded
   * PubSub is non-blocking, so this is cheap.
   */
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (
      session: PreviewSessionState,
    ) => Effect.Effect<{ next: PreviewSessionState; emit: PreviewEvent | null; result: R }, E>,
  ): Effect.Effect<R, E | PreviewSessionLookupError> => {
    type ModifyResult =
      | { kind: "fail"; error: PreviewSessionLookupError }
      | { kind: "ok"; result: R };

    return SynchronizedRef.modifyEffect(stateRef, (state) => {
      const session = state.sessions.get(compositeKey(threadId, tabId));
      if (!session) {
        return Effect.succeed([
          { kind: "fail", error: new PreviewSessionLookupError({ threadId, tabId }) },
          state,
        ] as readonly [ModifyResult, ManagerState]);
      }
      return mutator(session).pipe(
        Effect.flatMap(
          Effect.fn("PreviewManager.commitMutation")(function* ({ next, emit, result }) {
            if (emit) yield* PubSub.publish(eventsPubSub, emit);
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            return [{ kind: "ok", result } as ModifyResult, { sessions }] as readonly [
              ModifyResult,
              ManagerState,
            ];
          }),
        ),
      );
    }).pipe(
      Effect.flatMap((modify) =>
        modify.kind === "fail" ? Effect.fail(modify.error) : Effect.succeed(modify.result),
      ),
    );
  };

  const getExistingSession = (
    threadId: string,
    tabId: string,
  ): Effect.Effect<PreviewSessionState, PreviewSessionLookupError> =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.flatMap((state) => {
        const session = state.sessions.get(compositeKey(threadId, tabId));
        return session
          ? Effect.succeed(session)
          : Effect.fail(new PreviewSessionLookupError({ threadId, tabId }));
      }),
    );

  const requireSteelSession = (
    session: PreviewSessionState,
  ): Effect.Effect<SteelSessionState, PreviewRemoteHostUnavailableError> =>
    session.steel !== null
      ? Effect.succeed(session.steel)
      : Effect.fail(
          new PreviewRemoteHostUnavailableError({
            host: "steel",
            detail: "This preview tab is not backed by a Steel session.",
          }),
        );

  const snapshotFromSteelNavigation = (
    session: PreviewSessionState,
    navigation: SteelBrowserNavigationState,
    updatedAt: string,
  ): PreviewSessionSnapshot => {
    const fallbackUrl =
      session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.url;
    const fallbackTitle =
      session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
    return {
      threadId: session.threadId,
      tabId: session.tabId,
      ...(session.snapshot.host !== undefined ? { host: session.snapshot.host } : {}),
      navStatus: {
        _tag: "Success",
        url: navigation.url || fallbackUrl,
        title: navigation.title || fallbackTitle,
      },
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward,
      updatedAt,
    };
  };

  const commitSteelNavigation = (
    threadId: string,
    tabId: string,
    navigation: SteelBrowserNavigationState,
  ): Effect.Effect<PreviewSessionSnapshot, PreviewSessionLookupError> =>
    mutateExistingSession(
      threadId,
      tabId,
      Effect.fn("PreviewManager.commitSteelNavigation")(function* (session) {
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot = snapshotFromSteelNavigation(session, navigation, updatedAt);
        return {
          next: { ...session, snapshot },
          emit: {
            type: "navigated",
            threadId: session.threadId,
            tabId: session.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          },
          result: snapshot,
        };
      }),
    );

  const open: PreviewManagerShape["open"] = Effect.fn("PreviewManager.open")(function* (input) {
    const tabId = newPreviewTabId();
    const updatedAt = yield* currentIsoTimestamp;
    const url = input.url ? yield* normalizeUrl(input.url) : undefined;

    if (input.hostPreference === "steel") {
      const steelSession = yield* steelBrowser.createMobileSession({
        viewportSize: input.viewportSize,
      });
      const host = buildSteelHost({
        sessionId: steelSession.sessionId,
        viewerUrl: steelSession.viewerUrl,
        viewportSize: input.viewportSize,
      });

      const steelNavigation =
        url !== undefined
          ? yield* steelBrowser
              .navigate({
                sessionId: steelSession.sessionId,
                websocketUrl: steelSession.websocketUrl,
                url,
                viewportSize: input.viewportSize,
              })
              .pipe(
                Effect.catch((error) =>
                  steelBrowser
                    .release({ sessionId: steelSession.sessionId })
                    .pipe(Effect.flatMap(() => Effect.fail(error))),
                ),
              )
          : null;

      const snapshot =
        steelNavigation !== null
          ? buildSuccessSnapshot({
              threadId: input.threadId,
              tabId,
              url: steelNavigation.url || url || steelNavigation.url,
              title: steelNavigation.title,
              updatedAt,
              host,
              canGoBack: steelNavigation.canGoBack,
              canGoForward: steelNavigation.canGoForward,
            })
          : {
              ...buildIdleSnapshot({ threadId: input.threadId, tabId, updatedAt }),
              host,
            };

      yield* SynchronizedRef.update(stateRef, (state) => {
        const sessions = new Map(state.sessions);
        sessions.set(compositeKey(input.threadId, tabId), {
          threadId: input.threadId,
          tabId,
          snapshot,
          steel: {
            sessionId: steelSession.sessionId,
            websocketUrl: steelSession.websocketUrl,
            viewportSize: input.viewportSize,
          },
        });
        return { sessions };
      });
      yield* PubSub.publish(eventsPubSub, {
        type: "opened",
        threadId: input.threadId,
        tabId,
        createdAt: snapshot.updatedAt,
        snapshot,
      });
      return snapshot;
    }

    const snapshot = url
      ? buildLoadingSnapshot({
          threadId: input.threadId,
          tabId,
          url,
          title: "",
          updatedAt,
        })
      : buildIdleSnapshot({ threadId: input.threadId, tabId, updatedAt });
    yield* SynchronizedRef.update(stateRef, (state) => {
      const sessions = new Map(state.sessions);
      sessions.set(compositeKey(input.threadId, tabId), {
        threadId: input.threadId,
        tabId,
        snapshot,
        steel: null,
      });
      return { sessions };
    });
    yield* PubSub.publish(eventsPubSub, {
      type: "opened",
      threadId: input.threadId,
      tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    return snapshot;
  });

  const navigate: PreviewManagerShape["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      const existing = yield* getExistingSession(input.threadId, input.tabId);
      let nextSteel = existing.steel;
      let nextHost = existing.snapshot.host;
      let steelNavigation: SteelBrowserNavigationState | null = null;
      let releaseAfterCommit: string | null = null;
      if (existing.steel !== null) {
        const targetViewportSize = input.viewportSize ?? existing.steel.viewportSize;
        const shouldReplaceSteelSession =
          input.viewportSize !== undefined &&
          !viewportSizesEqual(existing.steel.viewportSize, input.viewportSize);

        if (shouldReplaceSteelSession) {
          const replacement = yield* steelBrowser.createMobileSession({
            viewportSize: input.viewportSize,
          });
          steelNavigation = yield* steelBrowser
            .navigate({
              sessionId: replacement.sessionId,
              websocketUrl: replacement.websocketUrl,
              url,
              viewportSize: input.viewportSize,
            })
            .pipe(
              Effect.catch((error) =>
                steelBrowser
                  .release({ sessionId: replacement.sessionId })
                  .pipe(Effect.flatMap(() => Effect.fail(error))),
              ),
            );
          nextSteel = {
            sessionId: replacement.sessionId,
            websocketUrl: replacement.websocketUrl,
            viewportSize: input.viewportSize,
          };
          nextHost = buildSteelHost({
            sessionId: replacement.sessionId,
            viewerUrl: replacement.viewerUrl,
            viewportSize: input.viewportSize,
          });
          releaseAfterCommit = existing.steel.sessionId;
        } else {
          steelNavigation = yield* steelBrowser.navigate({
            sessionId: existing.steel.sessionId,
            websocketUrl: existing.steel.websocketUrl,
            url,
            viewportSize: targetViewportSize,
          });
        }
      }
      const snapshot = yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = steelNavigation?.title ?? input.resolvedTitle ?? previousTitle;
          const snapshot: PreviewSessionSnapshot = {
            threadId: session.threadId,
            tabId: session.tabId,
            ...(nextHost !== undefined ? { host: nextHost } : {}),
            navStatus: { _tag: "Success", url: steelNavigation?.url || url, title: resolvedTitle },
            canGoBack: steelNavigation?.canGoBack ?? session.snapshot.canGoBack,
            canGoForward: steelNavigation?.canGoForward ?? session.snapshot.canGoForward,
            updatedAt,
          };
          return {
            next: {
              ...session,
              snapshot,
              steel: nextSteel,
            },
            emit: {
              type: "navigated",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
      if (releaseAfterCommit !== null) {
        yield* steelBrowser
          .release({ sessionId: releaseAfterCommit })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return snapshot;
    },
  );

  const reportStatus: PreviewManagerShape["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          threadId: session.threadId,
          tabId: session.tabId,
          ...(session.snapshot.host !== undefined ? { host: session.snapshot.host } : {}),
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          updatedAt,
        };
        const emit: PreviewEvent =
          input.navStatus._tag === "LoadFailed"
            ? {
                type: "failed",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                url: input.navStatus.url,
                title: input.navStatus.title,
                code: input.navStatus.code,
                description: input.navStatus.description,
              }
            : {
                type: "navigated",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                snapshot,
              };
        return {
          next: { ...session, snapshot },
          emit,
          result: undefined as void,
        };
      }),
    );
  });

  const refresh: PreviewManagerShape["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      // Verify the session exists; the desktop bridge handles the actual reload
      // and will report progress back via `reportStatus`.
      const existing = yield* getExistingSession(input.threadId, input.tabId);
      if (existing.steel === null) {
        yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
          Effect.succeed({ next: session, emit: null, result: undefined as void }),
        );
        return;
      }
      if (existing.snapshot.navStatus._tag !== "Idle") {
        const navigation = yield* steelBrowser.reload({
          sessionId: existing.steel.sessionId,
          websocketUrl: existing.steel.websocketUrl,
          viewportSize: existing.steel.viewportSize,
        });
        yield* commitSteelNavigation(input.threadId, input.tabId, navigation).pipe(Effect.asVoid);
        return;
      }
      yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: undefined as void }),
      );
    },
  );

  const goBack: PreviewManagerShape["goBack"] = Effect.fn("PreviewManager.goBack")(
    function* (input) {
      const existing = yield* getExistingSession(input.threadId, input.tabId);
      const steel = yield* requireSteelSession(existing);
      const navigation = yield* steelBrowser.goBack({
        sessionId: steel.sessionId,
        websocketUrl: steel.websocketUrl,
        viewportSize: steel.viewportSize,
      });
      return yield* commitSteelNavigation(input.threadId, input.tabId, navigation);
    },
  );

  const goForward: PreviewManagerShape["goForward"] = Effect.fn("PreviewManager.goForward")(
    function* (input) {
      const existing = yield* getExistingSession(input.threadId, input.tabId);
      const steel = yield* requireSteelSession(existing);
      const navigation = yield* steelBrowser.goForward({
        sessionId: steel.sessionId,
        websocketUrl: steel.websocketUrl,
        viewportSize: steel.viewportSize,
      });
      return yield* commitSteelNavigation(input.threadId, input.tabId, navigation);
    },
  );

  const keyboardInput: PreviewManagerShape["keyboardInput"] = Effect.fn(
    "PreviewManager.keyboardInput",
  )(function* (input) {
    const existing = yield* getExistingSession(input.threadId, input.tabId);
    const steel = yield* requireSteelSession(existing);
    yield* steelBrowser.keyboardInput({
      sessionId: steel.sessionId,
      websocketUrl: steel.websocketUrl,
      action: input.action,
    });
  });

  const close: PreviewManagerShape["close"] = Effect.fn("PreviewManager.close")(function* (input) {
    const createdAt = yield* currentIsoTimestamp;
    const { events, steelSessions } = yield* SynchronizedRef.modify(stateRef, (state) => {
      const eventsToEmit: PreviewEvent[] = [];
      const steelSessionsToRelease: SteelSessionState[] = [];
      const sessions = new Map(state.sessions);
      const targets = input.tabId
        ? [state.sessions.get(compositeKey(input.threadId, input.tabId))].filter(
            (entry): entry is PreviewSessionState => entry !== undefined,
          )
        : sessionsForThread(state, input.threadId);
      for (const target of targets) {
        sessions.delete(compositeKey(target.threadId, target.tabId));
        if (target.steel !== null) steelSessionsToRelease.push(target.steel);
        eventsToEmit.push({
          type: "closed",
          threadId: target.threadId,
          tabId: target.tabId,
          createdAt,
        });
      }
      if (eventsToEmit.length === 0) {
        return [{ events: eventsToEmit, steelSessions: steelSessionsToRelease }, state] as const;
      }
      return [
        { events: eventsToEmit, steelSessions: steelSessionsToRelease },
        { sessions },
      ] as const;
    });
    if (events.length > 0) {
      yield* Effect.forEach(events, (event) => PubSub.publish(eventsPubSub, event), {
        discard: true,
      });
    }
    if (steelSessions.length > 0) {
      yield* Effect.forEach(
        steelSessions,
        (session) => steelBrowser.release({ sessionId: session.sessionId }),
        { discard: true },
      );
    }
  });

  const list: PreviewManagerShape["list"] = Effect.fn("PreviewManager.list")(function* (input) {
    return yield* SynchronizedRef.get(stateRef).pipe(
      Effect.map(
        (state): PreviewListResult => ({
          sessions: sessionsForThread(state, input.threadId)
            .map((s) => s.snapshot)
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
        }),
      ),
    );
  });

  return {
    open,
    navigate,
    reportStatus,
    refresh,
    goBack,
    goForward,
    keyboardInput,
    close,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  } satisfies PreviewManagerShape;
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
