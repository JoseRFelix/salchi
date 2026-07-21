// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const SIDECAR_REGISTRY_DIRECTORY = "sidecars";
const SIDECAR_REAP_CONCURRENCY = 8;
const SIDECAR_TERMINATE_ATTEMPTS = 10;
const SIDECAR_TERMINATE_RETRY_DELAY = "200 millis";

export interface ManagedWhisperProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
}

export interface ManagedWhisperProcessControl {
  /** `null` means absent; `undefined` means the process could not be inspected safely. */
  readonly readIdentity: (pid: number) => ManagedWhisperProcessIdentity | null | undefined;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
}

interface ManagedWhisperSidecarRecord {
  readonly version: 1;
  readonly owner: ManagedWhisperProcessIdentity;
  readonly sidecar: ManagedWhisperProcessIdentity;
}

interface ManagedWhisperSidecarRegistration {
  readonly filePath: string;
  readonly record: ManagedWhisperSidecarRecord;
}

const ManagedWhisperProcessIdentitySchema = Schema.Struct({
  pid: Schema.Int,
  startTimeTicks: Schema.String,
});
const ManagedWhisperSidecarRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  owner: ManagedWhisperProcessIdentitySchema,
  sidecar: ManagedWhisperProcessIdentitySchema,
});
const decodeSidecarRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedWhisperSidecarRecordSchema),
);
const encodeSidecarRecord = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ManagedWhisperSidecarRecordSchema),
);

function readLinuxProcessIdentity(pid: number): ManagedWhisperProcessIdentity | null | undefined {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    // Fields after the parenthesized command begin at proc(5)'s field 3 (state).
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/g);
    const state = fields[0];
    const startTimeTicks = fields[19];
    if (state === "Z") return null;
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) return undefined;
    return { pid, startTimeTicks };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

const defaultProcessControl: ManagedWhisperProcessControl = {
  readIdentity: readLinuxProcessIdentity,
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
};

function safeReadIdentity(
  processControl: ManagedWhisperProcessControl,
  pid: number,
): ManagedWhisperProcessIdentity | null | undefined {
  try {
    return processControl.readIdentity(pid);
  } catch {
    return undefined;
  }
}

function sameProcess(
  expected: ManagedWhisperProcessIdentity,
  actual: ManagedWhisperProcessIdentity | null | undefined,
): boolean {
  return actual?.pid === expected.pid && actual.startTimeTicks === expected.startTimeTicks;
}

function parseSidecarRecord(raw: string): ManagedWhisperSidecarRecord | null {
  const record = Option.getOrNull(decodeSidecarRecord(raw));
  if (
    !record ||
    record.owner.pid < 1 ||
    record.sidecar.pid < 1 ||
    !/^\d+$/.test(record.owner.startTimeTicks) ||
    !/^\d+$/.test(record.sidecar.startTimeTicks)
  ) {
    return null;
  }
  return record;
}

export function managedWhisperSidecarRegistryDirectory(cacheDir: string): string {
  return join(cacheDir, SIDECAR_REGISTRY_DIRECTORY);
}

function removeRegistrationIfSidecarExited(input: {
  readonly registration: ManagedWhisperSidecarRegistration;
  readonly processControl: ManagedWhisperProcessControl;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const identity = safeReadIdentity(input.processControl, input.registration.record.sidecar.pid);
    if (identity !== undefined && !sameProcess(input.registration.record.sidecar, identity)) {
      yield* fileSystem.remove(input.registration.filePath, { force: true }).pipe(Effect.ignore);
    }
  });
}

export const registerManagedWhisperSidecarProcess = Effect.fn(
  "managedWhisper.registerSidecarProcess",
)(function* (input: {
  readonly cacheDir: string;
  readonly sidecarPid: number;
  readonly terminate: Effect.Effect<void>;
  readonly processControl?: ManagedWhisperProcessControl;
}) {
  const processControl = input.processControl ?? defaultProcessControl;
  let registration: ManagedWhisperSidecarRegistration | undefined;
  yield* Effect.addFinalizer(() =>
    input.terminate.pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.suspend(() =>
          registration === undefined
            ? Effect.void
            : removeRegistrationIfSidecarExited({ registration, processControl }),
        ),
      ),
      Effect.ignore,
    ),
  );

  const owner = safeReadIdentity(processControl, process.pid);
  const sidecar = safeReadIdentity(processControl, input.sidecarPid);
  if (!owner || !sidecar) return;

  const registryDirectory = managedWhisperSidecarRegistryDirectory(input.cacheDir);
  const nextRegistration: ManagedWhisperSidecarRegistration = {
    filePath: join(registryDirectory, `${randomUUID()}.json`),
    record: { version: 1, owner, sidecar },
  };
  registration = yield* Effect.gen(function* () {
    const contents = yield* encodeSidecarRecord(nextRegistration.record);
    yield* writeFileStringAtomically({
      filePath: nextRegistration.filePath,
      contents: `${contents}\n`,
    });
    return nextRegistration;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Unable to persist managed Whisper sidecar ownership", {
        cacheDir: input.cacheDir,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
});

function waitForProcessLifetimeToEnd(input: {
  readonly identity: ManagedWhisperProcessIdentity;
  readonly processControl: ManagedWhisperProcessControl;
  readonly attempts?: number;
}): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const actual = safeReadIdentity(input.processControl, input.identity.pid);
    if (actual === undefined) return false;
    if (!sameProcess(input.identity, actual)) {
      return true;
    }
    const attempts = input.attempts ?? SIDECAR_TERMINATE_ATTEMPTS;
    if (attempts <= 0) return false;
    yield* Effect.sleep(SIDECAR_TERMINATE_RETRY_DELAY);
    return yield* waitForProcessLifetimeToEnd({ ...input, attempts: attempts - 1 });
  });
}

function signalProcess(
  processControl: ManagedWhisperProcessControl,
  identity: ManagedWhisperProcessIdentity,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  if (!sameProcess(identity, safeReadIdentity(processControl, identity.pid))) return false;
  try {
    return processControl.signal(identity.pid, signal);
  } catch {
    return false;
  }
}

const reapSidecarRecord = Effect.fn("managedWhisper.reapSidecarRecord")(function* (input: {
  readonly filePath: string;
  readonly processControl: ManagedWhisperProcessControl;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem
    .readFileString(input.filePath)
    .pipe(Effect.catch(() => Effect.succeed("")));
  const record = parseSidecarRecord(raw);
  if (!record) {
    yield* fileSystem.remove(input.filePath, { force: true }).pipe(Effect.ignore);
    return;
  }

  const owner = safeReadIdentity(input.processControl, record.owner.pid);
  const sidecar = safeReadIdentity(input.processControl, record.sidecar.pid);
  if (owner === undefined || sidecar === undefined) return;
  if (sameProcess(record.owner, owner) && sameProcess(record.sidecar, sidecar)) return;
  if (!sameProcess(record.sidecar, sidecar)) {
    yield* fileSystem.remove(input.filePath, { force: true }).pipe(Effect.ignore);
    return;
  }

  signalProcess(input.processControl, record.sidecar, "SIGTERM");
  const terminated = yield* waitForProcessLifetimeToEnd({
    identity: record.sidecar,
    processControl: input.processControl,
  });
  if (!terminated) {
    signalProcess(input.processControl, record.sidecar, "SIGKILL");
    yield* waitForProcessLifetimeToEnd({
      identity: record.sidecar,
      processControl: input.processControl,
    });
  }
  const finalSidecar = safeReadIdentity(input.processControl, record.sidecar.pid);
  if (finalSidecar !== undefined && !sameProcess(record.sidecar, finalSidecar)) {
    yield* fileSystem.remove(input.filePath, { force: true }).pipe(Effect.ignore);
  }
});

export const reapManagedWhisperSidecars = Effect.fn("managedWhisper.reapSidecars")(
  function* (input: {
    readonly cacheDir: string;
    readonly processControl?: ManagedWhisperProcessControl;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registryDirectory = managedWhisperSidecarRegistryDirectory(input.cacheDir);
    const entries = yield* fileSystem
      .readDirectory(registryDirectory)
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
    const processControl = input.processControl ?? defaultProcessControl;
    yield* Effect.forEach(
      entries,
      (entry) =>
        reapSidecarRecord({
          filePath: path.join(registryDirectory, entry),
          processControl,
        }).pipe(Effect.catchCause(() => Effect.void)),
      { concurrency: SIDECAR_REAP_CONCURRENCY, discard: true },
    );
  },
);
