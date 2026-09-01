import "../index.css";

import {
  EnvironmentId,
  ThreadId,
  type BrowserInstallProgress,
  type BrowserInstallState,
  type BrowserSessionState,
} from "@salchi/contracts";
import { page } from "vitest/browser";
import { useLayoutEffect, useMemo, useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  initialBrowserViewportState,
  reduceBrowserViewportState,
} from "../browser/browserViewportState";
import { createBrowserSurfaceStreamLease } from "../browser/browserSurfaceStreamLease";
import { BrowserPanel } from "./BrowserPanel";
import { RightPanelSheet } from "./RightPanelSheet";

const {
  browserStreamConnections,
  createBrowserStreamConnectionMock,
  readEnvironmentConnectionMock,
  subscribeEnvironmentConnectionsMock,
} = vi.hoisted(() => {
  const browserStreamConnections: Array<{
    readonly dispose: ReturnType<typeof vi.fn>;
    readonly options: {
      readonly onConnectionState?: (state: "closed" | "connecting" | "open") => void;
      readonly onEvent: (event: unknown) => void;
      readonly onFrame: (frame: unknown) => void;
      readonly threadId: ThreadId;
    };
    readonly sendInput: ReturnType<typeof vi.fn>;
  }> = [];
  const createBrowserStreamConnectionMock = vi.fn((options) => {
    const connection = {
      dispose: vi.fn(),
      options,
      sendInput: vi.fn(() => true),
    };
    browserStreamConnections.push(connection);
    return connection;
  });
  return {
    browserStreamConnections,
    createBrowserStreamConnectionMock,
    readEnvironmentConnectionMock: vi.fn(),
    subscribeEnvironmentConnectionsMock: vi.fn(() => () => undefined),
  };
});

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: readEnvironmentConnectionMock,
  subscribeEnvironmentConnections: subscribeEnvironmentConnectionsMock,
}));

vi.mock("../browser/browserStreamConnection", () => ({
  createBrowserStreamConnection: createBrowserStreamConnectionMock,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-browser-panel");
const THREAD_A = ThreadId.make("thread-browser-a");
const THREAD_B = ThreadId.make("thread-browser-b");

function sessionState(threadId: ThreadId): BrowserSessionState {
  return {
    threadId,
    status: "stopped" as const,
    tabs: [],
    executable: null,
    viewport: { width: 800, height: 600 },
  };
}

function viewportState(threadId: ThreadId) {
  return reduceBrowserViewportState(initialBrowserViewportState(threadId), {
    type: "snapshot",
    snapshot: sessionState(threadId),
  });
}

function createBrowserClient() {
  const browser = {
    start: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    stop: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    getState: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    getInstallState: vi.fn(async (): Promise<BrowserInstallState> => ({
      status: "not-installed",
      variant: "headless-shell",
    })),
    install: vi.fn(
      async (
        _input: {
          readonly threadId: ThreadId;
          readonly variant: "headless-shell" | "chrome";
        },
        _onProgress: (progress: BrowserInstallProgress) => void,
      ): Promise<void> => undefined,
    ),
    cancelInstall: vi.fn(async (): Promise<BrowserInstallState> => ({
      status: "not-installed",
      variant: "headless-shell",
    })),
    setActiveTab: vi.fn(),
    openTab: vi.fn(),
    navigate: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    navigateHistory: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    closeTab: vi.fn(),
    setViewportSize: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
  };
  return { browser, server: { updateSettings: vi.fn(async () => undefined) } };
}

function StatefulPanel(props: {
  readonly initialState: ReturnType<typeof viewportState>;
  readonly threadId: ThreadId;
}) {
  const [state, dispatch] = useReducer(reduceBrowserViewportState, props.initialState);
  const streamLease = useMemo(
    () =>
      createBrowserSurfaceStreamLease({ environmentId: ENVIRONMENT_ID, threadId: props.threadId }),
    [props.threadId],
  );
  useLayoutEffect(() => () => streamLease.dispose(), [streamLease]);
  useLayoutEffect(() => {
    streamLease.setSurface("panel");
  }, [streamLease]);
  return (
    <BrowserPanel
      environmentId={ENVIRONMENT_ID}
      mode="sidebar"
      onClose={vi.fn()}
      onStateAction={dispatch}
      state={state}
      streamLease={streamLease}
      threadId={props.threadId}
      visible
    />
  );
}

function Panel(props: {
  readonly agentAccessNotice?: string;
  readonly onClose?: () => void;
  readonly state?: ReturnType<typeof viewportState>;
  readonly threadId: ThreadId;
  readonly visible: boolean;
}) {
  const state = props.state ?? viewportState(props.threadId);
  const streamLease = useMemo(
    () =>
      createBrowserSurfaceStreamLease({ environmentId: ENVIRONMENT_ID, threadId: props.threadId }),
    [props.threadId],
  );
  useLayoutEffect(() => () => streamLease.dispose(), [streamLease]);
  useLayoutEffect(() => {
    streamLease.setSurface(props.visible && state.authorization !== "denied" ? "panel" : null);
  }, [props.visible, state.authorization, streamLease]);
  return (
    <BrowserPanel
      {...(props.agentAccessNotice === undefined
        ? {}
        : { agentAccessNotice: props.agentAccessNotice })}
      environmentId={ENVIRONMENT_ID}
      mode="sidebar"
      onClose={props.onClose ?? vi.fn()}
      onStateAction={vi.fn()}
      state={state}
      streamLease={streamLease}
      threadId={props.threadId}
      visible={props.visible}
    />
  );
}

describe("BrowserPanel subscription visibility", () => {
  beforeEach(() => {
    readEnvironmentConnectionMock.mockReset();
    subscribeEnvironmentConnectionsMock.mockClear();
    createBrowserStreamConnectionMock.mockClear();
    browserStreamConnections.length = 0;
  });

  it("uses an address bar to navigate the active tab and opens a blank new tab", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [
          {
            targetId: "target-1",
            title: "",
            url: "about:blank",
            active: true,
          },
        ],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible />);

    try {
      await expect.element(page.getByText("New tab")).toBeVisible();
      await expect.element(page.getByText("Browse the web")).toBeVisible();
      const toolbar = document.querySelector('[data-browser-tabs-toolbar="true"]');
      const tabStrip = toolbar?.querySelector(".browser-tab-strip");
      const activeTab = toolbar?.querySelector('button[aria-pressed="true"]')?.parentElement;
      expect(toolbar?.parentElement?.firstElementChild).toBe(toolbar);
      expect(toolbar?.className).toContain("py-1");
      expect(activeTab?.className).toContain("rounded-md");
      expect(activeTab?.className).not.toContain("rounded-full");
      expect(tabStrip).not.toBeNull();
      expect(toolbar?.querySelector('[aria-label="Stop browser"]')).not.toBeNull();
      expect(toolbar?.querySelector('[aria-label="Close browser panel"]')).not.toBeNull();
      const address = page.getByLabelText("Browser address");
      await expect.element(address).toHaveValue("");
      await address.fill("example.com/docs");
      await page.getByRole("button", { name: "Navigate" }).click();
      await vi.waitFor(() =>
        expect(client.browser.navigate).toHaveBeenCalledWith({
          threadId: THREAD_A,
          targetId: "target-1",
          url: "https://example.com/docs",
        }),
      );

      await page.getByRole("button", { name: "Open new browser tab" }).click();
      await vi.waitFor(() =>
        expect(client.browser.openTab).toHaveBeenCalledWith({
          threadId: THREAD_A,
          url: "about:blank",
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("offers a managed install, streams progress, and starts Chromium on completion", async () => {
    let finishInstall: (() => void) | undefined;
    const installGate = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const client = createBrowserClient();
    client.browser.install.mockImplementation(async (_input, onProgress) => {
      onProgress({
        phase: "downloading",
        percent: 50,
        downloadedBytes: 50,
        totalBytes: 100,
      });
      await installGate;
    });
    client.browser.getInstallState.mockResolvedValue({
      status: "installed",
      variant: "headless-shell",
      executablePath: "/salchi/browsers/chromium",
      progress: {
        phase: "complete",
        percent: 100,
        downloadedBytes: 100,
        totalBytes: 100,
      },
    });
    client.browser.start.mockImplementation(async ({ threadId }) => ({
      ...sessionState(threadId),
      status: "running" as const,
      installState: { status: "installed" as const, variant: "headless-shell" as const },
    }));
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const initialState = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        ...sessionState(THREAD_A),
        installState: { status: "not-installed", variant: "headless-shell" },
        error: "No usable Chromium installation was found. Attempts: channel:chrome",
      },
    });
    const screen = await render(<StatefulPanel initialState={initialState} threadId={THREAD_A} />);

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
      await vi.waitFor(() =>
        expect(client.browser.start).toHaveBeenCalledWith({ threadId: THREAD_A }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("persists the Chrome choice and renders NeedsElevation as instructions", async () => {
    const client = createBrowserClient();
    client.browser.getInstallState.mockResolvedValue({
      status: "needs-elevation",
      variant: "chrome",
      reason: "Google Chrome is installed as a system package on Linux.",
      elevationCommand: "sudo -- '/usr/bin/node' '/opt/playwright/cli.js' install chrome",
    });
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const initialState = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        ...sessionState(THREAD_A),
        installState: { status: "not-installed", variant: "headless-shell" },
        error: "No usable Chromium installation was found. Attempts: channel:chrome",
      },
    });
    const screen = await render(<StatefulPanel initialState={initialState} threadId={THREAD_A} />);

    try {
      await page.getByRole("radio", { name: /Google Chrome/ }).click();
      await vi.waitFor(() =>
        expect(client.server.updateSettings).toHaveBeenCalledWith({
          browserManagedVariant: "chrome",
        }),
      );
      await expect
        .element(page.getByText("Google Chrome needs administrator installation"))
        .toBeVisible();
      await expect
        .element(page.getByText("sudo -- '/usr/bin/node' '/opt/playwright/cli.js' install chrome"))
        .toBeVisible();
      expect(client.browser.install).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Check again" }).click();
      await vi.waitFor(() =>
        expect(client.browser.cancelInstall).toHaveBeenCalledWith({ threadId: THREAD_A }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("starts an already-installed system Chrome without offering a redundant download", async () => {
    const client = createBrowserClient();
    client.browser.getInstallState.mockResolvedValue({
      status: "installed",
      variant: "chrome",
      executablePath: "/opt/google/chrome/chrome",
    });
    client.browser.start.mockImplementation(async ({ threadId }) => ({
      ...sessionState(threadId),
      status: "running" as const,
      installState: { status: "installed" as const, variant: "chrome" as const },
    }));
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const initialState = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        ...sessionState(THREAD_A),
        installState: { status: "not-installed", variant: "headless-shell" },
        error: "No usable Chromium installation was found. Attempts: channel:chrome",
      },
    });
    const screen = await render(<StatefulPanel initialState={initialState} threadId={THREAD_A} />);

    try {
      await page.getByRole("radio", { name: /Google Chrome/ }).click();
      await expect.element(page.getByText("Google Chrome is already installed")).toBeVisible();
      expect(client.browser.install).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Start Google Chrome" }).click();
      await vi.waitFor(() =>
        expect(client.browser.start).toHaveBeenCalledWith({ threadId: THREAD_A }),
      );
      expect(client.browser.install).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a running empty state when no tabs are open", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible />);

    try {
      await expect.element(page.getByText("No open tabs")).toBeVisible();
      await expect.element(page.getByText("Open a new tab to start browsing.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open tab" })).toBeVisible();
      expect(document.querySelector('canvas[aria-label="Live browser viewport"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("places browser history controls before the address bar and dispatches their actions", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [
          {
            targetId: "target-1",
            title: "Example",
            url: "https://example.com/",
            active: true,
          },
        ],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible />);

    try {
      const address = document.querySelector<HTMLInputElement>('[aria-label="Browser address"]');
      expect(address).not.toBeNull();
      for (const label of ["Go back", "Go forward", "Reload"] as const) {
        const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
        expect(button).not.toBeNull();
        expect(
          button && address
            ? button.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING
            : 0,
        ).not.toBe(0);
        await page.getByRole("button", { name: label }).click();
      }

      await vi.waitFor(() =>
        expect(client.browser.navigateHistory.mock.calls.map(([input]) => input)).toEqual([
          { threadId: THREAD_A, targetId: "target-1", action: "back" },
          { threadId: THREAD_A, targetId: "target-1", action: "forward" },
          { threadId: THREAD_A, targetId: "target-1", action: "reload" },
        ]),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("opens one blank tab when a running zero-tab panel is reopened", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible={false} />);

    try {
      expect(client.browser.openTab).not.toHaveBeenCalled();

      await screen.rerender(<Panel state={state} threadId={THREAD_A} visible />);
      await vi.waitFor(() => expect(client.browser.openTab).toHaveBeenCalledOnce());
      expect(client.browser.openTab).toHaveBeenLastCalledWith({
        threadId: THREAD_A,
        url: "about:blank",
      });

      await screen.rerender(<Panel state={state} threadId={THREAD_A} visible />);
      expect(client.browser.openTab).toHaveBeenCalledOnce();

      await screen.rerender(<Panel state={state} threadId={THREAD_A} visible={false} />);
      await screen.rerender(<Panel state={state} threadId={THREAD_A} visible />);
      await vi.waitFor(() => expect(client.browser.openTab).toHaveBeenCalledTimes(2));
    } finally {
      await screen.unmount();
    }
  });

  it("closes the panel after successfully closing its last tab", async () => {
    const client = createBrowserClient();
    const onClose = vi.fn();
    client.browser.closeTab.mockResolvedValue({
      threadId: THREAD_A,
      status: "running",
      tabs: [],
      executable: null,
      viewport: { width: 800, height: 600 },
    });
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [
          {
            targetId: "target-1",
            title: "Example",
            url: "https://example.com/",
            active: true,
          },
        ],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(
      <Panel onClose={onClose} state={state} threadId={THREAD_A} visible />,
    );

    try {
      await page.getByRole("button", { name: "Close Example" }).click();
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(client.browser.closeTab).toHaveBeenCalledWith({
        threadId: THREAD_A,
        targetId: "target-1",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("dims a stale running viewport without covering it with a paused label", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [
          {
            targetId: "target-1",
            title: "Example",
            url: "https://example.com/",
            active: true,
          },
        ],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible />);

    try {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[aria-label="Live browser viewport"]',
      );
      expect(canvas).not.toBeNull();
      await vi.waitFor(() => expect(browserStreamConnections).toHaveLength(1));
      browserStreamConnections[0]?.options.onFrame({
        targetId: "target-1",
        jpegBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 800,
        height: 600,
        seq: 1,
        receivedAt: performance.now(),
      });
      await vi.waitFor(() => expect(document.body.textContent).not.toContain("Paused"));
      expect(canvas?.classList.contains("opacity-55")).toBe(false);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      expect(document.body.textContent).not.toContain("Paused");

      await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
      await vi.waitFor(() => expect(canvas?.classList.contains("opacity-55")).toBe(true));
      expect(document.body.textContent).not.toContain("Paused");

      browserStreamConnections[0]?.options.onFrame({
        targetId: "target-1",
        jpegBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 800,
        height: 600,
        seq: 2,
        receivedAt: performance.now(),
      });
      await vi.waitFor(() => expect(canvas?.classList.contains("opacity-55")).toBe(false));

      browserStreamConnections[0]?.options.onConnectionState?.("closed");
      await vi.waitFor(() => expect(canvas?.classList.contains("opacity-55")).toBe(true));
      expect(document.body.textContent).not.toContain("Paused");
      expect(document.querySelector("[data-browser-live-state]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("enables interaction on the first viewport press and disables it when hidden", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_A,
        status: "running",
        tabs: [
          {
            targetId: "target-1",
            title: "Example",
            url: "https://example.com/",
            active: true,
          },
        ],
        executable: null,
        viewport: { width: 800, height: 600 },
      },
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible />);

    try {
      await vi.waitFor(() => expect(browserStreamConnections).toHaveLength(1));
      browserStreamConnections[0]?.options.onFrame({
        targetId: "target-1",
        jpegBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 800,
        height: 600,
        seq: 1,
        receivedAt: performance.now(),
      });

      expect(document.querySelector('button[aria-label="Interact"]')).toBeNull();
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[aria-label="Live browser viewport"]',
      );
      expect(canvas).not.toBeNull();
      const bounds = canvas?.getBoundingClientRect();
      expect(bounds?.width).toBeGreaterThan(0);
      expect(bounds?.height).toBeGreaterThan(0);
      if (canvas && bounds) {
        const pointer = {
          bubbles: true,
          button: 0,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        } satisfies PointerEventInit;
        canvas.dispatchEvent(new PointerEvent("pointerdown", pointer));
        canvas.dispatchEvent(new PointerEvent("pointerup", pointer));
      }
      const sendInput = browserStreamConnections[0]!.sendInput;
      await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(document.querySelector('[data-browser-interact="true"]')).not.toBeNull(),
      );
      expect(document.activeElement).toBe(canvas);
      canvas?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          bubbles: true,
          cancelable: true,
        }),
      );
      canvas?.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "a",
          code: "KeyA",
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(4));
      expect(sendInput.mock.calls.map(([_targetId, event]) => event._tag)).toEqual([
        "PointerDown",
        "PointerUp",
        "KeyDown",
        "KeyUp",
      ]);

      await screen.rerender(<Panel state={state} threadId={THREAD_A} visible={false} />);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-browser-interact="true"]')).toBeNull(),
      );
      expect(document.querySelector('button[aria-label="Interact"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1024, 768);
  });

  it("subscribes only while visible and replaces the subscription on thread change", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const screen = await render(<Panel threadId={THREAD_A} visible={false} />);

    try {
      expect(createBrowserStreamConnectionMock).not.toHaveBeenCalled();

      await screen.rerender(<Panel threadId={THREAD_A} visible />);
      await vi.waitFor(() => expect(createBrowserStreamConnectionMock).toHaveBeenCalledTimes(1));
      expect(browserStreamConnections[0]?.options.threadId).toBe(THREAD_A);

      await screen.rerender(<Panel threadId={THREAD_A} visible={false} />);
      await vi.waitFor(() => expect(browserStreamConnections[0]?.dispose).toHaveBeenCalledOnce());

      await screen.rerender(<Panel threadId={THREAD_A} visible />);
      await vi.waitFor(() => expect(createBrowserStreamConnectionMock).toHaveBeenCalledTimes(2));

      await screen.rerender(<Panel threadId={THREAD_B} visible />);
      await vi.waitFor(() => {
        expect(browserStreamConnections[1]?.dispose).toHaveBeenCalledOnce();
        expect(createBrowserStreamConnectionMock).toHaveBeenCalledTimes(3);
      });
      expect(browserStreamConnections[2]?.options.threadId).toBe(THREAD_B);
    } finally {
      await screen.unmount();
    }

    expect(browserStreamConnections[2]?.dispose).toHaveBeenCalledOnce();
  });

  it("reports only the visible full panel size and releases it on hide", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "snapshot",
      snapshot: {
        ...sessionState(THREAD_A),
        status: "running",
        tabs: [
          {
            targetId: "target-a",
            title: "Example",
            url: "https://example.com/",
            active: true,
          },
        ],
      },
    });
    const renderPanel = (visible: boolean) => (
      <div style={{ height: 760, width: 420 }}>
        <Panel state={state} threadId={THREAD_A} visible={visible} />
      </div>
    );
    const screen = await render(renderPanel(true));

    try {
      await vi.waitFor(() =>
        expect(client.browser.setViewportSize).toHaveBeenCalledWith(
          expect.objectContaining({ _tag: "Set", threadId: THREAD_A }),
        ),
      );
      await screen.rerender(renderPanel(false));
      await vi.waitFor(() =>
        expect(client.browser.setViewportSize).toHaveBeenCalledWith({
          _tag: "Release",
          threadId: THREAD_A,
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("unsubscribes as soon as a retained responsive sheet starts closing", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });

    const renderSheet = (open: boolean) => (
      <RightPanelSheet open={open} onClose={vi.fn()}>
        <Panel threadId={THREAD_A} visible={open} />
      </RightPanelSheet>
    );
    const screen = await render(renderSheet(true));

    try {
      await vi.waitFor(() => expect(createBrowserStreamConnectionMock).toHaveBeenCalledOnce());
      await screen.rerender(renderSheet(false));
      await vi.waitFor(() => expect(browserStreamConnections[0]?.dispose).toHaveBeenCalledOnce());

      expect(document.querySelector('[data-right-panel-sheet="true"]')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the owner-access state without starting an unauthorized viewport connection", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_A), {
      type: "authorizationDenied",
    });
    const screen = await render(<Panel state={state} threadId={THREAD_A} visible />);

    try {
      await expect.element(page.getByText("Owner access required")).toBeVisible();
      expect(createBrowserStreamConnectionMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("surfaces the remote OpenCode agent-access limitation", async () => {
    const screen = await render(
      <Panel
        agentAccessNotice="Agent browser control unavailable for remote OpenCode"
        threadId={THREAD_A}
        visible
      />,
    );

    try {
      await expect
        .element(page.getByText("Agent browser control unavailable for remote OpenCode"))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
