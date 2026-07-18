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
  withManagedTemporaryDirectory,
} from "./ManagedWhisper.ts";

function makeProcessHandle(exitCode: ChildProcessSpawner.ChildProcessHandle["exitCode"]) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
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
    fileName: "ggml-small.en.bin",
    bytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
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

it.layer(NodeServices.layer)("managed Whisper temporary directories", (it) => {
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
});
