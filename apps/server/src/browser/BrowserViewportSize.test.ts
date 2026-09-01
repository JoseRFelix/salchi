import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_VIEWPORT_SIZE,
  initialBrowserViewportPolicyState,
  normalizeBrowserViewportSize,
  setBrowserViewportAgentActive,
  setBrowserViewportFollowingEnabled,
  updateBrowserViewportRequest,
} from "./BrowserViewportSize.ts";

describe("browser viewport size normalization", () => {
  it("clamps both axes and snaps to the nearest even number", () => {
    expect(normalizeBrowserViewportSize({ width: 319, height: 479 })).toEqual({
      width: 320,
      height: 480,
    });
    expect(normalizeBrowserViewportSize({ width: 1_279, height: 1_023 })).toEqual({
      width: 1_280,
      height: 1_024,
    });
    expect(normalizeBrowserViewportSize({ width: 801, height: 601 })).toEqual({
      width: 802,
      height: 602,
    });
    expect(normalizeBrowserViewportSize({ width: 5_000, height: 5_000 })).toEqual({
      width: 1_280,
      height: 1_024,
    });
  });
});

describe("browser viewport surface policy", () => {
  it("uses the largest visible surface and the latest writer for equal-area ties", () => {
    let transition = updateBrowserViewportRequest(
      initialBrowserViewportPolicyState(true),
      "desktop-a",
      { width: 800, height: 600 },
    );
    expect(transition.apply).toBeNull();

    transition = updateBrowserViewportRequest(transition.state, "phone", {
      width: 400,
      height: 800,
    });
    expect(transition.apply).toBeNull();

    transition = updateBrowserViewportRequest(transition.state, "desktop-b", {
      width: 600,
      height: 800,
    });
    expect(transition.apply).toEqual({ width: 600, height: 800 });

    transition = updateBrowserViewportRequest(transition.state, "desktop-a", {
      width: 800,
      height: 600,
    });
    expect(transition.apply).toEqual({ width: 800, height: 600 });

    transition = updateBrowserViewportRequest(transition.state, "desktop-a", null);
    expect(transition.apply).toEqual({ width: 600, height: 800 });
  });

  it("queues only the newest winning size while the agent is active", () => {
    let state = setBrowserViewportAgentActive(initialBrowserViewportPolicyState(true), true).state;

    let transition = updateBrowserViewportRequest(state, "panel", {
      width: 500,
      height: 900,
    });
    expect(transition.apply).toBeNull();
    expect(transition.state.pendingSize).toEqual({ width: 500, height: 900 });

    transition = updateBrowserViewportRequest(transition.state, "panel", {
      width: 1_100,
      height: 700,
    });
    expect(transition.apply).toBeNull();
    expect(transition.state.pendingSize).toEqual({ width: 1_100, height: 700 });

    transition = setBrowserViewportAgentActive(transition.state, false);
    expect(transition.apply).toEqual({ width: 1_100, height: 700 });
    expect(transition.state.pendingSize).toBeNull();
  });

  it("reverts to the default while following is disabled and restores the winner when enabled", () => {
    const requested = updateBrowserViewportRequest(
      initialBrowserViewportPolicyState(true),
      "panel",
      { width: 1_000, height: 700 },
    );
    const disabled = setBrowserViewportFollowingEnabled(requested.state, false);
    expect(disabled.apply).toEqual(DEFAULT_BROWSER_VIEWPORT_SIZE);

    const ignoredResize = updateBrowserViewportRequest(disabled.state, "panel", {
      width: 1_200,
      height: 900,
    });
    expect(ignoredResize.apply).toBeNull();
    expect(ignoredResize.state.appliedSize).toEqual(DEFAULT_BROWSER_VIEWPORT_SIZE);

    const enabled = setBrowserViewportFollowingEnabled(ignoredResize.state, true);
    expect(enabled.apply).toEqual({ width: 1_200, height: 900 });
  });
});
