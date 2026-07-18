import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

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
});
