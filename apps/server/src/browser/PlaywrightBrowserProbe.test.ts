/**
 * Optional integration check against a real system Chrome/Chromium.
 * Enable with: SALCHI_BROWSER_INTEGRATION=1 vp run test src/browser/PlaywrightBrowserProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type BrowserRpcError, type BrowserSessionState } from "@salchi/contracts";
import * as NetService from "@salchi/shared/Net";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
              userDataDirectory: path.join(root, "profile"),
              processRegistryDirectory: path.join(root, "processes"),
              environmentExecutablePath: process.env.SALCHI_BROWSER_PATH,
              noSandbox: process.env.SALCHI_BROWSER_NO_SANDBOX === "1",
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

        // Wait until Salchi's context `page` listener has installed Fetch
        // interception before asking the external client to navigate.
        yield* waitForBrowserState(
          manager,
          (state) => state.tabs.length >= ownerState.tabs.length + 1,
        );
        yield* Effect.promise(() =>
          page.goto("data:text/html,<title>External agent tab</title><main>external agent</main>"),
        );
        const externalTabState = yield* waitForBrowserState(manager, (state) =>
          state.tabs.some((tab) => tab.title === "External agent tab"),
        );
        const externalTab = externalTabState.tabs.find((tab) => tab.title === "External agent tab");
        if (externalTab === undefined) {
          return yield* Effect.die("Externally opened tab did not appear in Salchi state.");
        }

        yield* manager.setActiveTab(integrationThreadId, externalTab.targetId);
        const frame = yield* manager.subscribeViewport(integrationThreadId).pipe(
          Stream.filter((event) => event._tag === "Frame"),
          Stream.runHead,
          Effect.timeout("10 seconds"),
        );
        expect(Option.isSome(frame)).toBe(true);
        if (Option.isSome(frame)) {
          expect(frame.value.targetId).toBe(externalTab.targetId);
          expect(frame.value.width).toBeGreaterThan(0);
          expect(frame.value.width).toBeLessThanOrEqual(800);
        }

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
