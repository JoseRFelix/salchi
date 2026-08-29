import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_SCREENCAST_INTERACTION_BOOST_MILLIS,
  browserScreencastEveryNthFrameForStart,
  makeBrowserScreencastFrameRateController,
} from "./BrowserScreencastPolicy.ts";

describe("browser screencast frame-rate controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("primes a sampled screencast at full cadence, then uses the desired cadence", () => {
    expect(browserScreencastEveryNthFrameForStart(2, true)).toBe(1);
    expect(browserScreencastEveryNthFrameForStart(2, false)).toBe(2);
    expect(browserScreencastEveryNthFrameForStart(1, true)).toBe(1);
  });

  it("boosts interaction to every frame and debounces decay to the configured cadence", () => {
    const changes: number[] = [];
    const controller = makeBrowserScreencastFrameRateController({
      configuredEveryNthFrame: 2,
      onEveryNthFrameChange: (value) => changes.push(value),
    });

    controller.recordInput();
    controller.recordInput();
    expect(changes).toEqual([1]);

    vi.advanceTimersByTime(BROWSER_SCREENCAST_INTERACTION_BOOST_MILLIS - 1);
    controller.recordInput();
    vi.advanceTimersByTime(BROWSER_SCREENCAST_INTERACTION_BOOST_MILLIS - 1);
    expect(changes).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([1, 2]);
  });

  it("does not schedule a redundant boost when every frame is already configured", () => {
    const onEveryNthFrameChange = vi.fn();
    const controller = makeBrowserScreencastFrameRateController({
      configuredEveryNthFrame: 1,
      onEveryNthFrameChange,
    });

    controller.recordInput();
    vi.runAllTimers();
    expect(onEveryNthFrameChange).not.toHaveBeenCalled();
  });

  it("cancels its pending decay when the browser session is disposed", () => {
    const onEveryNthFrameChange = vi.fn();
    const controller = makeBrowserScreencastFrameRateController({
      configuredEveryNthFrame: 3,
      onEveryNthFrameChange,
    });

    controller.recordInput();
    controller.dispose();
    vi.runAllTimers();
    expect(onEveryNthFrameChange).toHaveBeenCalledExactlyOnceWith(1);
  });
});
