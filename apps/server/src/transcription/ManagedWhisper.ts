// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";

import * as NetService from "@salchi/shared/Net";
import type { TranscriptionModel, TranscriptionStatus } from "@salchi/contracts";
import { findTranscriptionModel } from "@salchi/shared/transcriptionModel";
import { terminateChildProcess } from "@salchi/shared/childProcess";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";

export const MANAGED_WHISPER_VERSION = "v1.9.1";
const MANAGED_WHISPER_DOWNLOAD_TIMEOUT = "15 minutes";
const MANAGED_WHISPER_EXTRACTION_TIMEOUT = "1 minute";
const MANAGED_WHISPER_HEALTH_REQUEST_TIMEOUT = "2 seconds";
const MANAGED_WHISPER_START_TIMEOUT = "30 seconds";
const MANAGED_WHISPER_PROCESS_TERMINATE_GRACE = "2 seconds";
const MANAGED_WHISPER_LOCK_TIMEOUT = "15 minutes";
const MANAGED_WHISPER_LOCK_TIMEOUT_MS = 15 * 60 * 1_000;
const MANAGED_WHISPER_LOCK_RETRY_DELAY = "200 millis";
const MANAGED_WHISPER_STALE_LOCK_MS = 5 * 60 * 1_000;

interface ManagedWhisperModelAsset {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly url: string;
}

const MANAGED_WHISPER_MODEL_ASSETS: Readonly<Record<TranscriptionModel, ManagedWhisperModelAsset>> =
  {
    "tiny.en": {
      fileName: "ggml-tiny.en.bin",
      bytes: findTranscriptionModel("tiny.en").downloadBytes,
      sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    },
    "base.en": {
      fileName: "ggml-base.en.bin",
      bytes: findTranscriptionModel("base.en").downloadBytes,
      sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    },
    "small.en": {
      fileName: "ggml-small.en-q8_0.bin",
      bytes: findTranscriptionModel("small.en").downloadBytes,
      sha256: "67a179f608ea6114bd3fdb9060e762b588a3fb3bd00c4387971be4d177958067",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q8_0.bin",
    },
  };

export function resolveManagedWhisperModelAsset(
  model: TranscriptionModel,
): ManagedWhisperModelAsset {
  return MANAGED_WHISPER_MODEL_ASSETS[model];
}

interface ManagedWhisperRuntimeAsset {
  readonly archiveName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly url: string;
}

const RUNTIME_ASSETS: Readonly<Record<"arm64" | "x64", ManagedWhisperRuntimeAsset>> = {
  arm64: {
    archiveName: `whisper-bin-ubuntu-arm64-${MANAGED_WHISPER_VERSION}.tar.gz`,
    bytes: 4_555_819,
    sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${MANAGED_WHISPER_VERSION}/whisper-bin-ubuntu-arm64.tar.gz`,
  },
  x64: {
    archiveName: `whisper-bin-ubuntu-x64-${MANAGED_WHISPER_VERSION}.tar.gz`,
    bytes: 9_379_235,
    sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${MANAGED_WHISPER_VERSION}/whisper-bin-ubuntu-x64.tar.gz`,
  },
};

export class ManagedWhisperError extends Data.TaggedError("ManagedWhisperError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface ManagedWhisperProcess {
  readonly inferenceUrl: URL;
  readonly awaitTermination: Effect.Effect<never, ManagedWhisperError>;
}

const ManagedRuntimeMarkerSchema = Schema.Struct({
  version: Schema.String,
  archiveSha256: Schema.String,
  binaryBytes: Schema.Int,
  binarySha256: Schema.String,
});
type ManagedRuntimeMarker = typeof ManagedRuntimeMarkerSchema.Type;

const ManagedFileLockOwnerSchema = Schema.Struct({
  pid: Schema.Int,
  token: Schema.String,
});

const decodeManagedRuntimeMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedRuntimeMarkerSchema),
);
const encodeManagedRuntimeMarker = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ManagedRuntimeMarkerSchema),
);
const decodeManagedFileLockOwner = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedFileLockOwnerSchema),
);
const encodeManagedFileLockOwner = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ManagedFileLockOwnerSchema),
);

export function resolveManagedWhisperRuntimeAsset(
  platform: NodeJS.Platform,
  architecture: string,
): ManagedWhisperRuntimeAsset | null {
  if (platform !== "linux" || (architecture !== "arm64" && architecture !== "x64")) {
    return null;
  }
  return RUNTIME_ASSETS[architecture];
}

function managedWhisperError(detail: string, cause?: unknown) {
  return new ManagedWhisperError({ detail, cause });
}

const sha256File = Effect.fn("managedWhisper.sha256File")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hash = createHash("sha256");
  yield* fileSystem
    .stream(filePath)
    .pipe(Stream.runForEach((bytes) => Effect.sync(() => hash.update(bytes))));
  return hash.digest("hex");
});

const verifiedFileExists = Effect.fn("managedWhisper.verifiedFileExists")(function* (input: {
  readonly filePath: string;
  readonly bytes: number;
  readonly sha256: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem
    .stat(input.filePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!info || info.type !== "File" || Number(info.size) !== input.bytes) return false;
  const digest = yield* sha256File(input.filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  return digest === input.sha256;
});

function parseManagedRuntimeMarker(raw: string): ManagedRuntimeMarker | null {
  const marker = Option.getOrNull(decodeManagedRuntimeMarker(raw));
  if (marker === null || marker.binaryBytes < 1 || !/^[a-f0-9]{64}$/.test(marker.binarySha256)) {
    return null;
  }
  return marker;
}

export const validateManagedRuntime = Effect.fn("managedWhisper.validateRuntime")(
  function* (input: {
    readonly binaryPath: string;
    readonly markerPath: string;
    readonly version: string;
    readonly archiveSha256: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const markerRaw = yield* fileSystem
      .readFileString(input.markerPath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    const marker = parseManagedRuntimeMarker(markerRaw);
    if (
      marker === null ||
      marker.version !== input.version ||
      marker.archiveSha256 !== input.archiveSha256
    ) {
      return false;
    }

    const info = yield* fileSystem
      .stat(input.binaryPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (
      !info ||
      info.type !== "File" ||
      Number(info.size) !== marker.binaryBytes ||
      (info.mode & 0o111) === 0
    ) {
      return false;
    }
    const digest = yield* sha256File(input.binaryPath).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    return digest === marker.binarySha256;
  },
);

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "object" &&
    error.reason !== null &&
    "_tag" in error.reason &&
    error.reason._tag === "AlreadyExists"
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockOwner(raw: string): { readonly pid: number; readonly token: string } | null {
  const value = Option.getOrNull(decodeManagedFileLockOwner(raw));
  return value && value.pid > 0 ? value : null;
}

const removeStaleLock = Effect.fn("managedWhisper.removeStaleLock")(function* (lockPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const [raw, info] = yield* Effect.all([
    fileSystem.readFileString(lockPath).pipe(Effect.catch(() => Effect.succeed(""))),
    fileSystem.stat(lockPath).pipe(Effect.catch(() => Effect.succeed(null))),
  ]);
  if (!info) return true;
  const owner = parseLockOwner(raw);
  if (owner && processExists(owner.pid)) return false;
  const modifiedAt = Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (value) => value.getTime(),
  });
  const now = yield* Clock.currentTimeMillis;
  if (owner || now - modifiedAt >= MANAGED_WHISPER_STALE_LOCK_MS) {
    yield* fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore);
    return true;
  }
  return false;
});

interface ManagedFileLockOwner {
  readonly contents: string;
}

const releaseManagedFileLock = Effect.fn("managedWhisper.releaseFileLock")(function* (input: {
  readonly lockPath: string;
  readonly owner: ManagedFileLockOwner;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const raw = yield* input.fileSystem
    .readFileString(input.lockPath)
    .pipe(Effect.catch(() => Effect.succeed("")));
  if (raw === input.owner.contents) {
    yield* input.fileSystem.remove(input.lockPath, { force: true }).pipe(Effect.ignore);
  }
});

const acquireManagedFileLock = Effect.fn("managedWhisper.acquireFileLock")(function* (
  lockPath: string,
  interruptibleSleep: () => Effect.Effect<void>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const owner = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const contents = yield* encodeManagedFileLockOwner({
          pid: process.pid,
          token: randomUUID(),
        });
        const created = yield* Effect.scoped(
          fileSystem.open(lockPath, { flag: "wx", mode: 0o600 }).pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              isAlreadyExists(error)
                ? Effect.succeed(Option.none<FileSystem.File>())
                : Effect.fail(error),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(false),
                onSome: (file) =>
                  file.writeAll(new TextEncoder().encode(contents)).pipe(
                    Effect.andThen(file.sync),
                    Effect.as(true),
                    Effect.onError(() =>
                      fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore),
                    ),
                  ),
              }),
            ),
          ),
        );
        if (!created) return Option.none<ManagedFileLockOwner>();

        return Option.some({ contents } satisfies ManagedFileLockOwner);
      }),
    );
    if (Option.isSome(owner)) return owner.value;
    if ((yield* Clock.currentTimeMillis) - startedAt >= MANAGED_WHISPER_LOCK_TIMEOUT_MS) {
      return yield* managedWhisperError(
        `Timed out waiting for the managed dictation cache lock ${lockPath} after ${MANAGED_WHISPER_LOCK_TIMEOUT}.`,
      );
    }
    if (!(yield* removeStaleLock(lockPath))) {
      yield* interruptibleSleep();
    }
  }
});

export function withManagedFileLock<A, E, R>(input: {
  readonly lockPath: string;
  readonly use: Effect.Effect<A, E, R>;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.uninterruptibleMask((restore) =>
      acquireManagedFileLock(input.lockPath, () =>
        restore(Effect.sleep(MANAGED_WHISPER_LOCK_RETRY_DELAY)),
      ).pipe(
        Effect.flatMap((owner) =>
          restore(input.use).pipe(
            // In the pinned Effect beta an interrupted restored region can skip its generic
            // onExit cleanup. The ownership check makes this explicit interruption hook and
            // the normal exit hook safely idempotent.
            Effect.onInterrupt(() =>
              releaseManagedFileLock({ lockPath: input.lockPath, owner, fileSystem }),
            ),
            Effect.onExit(() =>
              releaseManagedFileLock({ lockPath: input.lockPath, owner, fileSystem }),
            ),
          ),
        ),
      ),
    );
  });
}

export function withManagedTemporaryDirectory<A, E, R>(input: {
  readonly directory: string;
  readonly prefix: string;
  readonly use: (temporaryDirectory: string) => Effect.Effect<A, E, R>;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.uninterruptibleMask((restore) =>
      fileSystem
        .makeTempDirectory({
          directory: input.directory,
          prefix: input.prefix,
        })
        .pipe(
          Effect.flatMap((temporaryDirectory) => {
            const cleanup = fileSystem
              .remove(temporaryDirectory, { recursive: true, force: true })
              .pipe(Effect.ignore);
            return restore(input.use(temporaryDirectory)).pipe(
              // See withManagedFileLock: keep interruption cleanup explicit for this Effect beta.
              Effect.onInterrupt(() => cleanup),
              Effect.onExit(() => cleanup),
            );
          }),
        ),
    );
  });
}

const downloadVerifiedFile = Effect.fn("managedWhisper.downloadVerifiedFile")(function* (input: {
  readonly url: string;
  readonly filePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly state: "downloading-runtime" | "downloading-model";
  readonly onStatus: (status: TranscriptionStatus) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;

  yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
  yield* withManagedFileLock({
    lockPath: `${input.filePath}.lock`,
    use: Effect.gen(function* () {
      if (yield* verifiedFileExists(input)) {
        yield* input.onStatus({
          configured: true,
          state: input.state,
          downloadedBytes: input.bytes,
          totalBytes: input.bytes,
          message: null,
        });
        return;
      }

      const partialPath = `${input.filePath}.${process.pid}.${randomUUID()}.part`;
      yield* input.onStatus({
        configured: true,
        state: input.state,
        downloadedBytes: 0,
        totalBytes: input.bytes,
        message: null,
      });

      const cleanupPartial = fileSystem.remove(partialPath, { force: true }).pipe(Effect.ignore);
      yield* Effect.gen(function* () {
        let downloadedBytes = 0;
        yield* httpClient.get(input.url).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.tap((bytes) => {
                downloadedBytes += bytes.length;
                if (downloadedBytes > input.bytes) {
                  return Effect.fail(
                    managedWhisperError("Downloaded artifact exceeded expected size."),
                  );
                }
                return input.onStatus({
                  configured: true,
                  state: input.state,
                  downloadedBytes,
                  totalBytes: input.bytes,
                  message: null,
                });
              }),
              Stream.run(fileSystem.sink(partialPath, { flag: "wx" })),
            ),
          ),
          Effect.timeout(MANAGED_WHISPER_DOWNLOAD_TIMEOUT),
          Effect.mapError((cause) =>
            cause instanceof ManagedWhisperError
              ? cause
              : managedWhisperError(`Failed to download ${path.basename(input.filePath)}.`, cause),
          ),
        );

        const valid = yield* verifiedFileExists({ ...input, filePath: partialPath });
        if (!valid) {
          return yield* managedWhisperError(
            `Downloaded ${path.basename(input.filePath)} failed integrity verification.`,
          );
        }
        yield* fileSystem.rename(partialPath, input.filePath);
      }).pipe(
        Effect.onInterrupt(() => cleanupPartial),
        Effect.ensuring(cleanupPartial),
      );
    }),
  });
});

export const terminateManagedChildProcess = Effect.fn("managedWhisper.terminateChild")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
) {
  yield* terminateChildProcess(child, {
    gracefulTimeout: MANAGED_WHISPER_PROCESS_TERMINATE_GRACE,
    forceTimeout: MANAGED_WHISPER_PROCESS_TERMINATE_GRACE,
  });
});

const addManagedChildProcessFinalizer = (
  child: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<void, never, import("effect/Scope").Scope> =>
  Effect.addFinalizer(() => terminateManagedChildProcess(child).pipe(Effect.ignore));

export const runTarExtraction = Effect.fn("managedWhisper.runTarExtraction")(function* (input: {
  readonly archivePath: string;
  readonly destination: string;
}) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              "tar",
              ["-xzf", input.archivePath, "-C", input.destination, "--strip-components=1"],
              {
                detached: false,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "inherit",
              },
            ),
          );
          yield* addManagedChildProcessFinalizer(child);
          return child;
        }),
      );
      const exitCode = yield* child.exitCode.pipe(
        Effect.timeoutOrElse({
          duration: MANAGED_WHISPER_EXTRACTION_TIMEOUT,
          orElse: () =>
            Effect.fail(
              managedWhisperError(
                `Timed out extracting whisper.cpp after ${MANAGED_WHISPER_EXTRACTION_TIMEOUT}.`,
              ),
            ),
        }),
      );
      if (Number(exitCode) !== 0) {
        return yield* managedWhisperError(`Failed to extract whisper.cpp (tar exit ${exitCode}).`);
      }
    }),
  );
});

const ensureManagedRuntime = Effect.fn("managedWhisper.ensureRuntime")(function* (input: {
  readonly cacheDir: string;
  readonly asset: ManagedWhisperRuntimeAsset;
  readonly onStatus: (status: TranscriptionStatus) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(
    input.cacheDir,
    `runtime-${MANAGED_WHISPER_VERSION}-${process.arch}`,
  );
  const binaryPath = path.join(runtimeDir, "whisper-server");
  const markerPath = path.join(runtimeDir, ".salchi-managed-runtime");
  yield* fileSystem.makeDirectory(input.cacheDir, { recursive: true });
  yield* withManagedFileLock({
    lockPath: `${runtimeDir}.lock`,
    use: Effect.gen(function* () {
      if (
        yield* validateManagedRuntime({
          binaryPath,
          markerPath,
          version: MANAGED_WHISPER_VERSION,
          archiveSha256: input.asset.sha256,
        })
      ) {
        return;
      }

      const archivePath = path.join(input.cacheDir, input.asset.archiveName);
      yield* downloadVerifiedFile({
        ...input.asset,
        filePath: archivePath,
        state: "downloading-runtime",
        onStatus: input.onStatus,
      });
      yield* input.onStatus({
        configured: true,
        state: "starting",
        downloadedBytes: null,
        totalBytes: null,
        message: "Installing the local dictation runtime…",
      });

      yield* withManagedTemporaryDirectory({
        directory: input.cacheDir,
        prefix: "whisper-runtime-",
        use: (temporaryDirectory) =>
          Effect.gen(function* () {
            yield* runTarExtraction({ archivePath, destination: temporaryDirectory });
            const temporaryBinary = path.join(temporaryDirectory, "whisper-server");
            const temporaryMarker = path.join(temporaryDirectory, ".salchi-managed-runtime");
            const binaryInfo = yield* fileSystem
              .stat(temporaryBinary)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (!binaryInfo || binaryInfo.type !== "File" || Number(binaryInfo.size) < 1) {
              return yield* managedWhisperError(
                "The whisper.cpp archive did not contain a valid whisper-server executable.",
              );
            }
            yield* fileSystem.chmod(temporaryBinary, 0o755);
            const marker: ManagedRuntimeMarker = {
              version: MANAGED_WHISPER_VERSION,
              archiveSha256: input.asset.sha256,
              binaryBytes: Number(binaryInfo.size),
              binarySha256: yield* sha256File(temporaryBinary),
            };
            yield* fileSystem.writeFileString(
              temporaryMarker,
              `${yield* encodeManagedRuntimeMarker(marker)}\n`,
            );
            if (
              !(yield* validateManagedRuntime({
                binaryPath: temporaryBinary,
                markerPath: temporaryMarker,
                version: MANAGED_WHISPER_VERSION,
                archiveSha256: input.asset.sha256,
              }))
            ) {
              return yield* managedWhisperError(
                "The installed whisper-server executable failed validation.",
              );
            }
            yield* fileSystem.remove(runtimeDir, { recursive: true, force: true });
            yield* fileSystem.rename(temporaryDirectory, runtimeDir);
          }),
      });
    }),
  });
  return binaryPath;
});

const ensureManagedModel = Effect.fn("managedWhisper.ensureModel")(function* (input: {
  readonly cacheDir: string;
  readonly asset: ManagedWhisperModelAsset;
  readonly onStatus: (status: TranscriptionStatus) => Effect.Effect<void>;
}) {
  const path = yield* Path.Path;
  const modelPath = path.join(input.cacheDir, input.asset.fileName);
  yield* downloadVerifiedFile({
    url: input.asset.url,
    filePath: modelPath,
    bytes: input.asset.bytes,
    sha256: input.asset.sha256,
    state: "downloading-model",
    onStatus: input.onStatus,
  });
  return modelPath;
});

export const awaitSidecarHealth = Effect.fn("managedWhisper.awaitHealth")(function* (
  healthUrl: URL,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const deadline = (yield* Clock.currentTimeMillis) + 30_000;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const healthy = yield* httpClient.get(healthUrl).pipe(
      Effect.timeout(MANAGED_WHISPER_HEALTH_REQUEST_TIMEOUT),
      Effect.map((response) => response.status >= 200 && response.status < 300),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (healthy) return;
    yield* Effect.sleep("200 millis");
  }
  return yield* managedWhisperError(
    `whisper-server did not become healthy within ${MANAGED_WHISPER_START_TIMEOUT}.`,
  );
});

export function makeManagedWhisperSidecarCommand(input: {
  readonly binaryPath: string;
  readonly modelPath: string;
  readonly port: number;
  readonly threads: number;
  readonly temporaryDirectory: string;
}) {
  return ChildProcess.make(
    input.binaryPath,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--threads",
      String(input.threads),
      "--model",
      input.modelPath,
      "--tmp-dir",
      input.temporaryDirectory,
      "--no-gpu",
    ],
    {
      // Keep terminal Ctrl+C scoped to the Salchi process. The sidecar is
      // terminated by its owning Effect scope instead of receiving SIGINT
      // concurrently and being mistaken for an unexpected crash.
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    },
  );
}

const startManagedSidecar = Effect.fn("managedWhisper.startSidecar")(function* (input: {
  readonly binaryPath: string;
  readonly modelPath: string;
  readonly cacheDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const port = yield* net.reserveLoopbackPort();
  const temporaryDirectory = path.join(input.cacheDir, "tmp");
  yield* fileSystem.makeDirectory(temporaryDirectory, { recursive: true });
  const threads = Math.max(1, Math.min(4, availableParallelism()));
  const child = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        makeManagedWhisperSidecarCommand({
          binaryPath: input.binaryPath,
          modelPath: input.modelPath,
          port,
          threads,
          temporaryDirectory,
        }),
      );
      yield* addManagedChildProcessFinalizer(child);
      return child;
    }),
  );

  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const healthUrl = new URL("/health", baseUrl);
  yield* Effect.raceFirst(
    awaitSidecarHealth(healthUrl),
    child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Effect.fail(managedWhisperError(`whisper-server exited with code ${exitCode}.`)),
      ),
    ),
  );
  return {
    inferenceUrl: new URL("/inference", baseUrl),
    awaitTermination: child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Effect.fail(managedWhisperError(`whisper-server exited with code ${exitCode}.`)),
      ),
      Effect.mapError((cause) =>
        cause instanceof ManagedWhisperError
          ? cause
          : managedWhisperError("Failed while monitoring whisper-server.", cause),
      ),
    ),
  } satisfies ManagedWhisperProcess;
});

const provisionManagedWhisperInternal = Effect.fn("managedWhisper.provision")(function* (input: {
  readonly model: TranscriptionModel;
  readonly onStatus: (status: TranscriptionStatus) => Effect.Effect<void>;
}) {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const asset = resolveManagedWhisperRuntimeAsset(process.platform, process.arch);
  if (!asset) {
    return yield* managedWhisperError(
      `Automatic dictation installation is not available for ${process.platform}/${process.arch}. Configure SALCHI_WHISPER_SERVER_URL instead.`,
    );
  }

  const cacheDir = path.join(config.providerStatusCacheDir, "dictation");
  yield* input.onStatus({
    configured: true,
    state: "checking",
    downloadedBytes: null,
    totalBytes: null,
    message: "Checking local dictation files…",
  });
  const binaryPath = yield* ensureManagedRuntime({ cacheDir, asset, onStatus: input.onStatus });
  const modelPath = yield* ensureManagedModel({
    cacheDir,
    asset: resolveManagedWhisperModelAsset(input.model),
    onStatus: input.onStatus,
  });
  yield* input.onStatus({
    configured: true,
    state: "starting",
    downloadedBytes: null,
    totalBytes: null,
    message: "Starting local dictation…",
  });
  return yield* startManagedSidecar({ binaryPath, modelPath, cacheDir });
});

export const provisionManagedWhisper = (input: {
  readonly model: TranscriptionModel;
  readonly onStatus: (status: TranscriptionStatus) => Effect.Effect<void>;
}) =>
  provisionManagedWhisperInternal(input).pipe(
    Effect.mapError((cause) =>
      cause instanceof ManagedWhisperError
        ? cause
        : managedWhisperError("Failed to prepare local dictation.", cause),
    ),
  );
