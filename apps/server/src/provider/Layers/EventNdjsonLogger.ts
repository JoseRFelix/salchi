// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort, bounded provider diagnostics logging.
 *
 * Native and canonical facades can share one manager so each thread has only
 * one writer and one rotation owner. Payloads are redacted and bounded before
 * they enter the batch queue, and one global TTL/byte policy covers all thread
 * families in the provider-log directory.
 */
import fs from "node:fs";
import path from "node:path";

import type { ThreadId } from "@salchi/contracts";
import { RotatingFileSink } from "@salchi/shared/logging";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import {
  DEFAULT_PROVIDER_LOG_MAX_AGE_MS,
  DEFAULT_PROVIDER_LOG_MAX_FILES_PER_THREAD,
  DEFAULT_PROVIDER_LOG_MAX_FILE_BYTES,
  DEFAULT_PROVIDER_LOG_MAX_RECORD_BYTES,
  DEFAULT_PROVIDER_LOG_MAX_STRING_BYTES,
  DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES,
  deleteProviderLogsForThread,
  pruneProviderLogs,
} from "../ProviderLogRetention.ts";

const DEFAULT_BATCH_WINDOW_MS = 200;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const RETENTION_CHECK_BYTES = 1024 * 1024;
const RETENTION_CHECK_INTERVAL_MS = 60_000;
const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const MAX_COLLECTION_ENTRIES = 100;
const MAX_OBJECT_DEPTH = 12;

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxStringBytes?: number;
  readonly batchWindowMs?: number;
}

export type CoordinatedEventNdjsonLoggerOptions = Omit<EventNdjsonLoggerOptions, "stream">;

interface ResolvedLoggerOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly maxRecordBytes: number;
  readonly maxStringBytes: number;
  readonly batchWindowMs: number;
}

interface ThreadWriter {
  writeMessage: (message: string) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

interface LoggerState {
  readonly threadWriters: Map<string, ThreadWriter>;
  readonly failedSegments: Set<string>;
}

interface EventNdjsonManager {
  readonly filePath: string;
  write: (
    stream: EventNdjsonStream,
    event: unknown,
    threadId: ThreadId | null,
  ) => Effect.Effect<void>;
  deleteThread: (threadId: ThreadId) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface CoordinatedEventNdjsonLoggers {
  readonly native: EventNdjsonLogger;
  readonly canonical: EventNdjsonLogger;
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function formatLoggerMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  }
  return typeof message === "string" ? message : String(message);
}

function makeLineLogger(): Logger.Logger<unknown, string> {
  return Logger.make(({ message }) => `${formatLoggerMessage(message)}\n`);
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  // Keep the historical label for compatibility with existing diagnostic tooling.
  return stream === "native" ? "NTIVE" : "CANON";
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.endsWith("token") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential")
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  const omittedBytes = encoded.length - maxBytes;
  const prefix = encoded
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}…[truncated ${String(omittedBytes)} bytes]`;
}

function redactSensitiveText(value: string, maxStringBytes: number): string {
  return truncateUtf8(value, maxStringBytes)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|authorization|cookie|token)\s*[:=]\s*)[^\s,;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`);
}

function sanitizeProviderValue(
  value: unknown,
  maxStringBytes: number,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactSensitiveText(value, maxStringBytes);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= MAX_OBJECT_DEPTH) return "[Maximum depth reached]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) {
      return `[Binary data: ${String(value.byteLength)} bytes]`;
    }
    if (Array.isArray(value)) {
      const sanitized = value
        .slice(0, MAX_COLLECTION_ENTRIES)
        .map((item) => sanitizeProviderValue(item, maxStringBytes, seen, depth + 1));
      if (value.length > MAX_COLLECTION_ENTRIES) {
        sanitized.push(`[${String(value.length - MAX_COLLECTION_ENTRIES)} entries omitted]`);
      }
      return sanitized;
    }

    const sanitized: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, MAX_COLLECTION_ENTRIES);
    for (const [key, item] of entries) {
      const safeKey = truncateUtf8(key, 512);
      sanitized[safeKey] = isSensitiveKey(key)
        ? REDACTED
        : sanitizeProviderValue(item, maxStringBytes, seen, depth + 1);
    }
    const ownKeyCount = Reflect.ownKeys(value).length;
    if (ownKeyCount > MAX_COLLECTION_ENTRIES) {
      sanitized._salchiOmittedFields = ownKeyCount - MAX_COLLECTION_ENTRIES;
    }
    return sanitized;
  } catch {
    return "[Unserializable value]";
  } finally {
    seen.delete(value);
  }
}

function boundSerializedRecord(serialized: string, maxRecordBytes: number): string {
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= maxRecordBytes) return serialized;

  let previewBytes = Math.max(32, Math.floor(maxRecordBytes / 2));
  let bounded = "";
  do {
    bounded = JSON.stringify({
      _salchiTruncated: true,
      originalBytes,
      preview: truncateUtf8(serialized, previewBytes),
    });
    previewBytes = Math.max(16, Math.floor(previewBytes / 2));
  } while (Buffer.byteLength(bounded) > maxRecordBytes && previewBytes > 16);
  return bounded;
}

export function serializeProviderEvent(
  event: unknown,
  options: { readonly maxRecordBytes: number; readonly maxStringBytes: number },
): string | undefined {
  try {
    const sanitized = sanitizeProviderValue(
      event,
      Math.max(64, options.maxStringBytes),
      new WeakSet(),
      0,
    );
    const serialized = JSON.stringify(sanitized);
    if (serialized === undefined) return undefined;
    return boundSerializedRecord(serialized, Math.max(256, options.maxRecordBytes));
  } catch {
    return undefined;
  }
}

function resolveOptions(options: CoordinatedEventNdjsonLoggerOptions): ResolvedLoggerOptions {
  return {
    maxBytes: Math.max(1, options.maxBytes ?? DEFAULT_PROVIDER_LOG_MAX_FILE_BYTES),
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_PROVIDER_LOG_MAX_FILES_PER_THREAD),
    maxTotalBytes: Math.max(0, options.maxTotalBytes ?? DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES),
    maxAgeMs: Math.max(0, options.maxAgeMs ?? DEFAULT_PROVIDER_LOG_MAX_AGE_MS),
    maxRecordBytes: Math.max(256, options.maxRecordBytes ?? DEFAULT_PROVIDER_LOG_MAX_RECORD_BYTES),
    maxStringBytes: Math.max(64, options.maxStringBytes ?? DEFAULT_PROVIDER_LOG_MAX_STRING_BYTES),
    batchWindowMs: Math.max(0, options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS),
  };
}

const makeThreadWriter = Effect.fn("makeThreadWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly afterFlush: (writtenBytes: number, now: number) => void;
  readonly registerSink: (sink: RotatingFileSink) => void;
  readonly shouldWrite: () => boolean;
}): Effect.fn.Return<ThreadWriter | undefined> {
  const sinkResult = yield* Effect.sync(() => {
    try {
      const sink = new RotatingFileSink({
        filePath: input.filePath,
        maxBytes: input.maxBytes,
        maxFiles: input.maxFiles,
        throwOnError: true,
        directoryMode: 0o700,
        fileMode: 0o600,
      });
      input.registerSink(sink);
      return { ok: true as const, sink };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!sinkResult.ok) {
    yield* logWarning("failed to initialize provider thread log file", {
      filePath: input.filePath,
      error: sinkResult.error,
    });
    return undefined;
  }

  const sink = sinkResult.sink;
  const scope = yield* Scope.make();
  const batchedLogger = yield* Logger.batched(makeLineLogger(), {
    window: input.batchWindowMs,
    flush: Effect.fn("makeThreadWriter.flush")(function* (messages) {
      const now = yield* Clock.currentTimeMillis;
      const flushResult = yield* Effect.sync(() => {
        try {
          let writtenBytes = 0;
          if (!input.shouldWrite()) {
            return { ok: true as const };
          }
          for (const message of messages) {
            sink.write(message);
            writtenBytes += Buffer.byteLength(message);
          }
          input.afterFlush(writtenBytes, now);
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      });

      if (!flushResult.ok) {
        yield* logWarning("provider event log batch flush failed", {
          filePath: input.filePath,
          error: flushResult.error,
        });
      }
    }),
  }).pipe(Effect.provideService(Scope.Scope, scope));

  const loggerLayer = Logger.layer([batchedLogger], { mergeWithExisting: false });

  return {
    writeMessage(message: string) {
      return Effect.log(message).pipe(Effect.provide(loggerLayer));
    },
    close() {
      return Scope.close(scope, Exit.void);
    },
  } satisfies ThreadWriter;
});

const makeEventNdjsonManager = Effect.fn("makeEventNdjsonManager")(function* (
  filePath: string,
  inputOptions: CoordinatedEventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonManager | undefined> {
  const options = resolveOptions(inputOptions);
  const providerLogsDir = path.dirname(filePath);
  const directoryReady = yield* Effect.sync(() => {
    try {
      fs.mkdirSync(providerLogsDir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(providerLogsDir).isDirectory()) {
        throw new Error("provider log path is not a real directory");
      }
      try {
        fs.chmodSync(providerLogsDir, 0o700);
      } catch {
        // POSIX modes are best-effort on platforms such as Windows.
      }
      const pruneResult = pruneProviderLogs(providerLogsDir, options);
      return { ok: true as const, pruneResult };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (!directoryReady.ok) {
    yield* logWarning("failed to create or prune provider event log directory", {
      filePath,
      error: directoryReady.error,
    });
    return undefined;
  }

  const sinks = new Set<RotatingFileSink>();
  const deletedSegments = new Set<string>();
  let bytesSinceRetention = 0;
  let estimatedRetainedBytes = directoryReady.pruneResult.remainingBytes;
  let lastRetentionAt = yield* Clock.currentTimeMillis;
  const retentionCheckBytes = Math.max(
    1,
    Math.min(RETENTION_CHECK_BYTES, options.maxTotalBytes || 1),
  );
  const afterFlush = (writtenBytes: number, now: number): void => {
    bytesSinceRetention += writtenBytes;
    estimatedRetainedBytes += writtenBytes;
    if (
      estimatedRetainedBytes <= options.maxTotalBytes &&
      bytesSinceRetention < retentionCheckBytes &&
      now - lastRetentionAt < RETENTION_CHECK_INTERVAL_MS
    ) {
      return;
    }
    const pruneResult = pruneProviderLogs(providerLogsDir, { ...options, now });
    for (const sink of sinks) sink.refreshCurrentSize();
    estimatedRetainedBytes = pruneResult.remainingBytes;
    bytesSinceRetention = 0;
    lastRetentionAt = now;
  };

  const stateRef = yield* SynchronizedRef.make<LoggerState>({
    threadWriters: new Map(),
    failedSegments: new Set(),
  });

  const resolveThreadWriter = Effect.fn("resolveThreadWriter")(function* (
    threadSegment: string,
  ): Effect.fn.Return<ThreadWriter | undefined> {
    return yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
      if (state.failedSegments.has(threadSegment)) {
        return Effect.succeed([undefined, state] as const);
      }

      const existing = state.threadWriters.get(threadSegment);
      if (existing) {
        return Effect.succeed([existing, state] as const);
      }

      return makeThreadWriter({
        filePath: path.join(providerLogsDir, `${threadSegment}.log`),
        maxBytes: options.maxBytes,
        maxFiles: options.maxFiles,
        batchWindowMs: options.batchWindowMs,
        afterFlush,
        registerSink: (sink) => sinks.add(sink),
        shouldWrite: () => !deletedSegments.has(threadSegment),
      }).pipe(
        Effect.map((writer) => {
          if (!writer) {
            const nextFailedSegments = new Set(state.failedSegments);
            nextFailedSegments.add(threadSegment);
            return [undefined, { ...state, failedSegments: nextFailedSegments }] as const;
          }

          const nextThreadWriters = new Map(state.threadWriters);
          nextThreadWriters.set(threadSegment, writer);
          return [writer, { ...state, threadWriters: nextThreadWriters }] as const;
        }),
      );
    });
  });

  const write = Effect.fn("write")(function* (
    stream: EventNdjsonStream,
    event: unknown,
    threadId: ThreadId | null,
  ) {
    if (deletedSegments.has(resolveThreadSegment(threadId))) return;
    const message = serializeProviderEvent(event, options);
    if (!message) {
      yield* logWarning("failed to serialize provider event log record", {});
      return;
    }

    const writer = yield* resolveThreadWriter(resolveThreadSegment(threadId));
    if (!writer) return;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${message}`;
    yield* writer.writeMessage(line);
  });

  const deleteThread = Effect.fn("deleteThreadProviderLogs")(function* (threadId: ThreadId) {
    deletedSegments.add(resolveThreadSegment(threadId));
    const result = yield* Effect.sync(() => deleteProviderLogsForThread(providerLogsDir, threadId));
    estimatedRetainedBytes = Math.max(0, estimatedRetainedBytes - result.deletedBytes);
    for (const sink of sinks) sink.refreshCurrentSize();
  });

  const close = Effect.fn("close")(function* () {
    yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* () {
        for (const writer of state.threadWriters.values()) {
          yield* writer.close();
        }
        sinks.clear();
        return [
          undefined,
          { threadWriters: new Map<string, ThreadWriter>(), failedSegments: new Set<string>() },
        ] as const;
      }),
    );
    yield* Effect.sync(() => pruneProviderLogs(providerLogsDir, options));
  });

  return { filePath, write, deleteThread, close } satisfies EventNdjsonManager;
});

function loggerFacade(manager: EventNdjsonManager, stream: EventNdjsonStream): EventNdjsonLogger {
  return {
    filePath: manager.filePath,
    write: (event, threadId) => manager.write(stream, event, threadId),
    close: manager.close,
  };
}

export const makeCoordinatedEventNdjsonLoggers = Effect.fn("makeCoordinatedEventNdjsonLoggers")(
  function* (
    filePath: string,
    options: CoordinatedEventNdjsonLoggerOptions = {},
  ): Effect.fn.Return<CoordinatedEventNdjsonLoggers | undefined> {
    const manager = yield* makeEventNdjsonManager(filePath, options);
    if (!manager) return undefined;
    return {
      native: loggerFacade(manager, "native"),
      canonical: loggerFacade(manager, "canonical"),
      deleteThread: manager.deleteThread,
    };
  },
);

export const makeEventNdjsonLogger = Effect.fn("makeEventNdjsonLogger")(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const manager = yield* makeEventNdjsonManager(filePath, options);
  return manager ? loggerFacade(manager, options.stream) : undefined;
});
