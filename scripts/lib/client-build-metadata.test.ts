import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vitest";

import {
  assertClientBuildVersion,
  CLIENT_BUILD_METADATA_FILENAME,
  ClientBuildMetadataError,
  decodeClientBuildMetadata,
  encodeClientBuildMetadata,
  verifyClientBuildVersion,
} from "./client-build-metadata.ts";

describe("client build metadata", () => {
  it("round-trips the client version", () => {
    assert.deepStrictEqual(decodeClientBuildMetadata(encodeClientBuildMetadata("1.2.3")), {
      version: "1.2.3",
    });
  });

  it("rejects invalid metadata", () => {
    expect(() => decodeClientBuildMetadata("{}")).toThrowError(ClientBuildMetadataError);
    expect(() => decodeClientBuildMetadata("{}")).toThrow(/non-empty string version/);
  });

  it("accepts a client matching the package version", () => {
    expect(() => assertClientBuildVersion({ version: "1.2.3" }, "1.2.3")).not.toThrow();
  });

  it("rejects a stale client before publish", () => {
    expect(() => assertClientBuildVersion({ version: "1.2.2" }, "1.2.3")).toThrowError(
      ClientBuildMetadataError,
    );
    expect(() => assertClientBuildVersion({ version: "1.2.2" }, "1.2.3")).toThrow(
      /bundled client version 1\.2\.2 does not match package version 1\.2\.3/,
    );
  });

  it.effect("verifies the generated metadata file on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const clientDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-client-build-metadata-",
      });
      yield* fs.writeFileString(
        path.join(clientDirectory, CLIENT_BUILD_METADATA_FILENAME),
        encodeClientBuildMetadata("1.2.3"),
      );

      const metadata = yield* Effect.promise(() =>
        verifyClientBuildVersion(clientDirectory, "1.2.3"),
      );

      assert.deepStrictEqual(metadata, { version: "1.2.3" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a publish when generated metadata is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clientDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-client-build-metadata-missing-",
      });

      const error = yield* Effect.promise(() =>
        verifyClientBuildVersion(clientDirectory, "1.2.3").then(
          () => null,
          (cause: unknown) => cause,
        ),
      );

      assert(error instanceof ClientBuildMetadataError);
      assert.match(error.message, /missing client build metadata/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
