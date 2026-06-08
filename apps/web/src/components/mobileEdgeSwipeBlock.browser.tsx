import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  isBlockedTarget,
  MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE,
  MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE,
  useMobileEdgeSwipe,
} from "../hooks/useMobileEdgeSwipe";

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

function RightPanelSwipeHarness(props: { onSwipe: () => void }) {
  useMobileEdgeSwipe({
    action: "close",
    enabled: true,
    onSwipe: props.onSwipe,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  return (
    <div data-testid="right-swipe-panel" {...{ [MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE]: "right" }} />
  );
}

function appendPierreShadowScrollFixture(input: { readonly scrollLeft: number }): {
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
  panel.appendChild(host);
  code.scrollLeft = input.scrollLeft;

  return { code, line };
}

function dispatchTouchPointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove",
  clientX: number,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: 40,
      composed: true,
      isPrimary: true,
      pointerId: 7,
      pointerType: "touch",
    }),
  );
}

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
  it("does not close the right panel when the Pierre scroll owner can still scroll left", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<RightPanelSwipeHarness onSwipe={onSwipe} />);

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

  it("closes the right panel when the Pierre scroll owner started at the left edge", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<RightPanelSwipeHarness onSwipe={onSwipe} />);

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

  it("does not close the right panel on leftward movement inside Pierre scroll content", async () => {
    const onSwipe = vi.fn();
    const screen = await render(<RightPanelSwipeHarness onSwipe={onSwipe} />);

    try {
      const { line } = appendPierreShadowScrollFixture({ scrollLeft: 0 });

      dispatchTouchPointer(line, "pointerdown", 200);
      dispatchTouchPointer(line, "pointermove", 136);

      expect(onSwipe).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
