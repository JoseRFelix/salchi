import type { BrowserInputEvent } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import { makeBrowserInputRateLimiter, toBrowserCdpInputCommand } from "./BrowserInput.ts";

const FRAME = { width: 800, height: 600 } as const;

describe("browser CDP input translation", () => {
  it("maps pointer events and clamps frame coordinates", () => {
    expect(
      toBrowserCdpInputCommand(
        {
          _tag: "PointerDown",
          x: -12,
          y: 900,
          button: "left",
          clickCount: 2,
        },
        FRAME,
      ),
    ).toEqual({
      _tag: "Mouse",
      params: {
        type: "mousePressed",
        x: 0,
        y: 600,
        button: "left",
        buttons: 1,
        clickCount: 2,
      },
    });

    expect(
      toBrowserCdpInputCommand(
        {
          _tag: "PointerUp",
          x: 801,
          y: 25,
          button: "left",
          clickCount: 1,
        },
        FRAME,
      ),
    ).toMatchObject({
      _tag: "Mouse",
      params: { type: "mouseReleased", x: 800, y: 25, buttons: 0 },
    });
  });

  it("maps pointer moves and wheel deltas", () => {
    expect(
      toBrowserCdpInputCommand(
        {
          _tag: "PointerMove",
          x: 400,
          y: 300,
          button: "left",
          clickCount: 1,
        },
        FRAME,
      ),
    ).toMatchObject({
      _tag: "Mouse",
      params: { type: "mouseMoved", button: "left", buttons: 1 },
    });
    expect(
      toBrowserCdpInputCommand({ _tag: "Wheel", x: 200, y: 150, deltaX: -4, deltaY: 24 }, FRAME),
    ).toEqual({
      _tag: "Mouse",
      params: {
        type: "mouseWheel",
        x: 200,
        y: 150,
        button: "none",
        buttons: 0,
        deltaX: -4,
        deltaY: 24,
      },
    });
  });

  it("maps keyboard and composed text events", () => {
    expect(
      toBrowserCdpInputCommand(
        { _tag: "KeyDown", key: "Enter", code: "Enter", modifiers: 0 },
        FRAME,
      ),
    ).toEqual({
      _tag: "Key",
      params: {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        modifiers: 0,
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      },
    });
    expect(
      toBrowserCdpInputCommand({ _tag: "KeyDown", key: "a", code: "KeyA", modifiers: 0 }, FRAME),
    ).toMatchObject({
      _tag: "Key",
      params: { type: "keyDown", text: "a", unmodifiedText: "a" },
    });
    expect(toBrowserCdpInputCommand({ _tag: "InsertText", text: "composed ✓" }, FRAME)).toEqual({
      _tag: "InsertText",
      params: { text: "composed ✓" },
    });
  });
});

describe("browser input rate limiter", () => {
  it("bounds a rolling per-session window and admits events after it expires", () => {
    let now = 0;
    const limiter = makeBrowserInputRateLimiter({ limit: 3, now: () => now, windowMs: 1_000 });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    now = 999;
    expect(limiter.tryAcquire()).toBe(false);
    now = 1_000;
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("accepts all browser input event variants without sharing state across limiters", () => {
    const events: BrowserInputEvent[] = [
      { _tag: "KeyUp", key: "a", code: "KeyA", modifiers: 0 },
      { _tag: "InsertText", text: "a" },
    ];
    expect(events.map((event) => toBrowserCdpInputCommand(event, FRAME)._tag)).toEqual([
      "Key",
      "InsertText",
    ]);
    expect(makeBrowserInputRateLimiter({ limit: 1 }).tryAcquire()).toBe(true);
    expect(makeBrowserInputRateLimiter({ limit: 1 }).tryAcquire()).toBe(true);
  });
});
