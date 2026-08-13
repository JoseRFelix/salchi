import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/unstable/process";

import {
  createStagePnpmConfig,
  getPatchedDependencyPackageName,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  runCommand,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Salchi (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Salchi (Nightly)");
  });

  it("uses the Salchi icon for desktop packaging across channels", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.salchiIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.salchiIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.salchiIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.salchiIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.salchiIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.salchiIconIco,
    });
  });

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@salchi/contracts": "workspace:*",
          "@salchi/shared": "workspace:*",
          "@salchi/ssh": "workspace:*",
          "@salchi/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.102",
          effect: "4.0.0-beta.102",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.102",
        effect: "4.0.0-beta.102",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@effect/platform-bun@4.0.0-beta.102":
            "patches/@effect__platform-bun@4.0.0-beta.102.patch",
          "@effect/platform-node@4.0.0-beta.102":
            "patches/@effect__platform-node@4.0.0-beta.102.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "effect@4.0.0-beta.102": "patches/effect@4.0.0-beta.102.patch",
        },
        {
          "@effect/platform-bun": "4.0.0-beta.102",
          "@effect/platform-node": "4.0.0-beta.102",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.102",
        },
      ),
      {
        patchedDependencies: {
          "@effect/platform-bun@4.0.0-beta.102":
            "patches/@effect__platform-bun@4.0.0-beta.102.patch",
          "@effect/platform-node@4.0.0-beta.102":
            "patches/@effect__platform-node@4.0.0-beta.102.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "effect@4.0.0-beta.102": "patches/effect@4.0.0-beta.102.patch",
        },
      },
    );

    assert.equal(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.102" },
      ),
      undefined,
    );
  });

  it("parses scoped patched dependency package names", () => {
    assert.equal(getPatchedDependencyPackageName("@pierre/diffs@1.1.20"), "@pierre/diffs");
    assert.equal(getPatchedDependencyPackageName("effect@4.0.0-beta.102"), "effect");
  });

  it.effect("includes command stdout and stderr tails in failures", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runCommand(
          ChildProcess.make(process.execPath, [
            "-e",
            "console.log('stdout-value'); console.error('stderr-value'); process.exit(7)",
          ]),
          { label: "failing command", verbose: false },
        ),
      );

      assert.match(error.message, /Command exited with non-zero exit code \(7\)/);
      assert.match(error.message, /Command: failing command/);
      assert.match(error.message, /stdout tail:\nstdout-value/);
      assert.match(error.message, /stderr tail:\nstderr-value/);
    }),
  );

  it.effect("tails long command output to 20000 characters", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runCommand(
          ChildProcess.make(process.execPath, [
            "-e",
            "process.stdout.write('BEGIN' + 'x'.repeat(20050) + 'TAIL'); process.exit(1)",
          ]),
          { label: "long output", verbose: false },
        ),
      );

      assert.match(error.message, /TAIL/);
      assert.notMatch(error.message, /BEGIN/);
    }),
  );

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                SALCHI_DESKTOP_SKIP_BUILD: "true",
                SALCHI_DESKTOP_KEEP_STAGE: "true",
                SALCHI_DESKTOP_SIGNED: "true",
                SALCHI_DESKTOP_VERBOSE: "true",
                SALCHI_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
