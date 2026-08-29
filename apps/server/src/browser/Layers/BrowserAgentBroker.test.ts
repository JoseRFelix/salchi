// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:http";

import { BrowserUnavailable, ThreadId, type BrowserSessionState } from "@salchi/contracts";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { SALCHI_BROWSER_CDP_URL_ENV } from "../BrowserAgentAccess.ts";
import {
  hasForwardingHeaders,
  isLoopbackAddress,
  makeBrowserAgentBrokerWithOptions,
  parseBrowserProxyPath,
  redactBrowserAgentSecrets,
} from "./BrowserAgentBroker.ts";

const threadId = ThreadId.make("browser-agent-broker-test");
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

class BrowserAgentBrokerTestError extends Data.TaggedError("BrowserAgentBrokerTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function nextTokenFactory() {
  let index = 0;
  return () => (++index).toString(16).padStart(64, "0");
}

function makeEchoCdpServer() {
  return Effect.acquireRelease(
    Effect.callback<
      { readonly server: ReturnType<typeof createServer>; readonly url: string },
      BrowserAgentBrokerTestError
    >((resume) => {
      const server = createServer();
      const websocketServer = new WebSocketServer({ noServer: true });
      websocketServer.on("connection", (socket) => {
        socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
      });
      server.on("upgrade", (request, socket, head) =>
        websocketServer.handleUpgrade(request, socket, head, (websocket) =>
          websocketServer.emit("connection", websocket, request),
        ),
      );
      server.once("error", (cause) =>
        resume(
          Effect.fail(
            new BrowserAgentBrokerTestError({
              message: "Echo CDP server failed.",
              cause,
            }),
          ),
        ),
      );
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          resume(
            Effect.fail(
              new BrowserAgentBrokerTestError({
                message: "Echo CDP server did not expose a TCP address.",
              }),
            ),
          );
          return;
        }
        resume(
          Effect.succeed({
            server,
            url: `ws://127.0.0.1:${address.port}/devtools/browser/test`,
          }),
        );
      });
      return Effect.sync(() => {
        websocketServer.close();
        server.closeAllConnections();
        server.close();
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        if (!server.listening) {
          resume(Effect.void);
          return;
        }
        server.close(() => resume(Effect.void));
      }),
  );
}

function openWebSocket(url: string, headers?: Readonly<Record<string, string>>) {
  return Effect.callback<WebSocket, BrowserAgentBrokerTestError>((resume) => {
    const socket = new WebSocket(url, headers === undefined ? undefined : { headers });
    const onOpen = () => {
      socket.off("error", onError);
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error) => {
      socket.off("open", onOpen);
      resume(
        Effect.fail(
          new BrowserAgentBrokerTestError({
            message: "WebSocket connection failed.",
            cause,
          }),
        ),
      );
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    return Effect.sync(() => socket.terminate());
  });
}

function nextMessage(socket: WebSocket) {
  return Effect.callback<string, BrowserAgentBrokerTestError>((resume) => {
    const onMessage = (data: WebSocket.RawData) => {
      socket.off("error", onError);
      resume(Effect.succeed(data.toString()));
    };
    const onError = (cause: Error) => {
      socket.off("message", onMessage);
      resume(
        Effect.fail(
          new BrowserAgentBrokerTestError({
            message: "WebSocket message failed.",
            cause,
          }),
        ),
      );
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    });
  });
}

function closeWebSocket(socket: WebSocket) {
  return Effect.callback<void>((resume) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resume(Effect.void);
      return;
    }
    socket.once("close", () => resume(Effect.void));
    socket.close();
    return Effect.sync(() => socket.terminate());
  });
}

function awaitWebSocketClosed(socket: WebSocket) {
  return Effect.callback<void>((resume) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resume(Effect.void);
      return;
    }
    const onClose = () => resume(Effect.void);
    socket.once("close", onClose);
    return Effect.sync(() => socket.off("close", onClose));
  });
}

function withPath(url: string, thread: string, token: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/internal/browser/cdp/${encodeURIComponent(thread)}/${token}`;
  return parsed.toString();
}

describe("browser agent broker security", () => {
  it("accepts only direct loopback addresses and rejects forwarding headers", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(hasForwardingHeaders({})).toBe(false);
    expect(hasForwardingHeaders({ "x-forwarded-for": "127.0.0.1" })).toBe(true);
    expect(hasForwardingHeaders({ forwarded: "for=127.0.0.1" })).toBe(true);
  });

  it("parses only the stable thread and 256-bit token path shape", () => {
    const token = "a".repeat(64);
    expect(parseBrowserProxyPath(`/internal/browser/cdp/thread%2Fone/${token}`)).toEqual({
      threadId: "thread/one",
      token,
    });
    expect(parseBrowserProxyPath(`/internal/browser/cdp/thread/short-token`)).toBeNull();
    expect(parseBrowserProxyPath(`/internal/browser/cdp/thread/extra/${token}`)).toBeNull();
    expect(parseBrowserProxyPath(`/internal/browser/cdp/%20/${token}`)).toBeNull();
  });

  it("redacts capability-shaped values from broker diagnostics", () => {
    const token = "a".repeat(64);
    expect(redactBrowserAgentSecrets(`failed at /thread/${token}`)).toBe(
      "failed at /thread/[redacted-browser-token]",
    );
  });
});

it.effect("never writes the capability token during a complete proxy connect cycle", () => {
  const captured: string[] = [];
  const logger = Logger.make(({ cause, message }) => {
    captured.push(JSON.stringify(message), Cause.pretty(cause));
  });
  const token = "a".repeat(64);

  return Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* makeEchoCdpServer();
      const closed = yield* Deferred.make<void>();
      let tokenCall = 0;
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: () => (tokenCall++ === 0 ? token : "b".repeat(64)),
        browserManager: {
          start: () =>
            Effect.succeed({
              threadId,
              status: "running",
              tabs: [],
              executable: null,
              viewport: { width: 800, height: 600 },
            }),
          getCdpWebSocketUrl: () => Effect.succeed(upstream.url),
          agentConnectionOpened: () => Effect.void,
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: () => Effect.void,
          agentConnectionClosed: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        },
      });
      const access = yield* broker.acquireSessionAccess(threadId);
      const stableUrl = access.environment[SALCHI_BROWSER_CDP_URL_ENV]!;
      const socket = yield* openWebSocket(stableUrl);
      const response = nextMessage(socket);
      socket.send('{"id":1,"method":"Browser.getVersion"}');
      yield* response;
      yield* closeWebSocket(socket);
      yield* Deferred.await(closed);
      yield* access.release;

      expect(captured.length).toBeGreaterThan(0);
      expect(captured.join("\n")).not.toContain(token);
      expect(captured.join("\n")).not.toContain(stableUrl);
    }),
  ).pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
});

it.effect("does not issue a CDP URL when browser agent access is disabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(false),
        browserManager: {
          start: () => Effect.die("disabled broker must not start a browser"),
          getCdpWebSocketUrl: () => Effect.die("disabled broker must not expose CDP"),
          agentConnectionOpened: () => Effect.die("disabled broker must not open a proxy"),
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: () => Effect.void,
          agentConnectionClosed: () => Effect.void,
        },
      });

      const access = yield* broker.acquireSessionAccess(threadId);
      expect(access.environment).toEqual({});
      yield* access.release;
    }),
  ),
);

it.effect("injects the root thread into provider browser environments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const virtualThreadId = ThreadId.make("codex-tool:exec-browser-proxy");
      const rootThreadId = ThreadId.make("browser-agent-root");
      const resolved: ThreadId[] = [];
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: nextTokenFactory(),
        resolveRootThreadId: (requestedThreadId) =>
          Effect.sync(() => {
            resolved.push(requestedThreadId);
            return rootThreadId;
          }),
        browserManager: {
          start: () => Effect.die("browser must remain lazy"),
          getCdpWebSocketUrl: () => Effect.die("browser must remain lazy"),
          agentConnectionOpened: () => Effect.die("browser must remain lazy"),
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: () => Effect.void,
          agentConnectionClosed: () => Effect.void,
        },
      });

      const access = yield* broker.acquireSessionAccess(virtualThreadId);
      const stableUrl = access.environment[SALCHI_BROWSER_CDP_URL_ENV];

      expect(resolved).toEqual([virtualThreadId]);
      expect(stableUrl).toMatch(
        /^ws:\/\/127\.0\.0\.1:\d+\/internal\/browser\/cdp\/browser-agent-root\/[0-9a-f]{64}$/,
      );
      yield* access.release;
    }),
  ),
);

it.effect("preserves the provider thread as the origin after browser-root normalization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* makeEchoCdpServer();
      const originThreadId = ThreadId.make("codex-child-browser-origin");
      const rootThreadId = ThreadId.make("browser-origin-root");
      const command = yield* Deferred.make<{
        readonly browserThreadId: ThreadId;
        readonly originThreadId: ThreadId | undefined;
      }>();
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: nextTokenFactory(),
        resolveRootThreadId: () => Effect.succeed(rootThreadId),
        browserManager: {
          start: () =>
            Effect.succeed({
              threadId: rootThreadId,
              status: "running",
              tabs: [],
              executable: null,
              viewport: { width: 800, height: 600 },
            }),
          getCdpWebSocketUrl: () => Effect.succeed(upstream.url),
          agentConnectionOpened: () => Effect.void,
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: (browserThreadId, _connectionId, activityOriginThreadId) =>
            Deferred.succeed(command, {
              browserThreadId,
              originThreadId: activityOriginThreadId,
            }).pipe(Effect.asVoid),
          agentConnectionClosed: () => Effect.void,
        },
      });
      const access = yield* broker.acquireSessionAccess(originThreadId);
      const socket = yield* openWebSocket(access.environment[SALCHI_BROWSER_CDP_URL_ENV]!);
      const response = nextMessage(socket);
      socket.send('{"id":1,"method":"Browser.getVersion"}');
      yield* response;

      expect(yield* Deferred.await(command).pipe(Effect.timeout("1 second"))).toEqual({
        browserThreadId: rootThreadId,
        originThreadId,
      });
      yield* closeWebSocket(socket);
      yield* access.release;
    }),
  ),
);

it.effect("validates stable URLs and relays concurrent CDP connections with heartbeats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* makeEchoCdpServer();
      const allClosed = yield* Deferred.make<void>();
      const opened: string[] = [];
      const closed: string[] = [];
      let starts = 0;
      let activityCount = 0;
      let commandCount = 0;
      const runningState: BrowserSessionState = {
        threadId,
        status: "running",
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
      };
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: nextTokenFactory(),
        heartbeatIntervalMillis: 1_000,
        browserManager: {
          start: () =>
            Effect.sync(() => {
              starts += 1;
              return runningState;
            }),
          getCdpWebSocketUrl: () => Effect.succeed(upstream.url),
          agentConnectionOpened: (_threadId, connectionId) =>
            Effect.sync(() => {
              opened.push(connectionId);
            }),
          recordAgentCdpActivity: () =>
            Effect.sync(() => {
              activityCount += 1;
            }),
          recordAgentCdpCommand: () =>
            Effect.sync(() => {
              commandCount += 1;
            }),
          agentConnectionClosed: (_threadId, connectionId) =>
            Effect.sync(() => {
              closed.push(connectionId);
              if (closed.length === 2) Deferred.doneUnsafe(allClosed, Effect.void);
            }),
        },
      });
      const access = yield* broker.acquireSessionAccess(threadId);
      const stableUrl = access.environment[SALCHI_BROWSER_CDP_URL_ENV];
      if (stableUrl === undefined) {
        return yield* Effect.die("Enabled browser broker did not issue a stable CDP URL.");
      }
      expect(Object.keys(access.environment)).toEqual([SALCHI_BROWSER_CDP_URL_ENV]);
      expect(stableUrl).toMatch(
        /^ws:\/\/127\.0\.0\.1:\d+\/internal\/browser\/cdp\/browser-agent-broker-test\/[0-9a-f]{64}$/,
      );
      expect(starts).toBe(0);

      const token = new URL(stableUrl).pathname.split("/").at(-1)!;
      const invalidTokenExit = yield* openWebSocket(
        withPath(stableUrl, threadId, token === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64)),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(invalidTokenExit)).toBe(true);
      const invalidThreadExit = yield* openWebSocket(
        withPath(stableUrl, "another-thread", token),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(invalidThreadExit)).toBe(true);
      const forwardedExit = yield* openWebSocket(stableUrl, {
        "X-Forwarded-For": "127.0.0.1",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(forwardedExit)).toBe(true);

      const [first, second] = yield* Effect.all(
        [openWebSocket(stableUrl), openWebSocket(stableUrl)],
        { concurrency: "unbounded" },
      );
      expect(starts).toBe(2);
      expect(opened).toHaveLength(2);

      const firstMessage = nextMessage(first);
      first.send('{"id":1,"method":"Browser.getVersion"}');
      expect(yield* firstMessage).toBe('{"id":1,"method":"Browser.getVersion"}');
      const secondMessage = nextMessage(second);
      second.send('{"id":2,"method":"Target.getTargets"}');
      expect(yield* secondMessage).toBe('{"id":2,"method":"Target.getTargets"}');
      yield* Effect.yieldNow;
      expect(commandCount).toBe(2);

      const beforeHeartbeat = activityCount;
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(activityCount).toBeGreaterThan(beforeHeartbeat);

      yield* Effect.all([closeWebSocket(first), closeWebSocket(second)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(allClosed);
      expect(new Set(closed)).toEqual(new Set(opened));

      yield* access.release;
      expect(Exit.isFailure(yield* openWebSocket(stableUrl).pipe(Effect.exit))).toBe(true);
    }),
  ),
);

it.effect("reports a lazy agent connection as user-prompted when no browser is installed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let prompted = 0;
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: nextTokenFactory(),
        browserManager: {
          start: () =>
            Effect.fail(
              new BrowserUnavailable({
                message: "No usable Chromium installation was found.",
                attempts: [],
                reason: "not-installed",
              }),
            ),
          getCdpWebSocketUrl: () => Effect.die("CDP must not be resolved after launch failure"),
          agentConnectionOpened: () => Effect.void,
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: () => Effect.void,
          recordAgentBrowserRequest: () =>
            Effect.sync(() => {
              prompted += 1;
            }),
          agentConnectionClosed: () => Effect.void,
        },
      });
      const access = yield* broker.acquireSessionAccess(threadId);
      const stableUrl = access.environment[SALCHI_BROWSER_CDP_URL_ENV]!;
      const socket = yield* openWebSocket(stableUrl);
      const response = nextMessage(socket);
      socket.send('{"id":7,"method":"Browser.getVersion"}');
      expect(yield* decodeUnknownJsonString(yield* response)).toEqual({
        id: 7,
        error: {
          code: -32_000,
          message: "Browser not installed; the user has been prompted in Salchi.",
        },
      });
      yield* Effect.yieldNow;
      expect(prompted).toBe(1);
      yield* closeWebSocket(socket);
      yield* access.release;
    }),
  ),
);

it.effect(
  "closes a waiting not-installed agent socket when its provider credential is released",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBrowserAgentBrokerWithOptions({
          accessEnabled: Effect.succeed(true),
          randomToken: nextTokenFactory(),
          browserManager: {
            start: () =>
              Effect.fail(
                new BrowserUnavailable({
                  message: "No usable Chromium installation was found.",
                  attempts: [],
                  reason: "not-installed",
                }),
              ),
            getCdpWebSocketUrl: () => Effect.die("CDP must not be resolved after launch failure"),
            agentConnectionOpened: () => Effect.void,
            recordAgentCdpActivity: () => Effect.void,
            recordAgentCdpCommand: () => Effect.void,
            agentConnectionClosed: () => Effect.void,
          },
        });
        const access = yield* broker.acquireSessionAccess(threadId);
        const socket = yield* openWebSocket(access.environment[SALCHI_BROWSER_CDP_URL_ENV]!);
        const closed = awaitWebSocketClosed(socket);

        yield* access.release;
        yield* closed;
        expect(socket.readyState).toBe(WebSocket.CLOSED);
      }),
    ),
);

it.effect("closes stable proxy connections when its scope is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* makeEchoCdpServer();
      const brokerScope = yield* Scope.make("sequential");
      const closed = yield* Deferred.make<void>();
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: nextTokenFactory(),
        browserManager: {
          start: () =>
            Effect.succeed({
              threadId,
              status: "running",
              tabs: [],
              executable: null,
              viewport: { width: 800, height: 600 },
            }),
          getCdpWebSocketUrl: () => Effect.succeed(upstream.url),
          agentConnectionOpened: () => Effect.void,
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: () => Effect.void,
          agentConnectionClosed: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        },
      }).pipe(Effect.provideService(Scope.Scope, brokerScope));
      const access = yield* broker.acquireSessionAccess(threadId);
      const stableUrl = access.environment[SALCHI_BROWSER_CDP_URL_ENV]!;
      const socket = yield* openWebSocket(stableUrl);

      yield* Scope.close(brokerScope, Exit.void);
      yield* Deferred.await(closed);
      yield* closeWebSocket(socket);
      expect(Exit.isFailure(yield* openWebSocket(stableUrl).pipe(Effect.exit))).toBe(true);
    }),
  ),
);

it.effect("releases the idle hold when credentials are revoked during proxy acquisition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* makeEchoCdpServer();
      const opening = yield* Deferred.make<void>();
      const allowOpen = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const broker = yield* makeBrowserAgentBrokerWithOptions({
        accessEnabled: Effect.succeed(true),
        randomToken: nextTokenFactory(),
        browserManager: {
          start: () =>
            Effect.succeed({
              threadId,
              status: "running",
              tabs: [],
              executable: null,
              viewport: { width: 800, height: 600 },
            }),
          getCdpWebSocketUrl: () => Effect.succeed(upstream.url),
          agentConnectionOpened: () =>
            Deferred.succeed(opening, undefined).pipe(
              Effect.andThen(Deferred.await(allowOpen)),
              Effect.asVoid,
            ),
          recordAgentCdpActivity: () => Effect.void,
          recordAgentCdpCommand: () => Effect.void,
          agentConnectionClosed: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        },
      });
      const access = yield* broker.acquireSessionAccess(threadId);
      const stableUrl = access.environment[SALCHI_BROWSER_CDP_URL_ENV]!;

      const connection = yield* openWebSocket(stableUrl).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(opening);
      yield* access.release;
      yield* Deferred.succeed(allowOpen, undefined);
      yield* Deferred.await(closed);

      expect(Exit.isFailure(yield* Fiber.join(connection))).toBe(true);
    }),
  ),
);
