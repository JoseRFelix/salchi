#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@salchi/shared/Net";
import { resolveSpawnCommand } from "@salchi/shared/shell";
import { terminateChildProcess } from "@salchi/shared/childProcess";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

export const DEFAULT_SALCHI_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), ".salchi"),
);

const MODE_ARGS = {
  dev: [
    "run",
    "--filter=@salchi/contracts",
    "--filter=@salchi/web",
    "--filter=salchi",
    "--parallel",
    "dev",
  ],
  "dev:server": ["run", "--filter=salchi", "dev"],
  "dev:web": ["run", "--filter=@salchi/web", "dev"],
  "dev:desktop": ["run", "--filter=@salchi/desktop", "--filter=@salchi/web", "dev"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export function getDevRunnerModeArgs(mode: DevMode): ReadonlyArray<string> {
  return MODE_ARGS[mode];
}

class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalUrlConfig = (name: string): Config.Config<URL | undefined> =>
  Config.url(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("SALCHI_PORT_OFFSET"),
  devInstance: optionalStringConfig("SALCHI_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid SALCHI_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `SALCHI_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric SALCHI_DEV_INSTANCE=${seed}` };
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed SALCHI_DEV_INSTANCE=${seed}` };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_SALCHI_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly salchiHome: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  salchiHome,
  noBrowser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const resolvedBaseDir = yield* resolveBaseDir(salchiHome);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
      SALCHI_HOME: resolvedBaseDir,
    };

    if (!isDesktopMode) {
      output.SALCHI_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      output.SALCHI_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      delete output.SALCHI_MODE;
      delete output.SALCHI_NO_BROWSER;
      delete output.SALCHI_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.SALCHI_HOST = host;
    }

    if (!isDesktopMode && noBrowser !== undefined) {
      output.SALCHI_NO_BROWSER = noBrowser ? "1" : "0";
    } else if (!isDesktopMode) {
      delete output.SALCHI_NO_BROWSER;
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.SALCHI_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.SALCHI_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.SALCHI_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.SALCHI_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.SALCHI_MODE = "web";
      delete output.SALCHI_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.SALCHI_MODE = "web";
      delete output.SALCHI_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      delete output.SALCHI_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService.NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService.NetService;
    return yield* checkPortAvailabilityOnHosts(port, DEV_PORT_PROBE_HOSTS, (candidatePort, host) =>
      net.canListenOnHost(candidatePort, host),
    );
  });

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService.NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${BASE_SERVER_PORT}+n web=${BASE_WEB_PORT}+n up to port ${MAX_PORT}.`,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService.NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly salchiHome: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly runnerArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: "Failed to read SALCHI_PORT_OFFSET/SALCHI_DEV_INSTANCE configuration.",
            cause,
          }),
      ),
    );

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance }),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      salchiHome: input.salchiHome,
      noBrowser: input.noBrowser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.SALCHI_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.SALCHI_HOME)}`,
    );

    if (input.dryRun) {
      return;
    }

    const args = [...MODE_ARGS[input.mode], ...input.runnerArgs];
    const spawnCommand = resolveSpawnCommand("vp", args, {
      env,
    });
    const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      shell: spawnCommand.shell,
      // Keep Vite+ in the same process group so terminal signals (Ctrl+C)
      // reach it directly. Effect defaults to detached: true on non-Windows,
      // which would put Vite+ in a new group and require manual forwarding.
      detached: false,
    });
    yield* Effect.addFinalizer(() =>
      terminateChildProcess(child, {
        gracefulTimeout: "1500 millis",
        forceTimeout: "1500 millis",
      }).pipe(Effect.ignore),
    );

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `vp exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner failed",
            cause,
          }),
    ),
  );
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  salchiHome: Flag.string("home-dir").pipe(
    Flag.withDescription("Base directory for all Salchi data (equivalent to SALCHI_HOME)."),
    Flag.withFallbackConfig(optionalStringConfig("SALCHI_HOME")),
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle (equivalent to SALCHI_NO_BROWSER)."),
    Flag.withFallbackConfig(optionalBooleanConfig("SALCHI_NO_BROWSER")),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to SALCHI_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("SALCHI_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to SALCHI_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("SALCHI_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to SALCHI_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("SALCHI_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to SALCHI_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("SALCHI_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn Vite+."),
    Flag.withDefault(false),
  ),
  runnerArgs: Argument.string("runner-arg").pipe(
    Argument.withDescription("Additional Vite+ args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
