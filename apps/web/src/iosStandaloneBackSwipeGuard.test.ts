import { describe, expect, it, vi } from "vitest";

import {
  IOS_EDGE_TAP_MAX_DURATION_MS,
  IOS_EDGE_TAP_SLOP_PX,
  IOS_HISTORY_SWIPE_EDGE_WIDTH_PX,
  installIosStandaloneBackSwipeGuard,
  isHistorySwipeEdgeTouch,
  isIosTouchDevice,
  isNativeTouchBehaviorTarget,
  isSyntheticEdgeTap,
  shouldInstallIosStandaloneBackSwipeGuard,
  shouldPreventIosHistorySwipeTouchStart,
} from "./iosStandaloneBackSwipeGuard";

type TouchLike = {
  readonly clientX: number;
  readonly clientY: number;
  readonly identifier: number;
};

class FakeMouseEvent extends Event {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly detail: number;
  readonly view: Window | null;

  constructor(type: string, eventInit: MouseEventInit = {}) {
    super(type, eventInit);
    this.button = eventInit.button ?? 0;
    this.clientX = eventInit.clientX ?? 0;
    this.clientY = eventInit.clientY ?? 0;
    this.detail = eventInit.detail ?? 0;
    this.view = eventInit.view ?? null;
  }
}

const fakeDefaultView = {} as {
  Element: typeof FakeElement;
  HTMLElement: typeof FakeHTMLElement;
  MouseEvent: typeof FakeMouseEvent;
};

class FakeElement extends EventTarget {
  readonly ownerDocument = {
    defaultView: fakeDefaultView,
  };
  isConnected = true;

  constructor(private readonly matchedSelectors: readonly string[] = []) {
    super();
  }

  closest(selector: string): FakeElement | null {
    return this.matchedSelectors.some((matchedSelector) => selector.includes(matchedSelector))
      ? this
      : null;
  }

  remove(): void {
    this.isConnected = false;
  }
}

class FakeHTMLElement extends FakeElement {
  readonly click = vi.fn();
  readonly focus = vi.fn();
}

fakeDefaultView.Element = FakeElement;
fakeDefaultView.HTMLElement = FakeHTMLElement;
fakeDefaultView.MouseEvent = FakeMouseEvent;

type CapturedMouseEvent = {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly detail: number;
  readonly type: string;
  readonly view: Window | null;
};

function captureMouseEvents(target: EventTarget, order?: string[]): CapturedMouseEvent[] {
  const events: CapturedMouseEvent[] = [];

  for (const type of ["mousedown", "mouseup", "click"] as const) {
    target.addEventListener(type, (event) => {
      const mouseEvent = event as FakeMouseEvent;
      order?.push(mouseEvent.type);
      events.push({
        button: mouseEvent.button,
        clientX: mouseEvent.clientX,
        clientY: mouseEvent.clientY,
        detail: mouseEvent.detail,
        type: mouseEvent.type,
        view: mouseEvent.view,
      });
    });
  }

  return events;
}

function createTouchList(touches: readonly TouchLike[]): TouchList {
  return Object.assign([...touches], {
    item: (index: number) => touches[index] ?? null,
  }) as unknown as TouchList;
}

function createTouchEventLike({
  cancelable = true,
  changedTouches,
  defaultPrevented = false,
  target = null,
  touches,
}: {
  readonly cancelable?: boolean;
  readonly changedTouches: readonly TouchLike[];
  readonly defaultPrevented?: boolean;
  readonly target?: EventTarget | null;
  readonly touches: readonly TouchLike[];
}): TouchEvent & { readonly preventDefault: ReturnType<typeof vi.fn> } {
  const event = {
    cancelable,
    defaultPrevented,
    preventDefault: vi.fn(() => {
      if (event.cancelable) {
        event.defaultPrevented = true;
      }
    }),
    target,
    touches: createTouchList(touches),
    changedTouches: createTouchList(changedTouches),
  };
  return event as unknown as TouchEvent & { readonly preventDefault: ReturnType<typeof vi.fn> };
}

function createIosStandaloneWindow() {
  let now = 0;
  const listeners = new Map<string, (event: TouchEvent) => void>();
  const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.set(type, listener as (event: TouchEvent) => void);
  });
  const removeEventListener = vi.fn();
  const targetWindow = {
    addEventListener,
    document: { documentElement: { clientWidth: 390 } },
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    innerWidth: 390,
    MouseEvent: FakeMouseEvent,
    navigator: {
      maxTouchPoints: 5,
      platform: "iPhone",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
    },
    performance: {
      now: () => now,
    },
    removeEventListener,
  } as unknown as Window;

  return {
    addEventListener,
    listeners,
    removeEventListener,
    setNow: (nextNow: number) => {
      now = nextNow;
    },
    targetWindow,
  };
}

describe("isIosTouchDevice", () => {
  it("detects iPhones from the user agent", () => {
    expect(
      isIosTouchDevice({
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("detects iPadOS devices that report a Mac platform", () => {
    expect(
      isIosTouchDevice({
        maxTouchPoints: 5,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("does not detect desktop Safari as an iOS touch device", () => {
    expect(
      isIosTouchDevice({
        maxTouchPoints: 0,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      }),
    ).toBe(false);
  });
});

describe("shouldInstallIosStandaloneBackSwipeGuard", () => {
  it("installs only for iOS standalone PWAs", () => {
    expect(
      shouldInstallIosStandaloneBackSwipeGuard({
        isStandalonePwa: true,
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      }),
    ).toBe(true);

    expect(
      shouldInstallIosStandaloneBackSwipeGuard({
        isStandalonePwa: false,
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      }),
    ).toBe(false);
  });
});

describe("isHistorySwipeEdgeTouch", () => {
  it("matches touches that start at either horizontal viewport edge", () => {
    expect(
      isHistorySwipeEdgeTouch({
        clientX: IOS_HISTORY_SWIPE_EDGE_WIDTH_PX,
        viewportWidth: 390,
      }),
    ).toBe(true);
    expect(
      isHistorySwipeEdgeTouch({
        clientX: 390 - IOS_HISTORY_SWIPE_EDGE_WIDTH_PX,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it("allows touches away from the horizontal viewport edges", () => {
    expect(
      isHistorySwipeEdgeTouch({
        clientX: IOS_HISTORY_SWIPE_EDGE_WIDTH_PX + 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      isHistorySwipeEdgeTouch({
        clientX: 390 - IOS_HISTORY_SWIPE_EDGE_WIDTH_PX - 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
  });
});

describe("isNativeTouchBehaviorTarget", () => {
  it("allows native behavior for form fields, editable content, terminals, and explicit opt-outs", () => {
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["input"]))).toBe(true);
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["textarea"]))).toBe(true);
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["select"]))).toBe(true);
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["[contenteditable='true']"]))).toBe(
      true,
    );
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement([".xterm"]))).toBe(true);
    expect(
      isNativeTouchBehaviorTarget(new FakeHTMLElement(["[data-ios-back-swipe-guard-allow"])),
    ).toBe(true);
  });

  it("does not exempt common interactive click targets", () => {
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["button"]))).toBe(false);
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["a[href]"]))).toBe(false);
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(['[role="button"]']))).toBe(false);
    expect(isNativeTouchBehaviorTarget(new FakeHTMLElement(["[tabindex"]))).toBe(false);
  });
});

describe("shouldPreventIosHistorySwipeTouchStart", () => {
  it("prevents cancelable single-touch starts at an edge", () => {
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it("prevents edge starts on buttons and links", () => {
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: false,
        targetAllowsNativeTouch: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it("skips targets that allow native touch behavior", () => {
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: false,
        targetAllowsNativeTouch: true,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
  });

  it("allows already-handled, non-cancelable, multi-touch, and non-edge starts", () => {
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: false,
        clientX: 4,
        defaultPrevented: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: true,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: false,
        touchCount: 2,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 100,
        defaultPrevented: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
  });
});

describe("isSyntheticEdgeTap", () => {
  it("accepts movement and duration at the configured boundaries", () => {
    expect(
      isSyntheticEdgeTap({
        deltaX: IOS_EDGE_TAP_SLOP_PX,
        deltaY: 0,
        durationMs: IOS_EDGE_TAP_MAX_DURATION_MS,
      }),
    ).toBe(true);
  });

  it("rejects movement beyond the diagonal slop", () => {
    expect(
      isSyntheticEdgeTap({
        deltaX: 8,
        deltaY: 8,
        durationMs: 100,
      }),
    ).toBe(false);
  });

  it("rejects holds beyond the maximum tap duration", () => {
    expect(
      isSyntheticEdgeTap({
        deltaX: 0,
        deltaY: 0,
        durationMs: IOS_EDGE_TAP_MAX_DURATION_MS + 1,
      }),
    ).toBe(false);
  });
});

describe("installIosStandaloneBackSwipeGuard", () => {
  it("installs and cleans up the edge touch listeners for iOS standalone PWAs", () => {
    const { addEventListener, listeners, removeEventListener, targetWindow } =
      createIosStandaloneWindow();

    const cleanup = installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    expect(addEventListener).toHaveBeenCalledWith(
      "touchstart",
      expect.any(Function),
      expect.objectContaining({ capture: true, passive: false }),
    );
    expect(addEventListener).toHaveBeenCalledWith(
      "touchmove",
      expect.any(Function),
      expect.objectContaining({ passive: true }),
    );
    expect(addEventListener).toHaveBeenCalledWith(
      "touchend",
      expect.any(Function),
      expect.objectContaining({ passive: false }),
    );
    expect(addEventListener).toHaveBeenCalledWith(
      "touchcancel",
      expect.any(Function),
      expect.objectContaining({ passive: true }),
    );

    const listener = listeners.get("touchstart");
    expect(listener).toBeDefined();

    const touchStart = createTouchEventLike({
      changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
    });
    listener?.(touchStart);

    expect(touchStart.preventDefault).toHaveBeenCalledTimes(1);

    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("touchstart", listener, true);
    expect(removeEventListener).toHaveBeenCalledWith("touchmove", listeners.get("touchmove"));
    expect(removeEventListener).toHaveBeenCalledWith("touchend", listeners.get("touchend"));
    expect(removeEventListener).toHaveBeenCalledWith("touchcancel", listeners.get("touchcancel"));
  });

  it("does not install outside iOS standalone PWAs", () => {
    const addEventListener = vi.fn();
    const targetWindow = {
      addEventListener,
      document: { documentElement: { clientWidth: 390 } },
      innerWidth: 390,
      navigator: {
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      },
      removeEventListener: vi.fn(),
    } as unknown as Window;

    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => false,
      window: targetWindow,
    });

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("restores a prevented edge tap with iOS compatibility mouse events", () => {
    const { listeners, setNow, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const button = new FakeHTMLElement();
    const order: string[] = [];
    const mouseEvents = captureMouseEvents(button, order);
    button.focus.mockImplementation(() => {
      order.push("focus");
    });

    setNow(100);
    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      }),
    );

    setNow(180);
    const touchEnd = createTouchEventLike({
      changedTouches: [{ clientX: 5, clientY: 21, identifier: 1 }],
      target: button,
      touches: [],
    });
    listeners.get("touchend")?.(touchEnd);

    expect(touchEnd.preventDefault).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["mousedown", "focus", "mouseup", "click"]);
    expect(button.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(button.click).not.toHaveBeenCalled();
    expect(mouseEvents).toEqual([
      {
        button: 0,
        clientX: 5,
        clientY: 21,
        detail: 1,
        type: "mousedown",
        view: targetWindow,
      },
      {
        button: 0,
        clientX: 5,
        clientY: 21,
        detail: 1,
        type: "mouseup",
        view: targetWindow,
      },
      {
        button: 0,
        clientX: 5,
        clientY: 21,
        detail: 1,
        type: "click",
        view: targetWindow,
      },
    ]);
  });

  it("opens mousedown-driven triggers after a guarded edge tap even when click is swallowed", () => {
    const { listeners, setNow, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const trigger = new FakeHTMLElement();
    let isOpen = false;
    let pointerType: "touch" | null = null;

    trigger.addEventListener("pointerdown", () => {
      pointerType = "touch";
    });
    trigger.addEventListener("mousedown", () => {
      isOpen = true;
    });
    trigger.addEventListener("click", () => {
      if (pointerType) {
        pointerType = null;
        return;
      }

      isOpen = true;
    });

    trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    setNow(100);
    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 386, clientY: 20, identifier: 1 }],
        target: trigger,
        touches: [{ clientX: 386, clientY: 20, identifier: 1 }],
      }),
    );

    setNow(180);
    listeners.get("touchend")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 385, clientY: 21, identifier: 1 }],
        target: trigger,
        touches: [],
      }),
    );

    expect(isOpen).toBe(true);
    expect(pointerType).toBeNull();
  });

  it("does not synthesize mouse events after a 40px move", () => {
    const { listeners, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const button = new FakeHTMLElement();
    const mouseEvents = captureMouseEvents(button);

    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      }),
    );
    listeners.get("touchmove")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 44, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 44, clientY: 20, identifier: 1 }],
      }),
    );
    listeners.get("touchend")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 44, clientY: 20, identifier: 1 }],
        target: button,
        touches: [],
      }),
    );

    expect(mouseEvents).toEqual([]);
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it("does not synthesize mouse events after an 800ms hold", () => {
    const { listeners, setNow, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const button = new FakeHTMLElement();
    const mouseEvents = captureMouseEvents(button);

    setNow(0);
    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      }),
    );
    setNow(800);
    listeners.get("touchend")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [],
      }),
    );

    expect(mouseEvents).toEqual([]);
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it("does not synthesize mouse events when touchend was consumed", () => {
    const { listeners, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const button = new FakeHTMLElement();
    const mouseEvents = captureMouseEvents(button);

    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      }),
    );
    const touchEnd = createTouchEventLike({
      changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      defaultPrevented: true,
      target: button,
      touches: [],
    });
    listeners.get("touchend")?.(touchEnd);

    expect(touchEnd.preventDefault).not.toHaveBeenCalled();
    expect(mouseEvents).toEqual([]);
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it("does not synthesize mouse events for a disconnected target", () => {
    const { listeners, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const button = new FakeHTMLElement();
    const mouseEvents = captureMouseEvents(button);

    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      }),
    );
    button.remove();
    listeners.get("touchend")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [],
      }),
    );

    expect(mouseEvents).toEqual([]);
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it("clears a pending synthetic tap when a second touch starts", () => {
    const { listeners, targetWindow } = createIosStandaloneWindow();
    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    const button = new FakeHTMLElement();
    const mouseEvents = captureMouseEvents(button);

    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [{ clientX: 4, clientY: 20, identifier: 1 }],
      }),
    );
    listeners.get("touchstart")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 12, clientY: 20, identifier: 2 }],
        target: button,
        touches: [
          { clientX: 4, clientY: 20, identifier: 1 },
          { clientX: 12, clientY: 20, identifier: 2 },
        ],
      }),
    );
    listeners.get("touchend")?.(
      createTouchEventLike({
        changedTouches: [{ clientX: 4, clientY: 20, identifier: 1 }],
        target: button,
        touches: [],
      }),
    );

    expect(mouseEvents).toEqual([]);
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });
});
