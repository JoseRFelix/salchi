import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  deriveConnectionIndicator,
  getConnectionDisplayName,
} from "./ConnectionStatusIndicator.logic";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    heartbeatPingCount: 0,
    heartbeatPongCount: 0,
    heartbeatTimeoutCount: 0,
    lastAttemptAt: null,
    lastError: null,
    lastErrorAt: null,
    lastHeartbeatPingAt: null,
    lastHeartbeatPongAt: null,
    lastHeartbeatTimeoutAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketReadyState: null,
    socketUrl: null,
    ...overrides,
  };
}

describe("deriveConnectionIndicator", () => {
  it("is online and green when connected", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "connected", hasConnected: true }),
      0,
    );
    expect(view.tone).toBe("online");
    expect(view.label).toBe("Connected");
  });

  it("uses the connection label in the detail when present", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "connected", hasConnected: true, connectionLabel: "  Prod box  " }),
      0,
    );
    expect(view.detail).toBe("Connected to Prod box.");
  });

  it("spins while making the first connection", () => {
    const view = deriveConnectionIndicator(makeStatus({ phase: "connecting" }), 0);
    expect(view.tone).toBe("syncing");
    expect(view.label).toBe("Connecting");
  });

  it("spins with a live countdown while reconnecting", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "waiting",
        reconnectAttemptCount: 2,
        nextRetryAt: new Date(10_000).toISOString(),
      }),
      4_200,
    );
    expect(view.tone).toBe("syncing");
    expect(view.label).toBe("Reconnecting");
    expect(view.detail).toBe("Reconnecting to T3 Server in 6s… Attempt 2/8");
  });

  it("is red without a retry affordance while the browser is offline", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        online: false,
        phase: "disconnected",
        disconnectedAt: new Date(0).toISOString(),
      }),
      0,
    );
    expect(view.tone).toBe("offline");
    expect(view.label).toBe("Offline");
  });

  it("is red once reconnect retries are exhausted", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "exhausted",
        reconnectAttemptCount: 8,
      }),
      0,
    );
    expect(view.tone).toBe("offline");
    expect(view.label).toBe("Disconnected");
    expect(view.detail).toBe("Couldn't reconnect to T3 Server. Retries exhausted.");
  });

  it("surfaces the underlying error message on a failed initial connection", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "disconnected", lastError: "  handshake rejected  " }),
      0,
    );
    expect(view.tone).toBe("offline");
    expect(view.label).toBe("Connection error");
    expect(view.detail).toBe("Can't reach T3 Server: handshake rejected");
  });

  it("uses the default name when error has no message", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "disconnected", lastError: null }),
      0,
    );
    expect(view.tone).toBe("offline");
    expect(view.detail).toBe("Can't reach T3 Server.");
  });

  it("uses the default name when error is whitespace-only", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "disconnected", lastError: "   " }),
      0,
    );
    expect(view.detail).toBe("Can't reach T3 Server.");
  });

  it("shows the connecting detail with the default server name", () => {
    const view = deriveConnectionIndicator(makeStatus({ phase: "connecting" }), 0);
    expect(view.detail).toBe("Connecting to T3 Server…");
  });

  it("uses the trimmed custom connection label in the connecting state", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "connecting", connectionLabel: "  My Server  " }),
      0,
    );
    expect(view.detail).toBe("Connecting to My Server…");
  });

  it("falls back to the default name when connectionLabel is whitespace-only", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "connected", hasConnected: true, connectionLabel: "   " }),
      0,
    );
    expect(view.detail).toBe("Connected to T3 Server.");
  });

  it("uses the custom connection name in the exhausted detail", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "exhausted",
        connectionLabel: "Prod Server",
      }),
      0,
    );
    expect(view.detail).toBe("Couldn't reconnect to Prod Server. Retries exhausted.");
  });

  it("formats reconnecting detail without countdown when nextRetryAt is null", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "attempting",
        reconnectAttemptCount: 3,
        nextRetryAt: null,
      }),
      0,
    );
    expect(view.tone).toBe("syncing");
    expect(view.label).toBe("Reconnecting");
    expect(view.detail).toBe("Reconnecting to T3 Server… Attempt 3/8");
  });

  it("uses the custom connection name in the reconnecting countdown", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "waiting",
        reconnectAttemptCount: 1,
        connectionLabel: "Remote Box",
        nextRetryAt: new Date(5_000).toISOString(),
      }),
      0,
    );
    expect(view.detail).toContain("Remote Box");
  });

  it("rounds reconnect countdown up to at least 1 second", () => {
    const view = deriveConnectionIndicator(
      makeStatus({
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "waiting",
        reconnectAttemptCount: 1,
        nextRetryAt: new Date(100).toISOString(),
      }),
      // nowMs is equal to the retry time — 0ms remaining.
      100,
    );
    expect(view.detail).toContain("1s");
  });
});

describe("getConnectionDisplayName", () => {
  function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
    return {
      attemptCount: 0,
      closeCode: null,
      closeReason: null,
      connectionLabel: null,
      connectedAt: null,
      disconnectedAt: null,
      hasConnected: false,
      heartbeatPingCount: 0,
      heartbeatPongCount: 0,
      heartbeatTimeoutCount: 0,
      lastAttemptAt: null,
      lastError: null,
      lastErrorAt: null,
      lastHeartbeatPingAt: null,
      lastHeartbeatPongAt: null,
      lastHeartbeatTimeoutAt: null,
      nextRetryAt: null,
      online: true,
      phase: "idle",
      reconnectAttemptCount: 0,
      reconnectMaxAttempts: 8,
      reconnectPhase: "idle",
      socketReadyState: null,
      socketUrl: null,
      ...overrides,
    };
  }

  it("returns the trimmed connectionLabel when present", () => {
    expect(getConnectionDisplayName(makeStatus({ connectionLabel: "  My Server  " }))).toBe(
      "My Server",
    );
  });

  it("returns the default name when connectionLabel is null", () => {
    expect(getConnectionDisplayName(makeStatus({ connectionLabel: null }))).toBe("T3 Server");
  });

  it("returns the default name when connectionLabel is whitespace-only", () => {
    expect(getConnectionDisplayName(makeStatus({ connectionLabel: "   " }))).toBe("T3 Server");
  });

  it("returns the default name when connectionLabel is an empty string", () => {
    expect(getConnectionDisplayName(makeStatus({ connectionLabel: "" }))).toBe("T3 Server");
  });
});
