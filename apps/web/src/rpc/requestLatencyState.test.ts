import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  trackRpcRequestSent,
  SLOW_RPC_ACK_THRESHOLD_MS,
  MAX_TRACKED_RPC_ACK_REQUESTS,
} from "./requestLatencyState";

describe("requestLatencyState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRequestLatencyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks unary requests as slow when the ack threshold is exceeded", () => {
    trackRpcRequestSent("1", "server.getConfig");
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS - 1);
    expect(getSlowRpcAckRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcAckRequests()).toMatchObject([
      {
        requestId: "1",
        tag: "server.getConfig",
        thresholdMs: SLOW_RPC_ACK_THRESHOLD_MS,
      },
    ]);
  });

  it("clears the slow request once the server acknowledges it", () => {
    trackRpcRequestSent("1", "git.status");
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);
    expect(getSlowRpcAckRequests()).toHaveLength(1);

    acknowledgeRpcRequest("1");
    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("ignores stale slow timer callbacks after reconnect clears the request", () => {
    const timeoutCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler) => {
      if (typeof handler === "function") {
        timeoutCallbacks.push(handler as () => void);
      }
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);

    trackRpcRequestSent("33", "vcs.listRefs");
    clearAllTrackedRpcRequests();

    timeoutCallbacks[0]?.();

    expect(getSlowRpcAckRequests()).toEqual([]);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("ignores long-lived subscriptions that do not produce an initial snapshot", () => {
    trackRpcRequestSent("1", WS_METHODS.subscribeTerminalEvents);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("ignores preview automation connections because they are idle control streams", () => {
    trackRpcRequestSent("1", WS_METHODS.previewAutomationConnect);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("tracks thread detail subscriptions until the initial snapshot arrives", () => {
    trackRpcRequestSent("1", ORCHESTRATION_WS_METHODS.subscribeThread);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);

    expect(getSlowRpcAckRequests()).toMatchObject([
      {
        requestId: "1",
        tag: ORCHESTRATION_WS_METHODS.subscribeThread,
      },
    ]);

    acknowledgeRpcRequest("1");

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("evicts the oldest pending requests once the tracker reaches capacity", () => {
    for (let index = 0; index < MAX_TRACKED_RPC_ACK_REQUESTS + 1; index += 1) {
      trackRpcRequestSent(String(index), "server.getConfig");
    }

    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);

    const slowRequests = getSlowRpcAckRequests();
    expect(slowRequests).toHaveLength(MAX_TRACKED_RPC_ACK_REQUESTS);
    expect(slowRequests[0]?.requestId).toBe("1");
    expect(slowRequests.at(-1)?.requestId).toBe(String(MAX_TRACKED_RPC_ACK_REQUESTS));
  });
});
