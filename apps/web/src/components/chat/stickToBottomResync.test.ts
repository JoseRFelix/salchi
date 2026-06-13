import { describe, expect, it, vi } from "vitest";

import { scheduleAtEndResync } from "./stickToBottomResync";

function createScheduler() {
  let nextTimeoutHandle = 1;
  const timeouts = new Map<number, () => void>();

  return {
    scheduler: {
      setTimeout: (callback: () => void) => {
        const handle = nextTimeoutHandle;
        nextTimeoutHandle += 1;
        timeouts.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle: number) => {
        timeouts.delete(handle);
      },
    },
    flushTimeouts: () => {
      const pending = Array.from(timeouts.entries());
      timeouts.clear();
      for (const [, callback] of pending) {
        callback();
      }
    },
    pendingTimeoutCount: () => timeouts.size,
  };
}

describe("scheduleAtEndResync", () => {
  it("re-attaches after the delay when the list is at the end", () => {
    const onAtEnd = vi.fn();
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: 1200,
      isAtEnd: () => true,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    expect(onAtEnd).not.toHaveBeenCalled();
    scheduler.flushTimeouts();
    expect(onAtEnd).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the list is not at the end", () => {
    const onAtEnd = vi.fn();
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: 1200,
      isAtEnd: () => false,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    scheduler.flushTimeouts();
    expect(onAtEnd).not.toHaveBeenCalled();
  });

  it("cancel() prevents the resync from firing", () => {
    const onAtEnd = vi.fn();
    const isAtEnd = vi.fn(() => true);
    const scheduler = createScheduler();

    const scheduled = scheduleAtEndResync({
      delayMs: 1200,
      isAtEnd,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    scheduled.cancel();
    scheduler.flushTimeouts();

    expect(isAtEnd).not.toHaveBeenCalled();
    expect(onAtEnd).not.toHaveBeenCalled();
    expect(scheduler.pendingTimeoutCount()).toBe(0);
  });

  it("clamps negative delayMs to zero", () => {
    const onAtEnd = vi.fn();
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: -500,
      isAtEnd: () => true,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    // Timeout should still be scheduled (with delay 0), not fired immediately.
    expect(onAtEnd).not.toHaveBeenCalled();
    expect(scheduler.pendingTimeoutCount()).toBe(1);
    scheduler.flushTimeouts();
    expect(onAtEnd).toHaveBeenCalledTimes(1);
  });

  it("works with zero delayMs", () => {
    const onAtEnd = vi.fn();
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: 0,
      isAtEnd: () => true,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    expect(onAtEnd).not.toHaveBeenCalled();
    scheduler.flushTimeouts();
    expect(onAtEnd).toHaveBeenCalledTimes(1);
  });

  it("calling cancel() a second time is a no-op", () => {
    const onAtEnd = vi.fn();
    const scheduler = createScheduler();

    const scheduled = scheduleAtEndResync({
      delayMs: 1200,
      isAtEnd: () => true,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    scheduled.cancel();
    // Second cancel must not throw.
    expect(() => scheduled.cancel()).not.toThrow();
    scheduler.flushTimeouts();
    expect(onAtEnd).not.toHaveBeenCalled();
  });

  it("evaluates isAtEnd lazily at timer fire time, not at schedule time", () => {
    const onAtEnd = vi.fn();
    let atEnd = false;
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: 1000,
      isAtEnd: () => atEnd,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    // atEnd is false when scheduled; flip it before the timer fires.
    atEnd = true;
    scheduler.flushTimeouts();
    expect(onAtEnd).toHaveBeenCalledTimes(1);
  });

  it("does not re-attach when isAtEnd flips to false before timer fires", () => {
    const onAtEnd = vi.fn();
    let atEnd = true;
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: 1000,
      isAtEnd: () => atEnd,
      onAtEnd,
      scheduler: scheduler.scheduler,
    });

    // atEnd was true when scheduled; user scrolled away before timer fires.
    atEnd = false;
    scheduler.flushTimeouts();
    expect(onAtEnd).not.toHaveBeenCalled();
  });

  it("schedules exactly one timeout per call", () => {
    const scheduler = createScheduler();

    scheduleAtEndResync({
      delayMs: 500,
      isAtEnd: () => true,
      onAtEnd: vi.fn(),
      scheduler: scheduler.scheduler,
    });

    expect(scheduler.pendingTimeoutCount()).toBe(1);
  });
});
