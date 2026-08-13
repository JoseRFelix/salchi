import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { dismissThreadError, isThreadErrorDismissed, ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1024, 768);
  });

  it("fills the chat column instead of collapsing around its text on mobile", async () => {
    await page.viewport(390, 700);
    const screen = await render(
      <div className="flex min-w-0 flex-col overflow-x-hidden bg-background">
        <ThreadErrorBanner
          error="Server model is unavailable. Try again in a moment."
          onDismiss={() => undefined}
        />
      </div>,
    );

    try {
      const alert = page.getByRole("alert").element();
      const bounds = alert.getBoundingClientRect();
      const description = alert.querySelector<HTMLElement>('[data-slot="alert-description"]');

      expect(bounds.width).toBeGreaterThanOrEqual(360);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      expect(description).not.toBeNull();
      expect(description?.getBoundingClientRect().width).toBeGreaterThanOrEqual(250);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps dismissal scoped to the exact thread error", () => {
    const threadKey = "environment-a:thread-dismissal-test";
    dismissThreadError(threadKey, "Provider disconnected");

    expect(isThreadErrorDismissed(threadKey, "Provider disconnected")).toBe(true);
    expect(isThreadErrorDismissed(threadKey, "Authentication expired")).toBe(false);
    expect(isThreadErrorDismissed(`${threadKey}-other`, "Provider disconnected")).toBe(false);
  });

  it("bounds retained dismissals for long-lived clients", () => {
    for (let index = 0; index <= 512; index += 1) {
      dismissThreadError(`environment-b:thread-${index}`, `Error ${index}`);
    }

    expect(isThreadErrorDismissed("environment-b:thread-0", "Error 0")).toBe(false);
    expect(isThreadErrorDismissed("environment-b:thread-512", "Error 512")).toBe(true);
  });
});
