import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import { deriveConnectionIndicator } from "./ConnectionStatusIndicator.logic";

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
    expect(view.detail).toBe("Reconnecting to Salchi Server in 6s… Attempt 2/8");
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
    expect(view.detail).toBe("Couldn't reconnect to Salchi Server. Retries exhausted.");
  });

  it("surfaces the underlying error message on a failed initial connection", () => {
    const view = deriveConnectionIndicator(
      makeStatus({ phase: "disconnected", lastError: "  handshake rejected  " }),
      0,
    );
    expect(view.tone).toBe("offline");
    expect(view.label).toBe("Connection error");
    expect(view.detail).toBe("Can't reach Salchi Server: handshake rejected");
  });
});
