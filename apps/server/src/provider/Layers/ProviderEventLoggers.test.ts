import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { ProviderEventLoggers, ProviderEventLoggersLive } from "./ProviderEventLoggers.ts";

it.layer(NodeServices.layer)("ProviderEventLoggersLive", (it) => {
  it.effect("does not install payload writers under production defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "salchi-provider-loggers-production-",
      });

      const loggers = yield* ProviderEventLoggers.pipe(
        Effect.provide(
          ProviderEventLoggersLive.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );

      expect(loggers.native).toBeUndefined();
      expect(loggers.canonical).toBeUndefined();
    }),
  );
});
