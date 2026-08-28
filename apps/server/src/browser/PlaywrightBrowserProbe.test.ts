/**
 * Optional integration check against a real system Chrome/Chromium.
 * Enable with: SALCHI_BROWSER_INTEGRATION=1 vp run test src/browser/PlaywrightBrowserProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@salchi/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vitest";

import { launchPlaywrightBrowser } from "./PlaywrightBrowserRuntime.ts";

describe.runIf(process.env.SALCHI_BROWSER_INTEGRATION === "1")(
  "Playwright browser integration probe",
  () => {
    it.effect("launches a persistent Chromium context and receives a screencast frame", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "salchi-browser-probe-",
        });
        const firstFrame = yield* Deferred.make<{
          readonly width: number;
          readonly height: number;
        }>();
        const runtime = yield* launchPlaywrightBrowser({
          threadId: ThreadId.make("browser-integration-probe"),
          userDataDirectory: path.join(root, "profile"),
          processRegistryDirectory: path.join(root, "processes"),
          environmentExecutablePath: process.env.SALCHI_BROWSER_PATH,
          noSandbox: process.env.SALCHI_BROWSER_NO_SANDBOX === "1",
          serverHost: "127.0.0.1",
          serverPort: 3773,
          callbacks: {
            onCdpActivity: () => undefined,
            onFrame: (frame) => {
              Deferred.doneUnsafe(firstFrame, Effect.succeed(frame));
            },
            onTabs: () => undefined,
            onCrashed: () => undefined,
          },
        });

        expect((yield* runtime.getTabs).length).toBeGreaterThan(0);
        expect(runtime.executable.executablePath.length).toBeGreaterThan(0);
        yield* runtime.setScreencastEnabled(true);
        const frame = yield* Deferred.await(firstFrame).pipe(Effect.timeout("10 seconds"));
        expect(frame.width).toBeGreaterThan(0);
        expect(frame.width).toBeLessThanOrEqual(800);
        expect(frame.height).toBeGreaterThan(0);
        yield* runtime.setScreencastEnabled(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
