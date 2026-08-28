import {
  BrowserCrashed,
  type BrowserHistoryAction,
  BrowserOperationError,
  BrowserUnavailable,
  ThreadNotFound,
  type BrowserExecutableInfo,
  type BrowserInputEvent,
  type BrowserOperationError as BrowserOperationErrorType,
  type BrowserRpcError,
  type BrowserSessionState,
  type BrowserSessionStatus,
  type BrowserTab,
  type BrowserViewportEvent,
  type BrowserViewportFrame,
  ThreadId,
} from "@salchi/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as NetService from "@salchi/shared/Net";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { reapManagedChildProcesses } from "../../process/ManagedChildProcessRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeBrowserIdleController, type BrowserIdleController } from "../BrowserIdle.ts";
import {
  browserMonotonicMillis,
  browserStreamDebugEnabled,
  getBrowserFrameTiming,
  installBrowserEventLoopLagMonitor,
  logBrowserHandlerTiming,
  recordBrowserFrameTiming,
} from "../BrowserStreamDiagnostics.ts";
import { isBrowserRootThread, resolveBrowserRootThreadId } from "../BrowserThreadRoot.ts";
import {
  launchPlaywrightBrowser,
  type BrowserRuntime,
  type BrowserRuntimeCallbacks,
  type PlaywrightBrowserLaunchInput,
} from "../PlaywrightBrowserRuntime.ts";
import { makeLatestViewportMailbox, type LatestViewportMailbox } from "../LatestViewportMailbox.ts";
import {
  BrowserSessionManager,
  type BrowserSessionManagerShape,
} from "../Services/BrowserSessionManager.ts";

export interface BrowserManagerLaunchConfig {
  readonly idleTimeoutMillis: number;
  readonly userDataDirectory: string;
  readonly processRegistryDirectory: string;
  readonly environmentExecutablePath?: string | undefined;
  readonly settingExecutablePath?: string | undefined;
  readonly noSandbox: boolean;
  readonly serverHost?: string | undefined;
  readonly serverPort: number;
}

export interface BrowserSessionManagerOptions {
  readonly resolveRootThreadId?: (threadId: ThreadId) => Effect.Effect<ThreadId, BrowserRpcError>;
  readonly threadExists: (threadId: ThreadId) => Effect.Effect<boolean, BrowserOperationErrorType>;
  readonly getLaunchConfig: (
    threadId: ThreadId,
  ) => Effect.Effect<BrowserManagerLaunchConfig, BrowserOperationErrorType>;
  readonly launchRuntime: (
    input: PlaywrightBrowserLaunchInput,
  ) => Effect.Effect<BrowserRuntime, BrowserUnavailable | BrowserOperationErrorType, Scope.Scope>;
}

interface SessionLifecycle {
  active: boolean;
  frameSequence: number;
}

interface StartingBrowserSession {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly deferred: Deferred.Deferred<BrowserSessionState, BrowserRpcError>;
  readonly lifecycle: SessionLifecycle;
  readonly launchFiber: Fiber.Fiber<void, never> | undefined;
}

interface RunningBrowserSession {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly runtime: BrowserRuntime;
  readonly idle: BrowserIdleController;
  readonly lifecycle: SessionLifecycle;
}

interface BrowserEntry {
  readonly threadId: ThreadId;
  readonly status: BrowserSessionStatus;
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly executable: BrowserExecutableInfo | null;
  readonly error: string | undefined;
  readonly mailbox: LatestViewportMailbox;
  readonly subscriberCount: number;
  readonly agentConnectionIds: ReadonlySet<string>;
  readonly starting: StartingBrowserSession | undefined;
  readonly session: RunningBrowserSession | undefined;
}

const isBrowserUnavailable = Schema.is(BrowserUnavailable);
const isBrowserOperationError = Schema.is(BrowserOperationError);

type StartDecision =
  | { readonly _tag: "Immediate"; readonly state: BrowserSessionState }
  | {
      readonly _tag: "Await";
      readonly deferred: Deferred.Deferred<BrowserSessionState, BrowserRpcError>;
    };

function snapshot(
  entry: BrowserEntry,
  options?: { readonly includeCdpWebSocketUrl?: boolean },
): BrowserSessionState {
  return {
    threadId: entry.threadId,
    status: entry.status,
    tabs: entry.tabs,
    executable: entry.executable,
    ...(options?.includeCdpWebSocketUrl === true && entry.session !== undefined
      ? { cdpWebSocketUrl: entry.session.runtime.cdpWebSocketUrl }
      : {}),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

function stateForRequestedThread(
  state: BrowserSessionState,
  requestedThreadId: ThreadId,
): BrowserSessionState {
  return state.threadId === requestedThreadId ? state : { ...state, threadId: requestedThreadId };
}

function viewportEventForRequestedThread(
  event: BrowserViewportEvent,
  requestedThreadId: ThreadId,
): BrowserViewportEvent {
  if (event.threadId === requestedThreadId) return event;
  switch (event._tag) {
    case "Frame": {
      const requestedFrame: BrowserViewportFrame = {
        ...event,
        threadId: requestedThreadId,
      };
      const timing = getBrowserFrameTiming(event);
      if (timing !== undefined) recordBrowserFrameTiming(requestedFrame, timing);
      return requestedFrame;
    }
    case "Tabs":
      return { ...event, threadId: requestedThreadId };
    case "Status":
      return { ...event, threadId: requestedThreadId };
  }
}

function makeOperationError(threadId: ThreadId, message: string, cause?: unknown) {
  return new BrowserOperationError({
    threadId,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function profileThreadIdFromDirectory(profileDirectory: string): ThreadId | undefined {
  try {
    const decoded = decodeURIComponent(profileDirectory);
    return decoded.trim().length > 0 ? ThreadId.make(decoded) : undefined;
  } catch {
    return undefined;
  }
}

function launchFailureFromCause(
  threadId: ThreadId,
  cause: Cause.Cause<BrowserUnavailable | BrowserOperationErrorType>,
): BrowserUnavailable | BrowserOperationErrorType {
  const error = Cause.squash(cause);
  if (isBrowserUnavailable(error) || isBrowserOperationError(error)) return error;
  return makeOperationError(
    threadId,
    Cause.hasInterruptsOnly(cause) ? "Browser start was interrupted." : "Browser start failed.",
    cause,
  );
}

export const makeBrowserSessionManagerWithOptions = Effect.fn(
  "browserSessionManager.makeWithOptions",
)(function* (options: BrowserSessionManagerOptions) {
  const managerScope = yield* Scope.Scope;
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);
  const entriesRef = yield* SynchronizedRef.make(new Map<string, BrowserEntry>());
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const resolvedThreadIds = new Map<string, ThreadId>();
  const streamDebug = browserStreamDebugEnabled();
  let nextSessionId = 0;

  const resolveThreadId = (
    requestedThreadId: ThreadId,
  ): Effect.Effect<ThreadId, BrowserRpcError> => {
    const cached = resolvedThreadIds.get(requestedThreadId);
    if (cached !== undefined) return Effect.succeed(cached);
    const resolve =
      options.resolveRootThreadId ?? ((threadId: ThreadId) => Effect.succeed(threadId));
    return resolve(requestedThreadId).pipe(
      Effect.tap((rootThreadId) =>
        Effect.sync(() => {
          resolvedThreadIds.set(requestedThreadId, rootThreadId);
          resolvedThreadIds.set(rootThreadId, rootThreadId);
        }),
      ),
    );
  };

  const runStateOperation = (
    requestedThreadId: ThreadId,
    operation: (rootThreadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>,
  ): Effect.Effect<BrowserSessionState, BrowserRpcError> =>
    Effect.flatMap(resolveThreadId(requestedThreadId), operation).pipe(
      Effect.map((state) => stateForRequestedThread(state, requestedThreadId)),
    );

  const scheduleInManager = <A, E>(effect: Effect.Effect<A, E>) => {
    void runFork(effect.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(managerScope)));
  };

  const getThreadSemaphore = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (locks) => {
      const current = locks.get(threadId);
      if (current !== undefined) return Effect.succeed([current, locks] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(locks);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withThreadLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const getEntry = (threadId: ThreadId) =>
    SynchronizedRef.get(entriesRef).pipe(Effect.map((entries) => entries.get(threadId)));

  const setEntry = (entry: BrowserEntry) =>
    SynchronizedRef.update(entriesRef, (entries) => {
      const next = new Map(entries);
      next.set(entry.threadId, entry);
      return next;
    });

  const getOrCreateEntry = Effect.fn("browserSessionManager.getOrCreateEntry")(function* (
    threadId: ThreadId,
  ) {
    const current = yield* getEntry(threadId);
    if (current !== undefined) return current;
    const mailbox = yield* makeLatestViewportMailbox(threadId).pipe(
      Effect.provideService(Scope.Scope, managerScope),
    );
    const entry: BrowserEntry = {
      threadId,
      status: "stopped",
      tabs: [],
      executable: null,
      error: undefined,
      mailbox,
      subscriberCount: 0,
      agentConnectionIds: new Set(),
      starting: undefined,
      session: undefined,
    };
    yield* setEntry(entry);
    return entry;
  });

  const requireThread = Effect.fn("browserSessionManager.requireThread")(function* (
    threadId: ThreadId,
  ) {
    if (yield* options.threadExists(threadId)) return;
    return yield* new ThreadNotFound({
      threadId,
      message: `Thread ${threadId} was not found.`,
    });
  });

  const closeScope = (scope: Scope.Closeable, exit: Exit.Exit<unknown, unknown> = Exit.void) =>
    Scope.close(scope, exit).pipe(Effect.ignore);

  const stopMatchingSession = Effect.fn("browserSessionManager.stopMatching")(function* (
    threadId: ThreadId,
    expectedSessionId?: number,
  ) {
    return yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = yield* getEntry(threadId);
        if (entry === undefined) return undefined;
        const currentId = entry.session?.id ?? entry.starting?.id;
        if (expectedSessionId !== undefined && currentId !== expectedSessionId) return undefined;
        if (entry.session !== undefined) entry.session.lifecycle.active = false;
        if (entry.starting !== undefined) {
          entry.starting.lifecycle.active = false;
          Deferred.doneUnsafe(
            entry.starting.deferred,
            Effect.fail(makeOperationError(threadId, "Browser start was stopped.")),
          );
        }
        const next: BrowserEntry = {
          ...entry,
          status: "stopped",
          tabs: [],
          executable: null,
          error: undefined,
          starting: undefined,
          session: undefined,
        };
        yield* setEntry(next);
        next.mailbox.publishTabs([]);
        next.mailbox.publishStatus("stopped");
        const launchFiber = entry.starting?.launchFiber;
        if (launchFiber !== undefined) {
          yield* Fiber.interrupt(launchFiber).pipe(Effect.ignore);
        }
        const sessionScope = entry.session?.scope ?? entry.starting?.scope;
        if (sessionScope !== undefined) yield* closeScope(sessionScope);
        return snapshot(next);
      }),
    );
  });

  const handleCrashed = Effect.fn("browserSessionManager.handleCrashed")(function* (
    threadId: ThreadId,
    sessionId: number,
    message: string,
  ) {
    yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = yield* getEntry(threadId);
        if (entry?.session?.id !== sessionId || entry.status !== "running") return undefined;
        entry.session.lifecycle.active = false;
        for (const _connectionId of entry.agentConnectionIds) {
          yield* entry.session.idle.agentConnectionRemoved;
        }
        const next: BrowserEntry = {
          ...entry,
          status: "crashed",
          error: message,
          agentConnectionIds: new Set(),
          session: undefined,
        };
        yield* setEntry(next);
        next.mailbox.publishStatus("crashed", message);
        yield* closeScope(entry.session.scope);
      }),
    );
  });

  const completeLaunchFailure = Effect.fn("browserSessionManager.completeLaunchFailure")(function* (
    threadId: ThreadId,
    sessionId: number,
    scope: Scope.Closeable,
    deferred: Deferred.Deferred<BrowserSessionState, BrowserRpcError>,
    error: BrowserUnavailable | BrowserOperationErrorType,
  ) {
    yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = yield* getEntry(threadId);
        if (entry?.starting?.id === sessionId) {
          entry.starting.lifecycle.active = false;
          const next: BrowserEntry = {
            ...entry,
            status: "stopped",
            tabs: [],
            executable: null,
            error: error.message,
            starting: undefined,
          };
          yield* setEntry(next);
          next.mailbox.publishTabs([]);
          next.mailbox.publishStatus("stopped", error.message);
          yield* closeScope(scope, Exit.fail(error));
        }
        Deferred.doneUnsafe(deferred, Effect.fail(error));
      }),
    );
  });

  const launchSession = Effect.fn("browserSessionManager.launchSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly sessionId: number;
    readonly scope: Scope.Closeable;
    readonly deferred: Deferred.Deferred<BrowserSessionState, BrowserRpcError>;
    readonly lifecycle: SessionLifecycle;
    readonly mailbox: LatestViewportMailbox;
  }) {
    const launchConfig = yield* options.getLaunchConfig(input.threadId);
    const idle = yield* makeBrowserIdleController({
      idleTimeoutMillis: launchConfig.idleTimeoutMillis,
    }).pipe(Effect.provideService(Scope.Scope, input.scope));
    const callbacks: BrowserRuntimeCallbacks = {
      onCdpActivity: () => {
        if (!input.lifecycle.active) return;
        scheduleInManager(idle.recordCdpActivity);
      },
      onFrame: (frame) => {
        if (!input.lifecycle.active) return;
        input.lifecycle.frameSequence += 1;
        const viewportFrame = {
          _tag: "Frame",
          threadId: input.threadId,
          targetId: frame.targetId,
          dataBase64: frame.dataBase64,
          width: frame.width,
          height: frame.height,
          seq: input.lifecycle.frameSequence,
          capturedAt: DateTime.nowUnsafe(),
        } satisfies BrowserViewportFrame;
        const mailboxPublishedAtMonotonicMillis = streamDebug ? browserMonotonicMillis() : 0;
        if (streamDebug) {
          recordBrowserFrameTiming(viewportFrame, {
            cdpReceivedAtMonotonicMillis: frame.receivedAtMonotonicMillis,
            mailboxPublishedAtMonotonicMillis,
          });
        }
        input.mailbox.publishFrame(viewportFrame);
        if (streamDebug) {
          scheduleInManager(
            logBrowserHandlerTiming(
              "browser.frame.cdp-receive-to-mailbox-publish",
              frame.receivedAtMonotonicMillis,
              {
                threadId: input.threadId,
                targetId: frame.targetId,
                seq: input.lifecycle.frameSequence,
              },
            ),
          );
        }
      },
      onTabs: (tabs) => {
        if (!input.lifecycle.active) return;
        input.mailbox.publishTabs(tabs);
        scheduleInManager(
          withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const entry = yield* getEntry(input.threadId);
              if (
                entry?.session?.id !== input.sessionId &&
                entry?.starting?.id !== input.sessionId
              ) {
                return;
              }
              yield* setEntry({ ...entry, tabs });
            }),
          ),
        );
      },
      onCrashed: (message) => {
        if (!input.lifecycle.active) return;
        input.lifecycle.active = false;
        scheduleInManager(handleCrashed(input.threadId, input.sessionId, message));
      },
    };
    const runtime = yield* options
      .launchRuntime({
        threadId: input.threadId,
        userDataDirectory: launchConfig.userDataDirectory,
        processRegistryDirectory: launchConfig.processRegistryDirectory,
        environmentExecutablePath: launchConfig.environmentExecutablePath,
        settingExecutablePath: launchConfig.settingExecutablePath,
        noSandbox: launchConfig.noSandbox,
        serverHost: launchConfig.serverHost,
        serverPort: launchConfig.serverPort,
        callbacks,
      })
      .pipe(Effect.provideService(Scope.Scope, input.scope));
    const tabs = yield* runtime.getTabs;

    const installed = yield* withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const entry = yield* getEntry(input.threadId);
        if (entry?.starting?.id !== input.sessionId) return undefined;
        for (let index = 0; index < entry.subscriberCount; index += 1) {
          yield* idle.subscriberAdded;
        }
        for (const _connectionId of entry.agentConnectionIds) {
          yield* idle.agentConnectionAdded;
        }
        if (entry.subscriberCount > 0) yield* runtime.setScreencastEnabled(true);
        yield* idle.recordCdpActivity;
        const next: BrowserEntry = {
          ...entry,
          status: "running",
          tabs,
          executable: runtime.executable,
          error: undefined,
          starting: undefined,
          session: {
            id: input.sessionId,
            scope: input.scope,
            runtime,
            idle,
            lifecycle: input.lifecycle,
          },
        };
        yield* setEntry(next);
        next.mailbox.publishTabs(tabs);
        next.mailbox.publishStatus("running");
        const state = snapshot(next);
        Deferred.doneUnsafe(input.deferred, Effect.succeed(state));
        return state;
      }),
    );
    if (installed === undefined) return;

    yield* idle.awaitIdle.pipe(
      Effect.andThen(
        Effect.forkIn(stopMatchingSession(input.threadId, input.sessionId), managerScope),
      ),
      Effect.asVoid,
      Effect.forkIn(input.scope),
    );
  });

  const startResolved: BrowserSessionManagerShape["start"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* (): Effect.fn.Return<StartDecision, BrowserRpcError> {
        yield* requireThread(threadId);
        const entry = yield* getOrCreateEntry(threadId);
        if (entry.status === "running") {
          return { _tag: "Immediate", state: snapshot(entry) };
        }
        if (entry.starting !== undefined) {
          return { _tag: "Await", deferred: entry.starting.deferred };
        }

        const sessionId = ++nextSessionId;
        const scope = yield* Scope.fork(managerScope, "sequential");
        const deferred = yield* Deferred.make<BrowserSessionState, BrowserRpcError>();
        const lifecycle: SessionLifecycle = { active: true, frameSequence: 0 };
        const starting: StartingBrowserSession = {
          id: sessionId,
          scope,
          deferred,
          lifecycle,
          launchFiber: undefined,
        };
        const startingEntry: BrowserEntry = {
          ...entry,
          status: "starting",
          tabs: [],
          executable: null,
          error: undefined,
          session: undefined,
          starting,
        };
        yield* setEntry(startingEntry);
        entry.mailbox.publishTabs([]);
        entry.mailbox.publishStatus("starting");

        const launchEffect = launchSession({
          threadId,
          sessionId,
          scope,
          deferred,
          lifecycle,
          mailbox: entry.mailbox,
        }).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.sync(() => {
                  Deferred.doneUnsafe(
                    deferred,
                    Effect.fail(makeOperationError(threadId, "Browser start was interrupted.")),
                  );
                });
              }
              return completeLaunchFailure(
                threadId,
                sessionId,
                scope,
                deferred,
                launchFailureFromCause(threadId, cause),
              );
            },
            onSuccess: () => Effect.void,
          }),
        );
        const launchFiber = yield* Effect.forkIn(launchEffect, managerScope);
        yield* setEntry({
          ...startingEntry,
          starting: { ...starting, launchFiber },
        });
        return { _tag: "Await", deferred };
      }),
    ).pipe(
      Effect.flatMap((decision) =>
        decision._tag === "Immediate"
          ? Effect.succeed(decision.state)
          : Deferred.await(decision.deferred),
      ),
    );

  const start: BrowserSessionManagerShape["start"] = (threadId) =>
    runStateOperation(threadId, startResolved);

  const stopResolved: BrowserSessionManagerShape["stop"] = (threadId) =>
    Effect.gen(function* () {
      const entry = yield* withThreadLock(
        threadId,
        Effect.gen(function* () {
          const current = yield* getEntry(threadId);
          if (current !== undefined) return current;
          yield* requireThread(threadId);
          return yield* getOrCreateEntry(threadId);
        }),
      );
      const existing = yield* stopMatchingSession(threadId);
      if (existing !== undefined) return existing;
      return snapshot(entry);
    });

  const stop: BrowserSessionManagerShape["stop"] = (threadId) =>
    runStateOperation(threadId, stopResolved);

  const getStateResolved: BrowserSessionManagerShape["getState"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        yield* requireThread(threadId);
        return snapshot(yield* getOrCreateEntry(threadId), { includeCdpWebSocketUrl: true });
      }),
    );

  const getState: BrowserSessionManagerShape["getState"] = (threadId) =>
    runStateOperation(threadId, getStateResolved);

  const getCdpWebSocketUrlResolved: BrowserSessionManagerShape["getCdpWebSocketUrl"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        yield* requireThread(threadId);
        const entry = yield* getOrCreateEntry(threadId);
        if (entry?.status === "crashed") {
          return yield* new BrowserCrashed({
            threadId,
            message: entry.error ?? "Chromium exited unexpectedly.",
          });
        }
        if (entry?.session === undefined || entry.status !== "running") {
          return yield* makeOperationError(threadId, "Browser session is not running.");
        }
        return entry.session.runtime.cdpWebSocketUrl;
      }),
    );

  const getCdpWebSocketUrl: BrowserSessionManagerShape["getCdpWebSocketUrl"] = (threadId) =>
    Effect.flatMap(resolveThreadId(threadId), getCdpWebSocketUrlResolved);

  const agentConnectionOpenedResolved: BrowserSessionManagerShape["agentConnectionOpened"] = (
    threadId,
    connectionId,
  ) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        yield* requireThread(threadId);
        const entry = yield* getOrCreateEntry(threadId);
        if (entry.session === undefined || entry.status !== "running") {
          return yield* makeOperationError(threadId, "Browser session is not running.");
        }
        if (entry.agentConnectionIds.has(connectionId)) return;
        const agentConnectionIds = new Set(entry.agentConnectionIds);
        agentConnectionIds.add(connectionId);
        yield* setEntry({ ...entry, agentConnectionIds });
        yield* entry.session.idle.agentConnectionAdded;
        yield* entry.session.idle.recordCdpActivity;
      }),
    );

  const agentConnectionOpened: BrowserSessionManagerShape["agentConnectionOpened"] = (
    threadId,
    connectionId,
  ) =>
    Effect.flatMap(resolveThreadId(threadId), (rootThreadId) =>
      agentConnectionOpenedResolved(rootThreadId, connectionId),
    );

  const recordAgentCdpActivityResolved: BrowserSessionManagerShape["recordAgentCdpActivity"] = (
    threadId,
    connectionId,
  ) =>
    Effect.flatMap(getEntry(threadId), (entry) =>
      entry?.session !== undefined && entry.agentConnectionIds.has(connectionId)
        ? entry.session.idle.recordCdpActivity
        : Effect.void,
    );

  const recordAgentCdpActivity: BrowserSessionManagerShape["recordAgentCdpActivity"] = (
    threadId,
    connectionId,
  ) =>
    Effect.flatMap(resolveThreadId(threadId), (rootThreadId) =>
      recordAgentCdpActivityResolved(rootThreadId, connectionId),
    ).pipe(Effect.ignore);

  const agentConnectionClosedResolved: BrowserSessionManagerShape["agentConnectionClosed"] = (
    threadId,
    connectionId,
  ) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = yield* getEntry(threadId);
        if (entry === undefined || !entry.agentConnectionIds.has(connectionId)) return;
        const agentConnectionIds = new Set(entry.agentConnectionIds);
        agentConnectionIds.delete(connectionId);
        yield* setEntry({ ...entry, agentConnectionIds });
        if (entry.session !== undefined) yield* entry.session.idle.agentConnectionRemoved;
      }),
    ).pipe(Effect.ignore);

  const agentConnectionClosed: BrowserSessionManagerShape["agentConnectionClosed"] = (
    threadId,
    connectionId,
  ) =>
    Effect.flatMap(resolveThreadId(threadId), (rootThreadId) =>
      agentConnectionClosedResolved(rootThreadId, connectionId),
    ).pipe(Effect.ignore);

  const withRunningSession = <A>(
    threadId: ThreadId,
    operation: (runtime: BrowserRuntime) => Effect.Effect<A, BrowserRpcError>,
  ): Effect.Effect<BrowserSessionState, BrowserRpcError> =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        yield* requireThread(threadId);
        const entry = yield* getOrCreateEntry(threadId);
        if (entry?.status === "crashed") {
          return yield* new BrowserCrashed({
            threadId,
            message: entry.error ?? "Chromium exited unexpectedly.",
          });
        }
        if (entry?.session === undefined || entry.status !== "running") {
          return yield* makeOperationError(threadId, "Browser session is not running.");
        }
        yield* operation(entry.session.runtime);
        const tabs = yield* entry.session.runtime.getTabs;
        const next = { ...entry, tabs };
        yield* setEntry(next);
        next.mailbox.publishTabs(tabs);
        return snapshot(next);
      }),
    );

  const setActiveTab: BrowserSessionManagerShape["setActiveTab"] = (threadId, targetId) =>
    runStateOperation(threadId, (rootThreadId) =>
      withRunningSession(rootThreadId, (runtime) => runtime.setActiveTab(targetId)),
    );

  const openTab: BrowserSessionManagerShape["openTab"] = (threadId, url) =>
    runStateOperation(threadId, (rootThreadId) =>
      withRunningSession(rootThreadId, (runtime) => runtime.openTab(url)),
    );

  const navigate: BrowserSessionManagerShape["navigate"] = (threadId, targetId, url) =>
    runStateOperation(threadId, (rootThreadId) =>
      withRunningSession(rootThreadId, (runtime) => runtime.navigate(targetId, url)),
    );

  const navigateHistory: BrowserSessionManagerShape["navigateHistory"] = (
    threadId,
    targetId,
    action: BrowserHistoryAction,
  ) =>
    runStateOperation(threadId, (rootThreadId) =>
      withRunningSession(rootThreadId, (runtime) => runtime.navigateHistory(targetId, action)),
    );

  const closeTab: BrowserSessionManagerShape["closeTab"] = (threadId, targetId) =>
    runStateOperation(threadId, (rootThreadId) =>
      withRunningSession(rootThreadId, (runtime) => runtime.closeTab(targetId)),
    );

  const dispatchInput: BrowserSessionManagerShape["dispatchInput"] = (
    threadId,
    targetId,
    event: BrowserInputEvent,
  ) =>
    Effect.flatMap(resolveThreadId(threadId), (rootThreadId) =>
      Effect.gen(function* () {
        const inputReceivedAt = streamDebug ? browserMonotonicMillis() : 0;
        const entry = yield* getEntry(rootThreadId);
        if (entry?.status === "crashed") {
          return yield* new BrowserCrashed({
            threadId: rootThreadId,
            message: entry.error ?? "Chromium exited unexpectedly.",
          });
        }
        if (entry?.session === undefined || entry.status !== "running") {
          return yield* makeOperationError(rootThreadId, "Browser session is not running.");
        }
        yield* entry.session.runtime.dispatchInput(targetId, event);
        if (streamDebug) {
          yield* logBrowserHandlerTiming("browser.input.manager-to-cdp-complete", inputReceivedAt, {
            threadId: rootThreadId,
            targetId,
            inputType: event._tag,
          });
        }
      }),
    );

  const releaseSubscriber = (threadId: ThreadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = yield* getEntry(threadId);
        if (entry === undefined || entry.subscriberCount === 0) return;
        const subscriberCount = entry.subscriberCount - 1;
        const next = { ...entry, subscriberCount };
        yield* setEntry(next);
        if (entry.session !== undefined) {
          yield* entry.session.idle.subscriberRemoved;
          if (subscriberCount === 0) {
            yield* entry.session.runtime.setScreencastEnabled(false).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Failed to stop browser screencast after unsubscribe", {
                  threadId,
                  error: error.message,
                }),
              ),
            );
          }
        }
      }),
    );

  const acquireSubscriber = (threadId: ThreadId) =>
    Effect.suspend(() => {
      let subscriberCountIncremented = false;
      return withThreadLock(
        threadId,
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const entry = yield* getOrCreateEntry(threadId);
          const subscriberCount = entry.subscriberCount + 1;
          yield* setEntry({ ...entry, subscriberCount });
          subscriberCountIncremented = true;
          if (entry.session !== undefined) {
            yield* entry.session.idle.subscriberAdded;
            if (entry.subscriberCount === 0) {
              yield* entry.session.runtime.setScreencastEnabled(true);
            }
          }
          return entry.mailbox;
        }),
      ).pipe(
        Effect.onError(() =>
          subscriberCountIncremented ? releaseSubscriber(threadId) : Effect.void,
        ),
      );
    });

  const subscribeViewport: BrowserSessionManagerShape["subscribeViewport"] = (threadId) =>
    Stream.scoped(
      Stream.fromEffect(
        Effect.acquireRelease(
          Effect.flatMap(resolveThreadId(threadId), (rootThreadId) =>
            acquireSubscriber(rootThreadId).pipe(
              Effect.map((mailbox) => ({ mailbox, rootThreadId })),
            ),
          ),
          ({ rootThreadId }) => releaseSubscriber(rootThreadId),
        ),
      ).pipe(Stream.flatMap(({ mailbox }) => mailbox.stream)),
    ).pipe(Stream.map((event) => viewportEventForRequestedThread(event, threadId)));

  return {
    resolveRootThreadId: resolveThreadId,
    start,
    stop,
    getState,
    getCdpWebSocketUrl,
    agentConnectionOpened,
    recordAgentCdpActivity,
    agentConnectionClosed,
    setActiveTab,
    openTab,
    navigate,
    navigateHistory,
    closeTab,
    dispatchInput,
    subscribeViewport,
  } satisfies BrowserSessionManagerShape;
});

const makeLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const netService = yield* NetService.NetService;
  const profileRoot = path.join(config.baseDir, "userdata", "browser-profiles");
  const processRegistryDirectory = path.join(config.providerStatusCacheDir, "browser-processes");

  yield* Effect.all([
    fileSystem.makeDirectory(profileRoot, { recursive: true }),
    fileSystem.makeDirectory(processRegistryDirectory, { recursive: true }),
  ]).pipe(Effect.orDie);
  yield* installBrowserEventLoopLagMonitor();

  const profileDirectories = yield* fileSystem
    .readDirectory(profileRoot, { recursive: false })
    .pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    profileDirectories,
    (profileDirectory) =>
      Effect.gen(function* () {
        const profileThreadId = profileThreadIdFromDirectory(profileDirectory);
        const thread =
          profileThreadId === undefined
            ? Option.none()
            : yield* projectionSnapshotQuery.getThreadShellById(profileThreadId).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to inspect an existing browser profile owner", {
                    profileDirectory,
                    cause,
                  }).pipe(Effect.as(Option.none())),
                ),
              );
        if (Option.isSome(thread) && isBrowserRootThread(thread.value)) return;
        yield* Effect.logWarning("Browser profile directory has no real root thread", {
          profileDirectory,
          ...(profileThreadId === undefined ? {} : { threadId: profileThreadId }),
        });
      }),
    { discard: true },
  );
  if (process.platform === "linux") {
    yield* reapManagedChildProcesses({ registryDirectory: processRegistryDirectory }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to reconcile orphaned Chromium processes", { cause }),
      ),
    );
  }

  return yield* makeBrowserSessionManagerWithOptions({
    resolveRootThreadId: (threadId) =>
      resolveBrowserRootThreadId(projectionSnapshotQuery, threadId),
    threadExists: (threadId) =>
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map((thread) => Option.isSome(thread) && isBrowserRootThread(thread.value)),
        Effect.mapError((cause) =>
          makeOperationError(threadId, "Failed to look up the browser thread.", cause),
        ),
      ),
    getLaunchConfig: (threadId) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) =>
            makeOperationError(threadId, "Failed to load browser settings.", cause),
          ),
        );
        const userDataDirectory = path.join(profileRoot, encodeURIComponent(threadId));
        yield* fileSystem
          .makeDirectory(userDataDirectory, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              makeOperationError(
                threadId,
                "Failed to create the browser profile directory.",
                cause,
              ),
            ),
          );
        return {
          idleTimeoutMillis: Duration.toMillis(settings.browserIdleTimeout),
          userDataDirectory,
          processRegistryDirectory,
          environmentExecutablePath: process.env.SALCHI_BROWSER_PATH,
          settingExecutablePath: settings.browserExecutablePath,
          noSandbox: process.env.SALCHI_BROWSER_NO_SANDBOX === "1",
          serverHost: config.host,
          serverPort: config.port,
        };
      }),
    launchRuntime: (input) =>
      launchPlaywrightBrowser(input).pipe(Effect.provideService(NetService.NetService, netService)),
  });
});

export const BrowserSessionManagerLive = Layer.effect(BrowserSessionManager, makeLive);
