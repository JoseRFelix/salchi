/**
 * Optional integration check against a real system Chrome/Chromium.
 * Enable with: SALCHI_BROWSER_INTEGRATION=1 vp run test src/browser/PlaywrightBrowserProbe.test.ts
 */
// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type BrowserRpcError, type BrowserSessionState } from "@salchi/contracts";
import * as NetService from "@salchi/shared/Net";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { chromium } from "playwright-core";
import { describe, expect } from "vitest";

import { makeBrowserAgentBrokerWithOptions } from "./Layers/BrowserAgentBroker.ts";
import { makeBrowserSessionManagerWithOptions } from "./Layers/BrowserSessionManager.ts";
import { launchPlaywrightBrowser, normalizeCdpWebSocketUrl } from "./PlaywrightBrowserRuntime.ts";
import type { BrowserSessionManagerShape } from "./Services/BrowserSessionManager.ts";

const integrationThreadId = ThreadId.make("browser-integration-probe");

class BrowserIntegrationProbeError extends Data.TaggedError("BrowserIntegrationProbeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const ONE_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function makeBrowserStressServer() {
  return Effect.gen(function* () {
    const slowRequestReceived = yield* Deferred.make<void>();
    let completeSlowNavigation = () => undefined;
    const resource = yield* Effect.acquireRelease(
      Effect.callback<
        { readonly server: ReturnType<typeof createServer>; readonly url: string },
        BrowserIntegrationProbeError
      >((resume) => {
        const server = createServer((request, response) => {
          if (request.url === "/stress") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(`<!doctype html>
            <title>Browser latency stress</title>
            <style>#stress-click { position: fixed; left: 10px; top: 10px; width: 100px; height: 40px; z-index: 1; }</style>
            <button id="stress-click">stress</button>
            <script>globalThis.__stressClicks = 0; document.querySelector('#stress-click').addEventListener('click', () => globalThis.__stressClicks++);</script>
            ${Array.from(
              { length: 240 },
              (_, index) => `<img src="/asset/${String(index)}.gif" alt="">`,
            ).join("")}`);
            return;
          }
          if (request.url === "/agent-navigation") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><title>Agent navigation stress</title><main>done</main>");
            return;
          }
          if (request.url === "/slow-navigation") {
            Deferred.doneUnsafe(slowRequestReceived, Effect.void);
            completeSlowNavigation = () => {
              response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              response.end("<!doctype html><title>Slow navigation</title><main>done</main>");
            };
            return;
          }
          response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Length": String(ONE_PIXEL_GIF.byteLength),
            "Content-Type": "image/gif",
          });
          response.end(ONE_PIXEL_GIF);
        });
        server.once("error", (cause) =>
          resume(
            Effect.fail(
              new BrowserIntegrationProbeError({
                message: "Browser stress server failed.",
                cause,
              }),
            ),
          ),
        );
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (typeof address !== "object" || address === null) {
            resume(
              Effect.fail(
                new BrowserIntegrationProbeError({
                  message: "Browser stress server did not expose an address.",
                  cause: address,
                }),
              ),
            );
            return;
          }
          resume(
            Effect.succeed({
              server,
              url: `http://127.0.0.1:${String(address.port)}`,
            }),
          );
        });
        return Effect.sync(() => server.closeAllConnections());
      }),
      ({ server }) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          if (!server.listening) {
            resume(Effect.void);
            return;
          }
          server.close(() => resume(Effect.void));
        }),
    );
    return {
      ...resource,
      slowRequestReceived,
      completeSlowNavigation: () => completeSlowNavigation(),
    };
  });
}

function waitForBrowserState(
  manager: BrowserSessionManagerShape,
  predicate: (state: BrowserSessionState) => boolean,
  attempts = 250,
): Effect.Effect<BrowserSessionState, BrowserRpcError> {
  return Effect.gen(function* () {
    const state = yield* manager.getState(integrationThreadId);
    if (predicate(state)) return state;
    if (attempts <= 0) return yield* Effect.die("Timed out waiting for browser state.");
    yield* Effect.sleep("20 millis");
    return yield* waitForBrowserState(manager, predicate, attempts - 1);
  });
}

it.effect("accepts only a loopback CDP websocket on the allocated port", () =>
  Effect.sync(() => {
    expect(
      normalizeCdpWebSocketUrl("ws://localhost:43123/devtools/browser/browser-id", 43123),
    ).toBe("ws://127.0.0.1:43123/devtools/browser/browser-id");
    expect(
      normalizeCdpWebSocketUrl("ws://0.0.0.0:43123/devtools/browser/browser-id", 43123),
    ).toBeNull();
    expect(
      normalizeCdpWebSocketUrl("ws://127.0.0.1:43124/devtools/browser/browser-id", 43123),
    ).toBeNull();
    expect(normalizeCdpWebSocketUrl("ws://127.0.0.1:43123/devtools/page/id", 43123)).toBeNull();
  }),
);

describe.runIf(process.env.SALCHI_BROWSER_INTEGRATION === "1")(
  "Playwright browser integration probe",
  () => {
    it.live("proxies concurrent CDP clients and lazily relaunches after Chromium crashes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const netService = yield* NetService.NetService;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "salchi-browser-probe-",
        });
        const launchedProcessIds: Array<number> = [];
        const manager = yield* makeBrowserSessionManagerWithOptions({
          threadExists: () => Effect.succeed(true),
          getLaunchConfig: () =>
            Effect.succeed({
              idleTimeoutMillis: 60_000,
              screencastQuality: 45,
              screencastEveryNthFrame: 2,
              userDataDirectory: path.join(root, "profile"),
              processRegistryDirectory: path.join(root, "processes"),
              environmentExecutablePath: process.env.SALCHI_BROWSER_PATH,
              noSandbox: process.env.SALCHI_BROWSER_NO_SANDBOX === "1",
              stealthMode: false,
              serverHost: "127.0.0.1",
              serverPort: 3773,
            }),
          launchRuntime: (input) =>
            launchPlaywrightBrowser(input).pipe(
              Effect.provideService(NetService.NetService, netService),
              Effect.tap((runtime) =>
                Effect.sync(() => launchedProcessIds.push(runtime.processPid)),
              ),
            ),
        });
        const broker = yield* makeBrowserAgentBrokerWithOptions({
          browserManager: manager,
          accessEnabled: Effect.succeed(true),
        });
        const access = yield* broker.acquireSessionAccess(integrationThreadId);
        yield* Effect.addFinalizer(() => access.release);
        const proxyUrlValue = access.environment.SALCHI_BROWSER_CDP_URL;
        if (proxyUrlValue === undefined) {
          return yield* Effect.die("Browser broker access was not enabled.");
        }
        const proxyUrl = new URL(proxyUrlValue);
        expect(proxyUrl.hostname).toBe("127.0.0.1");
        expect(Number(proxyUrl.port)).toBe(broker.port);
        expect(proxyUrl.pathname).toMatch(
          /^\/internal\/browser\/cdp\/browser-integration-probe\/[0-9a-f]{64}$/,
        );

        expect((yield* manager.getState(integrationThreadId)).status).toBe("stopped");
        expect(launchedProcessIds).toHaveLength(0);

        const connectExternalBrowser = (label: string) =>
          Effect.acquireRelease(
            Effect.tryPromise({
              try: () => chromium.connectOverCDP(proxyUrlValue),
              catch: (cause) =>
                new BrowserIntegrationProbeError({
                  message: `Failed to connect ${label} over the CDP proxy.`,
                  cause,
                }),
            }),
            (browser) =>
              Effect.promise(() => browser.close()).pipe(
                Effect.timeout("2 seconds"),
                Effect.ignore,
              ),
          );

        const externalBrowser = yield* connectExternalBrowser("the first Playwright client");
        const ownerState = yield* manager.getState(integrationThreadId);
        expect(ownerState.status).toBe("running");
        expect(ownerState.cdpWebSocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
        expect(ownerState.cdpWebSocketUrl).not.toBe(proxyUrlValue);
        expect(launchedProcessIds).toHaveLength(1);

        // Chromium's browser endpoint permits independent concurrent clients.
        const secondExternalBrowser = yield* connectExternalBrowser(
          "the second concurrent Playwright client",
        );
        expect(secondExternalBrowser.contexts()).toHaveLength(1);
        const context = externalBrowser.contexts()[0];
        if (context === undefined) {
          return yield* Effect.die("External CDP client found no persistent browser context.");
        }
        const page = yield* Effect.promise(() => context.newPage());
        const stressServer = yield* makeBrowserStressServer();

        // Wait until Salchi's context `page` listener has installed Fetch
        // interception before asking the external client to navigate.
        yield* waitForBrowserState(
          manager,
          (state) => state.tabs.length >= ownerState.tabs.length + 1,
        );
        const interactivePage = `<!doctype html>
          <title>External agent tab</title>
          <style>
            html, body { margin: 0; }
            #trusted-click { position: absolute; left: 100px; top: 80px; width: 120px; height: 50px; }
            #typed-text { position: absolute; left: 100px; top: 160px; width: 240px; height: 36px; }
          </style>
          <button id="trusted-click">Click here</button>
          <input id="typed-text" />
          <script>
            globalThis.__salchiTrustedClick = null;
            document.querySelector('#trusted-click').addEventListener('click', (event) => {
              globalThis.__salchiTrustedClick = {
                isTrusted: event.isTrusted,
                clientX: event.clientX,
                clientY: event.clientY,
              };
            });
          </script>`;
        yield* Effect.promise(() =>
          page.goto(`data:text/html,${encodeURIComponent(interactivePage)}`),
        );
        const externalTabState = yield* waitForBrowserState(manager, (state) =>
          state.tabs.some((tab) => tab.title === "External agent tab"),
        );
        const externalTab = externalTabState.tabs.find((tab) => tab.title === "External agent tab");
        if (externalTab === undefined) {
          return yield* Effect.die("Externally opened tab did not appear in Salchi state.");
        }

        yield* manager.setActiveTab(integrationThreadId, externalTab.targetId);
        const inactiveTab = (yield* manager.getState(integrationThreadId)).tabs.find(
          (tab) => !tab.active,
        );
        if (inactiveTab !== undefined) {
          const inactiveInputError = yield* Effect.flip(
            manager.dispatchInput(integrationThreadId, inactiveTab.targetId, {
              _tag: "InsertText",
              text: "must not reach an inactive tab",
            }),
          );
          expect(inactiveInputError).toMatchObject({
            _tag: "BrowserOperationError",
            threadId: integrationThreadId,
          });
        }
        const firstFrame = yield* Deferred.make<{
          readonly targetId: string;
          readonly width: number;
        }>();
        let stressFrameCount = 0;
        yield* manager.subscribeViewport(integrationThreadId).pipe(
          Stream.filter((event) => event._tag === "Frame"),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              stressFrameCount += 1;
              Deferred.doneUnsafe(
                firstFrame,
                Effect.succeed({ targetId: event.targetId, width: event.width }),
              );
            }),
          ),
          Effect.forkScoped,
        );
        const initialFrame = yield* Deferred.await(firstFrame).pipe(Effect.timeout("10 seconds"));
        expect(initialFrame.targetId).toBe(externalTab.targetId);
        expect(initialFrame.width).toBeGreaterThan(0);
        expect(initialFrame.width).toBeLessThanOrEqual(800);

        yield* manager.dispatchInput(integrationThreadId, externalTab.targetId, {
          _tag: "PointerDown",
          x: 160,
          y: 105,
          button: "left",
          clickCount: 1,
        });
        yield* manager.dispatchInput(integrationThreadId, externalTab.targetId, {
          _tag: "PointerUp",
          x: 160,
          y: 105,
          button: "left",
          clickCount: 1,
        });
        const trustedClick = yield* Effect.promise(() =>
          page.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __salchiTrustedClick: {
                    readonly clientX: number;
                    readonly clientY: number;
                    readonly isTrusted: boolean;
                  } | null;
                }
              ).__salchiTrustedClick,
          ),
        );
        expect(trustedClick).toEqual({ isTrusted: true, clientX: 160, clientY: 105 });

        yield* manager.dispatchInput(integrationThreadId, externalTab.targetId, {
          _tag: "PointerDown",
          x: 160,
          y: 178,
          button: "left",
          clickCount: 1,
        });
        yield* manager.dispatchInput(integrationThreadId, externalTab.targetId, {
          _tag: "PointerUp",
          x: 160,
          y: 178,
          button: "left",
          clickCount: 1,
        });
        yield* manager.dispatchInput(integrationThreadId, externalTab.targetId, {
          _tag: "InsertText",
          text: "typed through Salchi",
        });
        expect(yield* Effect.promise(() => page.locator("#typed-text").inputValue())).toBe(
          "typed through Salchi",
        );

        const slowNavigation = yield* manager
          .navigate(
            integrationThreadId,
            externalTab.targetId,
            `${stressServer.url}/slow-navigation`,
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(stressServer.slowRequestReceived).pipe(Effect.timeout("2 seconds"));
        const inputDuringNavigationStartedAt = performance.now();
        yield* manager
          .dispatchInput(integrationThreadId, externalTab.targetId, {
            _tag: "PointerMove",
            x: 20,
            y: 20,
            button: "none",
            clickCount: 0,
          })
          .pipe(Effect.timeout("250 millis"));
        const inputDuringNavigationMillis = performance.now() - inputDuringNavigationStartedAt;
        yield* Effect.sync(stressServer.completeSlowNavigation);
        yield* Fiber.join(slowNavigation);

        const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
        eventLoopDelay.enable();
        eventLoopDelay.reset();
        const stressStartedAt = performance.now();
        yield* Effect.promise(() => page.goto(`${stressServer.url}/stress`));
        const subresourceLoadMillis = performance.now() - stressStartedAt;
        const stressTab = yield* waitForBrowserState(manager, (state) =>
          state.tabs.some((tab) => tab.title === "Browser latency stress"),
        );
        const activeStressTab = stressTab.tabs.find((tab) => tab.active);
        if (activeStressTab === undefined) {
          return yield* Effect.die("Stress navigation did not leave an active browser tab.");
        }
        const burstStartedAt = performance.now();
        for (let index = 0; index < 100; index += 1) {
          yield* manager.dispatchInput(integrationThreadId, activeStressTab.targetId, {
            _tag: "PointerMove",
            x: 10 + index,
            y: 10,
            button: "none",
            clickCount: 0,
          });
        }
        const rapidInputBurstMillis = performance.now() - burstStartedAt;
        const clickBurstStartedAt = performance.now();
        for (let index = 0; index < 25; index += 1) {
          yield* manager.dispatchInput(integrationThreadId, activeStressTab.targetId, {
            _tag: "PointerDown",
            x: 50,
            y: 25,
            button: "left",
            clickCount: 1,
          });
          yield* manager.dispatchInput(integrationThreadId, activeStressTab.targetId, {
            _tag: "PointerUp",
            x: 50,
            y: 25,
            button: "left",
            clickCount: 1,
          });
        }
        const rapidClickBurstMillis = performance.now() - clickBurstStartedAt;
        expect(
          yield* Effect.promise(() =>
            page.evaluate(
              () =>
                (globalThis as typeof globalThis & { readonly __stressClicks: number })
                  .__stressClicks,
            ),
          ),
        ).toBe(25);
        const agentNavigationStartedAt = performance.now();
        yield* Effect.promise(() => page.goto(`${stressServer.url}/agent-navigation`));
        const agentNavigationMillis = performance.now() - agentNavigationStartedAt;
        yield* Effect.sleep("100 millis");
        const eventLoopP50Millis = eventLoopDelay.percentile(50) / 1_000_000;
        const eventLoopP99Millis = eventLoopDelay.percentile(99) / 1_000_000;
        eventLoopDelay.disable();
        process.stdout.write(
          `[browser-latency-probe] input-during-navigation=${inputDuringNavigationMillis.toFixed(1)}ms subresources=${subresourceLoadMillis.toFixed(1)}ms rapid-input-100=${rapidInputBurstMillis.toFixed(1)}ms rapid-click-25=${rapidClickBurstMillis.toFixed(1)}ms agent-navigation=${agentNavigationMillis.toFixed(1)}ms frames=${String(stressFrameCount)} event-loop-p50=${eventLoopP50Millis.toFixed(1)}ms event-loop-p99=${eventLoopP99Millis.toFixed(1)}ms\n`,
        );

        const blockedNavigationMessage = yield* Effect.promise(() =>
          page
            .goto("http://169.254.169.254/latest/meta-data/")
            .then(() => "navigation unexpectedly succeeded")
            .catch((cause: unknown) => String(cause)),
        );
        expect(blockedNavigationMessage).toContain("ERR_BLOCKED_BY_CLIENT");

        const firstProcessId = launchedProcessIds[0];
        if (firstProcessId === undefined || firstProcessId <= 1) {
          return yield* Effect.die("Chromium integration probe received an invalid PID.");
        }
        yield* Effect.sync(() => process.kill(firstProcessId, "SIGKILL"));
        const crashedState = yield* waitForBrowserState(
          manager,
          (state) => state.status === "crashed",
        );
        expect(crashedState.status).toBe("crashed");

        // The provider credential and URL outlive a Chromium process. A fresh
        // connection to the exact same stable URL lazily starts a replacement.
        const reconnectedBrowser = yield* connectExternalBrowser(
          "Playwright after Chromium crashed",
        );
        expect(reconnectedBrowser.contexts()).toHaveLength(1);
        expect(launchedProcessIds).toHaveLength(2);
        expect(launchedProcessIds[1]).not.toBe(firstProcessId);
        expect((yield* manager.getState(integrationThreadId)).status).toBe("running");

        const restartedContext = reconnectedBrowser.contexts()[0];
        if (restartedContext === undefined) {
          return yield* Effect.die("Relaunched browser exposed no persistent context.");
        }
        const restartedPage = yield* Effect.promise(() => restartedContext.newPage());
        yield* Effect.promise(() =>
          restartedPage.goto(
            "data:text/html,<title>External agent after restart</title><main>restarted</main>",
          ),
        );
        yield* waitForBrowserState(manager, (state) =>
          state.tabs.some((tab) => tab.title === "External agent after restart"),
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NetService.layer, NodeServices.layer))),
    );
  },
);
