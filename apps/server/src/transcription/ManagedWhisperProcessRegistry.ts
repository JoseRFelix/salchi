// @effect-diagnostics nodeBuiltinImport:off
import { join } from "node:path";

import * as Effect from "effect/Effect";

import {
  reapManagedChildProcesses,
  registerManagedChildProcess,
  type ManagedChildProcessControl,
  type ManagedChildProcessIdentity,
} from "../process/ManagedChildProcessRegistry.ts";

const SIDECAR_REGISTRY_DIRECTORY = "sidecars";

export type ManagedWhisperProcessIdentity = ManagedChildProcessIdentity;
export type ManagedWhisperProcessControl = ManagedChildProcessControl;

export function managedWhisperSidecarRegistryDirectory(cacheDir: string): string {
  return join(cacheDir, SIDECAR_REGISTRY_DIRECTORY);
}

export const registerManagedWhisperSidecarProcess = Effect.fn(
  "managedWhisper.registerSidecarProcess",
)(function* (input: {
  readonly cacheDir: string;
  readonly sidecarPid: number;
  readonly terminate: Effect.Effect<void>;
  readonly processControl?: ManagedWhisperProcessControl;
}) {
  yield* registerManagedChildProcess({
    registryDirectory: managedWhisperSidecarRegistryDirectory(input.cacheDir),
    childPid: input.sidecarPid,
    terminate: input.terminate,
    ...(input.processControl ? { processControl: input.processControl } : {}),
  });
});

export const reapManagedWhisperSidecars = Effect.fn("managedWhisper.reapSidecars")(
  function* (input: {
    readonly cacheDir: string;
    readonly processControl?: ManagedWhisperProcessControl;
  }) {
    yield* reapManagedChildProcesses({
      registryDirectory: managedWhisperSidecarRegistryDirectory(input.cacheDir),
      ...(input.processControl ? { processControl: input.processControl } : {}),
    });
  },
);
