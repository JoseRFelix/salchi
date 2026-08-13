import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ToastProvider, toastManager } from "./toast";

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string | undefined>) => unknown }) =>
    options?.select ? options.select({}) : {},
}));

function TrackpadToastHarness({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <ToastProvider>
      <button
        onClick={() => {
          toastManager.add({
            type: "success",
            title: "Trackpad toast",
            description: "Swipe me",
            timeout: 0,
            data: { onClose },
          });
        }}
        type="button"
      >
        Show toast
      </button>
    </ToastProvider>
  );
}

function dispatchWheel(root: HTMLElement, deltaX: number, deltaY = 0): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    deltaX,
    deltaY,
  });
  root.dispatchEvent(event);
  return event;
}

async function renderToast(onClose?: () => void) {
  const screen = await render(
    <TrackpadToastHarness {...(onClose === undefined ? {} : { onClose })} />,
  );
  await page.getByRole("button", { name: "Show toast" }).click();
  await expect.element(page.getByText("Trackpad toast")).toBeVisible();

  const root = document.querySelector<HTMLElement>('[data-slot="toast-root"]');
  if (!root) {
    throw new Error("Expected toast root to be mounted.");
  }
  return { root, screen };
}

function getTranslateX(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (transform === "none") return 0;
  return new DOMMatrixReadOnly(transform).m41;
}

describe("toast trackpad swipe", () => {
  afterEach(async () => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("follows a horizontal trackpad gesture and springs back below the threshold", async () => {
    const { root, screen } = await renderToast();

    try {
      const event = dispatchWheel(root, -32, 2);

      expect(event.defaultPrevented).toBe(true);
      expect(root).toHaveAttribute("data-trackpad-swiping");
      expect(root.style.getPropertyValue("--toast-trackpad-swipe-x")).toBe("32px");
      expect(getTranslateX(root)).toBeCloseTo(32, 1);

      await vi.waitFor(() => {
        expect(root).not.toHaveAttribute("data-trackpad-swiping");
        expect(root.style.getPropertyValue("--toast-trackpad-swipe-x")).toBe("0px");
      });
      await expect.element(page.getByText("Trackpad toast")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("dismisses after following an outward gesture past the threshold", async () => {
    const onClose = vi.fn();
    const { root, screen } = await renderToast(onClose);

    try {
      dispatchWheel(root, -48, 1);
      const dismissEvent = dispatchWheel(root, -40, 1);

      expect(dismissEvent.defaultPrevented).toBe(true);
      expect(root.style.getPropertyValue("--toast-trackpad-swipe-x")).toBe("88px");
      expect(root).toHaveAttribute("data-swipe-direction", "right");
      expect(onClose).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="toast-root"]')).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("leaves vertical scrolling alone", async () => {
    const { root, screen } = await renderToast();

    try {
      const event = dispatchWheel(root, -8, 40);

      expect(event.defaultPrevented).toBe(false);
      expect(root).not.toHaveAttribute("data-trackpad-swiping");
      expect(root.style.getPropertyValue("--toast-trackpad-swipe-x")).toBe("");
      await expect.element(page.getByText("Trackpad toast")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("resists an inward gesture without dismissing", async () => {
    const { root, screen } = await renderToast();

    try {
      dispatchWheel(root, 100, 1);

      expect(root.style.getPropertyValue("--toast-trackpad-swipe-x")).toBe("-10px");
      expect(getTranslateX(root)).toBeCloseTo(-10, 1);
      await expect.element(page.getByText("Trackpad toast")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
