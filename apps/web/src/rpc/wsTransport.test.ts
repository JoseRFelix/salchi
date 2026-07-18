import { DEFAULT_SERVER_SETTINGS, ServerSettings, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetClientTracingForTests,
  configureClientTracing,
} from "../observability/clientTracing";
import {
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  setSlowRpcAckThresholdMsForTests,
} from "../rpc/requestLatencyState";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { WsTransport, type SubscriptionErrorInfo } from "./wsTransport";

const encodeServerSettings = Schema.encodeSync(ServerSettings);

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  error() {
    this.emit("error", { type: "error" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const transports: WsTransport[] = [];

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function createTransport(...args: ConstructorParameters<typeof WsTransport>): WsTransport {
  const transport = new WsTransport(...args);
  transports.push(transport);
  return transport;
}

beforeEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
  transports.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        hostname: "localhost",
        port: "3020",
        protocol: "http:",
      },
      desktopBridge: undefined,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(async () => {
  await Promise.allSettled(transports.map((transport) => transport.dispose()));
  transports.length = 0;
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  await __resetClientTracingForTests();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("uses an explicit secure websocket base url", async () => {
    const transport = createTransport("wss://app.example.com");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("uses an explicit insecure websocket base url for remote backends", async () => {
    const transport = createTransport("ws://192.168.1.44:3773");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://192.168.1.44:3773/ws");
    await transport.dispose();
  });

  it("supports async websocket url providers", async () => {
    const transport = createTransport(async () => "wss://remote.example.com/?wsToken=dynamic");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://remote.example.com/ws?wsToken=dynamic");
    await transport.dispose();
  });

  it("tracks initial connection failures for the app error state", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      phase: "connecting",
      socketUrl: "ws://localhost:3020/ws",
    });

    socket.error();
    socket.close(1006, "server unavailable");

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        closeCode: 1006,
        closeReason: "server unavailable",
        hasConnected: false,
        lastError: "Unable to connect to the T3 server WebSocket.",
        phase: "disconnected",
      });
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("error");

    await transport.dispose();
  });

  it("surfaces reconnecting state after a live socket disconnects", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    socket.close(1013, "try again later");

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        closeReason: "try again later",
        hasConnected: true,
      });
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("reconnecting");

    await transport.dispose();
  });

  it("composes custom lifecycle handlers with default websocket state tracking", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onOpen,
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    socket.close(1012, "service restart");

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(
        {
          code: 1012,
          reason: "service restart",
        },
        {
          intentional: false,
        },
      );
      expect(getWsConnectionStatus()).toMatchObject({
        attemptCount: 2,
        closeReason: "service restart",
        phase: "connecting",
      });
    }, 2_000);

    await transport.dispose();
  });

  it("does not report an intentional dispose as a reconnectable disconnect", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      getConnectionLabel: () => "Remote Mac mini",
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        connectionLabel: "Remote Mac mini",
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.dispose();

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac mini",
      phase: "connected",
      reconnectPhase: "idle",
    });
  });

  it("reconnects the websocket session without disposing the transport", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connecting",
    });

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(secondSocket.sent[0] ?? "{}") as { id: string };
    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("ignores stale socket lifecycle events after a reconnect starts a new session", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connecting",
    });

    const secondSocket = getSocket();
    secondSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        phase: "connected",
      });
    });

    firstSocket.close(1006, "stale close");

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connected",
    });

    await transport.dispose();
  });

  it("ignores stale socket close events after the transport is disposed", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    secondSocket.open();
    await transport.dispose();

    onClose.mockClear();
    firstSocket.close(1006, "stale close after dispose");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("retries non-transport subscription failures and resets backoff after a value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    getSocket().open();
    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({ phase: "connected" });
    });

    vi.useFakeTimers();
    const errors: SubscriptionErrorInfo[] = [];
    const values: string[] = [];
    let connectCount = 0;

    const unsubscribe = transport.subscribe(
      () => {
        connectCount += 1;
        if (connectCount === 1) {
          return Stream.fail(new Error("server snapshot failed"));
        }
        if (connectCount === 2) {
          return Stream.make("snapshot");
        }
        return Stream.fail(new Error("server snapshot failed again"));
      },
      (value) => {
        values.push(value);
      },
      {
        onSubscriptionError: (info) => {
          errors.push(info);
        },
        tag: "shell",
      },
    );

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]).toMatchObject({
      attempt: 1,
      error: "server snapshot failed",
      staleSession: false,
      tag: "shell",
      transportError: false,
      willRetryInMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(values).toEqual(["snapshot"]);
      expect(errors).toHaveLength(2);
    });
    expect(errors[1]).toMatchObject({
      attempt: 1,
      error: "server snapshot failed again",
      transportError: false,
      willRetryInMs: 1_000,
    });

    unsubscribe();
    warnSpy.mockRestore();
  });

  it("stops a failed subscription retry loop after unsubscribe", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    getSocket().open();
    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({ phase: "connected" });
    });

    vi.useFakeTimers();
    const errors: SubscriptionErrorInfo[] = [];
    let connectCount = 0;

    const unsubscribe = transport.subscribe(
      () => {
        connectCount += 1;
        return Stream.fail(new Error("server snapshot failed"));
      },
      () => undefined,
      {
        onSubscriptionError: (info) => {
          errors.push(info);
        },
        tag: "shell",
      },
    );

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connectCount).toBe(1);
    expect(errors).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("marks unary requests as slow until the first server ack arrives", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    await waitFor(() => {
      expect(getSlowRpcAckRequests()).toMatchObject([
        {
          requestId: requestMessage.id,
          tag: WS_METHODS.serverUpsertKeybinding,
        },
      ]);
    }, 1_000);

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });
    expect(getSlowRpcAckRequests()).toEqual([]);

    await transport.dispose();
  }, 5_000);

  it("clears slow unary request tracking when the transport reconnects", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };

    await waitFor(() => {
      expect(getSlowRpcAckRequests()).toMatchObject([
        {
          requestId: firstRequest.id,
          tag: WS_METHODS.serverUpsertKeybinding,
        },
      ]);
    }, 1_000);

    void requestPromise.catch(() => undefined);

    await transport.reconnect();

    expect(getSlowRpcAckRequests()).toEqual([]);

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    secondSocket.open();

    await transport.dispose();
  }, 5_000);

  it("sends unary RPC requests and resolves successful exits", async () => {
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "terminal.toggle",
        key: "ctrl+k",
      },
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              environment: {
                environmentId: "environment-local",
                label: "Local environment",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes live stream listeners after an explicit transport reconnect", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };
    const firstEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/one",
        projectName: "one",
      },
    };

    firstSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [firstEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(firstEvent);
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const secondRequest = JSON.parse(secondSocket.sent[0] ?? "{}") as {
      id: string;
      tag: string;
    };
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };

    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("does not fire onResubscribe when the first stream attempt exits before any value", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    await transport.dispose();
  });

  it("backs off before retrying live subscriptions that exit before their first value", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribeLifecycle = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { retryDelay: 50 },
    );
    const unsubscribeTerminal = transport.subscribe(
      (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
      listener,
      { retryDelay: 50 },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(2);
    });

    const firstRequests = socket.sent.map((message) => JSON.parse(message) as { id: string });
    expect(firstRequests).toHaveLength(2);
    for (const request of firstRequests) {
      socket.serverMessage(
        JSON.stringify({
          _tag: "Exit",
          requestId: request.id,
          exit: {
            _tag: "Success",
            value: null,
          },
        }),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.sent).toHaveLength(2);

    await waitFor(() => {
      expect(socket.sent.length).toBeGreaterThanOrEqual(4);
    });
    expect(listener).not.toHaveBeenCalled();

    unsubscribeLifecycle();
    unsubscribeTerminal();
    await transport.dispose();
  });

  it("keeps live subscription recovery immediate after the stream has produced values", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { retryDelay: 250 },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/recovered",
        projectName: "recovered",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [welcomeEvent],
      }),
    );
    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("retries stream subscriptions after application-level failures", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors: SubscriptionErrorInfo[] = [];
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("Git command failed in GitCore.statusDetails"));
        }),
      vi.fn(),
      {
        onSubscriptionError: (info) => {
          errors.push(info);
        },
        retryDelay: 10,
        tag: "vcs-status",
      },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(attempts).toBe(1);
    expect(errors[0]).toMatchObject({
      attempt: 1,
      error: "Git command failed in GitCore.statusDetails",
      tag: "vcs-status",
      transportError: false,
      willRetryInMs: 1_000,
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription failed; retrying", {
      attempt: 1,
      error: "Git command failed in GitCore.statusDetails",
      retryDelayMs: 1_000,
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      "WebSocket RPC subscription disconnected",
      expect.anything(),
    );
    await waitFor(() => {
      expect(attempts).toBe(2);
    }, 1_500);

    unsubscribe();
    await transport.dispose();
  });

  it("keeps retrying stream subscriptions after transport failures", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("SocketCloseError: WebSocket closed"));
        }),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(2);
    });

    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: WebSocket closed",
    });

    unsubscribe();
    await transport.dispose();
  });

  it("logs a transport disconnect once even when multiple subscriptions fail together", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unsubscribeA = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );
    const unsubscribeB = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: 1006",
    });

    unsubscribeA();
    unsubscribeB();
    await transport.dispose();
  });

  it("streams finite request events without re-subscribing", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      listener,
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const progressEvent = {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    } as const;

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [progressEvent],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(progressEvent);
    expect(
      socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; tag?: string };
        return parsed._tag === "Request" && parsed.tag === WS_METHODS.gitRunStackedAction;
      }),
    ).toHaveLength(1);
    await transport.dispose();
  });

  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const transport = {
      disposed: false,
      session: {
        clientScope: {} as never,
        runtime,
      },
      closeSession: (
        WsTransport.prototype as unknown as {
          closeSession: (session: {
            clientScope: unknown;
            runtime: { dispose: () => Promise<void>; runPromise: () => Promise<void> };
          }) => Promise<void>;
        }
      ).closeSession,
    } as unknown as WsTransport;

    void WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
  });

  it("propagates OTLP trace ids for ws transport requests when client tracing is enabled", async () => {
    await configureClientTracing({
      exportIntervalMs: 10,
    });

    const transport = createTransport("ws://localhost:3020");
    const requestPromise = transport.request((client) => client[WS_METHODS.serverGetSettings]({}));

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      id: string;
      spanId?: string;
      traceId?: string;
    };
    expect(requestMessage.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestMessage.spanId).toMatch(/^[0-9a-f]{16}$/);

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: encodeServerSettings(DEFAULT_SERVER_SETTINGS),
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual(DEFAULT_SERVER_SETTINGS);
    await transport.dispose();
  });

  it("interrupts an in-flight RPC when its request signal is aborted", async () => {
    const transport = createTransport("ws://localhost:3020");
    const controller = new AbortController();
    const requestPromise = transport.request((client) => client[WS_METHODS.serverGetSettings]({}), {
      signal: controller.signal,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id?: string };

    controller.abort();

    const requestError = await requestPromise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(requestError).toSatisfy(
      (error: unknown) => error instanceof Error && /interrupted/i.test(error.message),
    );
    await waitFor(() => {
      const interrupt = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; requestId?: string })
        .find((message) => message._tag === "Interrupt");
      expect(interrupt?.requestId).toBe(request.id);
    });

    await transport.dispose();
  });

  it("does not flush an aborted request when the socket connects later", async () => {
    const transport = createTransport("ws://localhost:3020");
    const controller = new AbortController();
    const requestPromise = transport.request((client) => client[WS_METHODS.serverGetSettings]({}), {
      signal: controller.signal,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    controller.abort();
    const requestError = await requestPromise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(requestError).toSatisfy(
      (error: unknown) => error instanceof Error && /interrupted/i.test(error.message),
    );

    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string })
        .some((message) => message._tag === "Request"),
    ).toBe(false);

    await transport.dispose();
  });
});
