import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@salchi/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { cli } from "./cli/root.ts";
import { installProcessShutdownWatchdog } from "./processShutdownWatchdog.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

// This file is the dedicated executable entrypoint. Keep execution unconditional:
// Node's ESM main-module flag does not exist before Node 22.18 and silently skipped
// the CLI on otherwise supported Node 22.16, 22.17, and 23.x releases.
const shutdownWatchdog = installProcessShutdownWatchdog();
Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  Effect.ensuring(Effect.sync(shutdownWatchdog.dispose)),
  NodeRuntime.runMain,
);
