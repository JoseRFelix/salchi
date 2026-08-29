// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { BrowserInstallProgress, BrowserManagedVariant } from "@salchi/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { registerManagedChildProcess } from "../process/ManagedChildProcessRegistry.ts";
import { terminateProcessTree } from "../process/ProcessTree.ts";

const WORKER_MESSAGE_PREFIX = "SALCHI_BROWSER_INSTALL:";
const MAX_INSTALL_DIAGNOSTIC_BYTES = 64 * 1024;

export const MANAGED_BROWSER_NAMES = {
  "headless-shell": "chromium-headless-shell",
  chrome: "chrome",
} as const satisfies Readonly<Record<BrowserManagedVariant, string>>;
export const MANAGED_BROWSER_MANIFESTS = {
  "headless-shell": "salchi-browser.json",
  chrome: "salchi-browser-chrome.json",
} as const satisfies Readonly<Record<BrowserManagedVariant, string>>;
export const MANAGED_BROWSER_NAME = MANAGED_BROWSER_NAMES["headless-shell"];
export const MANAGED_BROWSER_MANIFEST = MANAGED_BROWSER_MANIFESTS["headless-shell"];

export class BrowserInstallerProcessError extends Data.TaggedError("BrowserInstallerProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface BrowserInstallerWorkerProgress {
  readonly type: "progress";
  readonly done: number;
  readonly total: number;
}

interface BrowserInstallerWorkerPhase {
  readonly type: "phase";
  readonly phase: "preparing" | "extracting" | "finalizing";
}

interface BrowserInstallerWorkerInstalled {
  readonly type: "installed";
  readonly executablePath: string;
}

type BrowserInstallerWorkerMessage =
  | BrowserInstallerWorkerProgress
  | BrowserInstallerWorkerPhase
  | BrowserInstallerWorkerInstalled;

export interface BrowserInstallerProcessInput {
  readonly browserDirectory: string;
  readonly processRegistryDirectory: string;
  readonly variant: BrowserManagedVariant;
  readonly onProgress: (progress: BrowserInstallProgress) => Effect.Effect<void>;
}

export const BROWSER_INSTALLER_WORKER_SOURCE = String.raw`
"use strict";
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const browserDirectory = process.argv[1];
const playwrightPackageRoot = process.argv[2];
const messagePrefix = process.argv[3];
const browserName = process.argv[4];
const manifestName = process.argv[5];

function emit(message) {
  process.stdout.write(messagePrefix + JSON.stringify(message) + "\n");
}

const originalFork = childProcess.fork;
childProcess.fork = function patchedFork() {
  const child = originalFork.apply(this, arguments);
  child.on("message", (message) => {
    if (message && message.method === "progress" && message.params) {
      emit({ type: "progress", done: message.params.done, total: message.params.total });
      if (message.params.total > 0 && message.params.done >= message.params.total) {
        emit({ type: "phase", phase: "extracting" });
      }
    }
  });
  return child;
};

async function main() {
  fs.mkdirSync(browserDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(browserDirectory, 0o700); } catch {}
  emit({ type: "phase", phase: "preparing" });
  const registryModule = require(path.join(playwrightPackageRoot, "lib", "coreBundle.js")).registry;
  const executable = registryModule.registry.findExecutable(browserName);
  if (!executable) throw new Error("The bundled Playwright registry has no " + browserName + " executable.");
  await registryModule.registry.install([executable], {});
  const executablePath = executable.executablePath("javascript");
  fs.accessSync(executablePath, fs.constants.X_OK);
  emit({ type: "phase", phase: "finalizing" });
  const manifestPath = path.join(browserDirectory, manifestName);
  const temporaryManifestPath = manifestPath + "." + process.pid + ".tmp";
  const manifest = JSON.stringify({
    version: 1,
    browserName,
    executablePath,
    playwrightVersion: require(path.join(playwrightPackageRoot, "package.json")).version,
  }) + "\n";
  fs.writeFileSync(temporaryManifestPath, manifest, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryManifestPath, manifestPath);
  try { fs.chmodSync(manifestPath, 0o600); } catch {}
  emit({ type: "installed", executablePath });
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
});
`;

function playwrightPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("playwright-core/package.json"));
}

export function playwrightCliPath(): string {
  return join(playwrightPackageRoot(), "cli.js");
}

export function resolvePlaywrightChromeExecutablePath(): string | undefined {
  const require = createRequire(import.meta.url);
  const registryModule = require(join(playwrightPackageRoot(), "lib", "coreBundle.js")) as {
    readonly registry: {
      readonly registry: {
        readonly findExecutable: (
          name: string,
        ) => { readonly executablePath: () => string | undefined } | undefined;
      };
    };
  };
  return registryModule.registry.registry.findExecutable("chrome")?.executablePath();
}

export function parseBrowserInstallerWorkerMessage(
  line: string,
): BrowserInstallerWorkerMessage | undefined {
  if (!line.startsWith(WORKER_MESSAGE_PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(WORKER_MESSAGE_PREFIX.length));
    if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
    if (
      value.type === "progress" &&
      "done" in value &&
      "total" in value &&
      typeof value.done === "number" &&
      typeof value.total === "number"
    ) {
      return { type: "progress", done: value.done, total: value.total };
    }
    if (
      value.type === "phase" &&
      "phase" in value &&
      (value.phase === "preparing" || value.phase === "extracting" || value.phase === "finalizing")
    ) {
      return { type: "phase", phase: value.phase };
    }
    if (
      value.type === "installed" &&
      "executablePath" in value &&
      typeof value.executablePath === "string" &&
      value.executablePath.length > 0
    ) {
      return { type: "installed", executablePath: value.executablePath };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const runBrowserInstallerProcess = Effect.fn("browserInstaller.runProcess")(function* (
  input: BrowserInstallerProcessInput,
) {
  if (input.variant === "chrome" && process.platform === "linux") {
    return yield* new BrowserInstallerProcessError({
      message:
        "Google Chrome requires a system package installation on Linux; Salchi will not run it with elevated privileges.",
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const temporaryDirectory = join(input.browserDirectory, "tmp");
  yield* fs.makeDirectory(input.browserDirectory, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(temporaryDirectory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(input.browserDirectory, 0o700).pipe(Effect.ignore);
  yield* fs.chmod(temporaryDirectory, 0o700).pipe(Effect.ignore);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "--eval",
                BROWSER_INSTALLER_WORKER_SOURCE,
                input.browserDirectory,
                playwrightPackageRoot(),
                WORKER_MESSAGE_PREFIX,
                MANAGED_BROWSER_NAMES[input.variant],
                MANAGED_BROWSER_MANIFESTS[input.variant],
              ],
              {
                detached: process.platform !== "win32",
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                extendEnv: true,
                env: {
                  PLAYWRIGHT_BROWSERS_PATH: input.browserDirectory,
                  TMPDIR: temporaryDirectory,
                  TMP: temporaryDirectory,
                  TEMP: temporaryDirectory,
                },
              },
            ),
          );
          yield* registerManagedChildProcess({
            registryDirectory: input.processRegistryDirectory,
            childPid: Number(child.pid),
            terminate: terminateProcessTree({
              rootPid: Number(child.pid),
              label: "managed browser installer",
            }),
          });
          return child;
        }),
      );

      let diagnostic = "";
      let executablePath: string | undefined;
      let latestProgress: BrowserInstallProgress = {
        phase: "preparing",
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      };
      const recordDiagnostic = (line: string) => {
        diagnostic = `${diagnostic}${line}\n`;
        if (diagnostic.length > MAX_INSTALL_DIAGNOSTIC_BYTES) {
          diagnostic = diagnostic.slice(-MAX_INSTALL_DIAGNOSTIC_BYTES);
        }
      };
      const output = child.all.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => {
          const message = parseBrowserInstallerWorkerMessage(line);
          if (message === undefined) {
            return Effect.sync(() => recordDiagnostic(line));
          }
          if (message.type === "installed") {
            executablePath = message.executablePath;
            return Effect.void;
          }
          if (message.type === "phase") {
            latestProgress = {
              ...latestProgress,
              phase: message.phase,
              ...(message.phase === "extracting" ? { percent: 100 } : {}),
            };
            return input.onProgress(latestProgress);
          }
          const totalBytes = Math.max(0, Math.trunc(message.total));
          const downloadedBytes = Math.max(0, Math.trunc(message.done));
          latestProgress = {
            phase: "downloading",
            percent:
              totalBytes === 0
                ? 0
                : Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))),
            downloadedBytes,
            totalBytes,
          };
          return input.onProgress(latestProgress);
        }),
      );
      const [exitCode] = yield* Effect.all([child.exitCode, output], {
        concurrency: "unbounded",
      });
      if (Number(exitCode) !== 0 || executablePath === undefined) {
        const detail = diagnostic.trim();
        return yield* new BrowserInstallerProcessError({
          message:
            detail.length > 0
              ? `Managed Chromium installation failed: ${detail}`
              : `Managed ${input.variant} installation failed with exit code ${String(exitCode)}.`,
        });
      }
      yield* input.onProgress({
        phase: "complete",
        percent: 100,
        downloadedBytes: latestProgress.totalBytes,
        totalBytes: latestProgress.totalBytes,
      });
      return executablePath;
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof BrowserInstallerProcessError
        ? cause
        : new BrowserInstallerProcessError({
            message: `Managed ${input.variant} installation could not be started.`,
            cause,
          }),
    ),
  );
});
