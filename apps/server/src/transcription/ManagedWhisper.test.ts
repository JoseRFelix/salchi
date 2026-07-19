import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  awaitSidecarHealth,
  ManagedWhisperError,
  resolveManagedWhisperModelAsset,
  runTarExtraction,
  terminateManagedChildProcess,
  validateManagedRuntime,
  withManagedFileLock,
  withManagedTemporaryDirectory,
} from "./ManagedWhisper.ts";

function makeProcessHandle(
  exitCode: ChildProcessSpawner.ChildProcessHandle["exitCode"],
  overrides?: Partial<Pick<ChildProcessSpawner.ChildProcessHandle, "isRunning" | "kill" | "unref">>,
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: overrides?.isRunning ?? Effect.succeed(true),
    kill: overrides?.kill ?? (() => Effect.void),
    unref: overrides?.unref ?? Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it("pins every selectable Whisper model to its verified artifact", () => {
  expect(resolveManagedWhisperModelAsset("tiny.en")).toMatchObject({
    fileName: "ggml-tiny.en.bin",
    bytes: 77_704_715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  });
  expect(resolveManagedWhisperModelAsset("base.en")).toMatchObject({
    fileName: "ggml-base.en.bin",
    bytes: 147_964_211,
  });
  expect(resolveManagedWhisperModelAsset("small.en")).toMatchObject({
    fileName: "ggml-small.en-q8_0.bin",
    bytes: 264_477_561,
    sha256: "67a179f608ea6114bd3fdb9060e762b588a3fb3bd00c4387971be4d177958067",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q8_0.bin",
  });
});

it.effect("times out and interrupts a stalled tar extraction", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeProcessHandle(
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        ),
      ),
    );
    const extraction = yield* runTarExtraction({
      archivePath: "/tmp/whisper-runtime.tar.gz",
      destination: "/tmp/whisper-runtime",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.flip,
      Effect.forkChild,
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");

    const error = yield* Fiber.join(extraction);
    expect(error).toBeInstanceOf(ManagedWhisperError);
    expect(error).toMatchObject({ detail: "Timed out extracting whisper.cpp after 1 minute." });
    expect(yield* Deferred.isDone(interrupted)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("bounds tar process cleanup when the child ignores both signals", () =>
  Effect.gen(function* () {
    const signals: string[] = [];
    const unreferenced = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeProcessHandle(Effect.never, {
          kill: (options) =>
            Effect.sync(() => {
              signals.push(options?.killSignal ?? "SIGTERM");
            }).pipe(Effect.andThen(Effect.never)),
          unref: Deferred.succeed(unreferenced, undefined).pipe(Effect.as(Effect.void)),
        }),
      ),
    );
    const extraction = yield* runTarExtraction({
      archivePath: "/tmp/whisper-runtime.tar.gz",
      destination: "/tmp/whisper-runtime",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.flip,
      Effect.forkChild,
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    expect(signals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust("2 seconds");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    yield* TestClock.adjust("2 seconds");

    expect(yield* Fiber.join(extraction)).toMatchObject({
      detail: "Timed out extracting whisper.cpp after 1 minute.",
    });
    expect(yield* Deferred.isDone(unreferenced)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("times out a stalled health request before retrying", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    let requestCount = 0;
    const httpClient = HttpClient.make((request) => {
      requestCount += 1;
      if (requestCount === 1) {
        return Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });
    const health = yield* awaitSidecarHealth(new URL("http://127.0.0.1:8080/health")).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.forkChild,
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    expect(yield* Deferred.isDone(interrupted)).toBe(true);
    yield* TestClock.adjust("200 millis");

    yield* Fiber.join(health);
    expect(requestCount).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("escalates a TERM-resistant child to KILL and then unreferences it", () =>
  Effect.gen(function* () {
    const signals: string[] = [];
    const unreferenced = yield* Deferred.make<void>();
    const child = makeProcessHandle(Effect.never, {
      kill: (options) =>
        Effect.sync(() => {
          signals.push(options?.killSignal ?? "SIGTERM");
        }).pipe(Effect.andThen(Effect.never)),
      unref: Deferred.succeed(unreferenced, undefined).pipe(Effect.as(Effect.void)),
    });

    const cleanup = yield* terminateManagedChildProcess(child).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(signals).toEqual(["SIGTERM"]);

    yield* TestClock.adjust("2 seconds");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    yield* TestClock.adjust("2 seconds");

    yield* Fiber.join(cleanup);
    expect(yield* Deferred.isDone(unreferenced)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not escalate when the child exits during TERM", () =>
  Effect.gen(function* () {
    const signals: string[] = [];
    const child = makeProcessHandle(Effect.never, {
      kill: (options) =>
        Effect.sync(() => {
          signals.push(options?.killSignal ?? "SIGTERM");
        }),
    });

    yield* terminateManagedChildProcess(child);
    expect(signals).toEqual(["SIGTERM"]);
  }),
);

it.effect("escalates when process inspection or TERM signaling fails", () =>
  Effect.gen(function* () {
    const signals: string[] = [];
    const child = makeProcessHandle(Effect.never, {
      isRunning: Effect.die(new Error("process inspection failed")),
      kill: (options) => {
        const signal = options?.killSignal ?? "SIGTERM";
        signals.push(signal);
        return signal === "SIGTERM" ? Effect.die(new Error("TERM signaling failed")) : Effect.void;
      },
    });

    yield* terminateManagedChildProcess(child);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }),
);

it.layer(NodeServices.layer)("managed Whisper cache lifecycle", (it) => {
  it.effect("allows an installed runtime to atomically replace its temporary directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-test-",
        });
        const runtimeDirectory = path.join(baseDirectory, "runtime");

        yield* withManagedTemporaryDirectory({
          directory: baseDirectory,
          prefix: "install-",
          use: (temporaryDirectory) =>
            fileSystem
              .writeFileString(path.join(temporaryDirectory, "whisper-server"), "test")
              .pipe(Effect.andThen(fileSystem.rename(temporaryDirectory, runtimeDirectory))),
        });

        expect(yield* fileSystem.exists(path.join(runtimeDirectory, "whisper-server"))).toBe(true);
      }),
    ),
  );

  it.effect("removes its temporary directory when installation is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-test-",
        });
        const started = yield* Deferred.make<string>();
        const installation = yield* withManagedTemporaryDirectory({
          directory: baseDirectory,
          prefix: "install-",
          use: (temporaryDirectory) =>
            Deferred.succeed(started, temporaryDirectory).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.forkChild);
        const temporaryDirectory = yield* Deferred.await(started);

        yield* Fiber.interrupt(installation);

        expect(yield* fileSystem.exists(temporaryDirectory)).toBe(false);
      }),
    ),
  );

  it.effect("serializes cache writers and removes the lock after release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-lock-test-",
        });
        const lockPath = path.join(baseDirectory, "artifact.lock");
        const firstEntered = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();

        const first = yield* withManagedFileLock({
          lockPath,
          use: Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(firstEntered);
        const second = yield* withManagedFileLock({
          lockPath,
          use: Deferred.succeed(secondEntered, undefined),
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(secondEntered)).toBe(false);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* TestClock.adjust("200 millis");
        yield* Deferred.await(secondEntered);
        yield* Fiber.join(second);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
      }),
    ),
  );

  it.effect("releases a cache lock when its owner is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-lock-interrupt-test-",
        });
        const lockPath = path.join(baseDirectory, "artifact.lock");
        const entered = yield* Deferred.make<void>();
        const holder = yield* withManagedFileLock({
          lockPath,
          use: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);

        yield* Fiber.interrupt(holder);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
        yield* withManagedFileLock({ lockPath, use: Effect.void });
      }),
    ),
  );

  it.effect("reclaims a lock left by a dead process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-stale-lock-test-",
        });
        const lockPath = path.join(baseDirectory, "artifact.lock");
        yield* fileSystem.writeFileString(lockPath, '{"pid":2147483647,"token":"abandoned"}');

        const acquired = yield* Deferred.make<void>();
        const waiter = yield* withManagedFileLock({
          lockPath,
          use: Deferred.succeed(acquired, undefined),
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("200 millis");

        yield* Fiber.join(waiter);
        expect(yield* Deferred.isDone(acquired)).toBe(true);
        expect(yield* fileSystem.exists(lockPath)).toBe(false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("reclaims an old malformed lock left by a partial write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-malformed-lock-test-",
        });
        const lockPath = path.join(baseDirectory, "artifact.lock");
        yield* fileSystem.writeFileString(lockPath, "partial-owner-record");
        yield* fileSystem.utimes(lockPath, 0, 0);
        yield* TestClock.adjust("10 minutes");

        yield* withManagedFileLock({ lockPath, use: Effect.void });

        expect(yield* fileSystem.exists(lockPath)).toBe(false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("rejects corrupt, truncated, and non-executable cached runtimes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "managed-whisper-runtime-validation-test-",
        });
        const binaryPath = path.join(baseDirectory, "whisper-server");
        const markerPath = path.join(baseDirectory, ".salchi-managed-runtime");
        const archiveSha256 = "a".repeat(64);
        const validMarker =
          '{"version":"v-test","archiveSha256":"' +
          archiveSha256 +
          '","binaryBytes":7,"binarySha256":"d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23"}';
        const validate = validateManagedRuntime({
          binaryPath,
          markerPath,
          version: "v-test",
          archiveSha256,
        });

        yield* fileSystem.writeFileString(binaryPath, "runtime");
        yield* fileSystem.chmod(binaryPath, 0o755);
        yield* fileSystem.writeFileString(markerPath, validMarker);
        expect(yield* validate).toBe(true);
        expect(
          yield* validateManagedRuntime({
            binaryPath,
            markerPath,
            version: "v-other",
            archiveSha256,
          }),
        ).toBe(false);
        expect(
          yield* validateManagedRuntime({
            binaryPath,
            markerPath,
            version: "v-test",
            archiveSha256: "b".repeat(64),
          }),
        ).toBe(false);

        yield* fileSystem.writeFileString(binaryPath, "rupture");
        expect(yield* validate).toBe(false);

        yield* fileSystem.writeFileString(binaryPath, "run");
        expect(yield* validate).toBe(false);

        yield* fileSystem.writeFileString(binaryPath, "runtime");
        yield* fileSystem.chmod(binaryPath, 0o644);
        expect(yield* validate).toBe(false);

        yield* fileSystem.chmod(binaryPath, 0o755);
        yield* fileSystem.writeFileString(markerPath, "not-json");
        expect(yield* validate).toBe(false);

        yield* fileSystem.writeFileString(markerPath, validMarker);
        yield* fileSystem.remove(binaryPath);
        expect(yield* validate).toBe(false);
      }),
    ),
  );
});
