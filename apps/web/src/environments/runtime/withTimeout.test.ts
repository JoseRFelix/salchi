import { afterEach, describe, expect, it, vi } from "vitest";

import { withAbortableTimeout } from "./withTimeout";

describe("withAbortableTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the underlying operation while preserving the timeout error", async () => {
    vi.useFakeTimers();
    const operation = { signal: null as AbortSignal | null };
    const promise = withAbortableTimeout(
      (signal) => {
        operation.signal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("operation aborted")), {
            once: true,
          });
        });
      },
      1_000,
      () => new Error("operation timed out"),
    );
    const expectation = expect(promise).rejects.toThrow("operation timed out");

    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;

    expect(operation.signal?.aborted).toBe(true);
  });
});
