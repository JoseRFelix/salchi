import { WS_METHODS } from "@salchi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserWsRpcHarness } from "../../test/wsRpcHarness";
import { createWsRpcClient } from "./wsRpcClient";
import { WsTransport, type SubscriptionErrorInfo } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const originalWebSocket = globalThis.WebSocket;

let harness: BrowserWsRpcHarness;
let sockets: HarnessWebSocket[] = [];
let transports: WsTransport[] = [];

class HarnessWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = HarnessWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    harness.connect({
      send: (data) => this.serverMessage(data),
    });
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
    void harness.onMessage(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === HarnessWebSocket.CLOSED) {
      return;
    }
    this.readyState = HarnessWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = HarnessWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
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

describe("BrowserWsRpcHarness", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    harness = new BrowserWsRpcHarness();
    await harness.reset();
    sockets = [];
    transports = [];
    globalThis.WebSocket = HarnessWebSocket as unknown as typeof WebSocket;
  });

  afterEach(async () => {
    await Promise.allSettled(transports.map((transport) => transport.dispose()));
    await harness.disconnect();
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it("does not leak stream shutdown failures across harness resets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = new WsTransport("ws://localhost:3020");
    transports.push(transport);
    const client = createWsRpcClient(transport);
    const errors: SubscriptionErrorInfo[] = [];

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.open();
    await waitFor(() => {
      expect(transport.isHeartbeatFresh()).toBe(true);
    });

    const unsubscribe = client.server.subscribeAuthAccess(() => undefined, {
      onSubscriptionError: (info) => {
        errors.push(info);
      },
    });

    await waitFor(() => {
      expect(
        harness.requests.some((request) => request._tag === WS_METHODS.subscribeAuthAccess),
      ).toBe(true);
    });

    await harness.reset();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      "WebSocket RPC subscription failed; retrying",
      expect.anything(),
    );
    unsubscribe();
  });
});
