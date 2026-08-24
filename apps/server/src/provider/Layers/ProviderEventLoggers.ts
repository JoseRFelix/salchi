/**
 * ProviderEventLoggers — single observability service that owns the two
 * shared NDJSON streams the provider runtime writes:
 *
 *   - `native`    — provider-protocol events as the SDK emits them, written
 *                   from inside each `<X>Adapter` factory.
 *   - `canonical` — runtime events after `ProviderService` has normalized
 *                   them onto `ProviderRuntimeEvent`.
 *
 * Why a service tag and not constructor options?
 *
 *   - Adapters are now constructed *inside* drivers (`<X>Driver.create()`),
 *     not at the boot Layer. There is no longer a single `make<X>AdapterLive(options)`
 *     call site where we can hand an `EventNdjsonLogger` in by hand.
 *   - Multiple driver instances per kind (`codex_personal`, `codex_work`)
 *     should share one underlying log writer per stream — opening N writers
 *     against the same rotating file would race the rotation logic. Owning
 *     the loggers on a single tag keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional. `makeEventNdjsonLogger` returns `undefined` when
 * the target directory cannot be created; we forward that as `undefined`
 * rather than failing the boot Layer, matching the previous best-effort
 * behavior of `server.ts`.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ThreadId } from "@salchi/contracts";

import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeCoordinatedEventNdjsonLoggers } from "./EventNdjsonLogger.ts";
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

export interface ProviderEventLoggersShape {
  readonly native: EventNdjsonLogger | undefined;
  readonly canonical: EventNdjsonLogger | undefined;
  readonly deleteThreadLogs: (threadId: ThreadId) => Effect.Effect<void>;
}

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`ProviderEventLoggersLive`); consumers (drivers, `ProviderService`) read
 * one tag and pluck the field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  ProviderEventLoggersShape
>()("salchi/provider/Layers/ProviderEventLoggers") {}

/**
 * Constant value used by tests / boot layers that want to opt out of native
 * + canonical logging entirely. Keeps the tag non-optional in the type
 * system while letting the runtime treat absence as a no-op.
 */
export const NoOpProviderEventLoggers: ProviderEventLoggersShape = {
  native: undefined,
  canonical: undefined,
  deleteThreadLogs: () => Effect.void,
};

/**
 * Live Layer that always repairs retained logs, then builds one coordinated
 * writer only when local provider diagnostics are enabled. Production config
 * defaults to disabled; canonical events are the default opt-in stream and
 * native events require a second explicit opt-in.
 */
export const ProviderEventLoggersLive = Layer.effect(
  ProviderEventLoggers,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const maxTotalBytes =
      config.providerEventLogMaxTotalBytes ?? DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES;
    const maxAgeMs = config.providerEventLogMaxAgeMs ?? DEFAULT_PROVIDER_LOG_MAX_AGE_MS;
    yield* Effect.sync(() =>
      pruneProviderLogs(config.providerLogsDir, {
        maxTotalBytes,
        maxAgeMs,
      }),
    );

    if (!config.providerEventLoggingEnabled) {
      return {
        native: undefined,
        canonical: undefined,
        deleteThreadLogs: (threadId) =>
          Effect.sync(() => {
            deleteProviderLogsForThread(config.providerLogsDir, threadId);
          }),
      } satisfies ProviderEventLoggersShape;
    }

    const loggers = yield* makeCoordinatedEventNdjsonLoggers(config.providerEventLogPath, {
      maxBytes: config.providerEventLogMaxFileBytes ?? DEFAULT_PROVIDER_LOG_MAX_FILE_BYTES,
      maxFiles:
        config.providerEventLogMaxFilesPerThread ?? DEFAULT_PROVIDER_LOG_MAX_FILES_PER_THREAD,
      maxTotalBytes,
      maxAgeMs,
      maxRecordBytes:
        config.providerEventLogMaxRecordBytes ?? DEFAULT_PROVIDER_LOG_MAX_RECORD_BYTES,
      maxStringBytes:
        config.providerEventLogMaxStringBytes ?? DEFAULT_PROVIDER_LOG_MAX_STRING_BYTES,
    });
    return {
      native: config.providerEventLogIncludeNative ? loggers?.native : undefined,
      canonical: loggers?.canonical,
      deleteThreadLogs: (threadId) =>
        loggers
          ? loggers.deleteThread(threadId)
          : Effect.sync(() => {
              deleteProviderLogsForThread(config.providerLogsDir, threadId);
            }),
    } satisfies ProviderEventLoggersShape;
  }),
);
