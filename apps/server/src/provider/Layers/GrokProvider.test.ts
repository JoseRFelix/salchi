import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { GrokSettings } from "@salchi/contracts";

import { buildInitialGrokProviderSnapshot, checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const realSleepLock = new Int32Array(new SharedArrayBuffer(4));

const realSleepMillis = (millis: number): void => {
  Atomics.wait(realSleepLock, 0, 0, millis);
};

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
): Effect.Effect<string, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (attempts <= 0) {
      return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
    }
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length > 0) {
      return raw;
    }
    yield* Effect.sync(() => realSleepMillis(25));
    return yield* waitForFileContent(filePath, attempts - 1);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code !== "ESRCH";
  }
}

function isProcessRunning(pid: number): Effect.Effect<boolean, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (process.platform === "linux") {
      const fs = yield* FileSystem.FileSystem;
      const stat = yield* fs
        .readFileString(`/proc/${pid}/stat`)
        .pipe(Effect.orElseSucceed(() => ""));
      const stateStart = stat.lastIndexOf(")") + 2;
      if (stateStart >= 2 && stat.slice(stateStart).startsWith("Z ")) {
        return false;
      }
    }

    return isProcessAlive(pid);
  });
}

function waitForProcessExit(
  pid: number,
  attempts = 80,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (!(yield* isProcessRunning(pid))) {
      return;
    }
    if (attempts <= 0) {
      return yield* Effect.die(new Error(`Timed out waiting for process ${pid} to exit`));
    }
    yield* Effect.sync(() => realSleepMillis(25));
    return yield* waitForProcessExit(pid, attempts - 1);
  });
}

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "salchi-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "%s\\n" "broken grok install" >&2', "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("broken grok install");
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "salchi-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("times out and cleans up a hanging CLI version probe", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "salchi-grok-timeout-" });
          const grokPath = path.join(dir, "grok");
          const pidLogPath = path.join(dir, "pid.log");
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              `PID_LOG=${shellSingleQuote(pidLogPath)}`,
              'printf "%s\\n" "$$" > "$PID_LOG"',
              "trap '' TERM INT",
              "while :; do sleep 1 & wait $!; done",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          const snapshotFiber = yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          ).pipe(Effect.forkScoped);
          const pid = Number((yield* waitForFileContent(pidLogPath, 80)).trim());
          yield* TestClock.adjust(Duration.millis(4_000));
          const snapshot = yield* Fiber.join(snapshotFiber);
          yield* waitForProcessExit(pid);
          return { snapshot, pid };
        }),
      );

      expect(result.snapshot.enabled).toBe(true);
      expect(result.snapshot.installed).toBe(true);
      expect(result.snapshot.status).toBe("error");
      expect((result.snapshot.message ?? "").toLowerCase()).toMatch(/timed out|timeout/);
      expect(yield* isProcessRunning(result.pid)).toBe(false);
    }),
  );
});
