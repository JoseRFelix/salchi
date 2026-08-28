import "../index.css";

import { EnvironmentId, ThreadId } from "@salchi/contracts";
import { page } from "vitest/browser";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  initialBrowserViewportState,
  reduceBrowserViewportState,
} from "../browser/browserViewportState";
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

function sessionState(threadId: ThreadId) {
  return {
    threadId,
    status: "stopped" as const,
    tabs: [],
    executable: null,
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
    setActiveTab: vi.fn(),
    openTab: vi.fn(),
    navigate: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    navigateHistory: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    closeTab: vi.fn(),
  };
  return { browser };
}

function Panel(props: {
  readonly onClose?: () => void;
  readonly state?: ReturnType<typeof viewportState>;
  readonly threadId: ThreadId;
  readonly visible: boolean;
}) {
  return (
    <BrowserPanel
      environmentId={ENVIRONMENT_ID}
      mode="sidebar"
      onClose={props.onClose ?? vi.fn()}
      onStateAction={vi.fn()}
      state={props.state ?? viewportState(props.threadId)}
      threadId={props.threadId}
      visible={props.visible}
    />
  );
}

function StatefulPanel(props: { readonly threadId: ThreadId; readonly visible: boolean }) {
  const [state, dispatch] = useReducer(
    reduceBrowserViewportState,
    props.threadId,
    initialBrowserViewportState,
  );
  return (
    <BrowserPanel
      environmentId={ENVIRONMENT_ID}
      mode="sidebar"
      onClose={vi.fn()}
      onStateAction={dispatch}
      state={state}
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

  it("unsubscribes as soon as a retained responsive sheet starts closing", async () => {
    const client = createBrowserClient();
    readEnvironmentConnectionMock.mockReturnValue({ client });

    const renderSheet = (open: boolean) => (
      <RightPanelSheet open={open} onClose={vi.fn()}>
        <Panel threadId={THREAD_A} visible />
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

  it("shows the owner-access state without starting an unauthorized retry loop", async () => {
    const client = createBrowserClient();
    client.browser.getState.mockRejectedValue({
      _tag: "EnvironmentAuthorizationError",
      message: "The authenticated session requires the browser:operate scope.",
      requiredScope: "browser:operate",
    });
    readEnvironmentConnectionMock.mockReturnValue({ client });
    const screen = await render(<StatefulPanel threadId={THREAD_A} visible />);

    try {
      await expect.element(page.getByText("Owner access required")).toBeVisible();
      expect(client.browser.getState).toHaveBeenCalledOnce();
      expect(createBrowserStreamConnectionMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
