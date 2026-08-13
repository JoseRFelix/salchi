import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_USAGE_BACKGROUND_REFRESH_INTERVAL_MS,
  startSidebarUsagePolling,
  type SidebarUsagePollingScheduler,
} from "./sidebarUsagePolling";

describe("startSidebarUsagePolling", () => {
  it("refreshes immediately, on focus, and once per minute", () => {
    const refresh = vi.fn();
    let intervalCallback: (() => void) | undefined;
    let focusCallback: (() => void) | undefined;
    const scheduler: SidebarUsagePollingScheduler = {
      setInterval: vi.fn((callback, intervalMs) => {
        intervalCallback = callback;
        expect(intervalMs).toBe(SIDEBAR_USAGE_BACKGROUND_REFRESH_INTERVAL_MS);
        return 17;
      }),
      clearInterval: vi.fn(),
      addEventListener: vi.fn((_type, callback) => {
        focusCallback = callback;
      }),
      removeEventListener: vi.fn(),
    };

    const stop = startSidebarUsagePolling(
      refresh,
      SIDEBAR_USAGE_BACKGROUND_REFRESH_INTERVAL_MS,
      scheduler,
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    focusCallback?.();
    intervalCallback?.();
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
    expect(scheduler.clearInterval).toHaveBeenCalledWith(17);
    expect(scheduler.removeEventListener).toHaveBeenCalledWith("focus", focusCallback);
  });
});
