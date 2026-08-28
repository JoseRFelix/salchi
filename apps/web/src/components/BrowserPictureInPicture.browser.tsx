import "../index.css";

import { EnvironmentId, ThreadId } from "@salchi/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserPictureInPicture } from "./BrowserPictureInPicture";

const { acquireBrowserStreamMock, disposeMock } = vi.hoisted(() => ({
  acquireBrowserStreamMock: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock("../browser/browserStreamPool", () => ({
  acquireBrowserStream: acquireBrowserStreamMock,
}));

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
    acquireBrowserStreamMock.mockReturnValue({ dispose: disposeMock, sendInput: vi.fn() });
    const onOpenPanel = vi.fn();
    const screen = await render(
      <BrowserPictureInPicture
        environmentId={EnvironmentId.make("environment-pip")}
        onClose={vi.fn()}
        onOpenPanel={onOpenPanel}
        phase="visible"
        threadId={ThreadId.make("thread-pip")}
      />,
    );

    expect(acquireBrowserStreamMock).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Open Browser panel" }).click();
    expect(onOpenPanel).toHaveBeenCalledOnce();

    await screen.unmount();
    expect(disposeMock).toHaveBeenCalledOnce();
  });
});
