import "../../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StableChatImage } from "./StableChatImage";

it("reserves a stable frame while chat images load and when they fail", async () => {
  const screen = await render(
    <div style={{ width: 320, marginTop: 10_000 }}>
      <StableChatImage src="/deferred-chat-image.png" alt="Generated screenshot" />
    </div>,
  );

  try {
    const frame = screen.container.querySelector<HTMLElement>("[data-chat-image-state]");
    const image = screen.container.querySelector<HTMLImageElement>("img");
    expect(frame).not.toBeNull();
    expect(image).not.toBeNull();
    expect(frame?.dataset.chatImageState).toBe("loading");
    expect(frame?.querySelector('[data-slot="chat-image-skeleton"]')).not.toBeNull();

    const loadingBounds = frame!.getBoundingClientRect();
    expect(loadingBounds.width).toBeCloseTo(320, 0);
    expect(loadingBounds.width / loadingBounds.height).toBeCloseTo(16 / 9, 1);

    image!.dispatchEvent(new Event("error"));

    await vi.waitFor(() => {
      expect(frame?.dataset.chatImageState).toBe("error");
    });
    expect(frame?.className).toContain("border-border/80");
    expect(frame?.className).toContain("bg-muted/30");
    expect(frame?.className).not.toContain("border-destructive");
    expect(frame?.className).not.toContain("bg-destructive");
    expect(frame?.querySelector('[data-slot="chat-image-error-icon"]')?.className).toContain(
      "text-muted-foreground",
    );
    expect(frame?.querySelector('[data-slot="chat-image-error-icon"]')?.className).not.toContain(
      "text-destructive",
    );
    expect(
      frame
        ?.querySelector('[data-slot="chat-image-error-icon"] svg')
        ?.classList.contains("lucide-triangle-alert"),
    ).toBe(true);
    expect(frame?.querySelector('[data-slot="chat-image-skeleton"]')).toBeNull();
    expect(frame?.querySelector('[data-slot="chat-image-error"]')?.textContent).toBe("");
    expect(frame?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Failed to load Generated screenshot",
    );

    const errorBounds = frame!.getBoundingClientRect();
    expect(errorBounds.width).toBeCloseTo(loadingBounds.width, 0);
    expect(errorBounds.height).toBeCloseTo(loadingBounds.height, 0);
  } finally {
    await screen.unmount();
  }
});

it("swaps the skeleton for the image without changing its frame", async () => {
  const screen = await render(
    <div style={{ width: 320, marginTop: 10_000 }}>
      <StableChatImage src="/successful-chat-image.png" alt="Generated screenshot" />
    </div>,
  );

  try {
    const frame = screen.container.querySelector<HTMLElement>("[data-chat-image-state]");
    const image = screen.container.querySelector<HTMLImageElement>("img");
    expect(frame).not.toBeNull();
    expect(image).not.toBeNull();
    const loadingBounds = frame!.getBoundingClientRect();

    image!.dispatchEvent(new Event("load"));

    await vi.waitFor(() => {
      expect(frame?.dataset.chatImageState).toBe("loaded");
    });
    expect(frame?.querySelector('[data-slot="chat-image-skeleton"]')).toBeNull();
    expect(image?.getAttribute("aria-hidden")).toBe("false");

    const loadedBounds = frame!.getBoundingClientRect();
    expect(loadedBounds.width).toBeCloseTo(loadingBounds.width, 0);
    expect(loadedBounds.height).toBeCloseTo(loadingBounds.height, 0);
  } finally {
    await screen.unmount();
  }
});
