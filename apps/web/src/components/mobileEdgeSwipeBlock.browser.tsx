import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  isBlockedTarget,
  MOBILE_EDGE_SWIPE_ALLOW_EDITABLE_ATTRIBUTE,
  MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE,
  MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE,
  type MobileEdgeSwipeHorizontalScrollOwnerScope,
  useMobileEdgeSwipe,
} from "../hooks/useMobileEdgeSwipe";
import {
  WORKSPACE_FILE_INLINE_DIFF_ATTRIBUTE,
  WORKSPACE_FILE_INLINE_DIFF_SELECTOR,
} from "../workspaceFilePreviewDom";

// isBlockedTarget reads live layout (scrollWidth/clientWidth), so it needs a real
// browser, not the node unit environment.
const mounted: HTMLElement[] = [];

function mount(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.remove();
  }
  document.body.innerHTML = "";
});

function RightPanelSwipeHarness(props: {
  horizontalScrollOwnerScope?: MobileEdgeSwipeHorizontalScrollOwnerScope;
  onSwipe: () => void;
}) {
  useMobileEdgeSwipe({
    action: "close",
    enabled: true,
    ...(props.horizontalScrollOwnerScope !== undefined
      ? { horizontalScrollOwnerScope: props.horizontalScrollOwnerScope }
      : {}),
    onSwipe: props.onSwipe,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  return (
    <div data-testid="right-swipe-panel" {...{ [MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE]: "right" }} />
  );
}

function LeftOpenSwipeHarness(props: { onSwipe: () => void }) {
  useMobileEdgeSwipe({
    enabled: true,
    onSwipe: props.onSwipe,
    side: "left",
    startArea: "edge",
    startSurface: "outside-panels",
  });

  return <div data-testid="left-swipe-target" />;
}

function appendPierreShadowScrollFixture(input: {
  readonly allowEditablePanelSwipe?: boolean;
  readonly editable?: boolean;
  readonly inlineFileDiff?: boolean;
  readonly scrollLeft: number;
}): {
  readonly code: HTMLElement;
  readonly line: HTMLElement;
} {
  const panel = document.querySelector<HTMLElement>('[data-testid="right-swipe-panel"]');
  if (!panel) {
    throw new Error("Expected right swipe panel to be mounted.");
  }

  const host = document.createElement("diffs-container");
  const shadowRoot = host.attachShadow({ mode: "open" });
  const code = document.createElement("div");
  code.setAttribute("data-code", "");
  if (input.editable) {
    code.setAttribute("contenteditable", "true");
  }
  code.style.display = "block";
  code.style.overflow = "scroll clip";
  code.style.whiteSpace = "nowrap";
  code.style.width = "120px";

  const line = document.createElement("div");
  line.style.display = "inline-block";
  line.style.width = "600px";
  line.textContent = "const x = aVeryLongLineThatOverflowsHorizontally();";
  code.appendChild(line);
  shadowRoot.appendChild(code);

  let fixtureRoot: HTMLElement = host;
  if (input.inlineFileDiff) {
    const inlineFileDiff = document.createElement("div");
    inlineFileDiff.setAttribute(WORKSPACE_FILE_INLINE_DIFF_ATTRIBUTE, "true");
    inlineFileDiff.setAttribute("data-testid", "workspace-file-inline-diff");
    inlineFileDiff.appendChild(host);
    fixtureRoot = inlineFileDiff;
  }

  if (input.allowEditablePanelSwipe) {
    const editableSwipeSurface = document.createElement("div");
    editableSwipeSurface.setAttribute(MOBILE_EDGE_SWIPE_ALLOW_EDITABLE_ATTRIBUTE, "true");
    editableSwipeSurface.appendChild(fixtureRoot);
    fixtureRoot = editableSwipeSurface;
  }

  panel.appendChild(fixtureRoot);
  code.scrollLeft = input.scrollLeft;

  return { code, line };
}

function appendVerticalScrollFixture(input: { readonly scrollTop: number }): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[data-testid="right-swipe-panel"]');
  if (!panel) {
    throw new Error("Expected right swipe panel to be mounted.");
  }

  const scroller = document.createElement("div");
  scroller.style.height = "80px";
  scroller.style.overflowY = "auto";
  scroller.style.width = "160px";
  const child = document.createElement("div");
  child.style.height = "360px";
  child.textContent = "Scrollable file explorer content";
  scroller.appendChild(child);
  panel.appendChild(scroller);
  scroller.scrollTop = input.scrollTop;

  return child;
}

function dispatchTouchPointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY = 40,
  options: {
    readonly isPrimary?: boolean;
    readonly pointerId?: number;
    readonly pointerType?: string;
  } = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    composed: true,
    isPrimary: options.isPrimary ?? true,
    pointerId: options.pointerId ?? 7,
    pointerType: options.pointerType ?? "touch",
  });
  target.dispatchEvent(event);
  return event;
}

function createTouch(target: EventTarget, identifier: number, clientX: number, clientY: number) {
  return new Touch({ clientX, clientY, identifier, target });
}

function dispatchTouchEvent(
  target: EventTarget,
  type: "touchend" | "touchmove" | "touchstart",
  touches: Touch[],
  changedTouches: Touch[],
): TouchEvent {
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    changedTouches,
    touches,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useMobileEdgeSwipe gesture recognition", () => {
  it("prevents post-lock touchmoves and fires a slow deliberate open drag", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<LeftOpenSwipeHarness onSwipe={onSwipe} />);
    const nowSpy = vi.spyOn(performance, "now");

    try {
      const target = document.querySelector<HTMLElement>('[data-testid="left-swipe-target"]');
      expect(target).not.toBeNull();

      nowSpy.mockReturnValue(0);
      const startTouch = createTouch(target!, 1, 4, 40);
      dispatchTouchEvent(target!, "touchstart", [startTouch], [startTouch]);

      nowSpy.mockReturnValue(20);
      const lockTouch = createTouch(target!, 1, 20, 42);
      const lockMove = dispatchTouchEvent(target!, "touchmove", [lockTouch], [lockTouch]);
      expect(lockMove.defaultPrevented).toBe(true);
      expect(onSwipe).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(500);
      const triggerTouch = createTouch(target!, 1, 60, 45);
      const triggerMove = dispatchTouchEvent(target!, "touchmove", [triggerTouch], [triggerTouch]);
      expect(triggerMove.defaultPrevented).toBe(true);
      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      await screen.unmount();
    }
  });

  it("fires after a horizontally locked arced pointer swipe", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<RightPanelSwipeHarness onSwipe={onSwipe} />);

    try {
      const target = appendVerticalScrollFixture({ scrollTop: 40 });

      dispatchTouchPointer(target, "pointerdown", 200, 40);
      dispatchTouchPointer(target, "pointermove", 215, 52);
      dispatchTouchPointer(target, "pointermove", 260, 90);

      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("ignores non-touch pointerup events while a touch pointer swipe is active", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<RightPanelSwipeHarness onSwipe={onSwipe} />);
    const nowSpy = vi.spyOn(performance, "now");

    try {
      const target = appendVerticalScrollFixture({ scrollTop: 40 });

      nowSpy.mockReturnValue(0);
      dispatchTouchPointer(target, "pointerdown", 200, 40);

      nowSpy.mockReturnValue(20);
      dispatchTouchPointer(target, "pointermove", 215, 40);

      nowSpy.mockReturnValue(30);
      const mouseUp = dispatchTouchPointer(target, "pointerup", 228, 40, {
        pointerType: "mouse",
      });
      expect(mouseUp.defaultPrevented).toBe(false);
      expect(onSwipe).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(35);
      const secondaryTouchUp = dispatchTouchPointer(target, "pointerup", 228, 40, {
        isPrimary: false,
      });
      expect(secondaryTouchUp.defaultPrevented).toBe(false);
      expect(onSwipe).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(40);
      const primaryTouchUp = dispatchTouchPointer(target, "pointerup", 228, 40);
      expect(primaryTouchUp.defaultPrevented).toBe(true);
      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      await screen.unmount();
    }
  });

  it("fires a touch flick once when released before the sustained distance", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<LeftOpenSwipeHarness onSwipe={onSwipe} />);
    const nowSpy = vi.spyOn(performance, "now");

    try {
      const target = document.querySelector<HTMLElement>('[data-testid="left-swipe-target"]');
      expect(target).not.toBeNull();

      nowSpy.mockReturnValue(0);
      const startTouch = createTouch(target!, 1, 4, 40);
      dispatchTouchEvent(target!, "touchstart", [startTouch], [startTouch]);

      nowSpy.mockReturnValue(20);
      const moveTouch = createTouch(target!, 1, 20, 40);
      dispatchTouchEvent(target!, "touchmove", [moveTouch], [moveTouch]);
      expect(onSwipe).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(30);
      const endTouch = createTouch(target!, 1, 28, 40);
      const touchEnd = dispatchTouchEvent(target!, "touchend", [], [endTouch]);

      expect(touchEnd.defaultPrevented).toBe(true);
      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      await screen.unmount();
    }
  });
});

describe("isBlockedTarget", () => {
  it("does not block a swipe over a snippet that fits without scrolling", () => {
    const code = document.createElement("code");
    code.setAttribute(MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE, "true");
    code.textContent = "x";
    mount(code);

    expect(isBlockedTarget(code)).toBe(false);
  });

  it("blocks a swipe over a code block that overflows horizontally", () => {
    const pre = document.createElement("pre");
    pre.setAttribute(MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE, "true");
    pre.style.width = "80px";
    pre.style.overflowX = "auto";
    pre.style.whiteSpace = "pre";
    const inner = document.createElement("code");
    inner.setAttribute(MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE, "true");
    inner.textContent = "const veryLongIdentifierThatDoesNotFitInsideTheNarrowPreElement = 1;";
    pre.appendChild(inner);
    mount(pre);

    // A touch lands on the inner <code>; the scrollable ancestor still blocks.
    expect(isBlockedTarget(inner)).toBe(true);
  });

  it("always blocks inputs and terminals regardless of scroll size", () => {
    const input = mount(document.createElement("input"));
    expect(isBlockedTarget(input)).toBe(true);

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const child = document.createElement("span");
    xterm.appendChild(child);
    mount(xterm);
    expect(isBlockedTarget(child)).toBe(true);
  });

  it("blocks contenteditable regions unless an ancestor opts into panel swipes", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editable.appendChild(child);
    mount(editable);
    expect(isBlockedTarget(child)).toBe(true);

    const editableSwipeSurface = document.createElement("div");
    editableSwipeSurface.setAttribute(MOBILE_EDGE_SWIPE_ALLOW_EDITABLE_ATTRIBUTE, "true");
    const allowedEditable = document.createElement("div");
    allowedEditable.setAttribute("contenteditable", "true");
    const allowedChild = document.createElement("span");
    allowedEditable.appendChild(allowedChild);
    editableSwipeSurface.appendChild(allowedEditable);
    mount(editableSwipeSurface);
    expect(isBlockedTarget(allowedChild)).toBe(false);
  });

  it("passes through plain content", () => {
    const div = mount(document.createElement("div"));
    expect(isBlockedTarget(div)).toBe(false);
    expect(isBlockedTarget(null)).toBe(false);
  });
});

describe("isBlockedTarget over horizontally scrollable content", () => {
  it("blocks a swipe inside an overflowing overflow-x ancestor", () => {
    const surface = document.createElement("div");
    surface.style.width = "100px";
    surface.style.overflowX = "auto";
    surface.style.whiteSpace = "nowrap";
    const child = document.createElement("span");
    child.style.display = "inline-block";
    child.style.width = "400px";
    surface.appendChild(child);
    mount(surface);

    expect(isBlockedTarget(child)).toBe(true);
  });

  it("blocks a swipe inside a pierre-style diff line (overflow: scroll clip grid)", () => {
    // Mirrors @pierre/diffs [data-code]: a horizontally scrolling grid whose
    // lines overflow. A fast horizontal scroll here must not close the panel.
    const code = document.createElement("div");
    code.style.display = "grid";
    code.style.overflow = "scroll clip";
    code.style.width = "120px";
    const line = document.createElement("div");
    line.style.whiteSpace = "pre";
    line.style.width = "600px";
    line.textContent = "const x = aVeryLongLineThatOverflowsHorizontally();";
    code.appendChild(line);
    mount(code);

    expect(isBlockedTarget(line)).toBe(true);
  });

  it("does not block content that fits or cannot scroll horizontally", () => {
    // overflow-x:auto but content fits -> nothing to scroll.
    const fits = document.createElement("div");
    fits.style.width = "400px";
    fits.style.overflowX = "auto";
    const fitsChild = document.createElement("span");
    fits.appendChild(fitsChild);
    mount(fits);
    expect(isBlockedTarget(fitsChild)).toBe(false);

    // Overflowing content but overflow-x:visible -> the browser does not scroll it.
    const visible = document.createElement("div");
    visible.style.width = "100px";
    visible.style.overflowX = "visible";
    visible.style.whiteSpace = "nowrap";
    const visibleChild = document.createElement("span");
    visibleChild.style.display = "inline-block";
    visibleChild.style.width = "400px";
    visible.appendChild(visibleChild);
    mount(visible);
    expect(isBlockedTarget(visibleChild)).toBe(false);
  });
});

describe("useMobileEdgeSwipe over Pierre shadow scroll content", () => {
  it("closes the right panel when the gesture starts in vertically scrolled content", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness
        horizontalScrollOwnerScope={{ ancestorSelector: WORKSPACE_FILE_INLINE_DIFF_SELECTOR }}
        onSwipe={onSwipe}
      />,
    );

    try {
      const target = appendVerticalScrollFixture({ scrollTop: 40 });

      dispatchTouchPointer(target, "pointerdown", 200);
      dispatchTouchPointer(target, "pointermove", 264);

      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("closes the right panel over generic Pierre scroll content when scoped to inline file diffs", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness
        horizontalScrollOwnerScope={{ ancestorSelector: WORKSPACE_FILE_INLINE_DIFF_SELECTOR }}
        onSwipe={onSwipe}
      />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({ scrollLeft: 100 });
      expect(code.scrollLeft).toBeGreaterThan(1);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not close the right panel over opted-in editable Pierre scroll content when it can still scroll left", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness horizontalScrollOwnerScope="all" onSwipe={onSwipe} />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({
        allowEditablePanelSwipe: true,
        editable: true,
        scrollLeft: 100,
      });
      expect(code.scrollLeft).toBeGreaterThan(1);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("closes the right panel over opted-in editable Pierre scroll content at the left edge", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness horizontalScrollOwnerScope="all" onSwipe={onSwipe} />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({
        allowEditablePanelSwipe: true,
        editable: true,
        scrollLeft: 0,
      });
      expect(code.scrollLeft).toBe(0);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not close the right panel over generic Pierre scroll content when all horizontal scrollers are guarded", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness horizontalScrollOwnerScope="all" onSwipe={onSwipe} />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({ scrollLeft: 100 });
      expect(code.scrollLeft).toBeGreaterThan(1);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("closes the right panel over generic Pierre scroll content guarded by all when it starts at the left edge", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness horizontalScrollOwnerScope="all" onSwipe={onSwipe} />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({ scrollLeft: 0 });
      expect(code.scrollLeft).toBe(0);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not close the right panel when the inline file diff scroll owner can still scroll left", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness
        horizontalScrollOwnerScope={{ ancestorSelector: WORKSPACE_FILE_INLINE_DIFF_SELECTOR }}
        onSwipe={onSwipe}
      />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({
        inlineFileDiff: true,
        scrollLeft: 100,
      });
      expect(code.scrollLeft).toBeGreaterThan(1);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("closes the right panel when the inline file diff scroll owner started at the left edge", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness
        horizontalScrollOwnerScope={{ ancestorSelector: WORKSPACE_FILE_INLINE_DIFF_SELECTOR }}
        onSwipe={onSwipe}
      />,
    );

    try {
      const { code, line } = appendPierreShadowScrollFixture({
        inlineFileDiff: true,
        scrollLeft: 0,
      });
      expect(code.scrollLeft).toBe(0);

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 264);

      expect(onSwipe).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not close the right panel on leftward movement inside Pierre scroll content", async () => {
    const onSwipe = vi.fn();
    const screen = await render(
      <RightPanelSwipeHarness
        horizontalScrollOwnerScope={{ ancestorSelector: WORKSPACE_FILE_INLINE_DIFF_SELECTOR }}
        onSwipe={onSwipe}
      />,
    );

    try {
      const { line } = appendPierreShadowScrollFixture({
        inlineFileDiff: true,
        scrollLeft: 0,
      });

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 136);

      expect(onSwipe).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
