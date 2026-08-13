// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const PROCESS_REAP_CONCURRENCY = 8;
const PROCESS_TERMINATE_ATTEMPTS = 10;
const PROCESS_TERMINATE_RETRY_DELAY = "200 millis";

export interface ManagedChildProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
}

export interface ManagedChildProcessControl {
  /** `null` means absent; `undefined` means the process could not be inspected safely. */
  readonly readIdentity: (pid: number) => ManagedChildProcessIdentity | null | undefined;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
}

interface ManagedChildProcessRecord {
  readonly version: 1;
  readonly owner: ManagedChildProcessIdentity;
  readonly child: ManagedChildProcessIdentity;
}

interface ManagedChildProcessRegistration {
  readonly filePath: string;
  readonly record: ManagedChildProcessRecord;
}

const ManagedChildProcessIdentitySchema = Schema.Struct({
  pid: Schema.Int,
  startTimeTicks: Schema.String,
});
const ManagedChildProcessRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  owner: ManagedChildProcessIdentitySchema,
  child: ManagedChildProcessIdentitySchema,
});
const LegacyManagedSidecarRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  owner: ManagedChildProcessIdentitySchema,
  sidecar: ManagedChildProcessIdentitySchema,
});
const decodeProcessRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([ManagedChildProcessRecordSchema, LegacyManagedSidecarRecordSchema]),
  ),
);
const encodeProcessRecord = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ManagedChildProcessRecordSchema),
);

function readLinuxProcessIdentity(pid: number): ManagedChildProcessIdentity | null | undefined {
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

const defaultProcessControl: ManagedChildProcessControl = {
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
  processControl: ManagedChildProcessControl,
  pid: number,
): ManagedChildProcessIdentity | null | undefined {
  try {
    return processControl.readIdentity(pid);
  } catch {
    return undefined;
  }
}

function sameProcess(
  expected: ManagedChildProcessIdentity,
  actual: ManagedChildProcessIdentity | null | undefined,
): boolean {
  return actual?.pid === expected.pid && actual.startTimeTicks === expected.startTimeTicks;
}

function parseProcessRecord(raw: string): ManagedChildProcessRecord | null {
  const decoded = Option.getOrNull(decodeProcessRecord(raw));
  const record = decoded
    ? {
        version: decoded.version,
        owner: decoded.owner,
        child: "child" in decoded ? decoded.child : decoded.sidecar,
      }
    : null;
  if (
    !record ||
    record.owner.pid < 1 ||
    record.child.pid < 1 ||
    !/^\d+$/.test(record.owner.startTimeTicks) ||
    !/^\d+$/.test(record.child.startTimeTicks)
  ) {
    return null;
  }
  return record;
}

function removeRegistrationIfChildExited(input: {
  readonly registration: ManagedChildProcessRegistration;
  readonly processControl: ManagedChildProcessControl;
}) {
  return Effect.sync(() => {
    const identity = safeReadIdentity(input.processControl, input.registration.record.child.pid);
    if (identity !== undefined && !sameProcess(input.registration.record.child, identity)) {
      try {
        unlinkSync(input.registration.filePath);
      } catch {
        // The record may already have been removed by a concurrent startup reconciliation.
      }
    }
  });
}

export const registerManagedChildProcess = Effect.fn("managedChildProcess.register")(
  function* (input: {
    readonly registryDirectory: string;
    readonly childPid: number;
    readonly terminate: Effect.Effect<void>;
    readonly processControl?: ManagedChildProcessControl;
  }) {
    const processControl = input.processControl ?? defaultProcessControl;
    let registration: ManagedChildProcessRegistration | undefined;
    yield* Effect.addFinalizer(() =>
      input.terminate.pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.suspend(() =>
            registration === undefined
              ? Effect.void
              : removeRegistrationIfChildExited({ registration, processControl }),
          ),
        ),
        Effect.ignore,
      ),
    );

    const owner = safeReadIdentity(processControl, process.pid);
    const child = safeReadIdentity(processControl, input.childPid);
    if (!owner || !child) return;

    const nextRegistration: ManagedChildProcessRegistration = {
      filePath: join(input.registryDirectory, `${randomUUID()}.json`),
      record: { version: 1, owner, child },
    };
    registration = yield* Effect.gen(function* () {
      const contents = yield* encodeProcessRecord(nextRegistration.record);
      yield* Effect.sync(() => {
        mkdirSync(input.registryDirectory, { recursive: true });
        const temporaryPath = `${nextRegistration.filePath}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporaryPath, `${contents}\n`, "utf8");
          renameSync(temporaryPath, nextRegistration.filePath);
        } finally {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // A successful rename removes the temporary path.
          }
        }
      });
      return nextRegistration;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Unable to persist managed child-process ownership", {
          registryDirectory: input.registryDirectory,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );
  },
);

function waitForProcessLifetimeToEnd(input: {
  readonly identity: ManagedChildProcessIdentity;
  readonly processControl: ManagedChildProcessControl;
  readonly attempts?: number;
}): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const actual = safeReadIdentity(input.processControl, input.identity.pid);
    if (actual === undefined) return false;
    if (!sameProcess(input.identity, actual)) {
      return true;
    }
    const attempts = input.attempts ?? PROCESS_TERMINATE_ATTEMPTS;
    if (attempts <= 0) return false;
    yield* Effect.sleep(PROCESS_TERMINATE_RETRY_DELAY);
    return yield* waitForProcessLifetimeToEnd({ ...input, attempts: attempts - 1 });
  });
}

function signalProcess(
  processControl: ManagedChildProcessControl,
  identity: ManagedChildProcessIdentity,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  if (!sameProcess(identity, safeReadIdentity(processControl, identity.pid))) return false;
  try {
    return processControl.signal(identity.pid, signal);
  } catch {
    return false;
  }
}

const reapProcessRecord = Effect.fn("managedChildProcess.reapRecord")(function* (input: {
  readonly filePath: string;
  readonly processControl: ManagedChildProcessControl;
}) {
  const raw = yield* Effect.sync(() => {
    try {
      return readFileSync(input.filePath, "utf8");
    } catch {
      return "";
    }
  });
  const record = parseProcessRecord(raw);
  if (!record) {
    yield* Effect.sync(() => {
      try {
        unlinkSync(input.filePath);
      } catch {
        // Best-effort cleanup of malformed or concurrently removed records.
      }
    });
    return;
  }

  const owner = safeReadIdentity(input.processControl, record.owner.pid);
  const child = safeReadIdentity(input.processControl, record.child.pid);
  if (owner === undefined || child === undefined) return;
  if (sameProcess(record.owner, owner) && sameProcess(record.child, child)) return;
  if (!sameProcess(record.child, child)) {
    yield* Effect.sync(() => {
      try {
        unlinkSync(input.filePath);
      } catch {
        // Best-effort cleanup of a record whose PID was reused.
      }
    });
    return;
  }

  signalProcess(input.processControl, record.child, "SIGTERM");
  const terminated = yield* waitForProcessLifetimeToEnd({
    identity: record.child,
    processControl: input.processControl,
  });
  if (!terminated) {
    signalProcess(input.processControl, record.child, "SIGKILL");
    yield* waitForProcessLifetimeToEnd({
      identity: record.child,
      processControl: input.processControl,
    });
  }
  const finalChild = safeReadIdentity(input.processControl, record.child.pid);
  if (finalChild !== undefined && !sameProcess(record.child, finalChild)) {
    yield* Effect.sync(() => {
      try {
        unlinkSync(input.filePath);
      } catch {
        // A concurrent reconciliation may already have removed it.
      }
    });
  }
});

export const reapManagedChildProcesses = Effect.fn("managedChildProcess.reap")(function* (input: {
  readonly registryDirectory: string;
  readonly processControl?: ManagedChildProcessControl;
}) {
  const entries = yield* Effect.sync(() => {
    try {
      return readdirSync(input.registryDirectory);
    } catch {
      return [] as string[];
    }
  });
  const processControl = input.processControl ?? defaultProcessControl;
  yield* Effect.forEach(
    entries,
    (entry) =>
      reapProcessRecord({
        filePath: join(input.registryDirectory, entry),
        processControl,
      }).pipe(Effect.catchCause(() => Effect.void)),
    { concurrency: PROCESS_REAP_CONCURRENCY, discard: true },
  );
});
