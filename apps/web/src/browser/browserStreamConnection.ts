import type {
  AuthWebSocketTicketResult,
  BrowserInputEvent,
  BrowserTab,
  EnvironmentId,
  ThreadId,
} from "@salchi/contracts";
import {
  BROWSER_STREAM_UNKNOWN_TAB_INDEX,
  decodeBrowserStreamServerMessage,
  encodeBrowserStreamInput,
  type BrowserStreamMetaMessage,
} from "@salchi/shared/browserStreamProtocol";

import { fetchEnvironmentHttp, resolveEnvironmentHttpUrl } from "../environments/runtime";
import {
  getWsReconnectDelayMsForRetry,
  WS_RECONNECT_MAX_DELAY_MS,
  WS_RECONNECT_MAX_RETRIES,
} from "../rpc/wsConnectionState";

export interface BrowserStreamViewportFrame {
  readonly targetId: string;
  readonly seq: number;
  readonly width: number;
  readonly height: number;
  readonly jpegBytes: Uint8Array;
  readonly receivedAt: number;
}

export type BrowserStreamConnectionState = "closed" | "connecting" | "open";

export interface BrowserStreamConnection {
  readonly dispose: () => void;
  readonly sendInput: (targetId: string, event: BrowserInputEvent) => boolean;
}

interface BrowserStreamSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void;
}

interface BrowserStreamVisibilityTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface BrowserStreamConnectionOptions {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onConnectionState?: (state: BrowserStreamConnectionState) => void;
  readonly onEvent: (event: BrowserStreamMetaMessage) => void;
  readonly onFrame: (frame: BrowserStreamViewportFrame) => void;
  readonly onAuthorizationDenied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly createSocket?: (url: string) => BrowserStreamSocket;
  readonly issueTicket?: () => Promise<string>;
  readonly visibilityTarget?: BrowserStreamVisibilityTarget;
  readonly setTimeout?: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  readonly now?: () => number;
}

export class BrowserStreamAuthorizationError extends Error {
  constructor(message = "Browser control requires owner access.") {
    super(message);
    this.name = "BrowserStreamAuthorizationError";
  }
}

const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;

export function resolveBrowserStreamWebSocketUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly ticket: string;
}): string {
  const url = new URL(
    resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: `/browser-stream/${encodeURIComponent(input.threadId)}`,
    }),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ ticket: input.ticket }).toString();
  url.hash = "";
  return url.toString();
}

async function issueBrowserStreamTicket(environmentId: EnvironmentId): Promise<string> {
  const response = await fetchEnvironmentHttp(
    { environmentId, pathname: "/api/auth/websocket-ticket" },
    { method: "POST" },
  );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new BrowserStreamAuthorizationError();
    }
    throw new Error(`Unable to issue a browser stream ticket (${response.status.toString()}).`);
  }
  const body = (await response.json()) as AuthWebSocketTicketResult;
  return body.ticket;
}

function reconnectDelay(attempt: number): number {
  return (
    getWsReconnectDelayMsForRetry(Math.min(attempt, WS_RECONNECT_MAX_RETRIES - 1)) ??
    WS_RECONNECT_MAX_DELAY_MS
  );
}

export function createBrowserStreamConnection(
  options: BrowserStreamConnectionOptions,
): BrowserStreamConnection {
  const createSocket: (url: string) => BrowserStreamSocket =
    options.createSocket ?? ((url) => new WebSocket(url));
  const issueTicket =
    options.issueTicket ?? (() => issueBrowserStreamTicket(options.environmentId));
  const visibilityTarget = options.visibilityTarget ?? document;
  const setTimer =
    options.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimeout ?? ((handle) => window.clearTimeout(handle));
  const now = options.now ?? (() => performance.now());
  let disposed = false;
  let socket: BrowserStreamSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let generation = 0;
  let tabs: ReadonlyArray<BrowserTab> = [];
  let pendingFrame:
    | (ReturnType<typeof decodeBrowserStreamServerMessage> & { readonly _tag: "Frame" })
    | null = null;

  const emitFrame = (
    message: ReturnType<typeof decodeBrowserStreamServerMessage> & { readonly _tag: "Frame" },
  ) => {
    const hintedTab =
      message.frame.tabIndexHint === BROWSER_STREAM_UNKNOWN_TAB_INDEX
        ? undefined
        : tabs[message.frame.tabIndexHint];
    const targetId = hintedTab?.targetId ?? tabs.find((tab) => tab.active)?.targetId;
    if (targetId === undefined) {
      pendingFrame = message;
      return;
    }
    pendingFrame = null;
    options.onFrame({
      targetId,
      seq: message.frame.seq,
      width: message.frame.width,
      height: message.frame.height,
      jpegBytes: message.frame.jpegBytes,
      receivedAt: now(),
    });
  };

  const clearReconnect = () => {
    if (reconnectTimer === null) return;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null || visibilityTarget.visibilityState !== "visible") {
      return;
    }
    const delayMs = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async () => {
    if (disposed || visibilityTarget.visibilityState !== "visible") return;
    clearReconnect();
    generation += 1;
    const currentGeneration = generation;
    options.onConnectionState?.("connecting");
    try {
      const ticket = await issueTicket();
      if (disposed || currentGeneration !== generation) return;
      const nextSocket = createSocket(
        resolveBrowserStreamWebSocketUrl({
          environmentId: options.environmentId,
          threadId: options.threadId,
          ticket,
        }),
      );
      nextSocket.binaryType = "arraybuffer";
      socket = nextSocket;
      let opened = false;
      let terminalEventHandled = false;

      nextSocket.addEventListener("open", () => {
        if (disposed || currentGeneration !== generation) return;
        opened = true;
        reconnectAttempt = 0;
        options.onConnectionState?.("open");
      });
      nextSocket.addEventListener("message", (rawEvent) => {
        if (disposed || currentGeneration !== generation) return;
        const event = rawEvent as MessageEvent<ArrayBuffer | Blob>;
        const process = (buffer: ArrayBuffer) => {
          if (disposed || currentGeneration !== generation) return;
          try {
            const message = decodeBrowserStreamServerMessage(buffer);
            if (message._tag === "Frame") {
              emitFrame(message);
              return;
            }
            if (!("agentActive" in message.event) && message.event._tag === "Tabs") {
              tabs = message.event.tabs;
              options.onEvent(message.event);
              if (pendingFrame !== null) emitFrame(pendingFrame);
              return;
            }
            options.onEvent(message.event);
          } catch (error) {
            options.onError?.(error);
          }
        };
        if (event.data instanceof ArrayBuffer) {
          process(event.data);
        } else {
          void event.data.arrayBuffer().then(process, (error: unknown) => options.onError?.(error));
        }
      });
      const handleTerminal = () => {
        if (terminalEventHandled || disposed || currentGeneration !== generation) return;
        terminalEventHandled = true;
        if (socket === nextSocket) socket = null;
        if (nextSocket.readyState < WEB_SOCKET_CLOSING) {
          nextSocket.close(1001, "Browser stream transport failed");
        }
        options.onConnectionState?.("closed");
        if (opened) reconnectAttempt = 0;
        scheduleReconnect();
      };
      nextSocket.addEventListener("error", handleTerminal, { once: true });
      nextSocket.addEventListener("close", handleTerminal, { once: true });
    } catch (error) {
      if (disposed || currentGeneration !== generation) return;
      options.onConnectionState?.("closed");
      if (error instanceof BrowserStreamAuthorizationError) {
        options.onAuthorizationDenied?.();
        return;
      }
      options.onError?.(error);
      scheduleReconnect();
    }
  };

  const onVisibilityChange = () => {
    if (disposed || visibilityTarget.visibilityState !== "visible") return;
    clearReconnect();
    if (socket === null || socket.readyState !== WEB_SOCKET_OPEN) void connect();
  };
  visibilityTarget.addEventListener("visibilitychange", onVisibilityChange);
  void connect();

  return {
    sendInput: (targetId, event) => {
      if (disposed || socket === null || socket.readyState !== WEB_SOCKET_OPEN) return false;
      try {
        socket.send(encodeBrowserStreamInput({ targetId, event }));
        return true;
      } catch (error) {
        options.onError?.(error);
        return false;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearReconnect();
      visibilityTarget.removeEventListener("visibilitychange", onVisibilityChange);
      const currentSocket = socket;
      socket = null;
      if (currentSocket !== null && currentSocket.readyState < WEB_SOCKET_CLOSING) {
        currentSocket.close(1000, "Browser panel hidden");
      }
      options.onConnectionState?.("closed");
    },
  };
}
