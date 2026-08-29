import "../index.css";

import {
  EnvironmentId,
  ThreadId,
  type BrowserInstallProgress,
  type BrowserInstallState,
} from "@salchi/contracts";
import { page } from "vitest/browser";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  initialBrowserViewportState,
  reduceBrowserViewportState,
} from "../browser/browserViewportState";
import { BrowserInstallPictureInPicture } from "./BrowserInstallPictureInPicture";

const { readEnvironmentConnectionMock } = vi.hoisted(() => ({
  readEnvironmentConnectionMock: vi.fn(),
}));

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: readEnvironmentConnectionMock,
}));

const environmentId = EnvironmentId.make("browser-install-prompt-environment");
const threadId = ThreadId.make("browser-install-prompt-thread");

function InstallPrompt(props: { readonly onClose: () => void }) {
  const [state, dispatch] = useReducer(
    reduceBrowserViewportState,
    reduceBrowserViewportState(initialBrowserViewportState(threadId), {
      type: "snapshot",
      snapshot: {
        threadId,
        status: "stopped",
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
        installState: { status: "not-installed", variant: "headless-shell" },
        error: "No usable Chromium installation was found. Attempts: channel:chromium",
      },
    }),
  );
  return (
    <BrowserInstallPictureInPicture
      environmentId={environmentId}
      onClose={props.onClose}
      onOpenPanel={vi.fn()}
      onStateAction={dispatch}
      state={state}
      threadId={threadId}
    />
  );
}

describe("BrowserInstallPictureInPicture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("installs directly from an agent-triggered offer and starts the managed browser", async () => {
    let finishInstall: (() => void) | undefined;
    const installGate = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const browser = {
      install: vi.fn(
        async (
          _input: { readonly threadId: ThreadId; readonly variant: "headless-shell" | "chrome" },
          onProgress: (progress: BrowserInstallProgress) => void,
        ) => {
          onProgress({
            phase: "downloading",
            percent: 50,
            downloadedBytes: 50,
            totalBytes: 100,
          });
          await installGate;
        },
      ),
      getInstallState: vi.fn(async (): Promise<BrowserInstallState> => ({
        status: "installed",
        variant: "headless-shell",
        executablePath: "/salchi/browsers/chromium-headless-shell",
      })),
      start: vi.fn(async () => ({
        threadId,
        status: "running" as const,
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
        installState: { status: "installed" as const, variant: "headless-shell" as const },
      })),
      cancelInstall: vi.fn(),
    };
    readEnvironmentConnectionMock.mockReturnValue({
      client: { browser, server: { updateSettings: vi.fn() } },
    });
    const screen = await render(<InstallPrompt onClose={vi.fn()} />);

    try {
      await expect
        .element(
          page.getByText(
            "No browser found on the server. Choose a managed browser for Salchi to install.",
          ),
        )
        .toBeVisible();
      await page.getByRole("button", { name: "Install Chromium" }).click();
      await expect.element(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
      finishInstall?.();
      await vi.waitFor(() => expect(browser.start).toHaveBeenCalledWith({ threadId }));
      await vi.waitFor(() =>
        expect(
          document.querySelector("[data-testid=browser-install-picture-in-picture]"),
        ).toBeNull(),
      );
    } finally {
      await screen.unmount();
    }
  });
});
