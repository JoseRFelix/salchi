/**
 * Fresh managed-browser installation and launch probe.
 * Enable with: SALCHI_BROWSER_INTEGRATION=1 vp run test src/browser/BrowserInstallerProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@salchi/contracts";
import * as NetService from "@salchi/shared/Net";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

import {
  makeBrowserInstallerWithOptions,
  readManagedBrowserInstallState,
} from "./Layers/BrowserInstaller.ts";
import { runBrowserInstallerProcess } from "./BrowserInstallerProcess.ts";
import { launchPlaywrightBrowser } from "./PlaywrightBrowserRuntime.ts";
import { BrowserInstallerError } from "./Services/BrowserInstaller.ts";

const managedIntegrationLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

describe.runIf(process.env.SALCHI_BROWSER_INTEGRATION === "1")(
  "managed Chromium integration",
  () => {
    it.live("installs into a fresh Salchi home, launches, and receives a JPEG frame", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "salchi-managed-browser-probe-",
          });
          const browserDirectory = path.join(root, "browsers");
          const processRegistryDirectory = path.join(root, "processes");
          const installer = yield* makeBrowserInstallerWithOptions({
            initialStates: {
              "headless-shell": { status: "not-installed", variant: "headless-shell" },
              chrome: { status: "not-installed", variant: "chrome" },
            },
            runInstall: ({ variant, onProgress }) =>
              runBrowserInstallerProcess({
                browserDirectory,
                processRegistryDirectory,
                variant,
                onProgress,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) => new BrowserInstallerError({ message: cause.message, cause }),
                ),
              ),
          });

          yield* installer
            .install("headless-shell")
            .pipe(Stream.runDrain, Effect.timeout("15 minutes"));
          const installState = yield* installer.getInstallState("headless-shell");
          expect(installState.status).toBe("installed");
          if (installState.status !== "installed" || !installState.executablePath) return;
          expect(path.resolve(installState.executablePath).startsWith(path.resolve(root))).toBe(
            true,
          );

          const frame = yield* Deferred.make<{
            readonly jpegBytes: Uint8Array;
            readonly width: number;
            readonly height: number;
          }>();
          const threadId = ThreadId.make("managed-browser-install-probe");
          const runtime = yield* launchPlaywrightBrowser({
            threadId,
            userDataDirectory: path.join(root, "profile"),
            processRegistryDirectory,
            managedExecutablePath: installState.executablePath,
            resolutionChannels: [],
            noSandbox: process.env.SALCHI_BROWSER_NO_SANDBOX === "1",
            stealthMode: false,
            screencastQuality: 45,
            screencastEveryNthFrame: 1,
            serverHost: "127.0.0.1",
            serverPort: 3773,
            callbacks: {
              onCdpActivity: () => undefined,
              onFrame: (value) => Deferred.doneUnsafe(frame, Effect.succeed(value)),
              onTabs: () => undefined,
              onCrashed: () => undefined,
            },
          });
          expect(runtime.executable.source).toBe("managed");
          const activeTab = (yield* runtime.getTabs).find((tab) => tab.active);
          if (!activeTab) return yield* Effect.die("Managed Chromium had no active page.");
          yield* runtime.setScreencastEnabled(true);
          yield* runtime.navigate(
            activeTab.targetId,
            "data:text/html,<title>Managed Chromium</title><main>ready</main>",
          );
          const received = yield* Deferred.await(frame).pipe(Effect.timeout("10 seconds"));
          expect(received.width).toBeGreaterThan(0);
          expect(received.height).toBeGreaterThan(0);
          expect(Array.from(received.jpegBytes.slice(0, 2))).toEqual([0xff, 0xd8]);
        }),
      ).pipe(Effect.provide(managedIntegrationLayer)),
    );

    it.live("probes the branded Chrome install path without invoking elevation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "salchi-managed-chrome-probe-",
          });
          const state = yield* readManagedBrowserInstallState(root, "chrome");

          if (state.status === "installed") {
            expect(state.executablePath).toBeTruthy();
            return;
          }
          if (process.platform === "linux" && process.arch === "x64") {
            expect(state.status).toBe("needs-elevation");
            expect(state.elevationCommand).toContain("install chrome");
            return;
          }
          if (process.platform === "linux") {
            expect(state.status).toBe("failed");
            expect(state.reason).toContain("does not support Linux");
            return;
          }
          expect(state.status).toBe("not-installed");
        }),
      ).pipe(Effect.provide(managedIntegrationLayer)),
    );
  },
);
