import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  baseSshArgs,
  getLastNonEmptyOutputLine,
  parseSshResolveOutput,
  resolveRemoteSalchiCliPackageSpec,
  runSshCommand,
} from "./command.ts";
import { SshCommandError } from "./errors.ts";

const encoder = new TextEncoder();

const makeFailedProcess = (input: { readonly stdout: string; readonly stderr?: string }) => {
  const stdoutStream =
    input.stdout.length > 0 ? Stream.make(encoder.encode(input.stdout)) : Stream.empty;
  const stderrStream =
    input.stderr && input.stderr.length > 0
      ? Stream.make(encoder.encode(input.stderr))
      : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: stderrStream,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const runFailingSshCommand = (input: { readonly stdout: string; readonly stderr?: string }) => {
  const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedProcess(input)));
  const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
  const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer);

  return Effect.result(
    runSshCommand(
      {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      },
      { remoteCommandArgs: ["sh", "-s"] },
    ),
  ).pipe(Effect.provide(processLayer));
};

const makeNeverFinishingProcess = () => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

describe("ssh command", () => {
  it.effect("parses resolved ssh config output into a target", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshResolveOutput(
          "devbox",
          ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
        ),
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      );
    }),
  );

  it.effect("builds interactive ssh args without forcing batch mode", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { batchMode: "no" },
        ),
        ["-o", "BatchMode=no", "-o", "ConnectTimeout=10", "-p", "2222"],
      );
    }),
  );

  it.effect("resolves the remote salchi package spec from the desktop release channel", () =>
    Effect.sync(() => {
      assert.equal(
        resolveRemoteSalchiCliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
        }),
        "salchi@0.0.17",
      );
      assert.equal(
        resolveRemoteSalchiCliPackageSpec({
          appVersion: "0.0.17-nightly.20260415.44",
          updateChannel: "nightly",
        }),
        "salchi@0.0.17-nightly.20260415.44",
      );
      assert.equal(
        resolveRemoteSalchiCliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "nightly",
          isDevelopment: true,
        }),
        "salchi@nightly",
      );
      assert.equal(
        resolveRemoteSalchiCliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "latest",
          isDevelopment: true,
        }),
        "salchi@nightly",
      );
    }),
  );

  it.effect("reads the last non-empty ssh output line", () =>
    Effect.sync(() => {
      assert.equal(
        getLastNonEmptyOutputLine(
          ["Welcome to the host", "", '{"credential":"pairing-token"}', ""].join("\n"),
        ),
        '{"credential":"pairing-token"}',
      );
    }),
  );

  it.effect("includes stdout in non-zero command failures when stderr is empty", () =>
    Effect.gen(function* () {
      const result = yield* runFailingSshCommand({
        stdout: "Pairing token creation failed\n",
      });

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, "Pairing token creation failed");
        assert.equal(result.failure.stdout, "Pairing token creation failed\n");
        assert.equal(result.failure.stderr, "");
      }
    }),
  );

  it.effect("redacts credentials from stdout in non-zero command failures", () =>
    Effect.gen(function* () {
      const result = yield* runFailingSshCommand({
        stdout: '{"credential":"pairing-secret","token":"api-secret"}\n',
      });

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.stdout, '{"credential":"[redacted]","token":"[redacted]"}\n');
        assert.equal(result.failure.message, '{"credential":"[redacted]","token":"[redacted]"}');
      }
    }),
  );

  it.effect("prefers stderr over stdout for non-zero command failure messages", () =>
    Effect.gen(function* () {
      const result = yield* runFailingSshCommand({
        stdout: "stdout detail\n",
        stderr: "stderr detail\n",
      });

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, "stderr detail");
        assert.equal(result.failure.stdout, "stdout detail\n");
        assert.equal(result.failure.stderr, "stderr detail\n");
      }
    }),
  );

  it.effect("truncates stdout in non-zero command failures", () =>
    Effect.gen(function* () {
      const result = yield* runFailingSshCommand({
        stdout: "x".repeat(4_050),
      });

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.stdout, `${"x".repeat(4_000)}\n[truncated]`);
        assert.equal(result.failure.message, `${"x".repeat(4_000)}\n[truncated]`);
      }
    }),
  );

  it.effect("fails commands that never finish", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          runSshCommand(
            {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 2222,
            },
            { timeoutMs: 1 },
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "SSH command timed out after 1ms.");
      }
    }).pipe(Effect.provide(processLayer));
  });
});
