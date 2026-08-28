// @effect-diagnostics nodeBuiltinImport:off
import { readlinkSync } from "node:fs";

import {
  type BrowserHistoryAction,
  BrowserOperationError,
  BrowserTabNotFound,
  type BrowserExecutableInfo,
  type BrowserInputEvent,
  type BrowserOperationError as BrowserOperationErrorType,
  type BrowserTab,
  type BrowserTabNotFound as BrowserTabNotFoundType,
  type ThreadId,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as NetService from "@salchi/shared/Net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
} from "playwright-core";

import {
  makeBrowserResolutionCandidates,
  resolveBrowserExecutable,
} from "./BrowserExecutableResolver.ts";
import {
  BROWSER_INPUT_RATE_LIMIT,
  BROWSER_INPUT_RATE_WINDOW_MS,
  makeBrowserInputRateLimiter,
  toBrowserCdpInputCommand,
} from "./BrowserInput.ts";
import { browserFetchInterceptionPatterns, shouldBlockBrowserRequest } from "./NavigationGuard.ts";
import {
  browserMonotonicMillis,
  browserStreamDebugEnabled,
  logBrowserHandlerTiming,
} from "./BrowserStreamDiagnostics.ts";
import {
  browserScreencastEveryNthFrameForStart,
  makeBrowserScreencastFrameRateController,
} from "./BrowserScreencastPolicy.ts";
import { registerManagedChildProcess } from "../process/ManagedChildProcessRegistry.ts";
import { terminateProcessTree } from "../process/ProcessTree.ts";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

interface PageRuntime {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly targetId: string;
  frameHeight: number;
  frameWidth: number;
  initialScreencastFramePending: boolean;
  screencastGeneration: number;
  screencasting: boolean;
  disposeListeners: () => void;
}

interface FetchRequestPausedEvent {
  readonly requestId: string;
  readonly request: { readonly url: string };
}

interface ScreencastFrameEvent {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata: {
    readonly deviceWidth: number;
    readonly deviceHeight: number;
  };
}

export interface BrowserRuntimeCallbacks {
  readonly onCdpActivity: () => void;
  readonly onFrame: (frame: {
    readonly targetId: string;
    readonly jpegBytes: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly receivedAtMonotonicMillis: number;
  }) => void;
  readonly onTabs: (tabs: ReadonlyArray<BrowserTab>) => void;
  readonly onCrashed: (message: string) => void;
}

export interface BrowserRuntime {
  readonly executable: BrowserExecutableInfo;
  readonly processPid: number;
  readonly cdpWebSocketUrl: string;
  readonly getTabs: Effect.Effect<ReadonlyArray<BrowserTab>, BrowserOperationErrorType>;
  readonly setActiveTab: (
    targetId: string,
  ) => Effect.Effect<void, BrowserOperationErrorType | BrowserTabNotFoundType>;
  readonly openTab: (
    url: string,
  ) => Effect.Effect<void, BrowserOperationErrorType | BrowserTabNotFoundType>;
  readonly navigate: (
    targetId: string,
    url: string,
  ) => Effect.Effect<void, BrowserOperationErrorType | BrowserTabNotFoundType>;
  readonly navigateHistory: (
    targetId: string,
    action: BrowserHistoryAction,
  ) => Effect.Effect<void, BrowserOperationErrorType | BrowserTabNotFoundType>;
  readonly closeTab: (
    targetId: string,
  ) => Effect.Effect<void, BrowserOperationErrorType | BrowserTabNotFoundType>;
  readonly dispatchInput: (
    targetId: string,
    event: BrowserInputEvent,
  ) => Effect.Effect<void, BrowserOperationErrorType | BrowserTabNotFoundType>;
  readonly setScreencastEnabled: (
    enabled: boolean,
  ) => Effect.Effect<void, BrowserOperationErrorType>;
}

export interface PlaywrightBrowserLaunchInput {
  readonly threadId: ThreadId;
  readonly userDataDirectory: string;
  readonly processRegistryDirectory: string;
  readonly environmentExecutablePath?: string | undefined;
  readonly settingExecutablePath?: string | undefined;
  readonly noSandbox: boolean;
  readonly screencastQuality: number;
  readonly screencastEveryNthFrame: number;
  readonly serverHost?: string | undefined;
  readonly serverPort: number;
  readonly callbacks: BrowserRuntimeCallbacks;
}

function operationError(threadId: ThreadId, message: string, cause: unknown) {
  return new BrowserOperationError({ threadId, message, cause });
}

function tryBrowserOperation<A>(
  threadId: ThreadId,
  message: string,
  operation: () => Promise<A>,
): Effect.Effect<A, BrowserOperationErrorType> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => operationError(threadId, message, cause),
  });
}

interface ChromiumVersionPayload {
  readonly webSocketDebuggerUrl?: unknown;
}

export function normalizeCdpWebSocketUrl(value: unknown, expectedPort: number): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "ws:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      Number(url.port) !== expectedPort ||
      !url.pathname.startsWith("/devtools/browser/")
    ) {
      return null;
    }
    url.hostname = "127.0.0.1";
    return url.toString();
  } catch {
    return null;
  }
}

function discoverCdpWebSocketUrl(
  threadId: ThreadId,
  port: number,
): Effect.Effect<string, BrowserOperationErrorType> {
  return Effect.tryPromise({
    try: async () => {
      // @effect-diagnostics-next-line globalFetchInEffect:off - Chromium's loopback DevTools discovery endpoint is isolated at this Promise boundary.
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`Chromium returned HTTP ${response.status}.`);
      const payload = (await response.json()) as ChromiumVersionPayload;
      const endpoint = normalizeCdpWebSocketUrl(payload.webSocketDebuggerUrl, port);
      if (endpoint === null) {
        throw new Error("Chromium returned an invalid browser websocket endpoint.");
      }
      return endpoint;
    },
    catch: (cause) =>
      operationError(threadId, "Failed to discover Chromium's loopback CDP endpoint.", cause),
  });
}

function executablePathFromProcess(input: {
  readonly pid: number;
  readonly commandLine: string;
  readonly fallback: string;
}): string {
  if (process.platform === "linux") {
    try {
      const executablePath = readlinkSync(`/proc/${input.pid}/exe`).trim();
      if (executablePath) return executablePath;
    } catch {
      // Fall through to the CDP command line / resolution label.
    }
  }
  const commandLine = input.commandLine.trim();
  if (commandLine.startsWith('"')) {
    const quoteEnd = commandLine.indexOf('"', 1);
    if (quoteEnd > 1) return commandLine.slice(1, quoteEnd);
  }
  const firstToken = commandLine.split(/\s+/g)[0];
  return firstToken || input.fallback;
}

export const launchPlaywrightBrowser = Effect.fn("browser.playwright.launch")(function* (
  input: PlaywrightBrowserLaunchInput,
) {
  const sessionScope = yield* Scope.Scope;
  const operationSemaphore = yield* Semaphore.make(1);
  const netService = yield* NetService.NetService;
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);
  const streamDebug = browserStreamDebugEnabled();
  let closing = false;
  let processPid: number | undefined;

  if (input.noSandbox) {
    yield* Effect.logWarning(
      "SECURITY WARNING: Chromium sandbox disabled by SALCHI_BROWSER_NO_SANDBOX=1",
      { threadId: input.threadId },
    );
  }

  const candidates = makeBrowserResolutionCandidates({
    environmentPath: input.environmentExecutablePath,
    settingPath: input.settingExecutablePath,
  });
  const launched = yield* Effect.acquireRelease(
    resolveBrowserExecutable({
      candidates,
      launch: (candidate) =>
        Effect.gen(function* () {
          const remoteDebuggingPort = yield* netService
            .reserveLoopbackPort("127.0.0.1")
            .pipe(
              Effect.mapError((cause) =>
                operationError(
                  input.threadId,
                  "Failed to allocate Chromium's loopback CDP port.",
                  cause,
                ),
              ),
            );
          const context = yield* Effect.tryPromise({
            try: () =>
              chromium.launchPersistentContext(input.userDataDirectory, {
                ...candidate.launchOptions,
                args: [
                  "--disable-dev-shm-usage",
                  "--remote-debugging-address=127.0.0.1",
                  `--remote-debugging-port=${remoteDebuggingPort}`,
                  ...(input.noSandbox ? ["--no-sandbox"] : []),
                ],
                chromiumSandbox: !input.noSandbox,
                deviceScaleFactor: 1,
                headless: true,
                viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
              }),
            catch: (cause) =>
              operationError(
                input.threadId,
                `Failed to launch Chromium using ${candidate.source}:${candidate.resolution}.`,
                cause,
              ),
          });
          const endpointExit = yield* Effect.exit(
            discoverCdpWebSocketUrl(input.threadId, remoteDebuggingPort),
          );
          if (endpointExit._tag === "Failure") {
            yield* Effect.tryPromise({
              try: () => context.close({ reason: "Failed to discover Salchi CDP endpoint" }),
              catch: () => undefined,
            }).pipe(Effect.ignore);
            return yield* Effect.failCause(endpointExit.cause);
          }
          return {
            context,
            cdpWebSocketUrl: endpointExit.value,
          };
        }),
    }),
    ({ value }) => {
      closing = true;
      return tryBrowserOperation(input.threadId, "Failed to close Chromium gracefully.", () =>
        value.context.close({ reason: "Salchi browser session stopped" }),
      ).pipe(
        Effect.timeout("2 seconds"),
        Effect.ignore,
        Effect.andThen(
          Effect.suspend(() =>
            processPid === undefined
              ? Effect.void
              : terminateProcessTree({
                  rootPid: processPid,
                  label: `browser:${input.threadId}`,
                }),
          ),
        ),
        Effect.ignore,
      );
    },
  );
  const context: BrowserContext = launched.value.context;
  const cdpWebSocketUrl = launched.value.cdpWebSocketUrl;
  const browser: Browser | null = context.browser();
  if (browser === null) {
    return yield* operationError(
      input.threadId,
      "Persistent Chromium context did not expose a browser process.",
      null,
    );
  }

  const browserCdp = yield* tryBrowserOperation(
    input.threadId,
    "Failed to attach to Chromium's browser CDP target.",
    () => browser.newBrowserCDPSession(),
  );
  const [processes, systemInfo] = yield* Effect.all([
    tryBrowserOperation(input.threadId, "Failed to inspect Chromium processes.", () =>
      browserCdp.send("SystemInfo.getProcessInfo"),
    ),
    tryBrowserOperation(input.threadId, "Failed to inspect the Chromium executable.", () =>
      browserCdp.send("SystemInfo.getInfo"),
    ),
  ]);
  const browserProcess = processes.processInfo.find((entry) => entry.type === "browser");
  if (browserProcess === undefined || browserProcess.id < 1) {
    return yield* operationError(
      input.threadId,
      "Chromium did not report its browser process identifier.",
      processes.processInfo,
    );
  }
  processPid = browserProcess.id;
  const executable: BrowserExecutableInfo = {
    source: launched.candidate.source,
    resolution: launched.candidate.resolution,
    executablePath: executablePathFromProcess({
      pid: processPid,
      commandLine: systemInfo.commandLine,
      fallback: launched.candidate.resolution,
    }),
  };

  const terminateOwnedBrowser = tryBrowserOperation(
    input.threadId,
    "Failed to close Chromium gracefully.",
    () => context.close({ reason: "Salchi browser session stopped" }),
  ).pipe(
    Effect.timeout("2 seconds"),
    Effect.ignore,
    Effect.andThen(
      terminateProcessTree({ rootPid: processPid, label: `browser:${input.threadId}` }),
    ),
    Effect.ignore,
  );
  if (process.platform === "linux") {
    yield* registerManagedChildProcess({
      registryDirectory: input.processRegistryDirectory,
      childPid: processPid,
      terminate: Effect.sync(() => {
        closing = true;
      }).pipe(Effect.andThen(terminateOwnedBrowser)),
    });
  }

  const pageRuntimes = new Map<string, PageRuntime>();
  const configuringPages = new WeakSet<Page>();
  const inputRateLimiter = makeBrowserInputRateLimiter();
  let activeTargetId: string | undefined;
  let activeInputRuntime: PageRuntime | undefined;
  let screencastEnabled = false;
  let appliedScreencastEveryNthFrame = input.screencastEveryNthFrame;
  let tabRefreshScheduled = false;
  let configuredPageCount = 0;
  let detachedPageCount = 0;

  const schedule = <A, E>(effect: Effect.Effect<A, E>) => {
    void runFork(effect.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(sessionScope)));
  };
  const serialized = <A, E>(effect: Effect.Effect<A, E>) => operationSemaphore.withPermit(effect);

  const refreshTabsUnlocked = Effect.gen(function* () {
    const handlerStartedAt = streamDebug ? browserMonotonicMillis() : 0;
    const tabs = yield* Effect.forEach(pageRuntimes.values(), (runtime) =>
      tryBrowserOperation(
        input.threadId,
        "Failed to read browser tab metadata.",
        async () =>
          ({
            targetId: runtime.targetId,
            title: await runtime.page.title().catch(() => ""),
            url: runtime.page.url(),
            active: runtime.targetId === activeTargetId,
          }) satisfies BrowserTab,
      ),
    );
    input.callbacks.onTabs(tabs);
    if (streamDebug) {
      yield* logBrowserHandlerTiming("browser.tabs.refresh", handlerStartedAt, {
        threadId: input.threadId,
        tabCount: tabs.length,
      });
    }
    return tabs;
  });

  const scheduleTabRefresh = () => {
    if (tabRefreshScheduled) return;
    tabRefreshScheduled = true;
    schedule(
      Effect.yieldNow.pipe(
        Effect.andThen(serialized(refreshTabsUnlocked)),
        Effect.ensuring(
          Effect.sync(() => {
            tabRefreshScheduled = false;
          }),
        ),
      ),
    );
  };

  const stopScreencastUnlocked = (runtime: PageRuntime) =>
    runtime.screencasting
      ? tryBrowserOperation(input.threadId, "Failed to stop the browser screencast.", () =>
          runtime.cdp.send("Page.stopScreencast"),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              runtime.initialScreencastFramePending = false;
              runtime.screencasting = false;
            }),
          ),
          Effect.asVoid,
        )
      : Effect.void;

  const startActiveScreencastUnlocked = (primeInitialFrame = true) =>
    Effect.gen(function* () {
      if (!screencastEnabled || activeTargetId === undefined) return;
      const runtime = pageRuntimes.get(activeTargetId);
      if (runtime === undefined || runtime.screencasting) return;
      yield* tryBrowserOperation(input.threadId, "Failed to focus the active browser tab.", () =>
        runtime.page.bringToFront(),
      );
      const everyNthFrame = browserScreencastEveryNthFrameForStart(
        appliedScreencastEveryNthFrame,
        primeInitialFrame,
      );
      runtime.initialScreencastFramePending = everyNthFrame !== appliedScreencastEveryNthFrame;
      runtime.screencastGeneration += 1;
      runtime.screencasting = true;
      yield* tryBrowserOperation(input.threadId, "Failed to start the browser screencast.", () =>
        runtime.cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: input.screencastQuality,
          maxWidth: VIEWPORT_WIDTH,
          everyNthFrame,
        }),
      ).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            runtime.initialScreencastFramePending = false;
            runtime.screencasting = false;
          }),
        ),
      );
      input.callbacks.onCdpActivity();
    });

  const finishInitialScreencastFrameUnlocked = (targetId: string, expectedGeneration: number) =>
    Effect.gen(function* () {
      if (
        !screencastEnabled ||
        activeTargetId !== targetId ||
        appliedScreencastEveryNthFrame === 1
      ) {
        return;
      }
      const runtime = pageRuntimes.get(targetId);
      if (
        runtime === undefined ||
        !runtime.screencasting ||
        runtime.screencastGeneration !== expectedGeneration
      ) {
        return;
      }
      yield* stopScreencastUnlocked(runtime);
      yield* startActiveScreencastUnlocked(false);
    });

  const setScreencastEveryNthFrameUnlocked = (everyNthFrame: number) =>
    Effect.gen(function* () {
      if (appliedScreencastEveryNthFrame === everyNthFrame) return;
      appliedScreencastEveryNthFrame = everyNthFrame;
      if (!screencastEnabled || activeTargetId === undefined) return;
      const runtime = pageRuntimes.get(activeTargetId);
      if (runtime === undefined || !runtime.screencasting) return;
      // The mailbox and socket stay alive while CDP alone is restarted. This
      // operation shares the existing page-operation semaphore with tab and
      // screencast transitions, so stop/start cannot interleave with them.
      yield* stopScreencastUnlocked(runtime);
      yield* startActiveScreencastUnlocked(false);
    });

  const screencastFrameRate = makeBrowserScreencastFrameRateController({
    configuredEveryNthFrame: input.screencastEveryNthFrame,
    onEveryNthFrameChange: (everyNthFrame) =>
      schedule(serialized(setScreencastEveryNthFrameUnlocked(everyNthFrame))),
  });
  yield* Effect.addFinalizer(() => Effect.sync(screencastFrameRate.dispose));

  const removePageUnlocked = Effect.fn("browser.playwright.removePage")(function* (
    targetId: string,
  ) {
    const runtime = pageRuntimes.get(targetId);
    if (runtime === undefined) return;
    pageRuntimes.delete(targetId);
    runtime.disposeListeners();
    yield* tryBrowserOperation(input.threadId, "Failed to detach a closed browser tab.", () =>
      runtime.cdp.detach(),
    ).pipe(Effect.ignore);
    detachedPageCount += 1;
    if (streamDebug) {
      schedule(
        Effect.logDebug("browser page CDP session detached", {
          threadId: input.threadId,
          targetId,
          configuredPageCount,
          detachedPageCount,
          livePageCount: pageRuntimes.size,
        }),
      );
    }
    if (activeTargetId === targetId) {
      activeInputRuntime = undefined;
      activeTargetId = pageRuntimes.keys().next().value;
      activeInputRuntime =
        activeTargetId === undefined ? undefined : pageRuntimes.get(activeTargetId);
      yield* startActiveScreencastUnlocked();
    }
    yield* refreshTabsUnlocked.pipe(Effect.ignore);
  });

  const configurePageUnlocked = Effect.fn("browser.playwright.configurePage")(function* (
    page: Page,
    options?: { readonly publishTabs?: boolean },
  ): Effect.fn.Return<PageRuntime, BrowserOperationErrorType> {
    const existing = [...pageRuntimes.values()].find((runtime) => runtime.page === page);
    if (existing !== undefined) return existing;
    if (configuringPages.has(page)) {
      return yield* operationError(
        input.threadId,
        "Browser tab configuration was already in progress.",
        page.url(),
      );
    }
    configuringPages.add(page);
    let configuringRuntime: PageRuntime | undefined;

    return yield* Effect.gen(function* () {
      const cdp = yield* tryBrowserOperation(
        input.threadId,
        "Failed to attach to a browser tab CDP target.",
        () => context.newCDPSession(page),
      );
      const target = yield* tryBrowserOperation(
        input.threadId,
        "Failed to identify a browser tab CDP target.",
        () => cdp.send("Target.getTargetInfo"),
      );
      const runtime: PageRuntime = {
        page,
        cdp,
        targetId: target.targetInfo.targetId,
        frameHeight: VIEWPORT_HEIGHT,
        frameWidth: VIEWPORT_WIDTH,
        initialScreencastFramePending: false,
        screencastGeneration: 0,
        screencasting: false,
        disposeListeners: () => undefined,
      };
      configuringRuntime = runtime;
      pageRuntimes.set(runtime.targetId, runtime);
      configuredPageCount += 1;
      if (streamDebug) {
        schedule(
          Effect.logDebug("browser page CDP session configured", {
            threadId: input.threadId,
            targetId: runtime.targetId,
            configuredPageCount,
            detachedPageCount,
            livePageCount: pageRuntimes.size,
          }),
        );
      }
      if (activeTargetId === undefined) {
        activeTargetId = runtime.targetId;
        activeInputRuntime = runtime;
      }

      const onRequestPaused = (event: FetchRequestPausedEvent) => {
        const handlerStartedAt = streamDebug ? browserMonotonicMillis() : 0;
        input.callbacks.onCdpActivity();
        const blocked = shouldBlockBrowserRequest({
          url: event.request.url,
          serverHost: input.serverHost,
          serverPort: input.serverPort,
        });
        if (blocked) {
          schedule(
            Effect.logInfo("Blocked browser request", {
              threadId: input.threadId,
              targetId: runtime.targetId,
              url: event.request.url,
            }),
          );
          void cdp
            .send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            })
            .catch(() => undefined);
          if (streamDebug) {
            schedule(
              logBrowserHandlerTiming("browser.fetch.request-paused", handlerStartedAt, {
                threadId: input.threadId,
                targetId: runtime.targetId,
                blocked: true,
              }),
            );
          }
          return;
        }
        void cdp
          .send("Fetch.continueRequest", { requestId: event.requestId })
          .catch(() => undefined);
        if (streamDebug) {
          schedule(
            logBrowserHandlerTiming("browser.fetch.request-paused", handlerStartedAt, {
              threadId: input.threadId,
              targetId: runtime.targetId,
              blocked: false,
            }),
          );
        }
      };
      const onScreencastFrame = (event: ScreencastFrameEvent) => {
        const cdpReceivedAtMonotonicMillis = streamDebug ? browserMonotonicMillis() : 0;
        // Start the ACK before doing any publication work. The browser must
        // never wait for websocket consumers before it can produce the next frame.
        void cdp
          .send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => undefined);
        runtime.frameWidth = Math.max(0, Math.round(event.metadata.deviceWidth));
        runtime.frameHeight = Math.max(0, Math.round(event.metadata.deviceHeight));
        if (!runtime.screencasting || runtime.targetId !== activeTargetId) return;
        const finishInitialFrame = runtime.initialScreencastFramePending;
        const screencastGeneration = runtime.screencastGeneration;
        runtime.initialScreencastFramePending = false;
        input.callbacks.onFrame({
          targetId: runtime.targetId,
          // CDP is the sole base64 boundary on the binary hot path. Decode at
          // receipt and retain bytes through the mailbox and raw socket write.
          jpegBytes: Buffer.from(event.data, "base64"),
          width: runtime.frameWidth,
          height: runtime.frameHeight,
          receivedAtMonotonicMillis: cdpReceivedAtMonotonicMillis,
        });
        if (finishInitialFrame) {
          schedule(
            serialized(
              finishInitialScreencastFrameUnlocked(runtime.targetId, screencastGeneration),
            ),
          );
        }
        if (streamDebug) {
          schedule(
            logBrowserHandlerTiming("browser.frame.cdp-handler", cdpReceivedAtMonotonicMillis, {
              threadId: input.threadId,
              targetId: runtime.targetId,
            }),
          );
        }
      };
      cdp.on("Fetch.requestPaused", onRequestPaused);
      cdp.on("Page.screencastFrame", onScreencastFrame);
      runtime.disposeListeners = () => {
        cdp.off("Fetch.requestPaused", onRequestPaused);
        cdp.off("Page.screencastFrame", onScreencastFrame);
      };
      yield* Effect.all([
        tryBrowserOperation(input.threadId, "Failed to enable browser tab CDP events.", () =>
          cdp.send("Page.enable"),
        ),
        tryBrowserOperation(input.threadId, "Failed to enable browser request interception.", () =>
          cdp.send("Fetch.enable", {
            patterns: browserFetchInterceptionPatterns({
              serverHost: input.serverHost,
              serverPort: input.serverPort,
            }),
          }),
        ),
      ]);

      const refreshFromPageEvent = () => {
        input.callbacks.onCdpActivity();
        scheduleTabRefresh();
      };
      const onFrameNavigated = (frame: Frame) => {
        if (frame === page.mainFrame()) refreshFromPageEvent();
      };
      const onClose = () => schedule(serialized(removePageUnlocked(runtime.targetId)));
      page.on("domcontentloaded", refreshFromPageEvent);
      page.on("load", refreshFromPageEvent);
      page.on("framenavigated", onFrameNavigated);
      page.on("close", onClose);
      runtime.disposeListeners = () => {
        cdp.off("Fetch.requestPaused", onRequestPaused);
        cdp.off("Page.screencastFrame", onScreencastFrame);
        page.off("domcontentloaded", refreshFromPageEvent);
        page.off("load", refreshFromPageEvent);
        page.off("framenavigated", onFrameNavigated);
        page.off("close", onClose);
      };

      yield* startActiveScreencastUnlocked();
      if (options?.publishTabs !== false) yield* refreshTabsUnlocked;
      return runtime;
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => configuringPages.delete(page)).pipe(
          Effect.andThen(
            configuringRuntime === undefined
              ? Effect.void
              : removePageUnlocked(configuringRuntime.targetId).pipe(Effect.ignore),
          ),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          configuringPages.delete(page);
        }),
      ),
    );
  });

  browser.on("disconnected", () => {
    if (!closing) input.callbacks.onCrashed("Chromium exited unexpectedly.");
  });
  context.on("page", (page) => schedule(serialized(configurePageUnlocked(page))));

  let pages = context.pages();
  if (pages.length === 0) {
    pages = [
      yield* tryBrowserOperation(input.threadId, "Failed to create the initial browser tab.", () =>
        context.newPage(),
      ),
    ];
  }
  for (const page of pages) {
    yield* serialized(configurePageUnlocked(page));
  }

  const lookupTab = (targetId: string): Effect.Effect<PageRuntime, BrowserTabNotFoundType> => {
    const runtime = pageRuntimes.get(targetId);
    return runtime === undefined
      ? Effect.fail(
          new BrowserTabNotFound({
            threadId: input.threadId,
            targetId,
            message: `Browser tab ${targetId} was not found.`,
          }),
        )
      : Effect.succeed(runtime);
  };

  const setActiveTabUnlocked = (targetId: string) =>
    Effect.gen(function* () {
      const next = yield* lookupTab(targetId);
      if (activeTargetId === targetId) return;
      const previous = activeTargetId === undefined ? undefined : pageRuntimes.get(activeTargetId);
      activeInputRuntime = undefined;
      if (previous !== undefined) yield* stopScreencastUnlocked(previous);
      activeTargetId = targetId;
      activeInputRuntime = next;
      yield* tryBrowserOperation(input.threadId, "Failed to focus the selected browser tab.", () =>
        next.page.bringToFront(),
      );
      yield* startActiveScreencastUnlocked();
      yield* refreshTabsUnlocked;
      input.callbacks.onCdpActivity();
    });

  const dispatchInputDirect = (targetId: string, event: BrowserInputEvent) =>
    Effect.gen(function* () {
      const handlerStartedAt = streamDebug ? browserMonotonicMillis() : 0;
      const runtime = activeInputRuntime;
      if (runtime === undefined || activeTargetId !== targetId || runtime.targetId !== targetId) {
        return yield* operationError(
          input.threadId,
          `Browser input target ${targetId} is not the active tab.`,
          { activeTargetId },
        );
      }
      if (!inputRateLimiter.tryAcquire()) {
        return yield* operationError(
          input.threadId,
          `Browser input exceeded ${BROWSER_INPUT_RATE_LIMIT} events per second.`,
          { limit: BROWSER_INPUT_RATE_LIMIT, windowMs: BROWSER_INPUT_RATE_WINDOW_MS },
        );
      }

      const command = toBrowserCdpInputCommand(event, {
        width: runtime.frameWidth,
        height: runtime.frameHeight,
      });
      yield* tryBrowserOperation(input.threadId, "Failed to dispatch browser input.", () => {
        switch (command._tag) {
          case "Mouse":
            return runtime.cdp.send("Input.dispatchMouseEvent", command.params);
          case "Key":
            return runtime.cdp.send("Input.dispatchKeyEvent", command.params);
          case "InsertText":
            return runtime.cdp.send("Input.insertText", command.params);
        }
      });
      screencastFrameRate.recordInput();
      input.callbacks.onCdpActivity();
      if (streamDebug) {
        yield* logBrowserHandlerTiming("browser.input.cdp-dispatch", handlerStartedAt, {
          threadId: input.threadId,
          targetId,
          inputType: event._tag,
        });
      }
    });

  return {
    executable,
    processPid,
    cdpWebSocketUrl,
    getTabs: serialized(refreshTabsUnlocked),
    setActiveTab: (targetId) => serialized(setActiveTabUnlocked(targetId)),
    openTab: (url) =>
      serialized(
        Effect.gen(function* () {
          const page = yield* tryBrowserOperation(
            input.threadId,
            "Failed to open a browser tab.",
            () => context.newPage(),
          );
          // Keep the context's transient about:blank page out of tab updates.
          // Request interception must be installed before navigation, so configure
          // first but publish only after the requested URL has loaded.
          const runtime = yield* configurePageUnlocked(page, { publishTabs: false });
          yield* tryBrowserOperation(input.threadId, "Failed to navigate the browser tab.", () =>
            page.goto(url),
          );
          yield* setActiveTabUnlocked(runtime.targetId);
          yield* refreshTabsUnlocked;
        }),
      ),
    navigate: (targetId, url) =>
      serialized(
        Effect.gen(function* () {
          const runtime = yield* lookupTab(targetId);
          yield* tryBrowserOperation(input.threadId, "Failed to navigate the browser tab.", () =>
            runtime.page.goto(url),
          );
          input.callbacks.onCdpActivity();
          yield* refreshTabsUnlocked;
        }),
      ),
    navigateHistory: (targetId, action) =>
      serialized(
        Effect.gen(function* () {
          const runtime = yield* lookupTab(targetId);
          yield* tryBrowserOperation(
            input.threadId,
            `Failed to navigate browser history ${action}.`,
            () => {
              switch (action) {
                case "back":
                  return runtime.page.goBack();
                case "forward":
                  return runtime.page.goForward();
                case "reload":
                  return runtime.page.reload();
              }
            },
          );
          input.callbacks.onCdpActivity();
          yield* refreshTabsUnlocked;
        }),
      ),
    closeTab: (targetId) =>
      serialized(
        Effect.gen(function* () {
          const runtime = yield* lookupTab(targetId);
          yield* tryBrowserOperation(input.threadId, "Failed to close the browser tab.", () =>
            runtime.page.close(),
          );
          yield* removePageUnlocked(targetId);
          input.callbacks.onCdpActivity();
        }),
      ),
    dispatchInput: dispatchInputDirect,
    setScreencastEnabled: (enabled) =>
      serialized(
        Effect.gen(function* () {
          if (screencastEnabled === enabled) return;
          screencastEnabled = enabled;
          if (enabled) {
            yield* startActiveScreencastUnlocked();
            return;
          }
          for (const runtime of pageRuntimes.values()) {
            yield* stopScreencastUnlocked(runtime);
          }
        }),
      ),
  } satisfies BrowserRuntime;
});
