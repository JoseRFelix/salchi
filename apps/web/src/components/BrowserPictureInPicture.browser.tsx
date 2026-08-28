import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserPictureInPicture } from "./BrowserPictureInPicture";

const { attachMock, detachMock } = vi.hoisted(() => ({
  attachMock: vi.fn(),
  detachMock: vi.fn(),
}));

const streamLease = {
  attach: attachMock,
  dispose: vi.fn(),
  sendInput: vi.fn(),
  setSurface: vi.fn(),
  snapshot: vi.fn(() => ({ connected: true, surface: "pip" as const })),
};

vi.mock("../browser/latestFrameRenderer", () => ({
  createBrowserBinaryFrameRenderer: () => ({
    dispose: vi.fn(),
    push: vi.fn(),
    redraw: vi.fn(),
  }),
}));

describe("BrowserPictureInPicture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("acquires frames while mounted, opens the panel from its body, and releases on unmount", async () => {
    attachMock.mockReturnValue(detachMock);
    const onOpenPanel = vi.fn();
    const screen = await render(
      <BrowserPictureInPicture
        onClose={vi.fn()}
        onOpenPanel={onOpenPanel}
        phase="visible"
        resetKey="thread-test"
        streamLease={streamLease}
      />,
    );

    expect(attachMock).toHaveBeenCalledOnce();
    expect(attachMock).toHaveBeenCalledWith(
      "pip",
      expect.objectContaining({ onFrame: expect.any(Function) }),
    );
    await page.getByRole("button", { name: "Open Browser panel" }).click();
    expect(onOpenPanel).toHaveBeenCalledOnce();

    await screen.unmount();
    expect(detachMock).toHaveBeenCalledOnce();
  });
});
