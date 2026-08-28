// @effect-diagnostics nodeBuiltinImport:off
import { randomBytes } from "node:crypto";
import * as NodeHttp from "node:http";
import type { Duplex } from "node:stream";

import { ThreadId, ThreadNotFound, type BrowserRpcError } from "@salchi/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  SALCHI_BROWSER_CDP_URL_ENV,
  type BrowserAgentSessionAccess,
} from "../BrowserAgentAccess.ts";
import {
  BrowserAgentBroker,
  type BrowserAgentBrokerShape,
} from "../Services/BrowserAgentBroker.ts";
import { BrowserSessionManager } from "../Services/BrowserSessionManager.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const BROKER_HOST = "127.0.0.1";
const BROKER_PATH = "/internal/browser/cdp";
const MAX_CDP_MESSAGE_BYTES = 32 * 1024 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_TEXT_PATTERN = /\b[0-9a-f]{64}\b/gi;
export const BROWSER_AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

interface ActiveProxyConnection {
  readonly id: string;
  readonly downstream: WebSocket;
  readonly upstream: WebSocket;
  readonly scope: Scope.Closeable;
  closed: boolean;
}

interface ProviderCredential {
  readonly token: string;
  readonly threadId: ThreadId;
  readonly connections: Set<ActiveProxyConnection>;
  readonly pendingClientSockets: Set<Duplex>;
  active: boolean;
}

export interface BrowserProxyPath {
  readonly threadId: ThreadId;
  readonly token: string;
}

class BrowserProxyConnectionError extends Data.TaggedError("BrowserProxyConnectionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function terminateWebSocket(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

export interface BrowserAgentBrokerOptions {
  readonly browserManager: Pick<
    BrowserSessionManager["Service"],
    | "start"
    | "getCdpWebSocketUrl"
    | "agentConnectionOpened"
    | "recordAgentCdpActivity"
    | "recordAgentCdpCommand"
    | "agentConnectionClosed"
  >;
  readonly accessEnabled: Effect.Effect<boolean>;
  readonly resolveRootThreadId?: (threadId: ThreadId) => Effect.Effect<ThreadId, BrowserRpcError>;
  readonly randomToken?: (() => string) | undefined;
  readonly heartbeatIntervalMillis?: number | undefined;
}

const isThreadNotFound = Schema.is(ThreadNotFound);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === BROKER_HOST || address === "::1" || address === "::ffff:127.0.0.1";
}

export function hasForwardingHeaders(headers: NodeHttp.IncomingHttpHeaders): boolean {
  return (
    headers.forwarded !== undefined ||
    headers["x-forwarded-for"] !== undefined ||
    headers["x-forwarded-host"] !== undefined ||
    headers["x-forwarded-proto"] !== undefined ||
    headers["x-real-ip"] !== undefined
  );
}

export function parseBrowserProxyPath(pathname: string): BrowserProxyPath | null {
  const prefix = `${BROKER_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/");
  if (segments.length !== 2 || !TOKEN_PATTERN.test(segments[1] ?? "")) return null;
  try {
    const decodedThreadId = decodeURIComponent(segments[0] ?? "");
    if (!decodedThreadId || decodedThreadId.trim() !== decodedThreadId) return null;
    return {
      threadId: ThreadId.make(decodedThreadId),
      token: segments[1]!,
    };
  } catch {
    return null;
  }
}

export function redactBrowserAgentSecrets(value: string): string {
  return value.replaceAll(TOKEN_TEXT_PATTERN, "[redacted-browser-token]");
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function browserFailureStatus(error: BrowserRpcError): number {
  return isThreadNotFound(error) ? 404 : 503;
}

function listenLoopback(server: NodeHttp.Server): Effect.Effect<number> {
  return Effect.callback<number>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<number>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const onError = (cause: Error) => settle(Effect.die(cause));
    server.once("error", onError);
    server.listen(0, BROKER_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      settle(port > 0 ? Effect.succeed(port) : Effect.die("Browser broker address was invalid."));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      server.close();
    });
  });
}

function closeHttpServer(server: NodeHttp.Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    server.closeAllConnections();
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
    return Effect.sync(() => server.closeAllConnections());
  });
}

function connectUpstream(
  url: string,
  pendingUpstreams: Set<WebSocket>,
): Effect.Effect<WebSocket, BrowserProxyConnectionError> {
  return Effect.callback<WebSocket, BrowserProxyConnectionError>((resume) => {
    const socket = new WebSocket(url, {
      maxPayload: MAX_CDP_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    pendingUpstreams.add(socket);
    let settled = false;
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      pendingUpstreams.delete(socket);
    };
    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateWebSocket(socket);
      resume(Effect.fail(new BrowserProxyConnectionError({ message, cause })));
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error) => fail("Failed to connect to Chromium CDP.", cause);
    const onClose = () => fail("Chromium CDP closed during proxy setup.");
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    return Effect.sync(() => {
      settled = true;
      cleanup();
      terminateWebSocket(socket);
    });
  });
}

function acceptDownstream(
  websocketServer: WebSocketServer,
  request: NodeHttp.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Effect.Effect<WebSocket, BrowserProxyConnectionError> {
  return Effect.callback<WebSocket, BrowserProxyConnectionError>((resume) => {
    try {
      websocketServer.handleUpgrade(request, socket, head, (downstream) => {
        resume(Effect.succeed(downstream));
      });
    } catch (cause) {
      resume(
        Effect.fail(
          new BrowserProxyConnectionError({
            message: "Failed to accept browser CDP proxy connection.",
            cause,
          }),
        ),
      );
    }
    return Effect.sync(() => socket.destroy());
  });
}

export const makeBrowserAgentBrokerWithOptions = Effect.fn("browserAgentBroker.makeWithOptions")(
  function* (options: BrowserAgentBrokerOptions) {
    const brokerScope = yield* Scope.Scope;
    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);
    const nextToken = options.randomToken ?? (() => randomBytes(32).toString("hex"));
    const heartbeatIntervalMillis =
      options.heartbeatIntervalMillis ?? BROWSER_AGENT_HEARTBEAT_INTERVAL_MS;
    const credentials = new Map<string, ProviderCredential>();
    const pendingUpstreams = new Set<WebSocket>();
    const pendingClientSockets = new Set<Duplex>();
    const websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CDP_MESSAGE_BYTES,
      perMessageDeflate: false,
    });

    const schedule = <A, E>(effect: Effect.Effect<A, E>) => {
      void runFork(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Browser agent broker background task failed", {
              cause: redactBrowserAgentSecrets(Cause.pretty(cause)),
            }),
          ),
          Effect.forkIn(brokerScope),
        ),
      );
    };

    const closeConnection = (
      credential: ProviderCredential,
      connection: ActiveProxyConnection,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (connection.closed) return;
        connection.closed = true;
        credential.connections.delete(connection);
        terminateWebSocket(connection.downstream);
        terminateWebSocket(connection.upstream);
        yield* Scope.close(connection.scope, Exit.void).pipe(Effect.ignore);
        yield* options.browserManager.agentConnectionClosed(credential.threadId, connection.id);
      });

    const releaseCredential = (credential: ProviderCredential): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!credential.active) return;
        credential.active = false;
        credentials.delete(credential.token);
        for (const socket of credential.pendingClientSockets) socket.destroy();
        credential.pendingClientSockets.clear();
        yield* Effect.forEach(
          [...credential.connections],
          (connection) => closeConnection(credential, connection),
          { concurrency: "unbounded", discard: true },
        );
      });

    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("Not Found");
    });

    server.on("upgrade", (request, socket, head) => {
      if (
        !isLoopbackAddress(request.socket.remoteAddress) ||
        hasForwardingHeaders(request.headers)
      ) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const url = new URL(request.url ?? "/", `http://${BROKER_HOST}`);
      const proxyPath = url.search === "" ? parseBrowserProxyPath(url.pathname) : null;
      const credential = proxyPath === null ? undefined : credentials.get(proxyPath.token);
      if (
        proxyPath === null ||
        credential === undefined ||
        !credential.active ||
        credential.threadId !== proxyPath.threadId
      ) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      pendingClientSockets.add(socket);
      credential.pendingClientSockets.add(socket);
      let upstream: WebSocket | undefined;
      let downstream: WebSocket | undefined;
      let connectionScope: Scope.Closeable | undefined;
      let connectionId: string | undefined;
      let idleHoldAcquired = false;
      let connectionInstalled = false;

      const setup = Effect.gen(function* () {
        const started = yield* Effect.exit(options.browserManager.start(credential.threadId));
        if (started._tag === "Failure") {
          const error = yield* Effect.flip(Effect.failCause(started.cause));
          rejectUpgrade(socket, browserFailureStatus(error), "Browser Unavailable");
          return;
        }
        const endpoint = yield* Effect.exit(
          options.browserManager.getCdpWebSocketUrl(credential.threadId),
        );
        if (endpoint._tag === "Failure") {
          const error = yield* Effect.flip(Effect.failCause(endpoint.cause));
          rejectUpgrade(socket, browserFailureStatus(error), "Browser Unavailable");
          return;
        }
        if (!credential.active || credentials.get(credential.token) !== credential) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }

        upstream = yield* connectUpstream(endpoint.value, pendingUpstreams);
        connectionId = nextToken();
        const opened = yield* Effect.exit(
          options.browserManager.agentConnectionOpened(credential.threadId, connectionId),
        );
        if (opened._tag === "Failure") {
          const error = yield* Effect.flip(Effect.failCause(opened.cause));
          rejectUpgrade(socket, browserFailureStatus(error), "Browser Unavailable");
          return;
        }
        idleHoldAcquired = true;
        if (!credential.active || credentials.get(credential.token) !== credential) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }

        downstream = yield* acceptDownstream(websocketServer, request, socket, head);
        connectionScope = yield* Scope.fork(brokerScope, "sequential");
        pendingClientSockets.delete(socket);
        credential.pendingClientSockets.delete(socket);
        const connection: ActiveProxyConnection = {
          id: connectionId,
          downstream,
          upstream,
          scope: connectionScope,
          closed: false,
        };
        credential.connections.add(connection);
        connectionInstalled = true;
        yield* Effect.logDebug("Browser agent CDP proxy connected", {
          threadId: credential.threadId,
        });

        const recordActivity = () =>
          schedule(
            options.browserManager.recordAgentCdpActivity(credential.threadId, connection.id),
          );
        const recordCommand = () =>
          schedule(
            options.browserManager.recordAgentCdpCommand(credential.threadId, connection.id),
          );
        const heartbeat = Effect.sleep(Duration.millis(heartbeatIntervalMillis)).pipe(
          Effect.andThen(
            options.browserManager.recordAgentCdpActivity(credential.threadId, connection.id),
          ),
          Effect.forever,
        );
        yield* Effect.forkIn(heartbeat, connectionScope);
        yield* options.browserManager.recordAgentCdpActivity(credential.threadId, connection.id);

        const relay = (destination: WebSocket, data: RawData, isBinary: boolean) => {
          if (destination.readyState === WebSocket.OPEN) {
            destination.send(data, { binary: isBinary });
          }
        };
        downstream.on("message", (data, isBinary) => {
          recordCommand();
          relay(upstream!, data, isBinary);
        });
        upstream.on("message", (data, isBinary) => {
          recordActivity();
          relay(downstream!, data, isBinary);
        });
        const close = () => schedule(closeConnection(credential, connection));
        downstream.once("close", close);
        downstream.once("error", close);
        upstream.once("close", close);
        upstream.once("error", close);
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            rejectUpgrade(socket, 502, "Bad Gateway");
          }),
        ),
        Effect.onExit(() => {
          if (connectionInstalled) return Effect.void;
          return Effect.gen(function* () {
            pendingClientSockets.delete(socket);
            credential.pendingClientSockets.delete(socket);
            if (downstream !== undefined) terminateWebSocket(downstream);
            if (upstream !== undefined) terminateWebSocket(upstream);
            if (connectionScope !== undefined) {
              yield* Scope.close(connectionScope, Exit.void).pipe(Effect.ignore);
            }
            if (idleHoldAcquired && connectionId !== undefined) {
              yield* options.browserManager.agentConnectionClosed(
                credential.threadId,
                connectionId,
              );
            }
            if (!socket.destroyed) socket.destroy();
          });
        }),
      );
      schedule(setup);
    });

    const brokerPort = yield* Effect.acquireRelease(listenLoopback(server), () =>
      Effect.gen(function* () {
        for (const socket of pendingClientSockets) socket.destroy();
        pendingClientSockets.clear();
        for (const upstream of pendingUpstreams) terminateWebSocket(upstream);
        pendingUpstreams.clear();
        yield* Effect.forEach([...credentials.values()], releaseCredential, {
          concurrency: "unbounded",
          discard: true,
        });
        websocketServer.close();
        yield* closeHttpServer(server);
      }),
    );

    const acquireSessionAccess: BrowserAgentBrokerShape["acquireSessionAccess"] = (threadId) =>
      Effect.gen(function* () {
        if (!(yield* options.accessEnabled)) {
          return {
            environment: {},
            release: Effect.void,
          } satisfies BrowserAgentSessionAccess;
        }
        const resolvedThreadId = yield* Effect.result(
          options.resolveRootThreadId?.(threadId) ?? Effect.succeed(threadId),
        );
        if (resolvedThreadId._tag === "Failure") {
          yield* Effect.logWarning("Browser agent access could not resolve its root thread", {
            threadId,
            error: resolvedThreadId.failure.message,
          });
          return {
            environment: {},
            release: Effect.void,
          } satisfies BrowserAgentSessionAccess;
        }
        const rootThreadId = resolvedThreadId.success;
        const token = nextToken();
        if (!TOKEN_PATTERN.test(token)) {
          return yield* Effect.die("Browser broker token generator returned an invalid token.");
        }
        const credential: ProviderCredential = {
          token,
          threadId: rootThreadId,
          connections: new Set(),
          pendingClientSockets: new Set(),
          active: true,
        };
        credentials.set(token, credential);
        return {
          environment: {
            [SALCHI_BROWSER_CDP_URL_ENV]: `ws://${BROKER_HOST}:${brokerPort}${BROKER_PATH}/${encodeURIComponent(rootThreadId)}/${token}`,
          },
          release: releaseCredential(credential),
        } satisfies BrowserAgentSessionAccess;
      });

    return {
      port: brokerPort,
      acquireSessionAccess,
    } satisfies BrowserAgentBrokerShape;
  },
);

const makeLive = Effect.gen(function* () {
  const browserManager = yield* BrowserSessionManager;
  const settings = yield* ServerSettingsService;
  return yield* makeBrowserAgentBrokerWithOptions({
    browserManager,
    ...(browserManager.resolveRootThreadId === undefined
      ? {}
      : { resolveRootThreadId: browserManager.resolveRootThreadId }),
    accessEnabled: settings.getSettings.pipe(
      Effect.map((value) => value.browserAgentAccessEnabled),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to read browser agent access setting", {
          detail: cause.message,
        }).pipe(Effect.as(false)),
      ),
    ),
  });
});

export const BrowserAgentBrokerLive = Layer.effect(BrowserAgentBroker, makeLive).pipe(Layer.orDie);

// The authenticated/public listener deliberately has no broker implementation.
// Keeping an explicit deny route ahead of the SPA fallback makes that boundary
// observable and prevents a reverse proxy from ever forwarding broker traffic.
const publicBrokerNotFound = HttpServerResponse.text("Not Found", { status: 404 });
// Effect's wildcard route registration also installs the same handler for the
// path without the trailing `/*`, so this denies both broker paths without
// declaring the base route twice.
export const browserAgentBrokerPublicDenyRouteLayer = HttpRouter.add(
  "*",
  `${BROKER_PATH}/*`,
  publicBrokerNotFound,
);
