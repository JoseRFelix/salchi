import { describe, expect, it } from "vitest";

import {
  BROWSER_VIEWPORT_LEASE_INVARIANT_GRACE_MILLIS,
  initialBrowserViewportLeaseInvariantState,
  updateBrowserViewportLeaseInvariant,
} from "./BrowserViewportLeaseInvariant.ts";

describe("browser viewport lease invariant", () => {
  it("logs once after a subscriber lacks a visible-surface lease for thirty seconds", () => {
    const started = updateBrowserViewportLeaseInvariant(initialBrowserViewportLeaseInvariantState, {
      now: 10,
      subscriberCount: 1,
      visibleLeaseCount: 0,
    });
    const beforeGrace = updateBrowserViewportLeaseInvariant(started.state, {
      now: 10 + BROWSER_VIEWPORT_LEASE_INVARIANT_GRACE_MILLIS - 1,
      subscriberCount: 1,
      visibleLeaseCount: 0,
    });
    const afterGrace = updateBrowserViewportLeaseInvariant(beforeGrace.state, {
      now: 10 + BROWSER_VIEWPORT_LEASE_INVARIANT_GRACE_MILLIS,
      subscriberCount: 1,
      visibleLeaseCount: 0,
    });
    const repeated = updateBrowserViewportLeaseInvariant(afterGrace.state, {
      now: 10 + BROWSER_VIEWPORT_LEASE_INVARIANT_GRACE_MILLIS * 2,
      subscriberCount: 1,
      visibleLeaseCount: 0,
    });

    expect(started.shouldLog).toBe(false);
    expect(beforeGrace.shouldLog).toBe(false);
    expect(afterGrace.shouldLog).toBe(true);
    expect(repeated.shouldLog).toBe(false);
  });

  it("resets immediately when a visible lease appears or the subscriber releases", () => {
    const violated = updateBrowserViewportLeaseInvariant(
      {
        logged: true,
        violationStartedAt: 0,
      },
      { now: 50_000, subscriberCount: 1, visibleLeaseCount: 1 },
    );
    expect(violated.state).toEqual(initialBrowserViewportLeaseInvariantState);

    const released = updateBrowserViewportLeaseInvariant(
      { logged: false, violationStartedAt: 1 },
      { now: 2, subscriberCount: 0, visibleLeaseCount: 0 },
    );
    expect(released.state).toEqual(initialBrowserViewportLeaseInvariantState);
  });
});
