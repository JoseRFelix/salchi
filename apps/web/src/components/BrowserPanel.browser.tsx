import "../index.css";

import {
  EnvironmentId,
  ThreadId,
  type BrowserDispatchInput,
  type BrowserViewportEvent,
} from "@salchi/contracts";
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

const { readEnvironmentConnectionMock, subscribeEnvironmentConnectionsMock } = vi.hoisted(() => ({
  readEnvironmentConnectionMock: vi.fn(),
  subscribeEnvironmentConnectionsMock: vi.fn(() => () => undefined),
}));

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: readEnvironmentConnectionMock,
  subscribeEnvironmentConnections: subscribeEnvironmentConnectionsMock,
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
  const unsubscriptions: Array<ReturnType<typeof vi.fn>> = [];
  const listeners: Array<(event: BrowserViewportEvent) => void> = [];
  const subscriptionOptions: Array<{
    readonly onResubscribe?: () => void;
    readonly onSubscriptionError?: (info: { readonly error: string }) => void;
  }> = [];
  const subscribeViewport = vi.fn(
    (
      _input: { readonly threadId: ThreadId },
      listener: (event: BrowserViewportEvent) => void,
      options?: {
        readonly onResubscribe?: () => void;
        readonly onSubscriptionError?: (info: { readonly error: string }) => void;
      },
    ) => {
      const unsubscribe = vi.fn();
      unsubscriptions.push(unsubscribe);
      listeners.push(listener);
      subscriptionOptions.push(options ?? {});
      return unsubscribe;
    },
  );
  const browser = {
    start: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    stop: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    getState: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    setActiveTab: vi.fn(),
    openTab: vi.fn(),
    navigate: vi.fn(async ({ threadId }: { threadId: ThreadId }) => sessionState(threadId)),
    closeTab: vi.fn(),
    dispatchInput: vi.fn(async (_input: BrowserDispatchInput) => undefined),
    subscribeViewport,
  };
  return { browser, listeners, subscribeViewport, subscriptionOptions, unsubscriptions };
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

  it("keeps a static streamed frame live and shows paused only over the image on reconnect", async () => {
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
      await vi.waitFor(() => expect(client.listeners).toHaveLength(1));
      client.listeners[0]?.({
        _tag: "Frame",
        threadId: THREAD_A,
        targetId: "target-1",
        dataBase64: "Zg==",
        width: 800,
        height: 600,
        seq: 1,
        capturedAt: "2026-08-25T00:00:00.000Z" as never,
      });
      await vi.waitFor(() => expect(document.body.textContent).not.toContain("Paused"));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      expect(document.body.textContent).not.toContain("Paused");

      client.subscriptionOptions[0]?.onResubscribe?.();
      await expect.element(page.getByText("Paused")).toBeVisible();
      expect(document.querySelector("[data-browser-live-state]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("dispatches pointer input only in explicit interact mode and disables it when hidden", async () => {
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
      await vi.waitFor(() => expect(client.listeners).toHaveLength(1));
      client.listeners[0]?.({
        _tag: "Frame",
        threadId: THREAD_A,
        targetId: "target-1",
        dataBase64: "Zg==",
        width: 800,
        height: 600,
        seq: 1,
        capturedAt: "2026-08-25T00:00:00.000Z" as never,
      });

      const interact = page.getByRole("button", { name: "Interact" });
      await expect.element(interact).toBeEnabled();
      await interact.click();
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[aria-label="Interactive browser viewport"]',
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
      await vi.waitFor(() => expect(client.browser.dispatchInput).toHaveBeenCalledTimes(2));
      expect(client.browser.dispatchInput.mock.calls.map(([input]) => input.event._tag)).toEqual([
        "PointerDown",
        "PointerUp",
      ]);

      await screen.rerender(<Panel state={state} threadId={THREAD_A} visible={false} />);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-browser-interact="true"]')).toBeNull(),
      );
      await expect
        .element(page.getByRole("button", { name: "Interact" }))
        .toHaveAttribute("aria-pressed", "false");
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
      expect(client.subscribeViewport).not.toHaveBeenCalled();

      await screen.rerender(<Panel threadId={THREAD_A} visible />);
      await vi.waitFor(() => expect(client.subscribeViewport).toHaveBeenCalledTimes(1));
      expect(client.subscribeViewport.mock.calls[0]?.[0]).toEqual({ threadId: THREAD_A });

      await screen.rerender(<Panel threadId={THREAD_A} visible={false} />);
      await vi.waitFor(() => expect(client.unsubscriptions[0]).toHaveBeenCalledOnce());

      await screen.rerender(<Panel threadId={THREAD_A} visible />);
      await vi.waitFor(() => expect(client.subscribeViewport).toHaveBeenCalledTimes(2));

      await screen.rerender(<Panel threadId={THREAD_B} visible />);
      await vi.waitFor(() => {
        expect(client.unsubscriptions[1]).toHaveBeenCalledOnce();
        expect(client.subscribeViewport).toHaveBeenCalledTimes(3);
      });
      expect(client.subscribeViewport.mock.calls[2]?.[0]).toEqual({ threadId: THREAD_B });
    } finally {
      await screen.unmount();
    }

    expect(client.unsubscriptions[2]).toHaveBeenCalledOnce();
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
      await vi.waitFor(() => expect(client.subscribeViewport).toHaveBeenCalledOnce());
      await screen.rerender(renderSheet(false));
      await vi.waitFor(() => expect(client.unsubscriptions[0]).toHaveBeenCalledOnce());

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
      expect(client.subscribeViewport).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
