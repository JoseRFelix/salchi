import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MILLIS,
  createBrowserViewportResizeController,
} from "./browserViewportResize";

describe("browser panel viewport resize reporting", () => {
  it("sends on open, debounces settled resizes, and releases on hide", () => {
    vi.useFakeTimers();
    const sent: Array<{ readonly width: number; readonly height: number }> = [];
    const release = vi.fn();
    const controller = createBrowserViewportResizeController({
      onSet: (size) => sent.push(size),
      onRelease: release,
    });

    try {
      controller.activate({ width: 390.4, height: 760.2 });
      expect(sent).toEqual([{ width: 390, height: 760 }]);
      controller.resize({ width: 400, height: 750 });
      controller.resize({ width: 420, height: 730 });
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MILLIS - 1);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual([
        { width: 390, height: 760 },
        { width: 420, height: 730 },
      ]);

      controller.deactivate();
      expect(release).toHaveBeenCalledTimes(1);
      controller.dispose();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resends the current size after an RPC transport reconnect", () => {
    const onSet = vi.fn();
    const controller = createBrowserViewportResizeController({ onSet, onRelease: vi.fn() });
    controller.activate({ width: 800, height: 600 });
    controller.resend();
    expect(onSet).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
