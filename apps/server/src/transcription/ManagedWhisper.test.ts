import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  resolveManagedWhisperModelAsset,
  withManagedTemporaryDirectory,
} from "./ManagedWhisper.ts";

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
