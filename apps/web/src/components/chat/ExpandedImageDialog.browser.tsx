import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import previewScreenshotUrl from "../../../../../assets/screenshots/salchi-web-app.png";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

describe("ExpandedImageDialog", () => {
  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1024, 768);
  });

  it("places the image actions above the expanded image and captures its preview", async () => {
    await page.viewport(1280, 900);
    const screen = await render(
      <ExpandedImageDialog
        preview={{
          images: [{ src: previewScreenshotUrl, name: "salchi-web-app.png" }],
          index: 0,
        }}
        onClose={vi.fn()}
      />,
    );

    try {
      const dialog = page.getByRole("dialog", { name: "Expanded image preview" });
      const image = page.getByRole("img", { name: "salchi-web-app.png" });
      const downloadButton = page.getByRole("link", { name: "Download salchi-web-app.png" });
      const closeButtons = page.getByRole("button", { name: "Close image preview" });

      await expect.element(dialog).toBeVisible();
      await expect.element(image).toBeVisible();
      await expect.element(downloadButton).toBeVisible();
      await expect.element(closeButtons.nth(1)).toBeVisible();

      const actions = document.querySelector<HTMLElement>("[data-slot='expanded-image-actions']");
      const imageElement = document.querySelector<HTMLImageElement>(
        "img[alt='salchi-web-app.png']",
      );
      expect(actions).not.toBeNull();
      expect(imageElement).not.toBeNull();
      expect(actions!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        imageElement!.getBoundingClientRect().top,
      );
      expect(actions!.contains(imageElement)).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the image actions inside the viewport safe area", async () => {
    await page.viewport(390, 844);
    const screen = await render(
      <ExpandedImageDialog
        preview={{
          images: [{ src: previewScreenshotUrl, name: "salchi-web-app.png" }],
          index: 0,
        }}
        onClose={vi.fn()}
      />,
    );

    try {
      const dialog = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Expanded image preview"]',
      );
      const actions = document.querySelector<HTMLElement>("[data-slot='expanded-image-actions']");

      expect(dialog).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(dialog!.classList.contains("pt-[calc(env(safe-area-inset-top)+1.5rem)]")).toBe(true);

      const dialogRect = dialog!.getBoundingClientRect();
      const actionsRect = actions!.getBoundingClientRect();
      const paddingTop = Number.parseFloat(getComputedStyle(dialog!).paddingTop);
      expect(actionsRect.top).toBeGreaterThanOrEqual(dialogRect.top + paddingTop);
    } finally {
      await screen.unmount();
    }
  });
});
