import { describe, expect, it } from "vitest";

import {
  browserKeyboardModifiers,
  computeBrowserFrameLayout,
  mapCanvasPointToBrowserFrame,
} from "./browserInput";

describe("browser viewport input coordinates", () => {
  it("inverts horizontal letterboxing", () => {
    expect(computeBrowserFrameLayout(1_000, 600, 800, 600)).toEqual({
      scale: 1,
      drawWidth: 800,
      drawHeight: 600,
      drawX: 100,
      drawY: 0,
    });
    expect(
      mapCanvasPointToBrowserFrame({
        bounds: { left: 20, top: 30, width: 1_000, height: 600 },
        clientX: 520,
        clientY: 330,
        devicePixelRatio: 1,
        frameWidth: 800,
        frameHeight: 600,
      }),
    ).toEqual({ x: 400, y: 300 });
    expect(
      mapCanvasPointToBrowserFrame({
        bounds: { left: 20, top: 30, width: 1_000, height: 600 },
        clientX: 50,
        clientY: 330,
        devicePixelRatio: 1,
        frameWidth: 800,
        frameHeight: 600,
      }),
    ).toBeNull();
  });

  it("inverts vertical letterboxing and device-pixel-ratio scaling", () => {
    expect(
      mapCanvasPointToBrowserFrame({
        bounds: { left: 10, top: 20, width: 400, height: 400 },
        clientX: 210,
        clientY: 220,
        devicePixelRatio: 2,
        frameWidth: 800,
        frameHeight: 600,
      }),
    ).toEqual({ x: 400, y: 300 });
    expect(
      mapCanvasPointToBrowserFrame({
        bounds: { left: 10, top: 20, width: 400, height: 400 },
        clientX: 210,
        clientY: 25,
        devicePixelRatio: 2,
        frameWidth: 800,
        frameHeight: 600,
      }),
    ).toBeNull();
  });

  it("clamps a captured drag to the frame edge", () => {
    expect(
      mapCanvasPointToBrowserFrame({
        bounds: { left: 0, top: 0, width: 400, height: 300 },
        clientX: 500,
        clientY: -20,
        devicePixelRatio: 2,
        frameWidth: 800,
        frameHeight: 600,
        clampToFrame: true,
      }),
    ).toEqual({ x: 800, y: 0 });
  });

  it("encodes CDP modifier bits", () => {
    expect(
      browserKeyboardModifiers({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toBe(11);
  });
});
