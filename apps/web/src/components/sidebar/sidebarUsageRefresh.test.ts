import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  refreshSidebarUsageLimits,
  resetSidebarUsageRefreshForTests,
  SIDEBAR_USAGE_CACHE_TTL_MS,
} from "./sidebarUsageRefresh";

beforeEach(() => {
  resetSidebarUsageRefreshForTests();
});

describe("refreshSidebarUsageLimits", () => {
  it("reuses successful data for twenty seconds", async () => {
    let nowMs = 1_000;
    const refresh = vi.fn(async () => ({ accountRateLimits: [] }));
    const updateStore = vi.fn();
    const options = { now: () => nowMs, refresh, updateStore };

    await expect(refreshSidebarUsageLimits(options)).resolves.toBe(true);
    nowMs += SIDEBAR_USAGE_CACHE_TTL_MS - 1;
    await expect(refreshSidebarUsageLimits(options)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await expect(refreshSidebarUsageLimits(options)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes and does not cache failures", async () => {
    let resolveRefresh: ((value: { accountRateLimits: [] }) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<{ accountRateLimits: [] }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const updateStore = vi.fn();
    const options = { now: () => 5_000, refresh, updateStore };

    const first = refreshSidebarUsageLimits(options);
    const second = refreshSidebarUsageLimits(options);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh?.({ accountRateLimits: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    resetSidebarUsageRefreshForTests();
    const failedRefresh = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(refreshSidebarUsageLimits({ ...options, refresh: failedRefresh })).resolves.toBe(
      false,
    );
    await expect(refreshSidebarUsageLimits({ ...options, refresh: failedRefresh })).resolves.toBe(
      false,
    );
    expect(failedRefresh).toHaveBeenCalledTimes(2);
  });
});
