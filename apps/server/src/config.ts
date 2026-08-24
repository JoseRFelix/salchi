/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";

import {
  DEFAULT_PROVIDER_LOG_MAX_AGE_MS,
  DEFAULT_PROVIDER_LOG_MAX_FILES_PER_THREAD,
  DEFAULT_PROVIDER_LOG_MAX_FILE_BYTES,
  DEFAULT_PROVIDER_LOG_MAX_RECORD_BYTES,
  DEFAULT_PROVIDER_LOG_MAX_STRING_BYTES,
  DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES,
} from "./provider/ProviderLogRetention.ts";

export const DEFAULT_PORT = 3773;

export const RuntimeMode = Schema.Literals(["web", "desktop"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const StartupPresentation = Schema.Literals(["browser", "headless"]);
export type StartupPresentation = typeof StartupPresentation.Type;

/**
 * ServerDerivedPaths - Derived paths from the base directory.
 */
export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath: string;
  readonly providerStatusCacheDir: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly serverTracePath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
  readonly anonymousIdPath: string;
  readonly environmentIdPath: string;
  readonly serverRuntimeStatePath: string;
  readonly secretsDir: string;
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly logLevel: LogLevel.LogLevel;
  readonly traceMinLevel: LogLevel.LogLevel;
  readonly traceTimingEnabled: boolean;
  readonly traceBatchWindowMs: number;
  readonly traceMaxBytes: number;
  readonly traceMaxFiles: number;
  readonly providerEventLoggingEnabled?: boolean;
  readonly providerEventLogIncludeNative?: boolean;
  readonly providerEventLogMaxFileBytes?: number;
  readonly providerEventLogMaxFilesPerThread?: number;
  readonly providerEventLogMaxTotalBytes?: number;
  readonly providerEventLogMaxAgeMs?: number;
  readonly providerEventLogMaxRecordBytes?: number;
  readonly providerEventLogMaxStringBytes?: number;
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpExportIntervalMs: number;
  readonly otlpServiceName: string;
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly baseDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly noBrowser: boolean;
  readonly startupPresentation: StartupPresentation;
  readonly desktopBootstrapToken: string | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly whisperServerUrl: URL | undefined;
  readonly whisperAutoProvision: boolean;
}

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfigShape["baseDir"],
  devUrl: ServerConfigShape["devUrl"],
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(baseDir, devUrl !== undefined ? "dev" : "userdata");
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(baseDir, "caches");
  return {
    stateDir,
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    providerStatusCacheDir,
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    serverTracePath: join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    anonymousIdPath: join(stateDir, "anonymous-id"),
    environmentIdPath: join(stateDir, "environment-id"),
    serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
    secretsDir: join(stateDir, "secrets"),
  };
});

export const ensureServerDirectories = Effect.fn(function* (derivedPaths: ServerDerivedPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.all(
    [
      fs.makeDirectory(derivedPaths.stateDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(derivedPaths.logsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(derivedPaths.providerLogsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(derivedPaths.terminalLogsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(derivedPaths.attachmentsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(derivedPaths.secretsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(derivedPaths.worktreesDir, { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.keybindingsConfigPath), { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true }),
      fs.makeDirectory(derivedPaths.providerStatusCacheDir, { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.anonymousIdPath), { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.serverRuntimeStatePath), { recursive: true }),
    ],
    { concurrency: "unbounded" },
  );

  // Tighten directories created by older versions. chmod is best-effort so
  // Windows and filesystems without POSIX modes continue to start normally.
  yield* Effect.forEach(
    [
      derivedPaths.stateDir,
      derivedPaths.logsDir,
      derivedPaths.providerLogsDir,
      derivedPaths.terminalLogsDir,
      derivedPaths.attachmentsDir,
      derivedPaths.secretsDir,
    ],
    (directory) =>
      Effect.gen(function* () {
        const symbolicLink = yield* fs
          .readLink(directory)
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
        if (!symbolicLink) {
          yield* fs.chmod(directory, 0o700).pipe(Effect.ignore);
        }
      }),
    { concurrency: "unbounded", discard: true },
  );
});

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "salchi/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, baseDirOrPrefix: string | { prefix: string }) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const devUrl = undefined;

        const fs = yield* FileSystem.FileSystem;
        const baseDir =
          typeof baseDirOrPrefix === "string"
            ? baseDirOrPrefix
            : yield* fs.makeTempDirectoryScoped({ prefix: baseDirOrPrefix.prefix });
        const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
        yield* ensureServerDirectories(derivedPaths);

        return {
          logLevel: "Error",
          traceMinLevel: "Info",
          traceTimingEnabled: true,
          traceBatchWindowMs: 200,
          traceMaxBytes: 10 * 1024 * 1024,
          traceMaxFiles: 10,
          providerEventLoggingEnabled: false,
          providerEventLogIncludeNative: false,
          providerEventLogMaxFileBytes: DEFAULT_PROVIDER_LOG_MAX_FILE_BYTES,
          providerEventLogMaxFilesPerThread: DEFAULT_PROVIDER_LOG_MAX_FILES_PER_THREAD,
          providerEventLogMaxTotalBytes: DEFAULT_PROVIDER_LOG_MAX_TOTAL_BYTES,
          providerEventLogMaxAgeMs: DEFAULT_PROVIDER_LOG_MAX_AGE_MS,
          providerEventLogMaxRecordBytes: DEFAULT_PROVIDER_LOG_MAX_RECORD_BYTES,
          providerEventLogMaxStringBytes: DEFAULT_PROVIDER_LOG_MAX_STRING_BYTES,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "salchi-server",
          cwd,
          baseDir,
          ...derivedPaths,
          mode: "web",
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          whisperServerUrl: undefined,
          whisperAutoProvision: false,
          port: 0,
          host: undefined,
          desktopBootstrapToken: undefined,
          staticDir: undefined,
          devUrl,
          noBrowser: false,
          startupPresentation: "browser",
        } satisfies ServerConfigShape;
      }),
    );
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
