import {
  PreviewAutomationExecutionError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationUnavailableError,
  PreviewTabId,
  ThreadId,
  type BrowserNavigationTarget,
  type PreviewAutomationClickInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
  type RemoteBrowserNavigateInput,
  type RemoteBrowserScreen,
  type RemoteBrowserStartInput,
  type RemoteBrowserStatus,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";

export interface RemoteBrowserManagerShape {
  readonly getStatus: Effect.Effect<RemoteBrowserStatus>;
  readonly start: (input?: RemoteBrowserStartInput) => Effect.Effect<RemoteBrowserStatus>;
  readonly navigate: (input: RemoteBrowserNavigateInput) => Effect.Effect<RemoteBrowserStatus>;
  readonly statuses: Stream.Stream<RemoteBrowserStatus>;
}

export class RemoteBrowserManager extends Context.Service<
  RemoteBrowserManager,
  RemoteBrowserManagerShape
>()("salchi/remoteBrowser/RemoteBrowserManager") {}

const REMOTE_BROWSER_CLIENT_ID = "server-managed-remote-browser";
const GLOBAL_REMOTE_BROWSER_THREAD_ID = "__global_remote_browser__";
const REMOTE_BROWSER_TAB_ID = "remote";
const NEKO_CONTAINER_HTTP_PORT = 8080;
const DEFAULT_NEKO_WEBRTC_PORTS = "56000-56100";
const NEKO_CLIENT_PATCH_VERSION = "salchi-clean-embedded-ui-v3";
const NEKO_CHROMIUM_APP_ARGUMENTS = [
  "--app=about:blank",
  "--test-type",
  "--no-default-browser-check",
] as const;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const REMOTE_BROWSER_SCREEN_PATTERN = /^([1-9][0-9]{2,4})x([1-9][0-9]{2,4})@([1-9][0-9]{0,2})$/u;
const NekoLoginResponse = Schema.Struct({
  token: Schema.optional(Schema.String),
});
const decodeNekoLoginResponse = HttpClientResponse.schemaBodyJson(NekoLoginResponse);
const NEKO_EMBEDDED_UI_CSS = `

/* Salchi embeds Neko as a transport, not as visible product UI. */
.connect .window,
.about .window,
.unsupported .window {
  display: none !important;
}
`;
const NEKO_BROWSER_SUPERVISOR_COMMAND =
  /(^command=(?:\/bin\/entrypoint\.sh )?\/usr\/bin\/(?:brave-browser|chromium|google-chrome|google-chrome-stable|microsoft-edge)\b[^\n]*\n)/m;

type PlaywrightBrowser = import("playwright-core").Browser;
type PlaywrightPage = import("playwright-core").Page;

interface BrowserRuntime {
  readonly browser: PlaywrightBrowser;
  readonly page: PlaywrightPage;
  readonly consoleEntries: RemoteBrowserStatusEntry[];
  readonly networkEntries: RemoteBrowserNetworkEntry[];
}

interface RemoteBrowserStatusEntry {
  readonly level: string;
  readonly text: string;
  readonly timestamp: string;
  readonly source?: string;
}

interface RemoteBrowserNetworkEntry {
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
  readonly failed: boolean;
  readonly errorText?: string;
  readonly timestamp: string;
}

interface DockerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface NekoClientPatchMount {
  readonly source: string;
  readonly target: string;
}

interface NekoClientPatch {
  readonly version: string;
  readonly mounts: ReadonlyArray<NekoClientPatchMount>;
}

interface SnapshotElement {
  readonly tag: string;
  readonly role: string | null;
  readonly name: string;
  readonly selector: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SnapshotPageData {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly visibleText: string;
  readonly interactiveElements: SnapshotElement[];
}

class DockerCommandFailed extends Data.TaggedError("DockerCommandFailed")<{
  readonly args: ReadonlyArray<string>;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {}

class NekoClientPatchFailed extends Data.TaggedError("NekoClientPatchFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class NekoApiRequestFailed extends Data.TaggedError("NekoApiRequestFailed")<{
  readonly message: string;
  readonly status?: number;
  readonly body?: string;
  readonly cause?: unknown;
}> {}

type DockerCommandError = ProcessRunner.ProcessRunError | DockerCommandFailed;
type NekoClientPatchError = DockerCommandError | NekoClientPatchFailed;
type NekoApiError = NekoApiRequestFailed;

const nowIso = (): string => DateTime.formatIso(DateTime.nowUnsafe());

const statusPageUrl = (url: string): string | null => {
  const trimmed = url.trim();
  return trimmed.length === 0 || trimmed === "about:blank" ? null : trimmed;
};

const failureMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const dockerErrorMessage = (error: DockerCommandError): string => {
  if (error instanceof DockerCommandFailed) {
    const output = error.stderr.trim() || error.stdout.trim() || "no output";
    return `docker ${error.args.join(" ")} exited with ${error.code ?? "unknown"}: ${output}`;
  }
  if ("message" in error && typeof error.message === "string") return error.message;
  return String(error);
};

const nekoClientPatchErrorMessage = (error: NekoClientPatchError): string => {
  if (error instanceof NekoClientPatchFailed) {
    return error.message;
  }
  return dockerErrorMessage(error);
};

const nekoApiErrorMessage = (error: NekoApiError): string => {
  if (error.body && error.body.trim().length > 0) {
    return `${error.message}: ${error.body.trim().slice(0, 500)}`;
  }
  return error.message;
};

const sanitizePathSegment = (input: string): string =>
  input.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "default";

const parseRemoteBrowserScreen = (
  screen: RemoteBrowserScreen,
): { readonly width: number; readonly height: number; readonly rate: number } | null => {
  const match = REMOTE_BROWSER_SCREEN_PATTERN.exec(screen);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    rate: Number(match[3]),
  };
};

const disabledAgentControl = (): RemoteBrowserStatus["agentControl"] => ({
  state: "disabled",
  message: null,
});

const withNekoCredentials = (
  rawUrl: string | null,
  user: string,
  password: string,
): string | null => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has("usr")) url.searchParams.set("usr", user);
    if (!url.searchParams.has("pwd")) url.searchParams.set("pwd", password);
    if (!url.searchParams.has("embed")) url.searchParams.set("embed", "1");
    return url.toString();
  } catch {
    return rawUrl;
  }
};

const initialStatus = (config: ServerConfigShape): RemoteBrowserStatus => {
  const remote = config.remoteBrowser;
  if (!remote.enabled) {
    return {
      enabled: false,
      provider: "disabled",
      state: "disabled",
      url: null,
      pageUrl: null,
      cdpUrl: null,
      image: null,
      containerName: null,
      screen: remote.screen,
      progress: null,
      message: "Remote browser is disabled.",
      retryable: false,
      agentControl: disabledAgentControl(),
    };
  }
  if (remote.provider === "remote-url") {
    return {
      enabled: true,
      provider: "remote-url",
      state: "ready",
      url: remote.url,
      pageUrl: null,
      cdpUrl: remote.cdpUrl,
      image: null,
      containerName: null,
      screen: remote.screen,
      progress: null,
      message: "Remote browser is configured.",
      retryable: false,
      agentControl: remote.cdpUrl
        ? { state: "connecting", message: "Connecting to the browser CDP endpoint." }
        : disabledAgentControl(),
    };
  }
  return {
    enabled: true,
    provider: "managed-neko",
    state: "idle",
    url: remote.url,
    pageUrl: null,
    cdpUrl: remote.cdpUrl,
    image: remote.image,
    containerName: remote.containerName,
    screen: remote.screen,
    progress: null,
    message: "Remote browser is configured and will start when requested.",
    retryable: false,
    agentControl: remote.cdpUrl
      ? { state: "connecting", message: "Waiting for the browser container." }
      : disabledAgentControl(),
  };
};

const resolveTargetUrl = (target: BrowserNavigationTarget, environmentHost: string): string => {
  if (target.kind === "url") return normalizePreviewUrl(target.url);
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  return `${protocol}://${environmentHost}:${target.port}${path}`;
};

const serializeError = (error: unknown): NonNullable<PreviewAutomationResponse["error"]> => {
  if (typeof error === "object" && error !== null && "_tag" in error && "message" in error) {
    const tag = String(error._tag);
    const message = String(error.message);
    if (
      tag === "PreviewAutomationUnavailableError" ||
      tag === "PreviewAutomationTabNotFoundError" ||
      tag === "PreviewAutomationExecutionError"
    ) {
      return { _tag: tag, message };
    }
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    message: failureMessage(error, "Remote browser automation failed."),
  };
};

const automationPromise = <A>(
  run: () => Promise<A>,
  message: string,
): Effect.Effect<A, PreviewAutomationExecutionError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new PreviewAutomationExecutionError({ message: failureMessage(cause, message) }),
  });

const make = Effect.gen(function* RemoteBrowserManagerMake() {
  const config = yield* ServerConfig;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverEnvironment = yield* ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const statusRef = yield* Ref.make<RemoteBrowserStatus>(initialStatus(config));
  const screenRef = yield* Ref.make<RemoteBrowserScreen>(config.remoteBrowser.screen);
  const runtimeRef = yield* Ref.make<BrowserRuntime | null>(null);
  const startingRef = yield* Ref.make(false);
  const nekoAdminTokenRef = yield* Ref.make<string | null>(null);
  const pubSub = yield* PubSub.unbounded<RemoteBrowserStatus>();
  const nekoUserPassword = process.env.T3CODE_NEKO_USER_PASSWORD ?? "neko";
  const nekoAdminPassword = process.env.T3CODE_NEKO_ADMIN_PASSWORD ?? "admin";
  const nekoWebRtcPorts = process.env.T3CODE_NEKO_WEBRTC_PORTS ?? DEFAULT_NEKO_WEBRTC_PORTS;
  const nekoNat1To1 = process.env.T3CODE_NEKO_NAT1TO1 ?? "127.0.0.1";
  const environmentHost =
    process.env.T3CODE_BROWSER_ENVIRONMENT_HOST ??
    (config.remoteBrowser.provider === "managed-neko" ? "host.docker.internal" : "127.0.0.1");

  const runDocker = (
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ): Effect.Effect<DockerCommandResult, DockerCommandError> =>
    processRunner
      .run({
        command: "docker",
        args,
        timeout: options?.timeout ?? Duration.minutes(2),
        maxOutputBytes: 2 * 1024 * 1024,
        outputMode: "truncate",
        truncatedMarker: "\n... output truncated ...",
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed({ stdout: result.stdout, stderr: result.stderr })
            : Effect.fail(
                new DockerCommandFailed({
                  args,
                  code: result.code,
                  stdout: result.stdout,
                  stderr: result.stderr,
                }),
              ),
        ),
      );

  const dockerSucceeds = (args: ReadonlyArray<string>): Effect.Effect<boolean> =>
    runDocker(args).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );

  const patchFileSystem = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    message: string,
  ): Effect.Effect<A, NekoClientPatchFailed, R> =>
    effect.pipe(Effect.mapError((cause) => new NekoClientPatchFailed({ message, cause })));

  const prepareNekoClientPatch = (
    image: string,
  ): Effect.Effect<NekoClientPatch, NekoClientPatchError> =>
    Effect.gen(function* RemoteBrowserPrepareNekoClientPatch() {
      const patchDir = path.join(
        config.stateDir,
        "remote-browser",
        "neko-client-patches",
        sanitizePathSegment(image),
        NEKO_CLIENT_PATCH_VERSION,
      );
      yield* patchFileSystem(
        fileSystem.makeDirectory(patchDir, { recursive: true }),
        "Failed to create the Neko client patch directory.",
      );

      const bundleList = yield* runDocker(
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          image,
          "-lc",
          "find /var/www/js -maxdepth 1 -type f -name 'app*.js' | sort",
        ],
        { timeout: Duration.minutes(2) },
      );
      const bundlePaths = bundleList.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/var/www/js/") && line.endsWith(".js"));

      if (bundlePaths.length === 0) {
        return yield* new NekoClientPatchFailed({
          message: "Failed to patch the Neko client: no app bundles were found in /var/www/js.",
          cause: null,
        });
      }

      const mounts: NekoClientPatchMount[] = [];
      let patchedMutedOverlay = false;
      for (const bundlePath of bundlePaths) {
        const original = yield* runDocker(
          ["run", "--rm", "--entrypoint", "cat", image, bundlePath],
          { timeout: Duration.minutes(2) },
        );
        const patched = original.stdout.replaceAll('"mutedOverlay",!0', '"mutedOverlay",!1');
        if (patched === original.stdout) continue;
        patchedMutedOverlay = true;

        const patchedPath = path.join(
          patchDir,
          sanitizePathSegment(bundlePath.replace(/^\/+/, "")),
        );
        yield* patchFileSystem(
          fileSystem.writeFileString(patchedPath, patched),
          `Failed to write the patched Neko client bundle for ${bundlePath}.`,
        );
        mounts.push({ source: patchedPath, target: bundlePath });
      }

      if (!patchedMutedOverlay) {
        return yield* new NekoClientPatchFailed({
          message: "Failed to patch the Neko client: muted overlay marker was not found.",
          cause: null,
        });
      }

      const styleList = yield* runDocker(
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          image,
          "-lc",
          "find /var/www/css -maxdepth 1 -type f -name '*.css' | sort",
        ],
        { timeout: Duration.minutes(2) },
      );
      const stylePaths = styleList.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/var/www/css/") && line.endsWith(".css"));

      if (stylePaths.length === 0) {
        return yield* new NekoClientPatchFailed({
          message: "Failed to patch the Neko client: no CSS bundles were found in /var/www/css.",
          cause: null,
        });
      }

      for (const stylePath of stylePaths) {
        const original = yield* runDocker(
          ["run", "--rm", "--entrypoint", "cat", image, stylePath],
          { timeout: Duration.minutes(2) },
        );
        const patched = original.stdout.includes(NEKO_EMBEDDED_UI_CSS.trim())
          ? original.stdout
          : `${original.stdout}${NEKO_EMBEDDED_UI_CSS}`;
        const patchedPath = path.join(patchDir, sanitizePathSegment(stylePath.replace(/^\/+/, "")));
        yield* patchFileSystem(
          fileSystem.writeFileString(patchedPath, patched),
          `Failed to write the patched Neko client stylesheet for ${stylePath}.`,
        );
        mounts.push({ source: patchedPath, target: stylePath });
      }

      const supervisorList = yield* runDocker(
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          image,
          "-lc",
          "find /etc/neko/supervisord -maxdepth 1 -type f -name '*.conf' | sort",
        ],
        { timeout: Duration.minutes(2) },
      );
      const supervisorPaths = supervisorList.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/etc/neko/supervisord/") && line.endsWith(".conf"));
      let patchedBrowserSupervisor = false;
      for (const supervisorPath of supervisorPaths) {
        const original = yield* runDocker(
          ["run", "--rm", "--entrypoint", "cat", image, supervisorPath],
          { timeout: Duration.minutes(2) },
        );
        if (!NEKO_BROWSER_SUPERVISOR_COMMAND.test(original.stdout)) continue;
        const missingArguments = NEKO_CHROMIUM_APP_ARGUMENTS.filter((argument) =>
          argument.startsWith("--app=")
            ? !original.stdout.includes("--app=")
            : !original.stdout.includes(argument),
        );
        const patched =
          missingArguments.length === 0
            ? original.stdout
            : original.stdout.replace(
                NEKO_BROWSER_SUPERVISOR_COMMAND,
                `$1${missingArguments.map((argument) => `  ${argument}`).join("\n")}\n`,
              );
        if (patched === original.stdout && missingArguments.length > 0) continue;

        patchedBrowserSupervisor = true;
        const patchedPath = path.join(
          patchDir,
          sanitizePathSegment(supervisorPath.replace(/^\/+/, "")),
        );
        yield* patchFileSystem(
          fileSystem.writeFileString(patchedPath, patched),
          `Failed to write the patched Neko browser supervisor config for ${supervisorPath}.`,
        );
        mounts.push({ source: patchedPath, target: supervisorPath });
      }

      if (!patchedBrowserSupervisor) {
        return yield* new NekoClientPatchFailed({
          message:
            "Failed to patch the Neko browser launch command: no supported Chromium supervisor config was found.",
          cause: null,
        });
      }

      return {
        version: `${NEKO_CLIENT_PATCH_VERSION}:${mounts.map((mount) => mount.target).join(",")}`,
        mounts,
      };
    });

  const nekoLocalApiUrl = (pathname: string): string => {
    const url = new URL(`http://127.0.0.1:${config.remoteBrowser.httpPort}`);
    url.pathname = pathname;
    return url.toString();
  };

  const executeNekoApiRequest = <E>(
    requestEffect: Effect.Effect<HttpClientRequest.HttpClientRequest, E>,
    message: string,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, NekoApiError> =>
    requestEffect.pipe(
      Effect.mapError((cause) => new NekoApiRequestFailed({ message, cause })),
      Effect.flatMap((request) => httpClient.execute(request)),
      Effect.mapError((cause) => new NekoApiRequestFailed({ message, cause })),
    );

  const readNekoResponseBody = (
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<string> => response.text.pipe(Effect.catch(() => Effect.succeed("")));

  const loginNekoAdmin = Effect.gen(function* RemoteBrowserLoginNekoAdmin() {
    const response = yield* executeNekoApiRequest(
      HttpClientRequest.post(nekoLocalApiUrl("/api/login")).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          username: "salchi-admin",
          password: nekoAdminPassword,
        }),
      ),
      "Failed to authenticate with Neko.",
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* readNekoResponseBody(response);
      return yield* new NekoApiRequestFailed({
        message: `Neko login failed with HTTP ${response.status}`,
        status: response.status,
        body,
      });
    }

    const parsed = yield* decodeNekoLoginResponse(response).pipe(
      Effect.mapError(
        (cause) =>
          new NekoApiRequestFailed({
            message: "Neko login returned invalid JSON.",
            cause,
          }),
      ),
    );
    const token = parsed.token ?? null;
    if (!token) {
      return yield* new NekoApiRequestFailed({
        message: "Neko login did not return an API token.",
      });
    }

    yield* Ref.set(nekoAdminTokenRef, token);
    return token;
  });

  const getNekoAdminToken = Effect.gen(function* RemoteBrowserGetNekoAdminToken() {
    const cachedToken = yield* Ref.get(nekoAdminTokenRef);
    if (cachedToken) return cachedToken;
    return yield* loginNekoAdmin;
  });

  const postNekoScreen = (
    token: string,
    screen: RemoteBrowserScreen,
  ): Effect.Effect<void, NekoApiError> =>
    Effect.gen(function* RemoteBrowserPostNekoScreen() {
      const parsedScreen = parseRemoteBrowserScreen(screen);
      if (!parsedScreen) {
        return yield* new NekoApiRequestFailed({
          message: `Invalid remote browser resolution: ${screen}`,
        });
      }

      const response = yield* executeNekoApiRequest(
        HttpClientRequest.post(nekoLocalApiUrl("/api/room/screen")).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          HttpClientRequest.bodyJson(parsedScreen),
        ),
        "Failed to update Neko screen.",
      );
      if (response.status < 200 || response.status >= 300) {
        const body = yield* readNekoResponseBody(response);
        return yield* new NekoApiRequestFailed({
          message: `Neko screen update failed with HTTP ${response.status}`,
          status: response.status,
          body,
        });
      }
      yield* readNekoResponseBody(response).pipe(Effect.ignore);
    });

  const setManagedNekoScreen = (screen: RemoteBrowserScreen): Effect.Effect<void, NekoApiError> =>
    Effect.gen(function* RemoteBrowserSetManagedNekoScreen() {
      const firstToken = yield* getNekoAdminToken;
      const firstAttempt = yield* postNekoScreen(firstToken, screen).pipe(Effect.result);
      if (firstAttempt._tag === "Success") return;
      if (firstAttempt.failure.status !== 401) return yield* firstAttempt.failure;

      yield* Ref.set(nekoAdminTokenRef, null);
      const nextToken = yield* getNekoAdminToken;
      yield* postNekoScreen(nextToken, screen);
    });

  const publish = (patch: Partial<RemoteBrowserStatus>): Effect.Effect<void> =>
    Ref.updateAndGet(statusRef, (current) => ({ ...current, ...patch })).pipe(
      Effect.tap((status) => PubSub.publish(pubSub, status)),
      Effect.asVoid,
    );

  const updateAgentControl = (
    agentControl: RemoteBrowserStatus["agentControl"],
  ): Effect.Effect<void> => publish({ agentControl });

  const reportOwner = (supportsAutomation: boolean): Effect.Effect<void> =>
    broker
      .reportOwner({
        clientId: REMOTE_BROWSER_CLIENT_ID,
        environmentId,
        threadId: ThreadId.make(GLOBAL_REMOTE_BROWSER_THREAD_ID),
        tabId: supportsAutomation ? PreviewTabId.make(REMOTE_BROWSER_TAB_ID) : null,
        visible: true,
        supportsAutomation,
        focusedAt: nowIso(),
      })
      .pipe(Effect.ignore);

  const disconnectRuntime = Effect.gen(function* RemoteBrowserDisconnectRuntime() {
    const runtime = yield* Ref.get(runtimeRef);
    if (!runtime) return;
    yield* Effect.tryPromise({
      try: () => runtime.browser.close(),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    yield* Ref.set(runtimeRef, null);
  });

  const connectAgentControl = Effect.gen(function* RemoteBrowserConnectAgentControl() {
    const cdpUrl = config.remoteBrowser.cdpUrl;
    if (!config.remoteBrowser.enabled || !cdpUrl) {
      yield* updateAgentControl(disabledAgentControl());
      yield* reportOwner(false);
      return;
    }

    yield* updateAgentControl({
      state: "connecting",
      message: "Connecting to the browser CDP endpoint.",
    });
    yield* disconnectRuntime;
    const runtime = yield* Effect.tryPromise({
      try: async () => {
        const { chromium } = await import("playwright-core");
        const browser = await chromium.connectOverCDP(cdpUrl);
        const firstContext = browser.contexts()[0];
        const existingPage = firstContext?.pages()[0];
        const context = firstContext ?? (await browser.newContext());
        const resolvedPage = existingPage ?? (await context.newPage());
        const consoleEntries: RemoteBrowserStatusEntry[] = [];
        const networkEntries: RemoteBrowserNetworkEntry[] = [];
        resolvedPage.on("console", (entry) => {
          consoleEntries.push({
            level: entry.type(),
            text: entry.text(),
            timestamp: nowIso(),
          });
          consoleEntries.splice(0, Math.max(0, consoleEntries.length - 200));
        });
        resolvedPage.on("response", (response) => {
          networkEntries.push({
            url: response.url(),
            method: response.request().method(),
            status: response.status(),
            failed: response.status() >= 400,
            timestamp: nowIso(),
          });
          networkEntries.splice(0, Math.max(0, networkEntries.length - 200));
        });
        resolvedPage.on("requestfailed", (request) => {
          const errorText = request.failure()?.errorText;
          networkEntries.push({
            url: request.url(),
            method: request.method(),
            status: null,
            failed: true,
            ...(errorText === undefined ? {} : { errorText }),
            timestamp: nowIso(),
          });
          networkEntries.splice(0, Math.max(0, networkEntries.length - 200));
        });
        return {
          browser,
          page: resolvedPage,
          consoleEntries,
          networkEntries,
        } satisfies BrowserRuntime;
      },
      catch: (cause) =>
        new PreviewAutomationUnavailableError({
          message: failureMessage(cause, "Failed to connect to CDP."),
        }),
    }).pipe(
      Effect.catch((error: PreviewAutomationUnavailableError) =>
        updateAgentControl({ state: "error", message: error.message }).pipe(
          Effect.andThen(reportOwner(false)),
          Effect.as(null),
        ),
      ),
    );
    if (!runtime) return;
    yield* Ref.set(runtimeRef, runtime);
    yield* publish({
      agentControl: { state: "ready", message: "Agent browser control is ready." },
      pageUrl: statusPageUrl(runtime.page.url()),
    });
    yield* reportOwner(true);
  });

  const startManagedNeko = (screen: RemoteBrowserScreen) =>
    Effect.gen(function* RemoteBrowserStartManagedNeko() {
      const image = config.remoteBrowser.image;
      const containerName = config.remoteBrowser.containerName;
      if (!image || !containerName) {
        yield* publish({
          state: "error",
          message: "Managed Neko is missing an image or container name.",
          retryable: true,
        });
        return;
      }

      yield* publish({
        state: "checking-docker",
        message: "Checking Docker.",
        retryable: false,
        screen,
        progress: null,
      });
      const dockerAvailable = yield* dockerSucceeds(["version", "--format", "{{.Server.Version}}"]);
      if (!dockerAvailable) {
        yield* publish({
          state: "error",
          message: "Docker is unavailable. Install Docker or configure T3CODE_REMOTE_BROWSER_URL.",
          retryable: true,
        });
        return;
      }

      const imageExists = yield* dockerSucceeds(["image", "inspect", image]);
      if (!imageExists) {
        yield* publish({
          state: "pulling-image",
          message: `Downloading ${image}.`,
          retryable: false,
          progress: null,
        });
        const pulled = yield* runDocker(["pull", image], { timeout: Duration.minutes(30) }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          }),
        );
        if (!pulled.ok) {
          yield* publish({
            state: "error",
            message: `Failed to pull ${image}: ${dockerErrorMessage(pulled.error)}`,
            retryable: true,
          });
          return;
        }
      }

      const clientPatch = yield* prepareNekoClientPatch(image).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (patch) => ({ ok: true as const, patch }),
        }),
      );
      if (!clientPatch.ok) {
        yield* publish({
          state: "error",
          message: `Failed to prepare browser UI patch: ${nekoClientPatchErrorMessage(clientPatch.error)}`,
          retryable: true,
        });
        return;
      }
      const clientPatchMountArgs = clientPatch.patch.mounts.flatMap((mount) => [
        "--mount",
        `type=bind,source=${mount.source},target=${mount.target},readonly`,
      ]);

      yield* publish({
        state: "starting-container",
        message: "Starting browser container.",
        retryable: false,
        screen,
        progress: null,
      });
      const containerExists = yield* dockerSucceeds(["container", "inspect", containerName]);
      const hostHttpPort = config.remoteBrowser.httpPort;
      const expectedContainerEnv = [
        "NEKO_SERVER_BIND=0.0.0.0:8080",
        "NEKO_SESSION_COOKIE_ENABLED=false",
        `NEKO_DESKTOP_SCREEN=${screen}`,
        `NEKO_WEBRTC_EPR=${nekoWebRtcPorts}`,
        `NEKO_WEBRTC_NAT1TO1=${nekoNat1To1}`,
        `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${nekoUserPassword}`,
        `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${nekoAdminPassword}`,
        `SALCHI_NEKO_HOST_HTTP_PORT=${hostHttpPort}`,
        `SALCHI_NEKO_IMAGE=${image}`,
        `SALCHI_NEKO_CLIENT_PATCH=${clientPatch.patch.version}`,
        `SALCHI_NEKO_CLIENT_PATCH_SOURCES=${clientPatch.patch.mounts
          .map((mount) => mount.source)
          .join(",")}`,
      ];
      const containerNeedsRefresh = containerExists
        ? yield* runDocker([
            "container",
            "inspect",
            containerName,
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
          ]).pipe(
            Effect.match({
              onFailure: () => true,
              onSuccess: (result) => {
                const existingEnv = new Set(
                  result.stdout
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                );
                return expectedContainerEnv.some((entry) => !existingEnv.has(entry));
              },
            }),
          )
        : false;
      if (containerNeedsRefresh) {
        yield* disconnectRuntime;
        yield* publish({
          state: "starting-container",
          message: "Refreshing browser container configuration.",
          retryable: false,
          screen,
          progress: null,
        });
        const removed = yield* runDocker(["rm", "-f", containerName]).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          }),
        );
        if (!removed.ok) {
          yield* publish({
            state: "error",
            message: `Failed to refresh browser container: ${dockerErrorMessage(removed.error)}`,
            retryable: true,
          });
          return;
        }
      }
      if (!containerExists || containerNeedsRefresh) {
        const created = yield* runDocker([
          "create",
          "--name",
          containerName,
          "--shm-size",
          "2g",
          "--add-host",
          "host.docker.internal:host-gateway",
          ...clientPatchMountArgs,
          "-p",
          `${hostHttpPort}:${NEKO_CONTAINER_HTTP_PORT}`,
          "-p",
          `${nekoWebRtcPorts}:${nekoWebRtcPorts}/udp`,
          "-e",
          "NEKO_SERVER_BIND=0.0.0.0:8080",
          "-e",
          "NEKO_SESSION_COOKIE_ENABLED=false",
          "-e",
          `NEKO_DESKTOP_SCREEN=${screen}`,
          "-e",
          `NEKO_WEBRTC_EPR=${nekoWebRtcPorts}`,
          "-e",
          `NEKO_WEBRTC_NAT1TO1=${nekoNat1To1}`,
          "-e",
          `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${nekoUserPassword}`,
          "-e",
          `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${nekoAdminPassword}`,
          "-e",
          `SALCHI_NEKO_HOST_HTTP_PORT=${hostHttpPort}`,
          "-e",
          `SALCHI_NEKO_IMAGE=${image}`,
          "-e",
          `SALCHI_NEKO_CLIENT_PATCH=${clientPatch.patch.version}`,
          "-e",
          `SALCHI_NEKO_CLIENT_PATCH_SOURCES=${clientPatch.patch.mounts
            .map((mount) => mount.source)
            .join(",")}`,
          image,
        ]).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          }),
        );
        if (!created.ok) {
          yield* publish({
            state: "error",
            message: `Failed to create browser container: ${dockerErrorMessage(created.error)}`,
            retryable: true,
          });
          return;
        }
      }

      const started = yield* runDocker(["start", containerName]).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );
      if (!started.ok) {
        yield* publish({
          state: "error",
          message: `Failed to start browser container: ${dockerErrorMessage(started.error)}`,
          retryable: true,
        });
        return;
      }

      yield* publish({
        state: "ready",
        url: withNekoCredentials(config.remoteBrowser.url, "neko", nekoUserPassword),
        pageUrl: null,
        screen,
        message: "Remote browser is ready.",
        retryable: false,
        progress: null,
      });
      yield* connectAgentControl;
    });

  const runStart = (input?: RemoteBrowserStartInput) =>
    Effect.gen(function* RemoteBrowserRunStart() {
      if (!config.remoteBrowser.enabled) return yield* Ref.get(statusRef);
      const currentStatus = yield* Ref.get(statusRef);
      const requestedScreen = input?.screen;
      const screen = requestedScreen ?? (yield* Ref.get(screenRef));
      const screenChanged =
        requestedScreen !== undefined && requestedScreen !== currentStatus.screen;
      if (currentStatus.state === "ready" && !screenChanged) return currentStatus;
      const alreadyStarting = yield* Ref.getAndSet(startingRef, true);
      if (alreadyStarting) return yield* Ref.get(statusRef);
      const previousScreen = currentStatus.screen;
      yield* Ref.set(screenRef, screen);
      yield* (
        currentStatus.state === "ready" &&
        screenChanged &&
        config.remoteBrowser.provider === "managed-neko"
          ? setManagedNekoScreen(screen).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Ref.set(screenRef, previousScreen).pipe(
                    Effect.andThen(
                      publish({
                        state: "ready",
                        screen: previousScreen,
                        message: `Failed to change browser resolution: ${nekoApiErrorMessage(error)}`,
                        retryable: true,
                        progress: null,
                      }),
                    ),
                  ),
                onSuccess: () =>
                  publish({
                    state: "ready",
                    screen,
                    message: "Remote browser resolution changed.",
                    retryable: false,
                    progress: null,
                  }),
              }),
            )
          : config.remoteBrowser.provider === "managed-neko"
            ? startManagedNeko(screen)
            : publish({
                state: "ready",
                url: withNekoCredentials(config.remoteBrowser.url, "neko", nekoUserPassword),
                pageUrl: null,
                screen,
                message: "Remote browser is ready.",
                retryable: false,
              }).pipe(Effect.andThen(connectAgentControl))
      ).pipe(Effect.ensuring(Ref.set(startingRef, false)));
      return yield* Ref.get(statusRef);
    });

  const runtimeOrFail = Effect.gen(function* RemoteBrowserRuntimeOrFail() {
    const runtime = yield* Ref.get(runtimeRef);
    if (!runtime) {
      return yield* new PreviewAutomationUnavailableError({
        message: "Agent browser control is not connected.",
      });
    }
    return runtime;
  });

  const navigate = (input: RemoteBrowserNavigateInput) =>
    Effect.gen(function* RemoteBrowserNavigate() {
      yield* runStart();
      const runtime = yield* runtimeOrFail;
      const url = normalizePreviewUrl(input.url);
      yield* publish({
        message: `Navigating to ${url}.`,
        retryable: false,
      });
      yield* automationPromise(
        () =>
          runtime.page
            .goto(url, {
              waitUntil: "load",
              timeout: 15_000,
            })
            .then(() => undefined),
        "Failed to navigate the remote browser.",
      );
      yield* publish({
        state: "ready",
        pageUrl: statusPageUrl(runtime.page.url()) ?? url,
        message: "Remote browser is ready.",
        retryable: false,
        progress: null,
      });
      return yield* Ref.get(statusRef);
    }).pipe(
      Effect.catch((error) =>
        publish({
          message: failureMessage(error, "Failed to navigate the remote browser."),
          retryable: true,
        }).pipe(Effect.andThen(Ref.get(statusRef))),
      ),
    );

  const automationStatus = Effect.gen(function* RemoteBrowserAutomationStatus() {
    const runtime = yield* Ref.get(runtimeRef);
    const status = yield* Ref.get(statusRef);
    if (!runtime) {
      return {
        available: false,
        visible: status.state === "ready",
        tabId: null,
        url: status.url,
        title: null,
        loading: status.state !== "ready",
      } satisfies PreviewAutomationStatus;
    }
    const title = yield* automationPromise<string>(
      () => runtime.page.title(),
      "Failed to read page title.",
    ).pipe(Effect.catch(() => Effect.succeed<string>("")));
    return {
      available: true,
      visible: true,
      tabId: PreviewTabId.make(REMOTE_BROWSER_TAB_ID),
      url: runtime.page.url() || status.url,
      title,
      loading: false,
    } satisfies PreviewAutomationStatus;
  });

  const snapshot = Effect.gen(function* RemoteBrowserSnapshot() {
    const runtime = yield* runtimeOrFail;
    const page = runtime.page;
    const pageData = yield* automationPromise<SnapshotPageData>(
      () =>
        page.evaluate(
          ({ maxText, maxElements }: { maxText: number; maxElements: number }) => {
            interface BrowserRect {
              readonly x: number;
              readonly y: number;
              readonly width: number;
              readonly height: number;
            }
            interface BrowserElement {
              readonly id?: string;
              readonly tagName: string;
              readonly parentElement: BrowserElement | null;
              readonly children: ArrayLike<BrowserElement>;
              readonly innerText?: string;
              getAttribute(name: string): string | null;
              getBoundingClientRect(): BrowserRect;
            }
            interface BrowserDocument {
              readonly documentElement: BrowserElement;
              readonly body?: { readonly innerText?: string };
              readonly title: string;
              readonly readyState: string;
              querySelectorAll(selector: string): ArrayLike<BrowserElement>;
            }
            const browserGlobal = globalThis as unknown as {
              readonly CSS?: { readonly escape?: (value: string) => string };
              readonly document: BrowserDocument;
              readonly location: { readonly href: string };
              readonly getComputedStyle: (element: BrowserElement) => {
                readonly visibility: string;
                readonly display: string;
              };
            };
            const escapeCss =
              browserGlobal.CSS?.escape ??
              ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
            const selectorFor = (element: BrowserElement): string => {
              if (element.id) return `#${escapeCss(element.id)}`;
              const buildParts = (
                current: BrowserElement | null,
                parts: string[] = [],
              ): string[] => {
                if (!current || current === browserGlobal.document.documentElement) return parts;
                const parent = current.parentElement;
                const siblings = parent
                  ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
                  : [];
                const base = current.tagName.toLowerCase();
                const part =
                  siblings.length > 1
                    ? `${base}:nth-of-type(${siblings.indexOf(current) + 1})`
                    : base;
                return buildParts(parent, [part, ...parts]);
              };
              return buildParts(element).join(" > ");
            };
            const visible = (element: BrowserElement): boolean => {
              const style = browserGlobal.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                rect.width > 0 &&
                rect.height > 0
              );
            };
            const elements = Array.from(
              browserGlobal.document.querySelectorAll(
                "a[href],button,input,textarea,select,[role],[tabindex]",
              ),
            )
              .filter(visible)
              .slice(0, maxElements)
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  tag: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  name:
                    element.getAttribute("aria-label") ||
                    element.innerText ||
                    element.getAttribute("name") ||
                    "",
                  selector: selectorFor(element),
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                };
              });
            return {
              url: browserGlobal.location.href,
              title: browserGlobal.document.title,
              loading: browserGlobal.document.readyState !== "complete",
              visibleText: (browserGlobal.document.body?.innerText || "").slice(0, maxText),
              interactiveElements: elements,
            };
          },
          { maxText: MAX_VISIBLE_TEXT_LENGTH, maxElements: MAX_INTERACTIVE_ELEMENTS },
        ),
      "Failed to inspect page.",
    );
    const screenshot = yield* automationPromise<Buffer>(
      () => page.screenshot({ type: "png" }),
      "Failed to capture screenshot.",
    );
    const viewport = page.viewportSize();
    return {
      ...pageData,
      accessibilityTree: null,
      consoleEntries: runtime.consoleEntries,
      networkEntries: runtime.networkEntries,
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png" as const,
        data: screenshot.toString("base64"),
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
      },
    } satisfies PreviewAutomationSnapshot;
  });

  const handleRequest = (
    request: PreviewAutomationRequest,
  ): Effect.Effect<
    unknown,
    | PreviewAutomationExecutionError
    | PreviewAutomationTabNotFoundError
    | PreviewAutomationUnavailableError
  > =>
    Effect.gen(function* RemoteBrowserHandleRequest() {
      if (request.operation === "status") return yield* automationStatus;
      if (request.operation === "open") {
        yield* runStart();
        const runtime = yield* runtimeOrFail;
        const input = request.input as PreviewAutomationOpenInput;
        if (input.url) {
          yield* automationPromise(
            () => runtime.page.goto(normalizePreviewUrl(input.url!)).then(() => undefined),
            "Failed to open remote browser URL.",
          );
          yield* publish({
            pageUrl: statusPageUrl(runtime.page.url()) ?? normalizePreviewUrl(input.url),
          });
        }
        return yield* automationStatus;
      }

      const status = yield* Ref.get(statusRef);
      if (status.agentControl.state !== "ready") {
        return yield* new PreviewAutomationTabNotFoundError({
          message: "The remote browser does not have an automation tab yet.",
        });
      }

      const runtime = yield* runtimeOrFail;
      const page = runtime.page;
      switch (request.operation) {
        case "navigate": {
          const input = request.input as PreviewAutomationNavigateInput;
          const url = input.target
            ? resolveTargetUrl(input.target, environmentHost)
            : normalizePreviewUrl(input.url!);
          yield* automationPromise(
            () =>
              page
                .goto(url, {
                  waitUntil:
                    input.readiness === "domContentLoaded"
                      ? "domcontentloaded"
                      : input.readiness === "none"
                        ? "commit"
                        : "load",
                  timeout: input.timeoutMs ?? request.timeoutMs,
                })
                .then(() => undefined),
            "Failed to navigate the remote browser.",
          );
          yield* publish({ pageUrl: statusPageUrl(page.url()) ?? url });
          return yield* automationStatus;
        }
        case "snapshot":
          return yield* snapshot;
        case "click": {
          const input = request.input as PreviewAutomationClickInput;
          const timeout = input.timeoutMs ?? request.timeoutMs;
          if (input.locator) {
            yield* automationPromise(
              () => page.locator(input.locator!).click({ timeout }),
              "Failed to click remote browser locator.",
            );
          } else if (input.selector) {
            yield* automationPromise(
              () => page.locator(input.selector!).click({ timeout }),
              "Failed to click remote browser selector.",
            );
          } else {
            yield* automationPromise(
              () => page.mouse.click(input.x!, input.y!),
              "Failed to click remote browser coordinates.",
            );
          }
          return null;
        }
        case "type": {
          const input = request.input as PreviewAutomationTypeInput;
          const timeout = input.timeoutMs ?? request.timeoutMs;
          const locator = input.locator ?? input.selector;
          if (locator) {
            const target = page.locator(locator);
            yield* automationPromise(
              () => target.click({ timeout }),
              "Failed to focus remote browser input.",
            );
            if (input.clear) {
              yield* automationPromise(
                () => target.fill("", { timeout }),
                "Failed to clear remote browser input.",
              );
            }
          }
          yield* automationPromise(
            () => page.keyboard.insertText(input.text),
            "Failed to type in remote browser.",
          );
          return null;
        }
        case "press": {
          const input = request.input as PreviewAutomationPressInput;
          const key = [...(input.modifiers ?? []), input.key].join("+");
          yield* automationPromise(
            () => page.keyboard.press(key),
            "Failed to press key in remote browser.",
          );
          return null;
        }
        case "scroll": {
          const input = request.input as PreviewAutomationScrollInput;
          const deltaX = input.deltaX ?? 0;
          const deltaY = input.deltaY ?? 0;
          const locator = input.locator ?? input.selector;
          if (locator) {
            yield* automationPromise(
              () =>
                page.locator(locator).evaluate(
                  (
                    element: { scrollBy: (x: number, y: number) => void },
                    delta: { x: number; y: number },
                  ) => {
                    element.scrollBy(delta.x, delta.y);
                  },
                  { x: deltaX, y: deltaY },
                ),
              "Failed to scroll remote browser element.",
            );
          } else {
            yield* automationPromise(
              () => page.mouse.wheel(deltaX, deltaY),
              "Failed to scroll remote browser.",
            );
          }
          return null;
        }
        case "evaluate": {
          const input = request.input as PreviewAutomationEvaluateInput;
          return yield* automationPromise(
            () =>
              page.evaluate(
                async ({
                  expression,
                  awaitPromise,
                }: {
                  expression: string;
                  awaitPromise: boolean | undefined;
                }) => {
                  const result = (0, eval)(expression);
                  return awaitPromise === false ? result : await result;
                },
                { expression: input.expression, awaitPromise: input.awaitPromise },
              ),
            "Failed to evaluate JavaScript in remote browser.",
          );
        }
        case "waitFor": {
          const input = request.input as PreviewAutomationWaitForInput;
          const timeout = input.timeoutMs ?? request.timeoutMs;
          if (input.locator) {
            yield* automationPromise(
              () => page.locator(input.locator!).waitFor({ timeout }),
              "Timed out waiting for remote browser locator.",
            );
          }
          if (input.selector) {
            yield* automationPromise(
              () => page.locator(input.selector!).waitFor({ timeout }),
              "Timed out waiting for remote browser selector.",
            );
          }
          if (input.text) {
            const text = input.text;
            yield* automationPromise(
              () =>
                page
                  .waitForFunction(
                    ({ expectedText }: { expectedText: string }) => {
                      const browserGlobal = globalThis as unknown as {
                        readonly document: { readonly body?: { readonly innerText?: string } };
                      };
                      return (
                        browserGlobal.document.body?.innerText?.includes(expectedText) === true
                      );
                    },
                    { expectedText: text },
                    { timeout },
                  )
                  .then(() => undefined),
              "Timed out waiting for remote browser text.",
            );
          }
          if (input.urlIncludes) {
            yield* automationPromise(
              () =>
                page.waitForURL(
                  (url: { toString: () => string }) => url.toString().includes(input.urlIncludes!),
                  { timeout },
                ),
              "Timed out waiting for remote browser URL.",
            );
          }
          return null;
        }
        case "recordingStart":
        case "recordingStop":
          return yield* new PreviewAutomationUnavailableError({
            message: "Remote browser recording is not implemented yet.",
          });
      }
    });

  const requestLoop = Effect.flatMap(broker.connect(REMOTE_BROWSER_CLIENT_ID), (requests) =>
    Stream.runForEach(requests, (request) =>
      handleRequest(request).pipe(
        Effect.flatMap((result) =>
          broker.respond({
            requestId: request.requestId,
            ok: true,
            ...(result === undefined ? {} : { result }),
          }),
        ),
        Effect.catch((error) =>
          broker.respond({
            requestId: request.requestId,
            ok: false,
            error: serializeError(error),
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("remote browser automation request loop stopped", { cause }),
    ),
    Effect.forever,
  );

  yield* requestLoop.pipe(Effect.forkScoped);
  yield* reportOwner(false);
  if (config.remoteBrowser.enabled && config.remoteBrowser.provider === "remote-url") {
    yield* runStart().pipe(Effect.forkScoped);
  } else if (config.remoteBrowser.enabled && config.remoteBrowser.prewarm) {
    yield* runStart().pipe(Effect.forkScoped);
  }

  return RemoteBrowserManager.of({
    getStatus: Ref.get(statusRef),
    start: runStart,
    navigate,
    statuses: Stream.concat(Stream.fromEffect(Ref.get(statusRef)), Stream.fromPubSub(pubSub)),
  });
});

export const layer = Layer.effect(RemoteBrowserManager, make);
