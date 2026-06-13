import { describe, expect, it } from "vitest";

import { createTouchScrollIntentTracker, isWheelScrollAwayIntent } from "./timelineScrollIntent";

describe("isWheelScrollAwayIntent", () => {
  it("treats upward wheels as scroll-away intent", () => {
    expect(isWheelScrollAwayIntent(-12)).toBe(true);
  });

  it("ignores downward and resting wheels", () => {
    expect(isWheelScrollAwayIntent(12)).toBe(false);
    expect(isWheelScrollAwayIntent(0)).toBe(false);
  });

  it("treats a delta of -1 (minimal upward wheel) as scroll-away intent", () => {
    expect(isWheelScrollAwayIntent(-1)).toBe(true);
  });

  it("treats large upward wheel deltas as scroll-away intent", () => {
    expect(isWheelScrollAwayIntent(-300)).toBe(true);
  });

  it("treats large downward wheel deltas as not scroll-away intent", () => {
    expect(isWheelScrollAwayIntent(300)).toBe(false);
  });
});

describe("createTouchScrollIntentTracker", () => {
  it("reports intent when the finger moves down the screen (scrolling content up)", () => {
    const tracker = createTouchScrollIntentTracker();
    tracker.touchStart(100);
    expect(tracker.touchMove(140)).toBe(true);
  });

  it("does not report intent when the finger moves up the screen (scrolling content down)", () => {
    const tracker = createTouchScrollIntentTracker();
    tracker.touchStart(100);
    expect(tracker.touchMove(60)).toBe(false);
  });

  it("does not report intent on the first move without a start", () => {
    const tracker = createTouchScrollIntentTracker();
    expect(tracker.touchMove(100)).toBe(false);
    // Subsequent downward move is now tracked relative to the seeded position.
    expect(tracker.touchMove(140)).toBe(true);
  });

  it("resets tracking on a new touchStart", () => {
    const tracker = createTouchScrollIntentTracker();
    tracker.touchStart(200);
    expect(tracker.touchMove(240)).toBe(true);

    tracker.touchStart(100);
    // First move after reset compares against the new start position.
    expect(tracker.touchMove(80)).toBe(false);
  });

  it("does not report intent when the finger stays at the same position (zero delta)", () => {
    const tracker = createTouchScrollIntentTracker();
    tracker.touchStart(150);
    expect(tracker.touchMove(150)).toBe(false);
  });

  it("tracks state incrementally across consecutive moves", () => {
    const tracker = createTouchScrollIntentTracker();
    tracker.touchStart(100);
    // First move: downward
    expect(tracker.touchMove(110)).toBe(true);
    // Second move: upward relative to previous position
    expect(tracker.touchMove(95)).toBe(false);
    // Third move: downward again relative to previous position
    expect(tracker.touchMove(105)).toBe(true);
  });

  it("seeds lastClientY from the first touchMove when no touchStart occurred", () => {
    const tracker = createTouchScrollIntentTracker();
    // First call with no start seeds the position without reporting intent.
    expect(tracker.touchMove(200)).toBe(false);
    // Moving upward from 200 (finger moves up the screen).
    expect(tracker.touchMove(180)).toBe(false);
    // Moving downward from 180 (finger moves down the screen = scroll-away).
    expect(tracker.touchMove(220)).toBe(true);
  });

  it("touchStart with a new position changes the reference for the next move", () => {
    const tracker = createTouchScrollIntentTracker();
    tracker.touchStart(500);
    // Move upward (finger moves up = scroll down = not scroll-away).
    expect(tracker.touchMove(450)).toBe(false);
    // A new touchStart re-anchors.
    tracker.touchStart(50);
    // Move downward from 50 (scroll-away).
    expect(tracker.touchMove(90)).toBe(true);
  });
});
