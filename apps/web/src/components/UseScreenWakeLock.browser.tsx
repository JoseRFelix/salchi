import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useScreenWakeLock } from "../hooks/useScreenWakeLock";

class MockWakeLockSentinel extends EventTarget {
  released = false;

  readonly release = vi.fn(async () => {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });

  lose(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

function WakeLockHarness(props: { readonly active: boolean }) {
  useScreenWakeLock(props.active);
  return null;
}

function installWakeLock(request: () => Promise<WakeLockSentinel>): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "wakeLock", original);
    } else {
      Reflect.deleteProperty(navigator, "wakeLock");
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScreenWakeLock", () => {
  it("reacquires a wake lock after the browser releases it unexpectedly", async () => {
    const first = new MockWakeLockSentinel();
    const second = new MockWakeLockSentinel();
    const request = vi
      .fn<() => Promise<WakeLockSentinel>>()
      .mockResolvedValueOnce(first as unknown as WakeLockSentinel)
      .mockResolvedValueOnce(second as unknown as WakeLockSentinel);
    const restore = installWakeLock(request);
    const screen = await render(<WakeLockHarness active />);

    try {
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledOnce();
      });
      first.lose();
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(2);
      });
      expect(second.released).toBe(false);

      await screen.unmount();
      await vi.waitFor(() => {
        expect(second.release).toHaveBeenCalledOnce();
      });
    } finally {
      await screen.unmount();
      restore();
    }
  });

  it("retries temporary acquisition failures and stops retrying after deactivation", async () => {
    const acquired = new MockWakeLockSentinel();
    const request = vi
      .fn<() => Promise<WakeLockSentinel>>()
      .mockRejectedValueOnce(new DOMException("Temporarily unavailable", "NotAllowedError"))
      .mockResolvedValueOnce(acquired as unknown as WakeLockSentinel);
    const restore = installWakeLock(request);
    const screen = await render(<WakeLockHarness active />);

    try {
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(2);
      });
      await screen.rerender(<WakeLockHarness active={false} />);
      await vi.waitFor(() => {
        expect(acquired.release).toHaveBeenCalledOnce();
      });
      await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
      restore();
    }
  });
});
