import { EnvironmentId, ThreadId, type BrowserSessionState } from "@salchi/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useBrowserPanelController } from "../browser/useBrowserPanelController";

const {
  browserClient,
  openRightPanelMock,
  readEnvironmentConnectionMock,
  rightPanelRegistration,
  subscribeEnvironmentConnectionsMock,
} = vi.hoisted(() => {
  const browserClient = {
    getState: vi.fn(),
    subscribeAgentActivity: vi.fn(
      (
        _input: unknown,
        _listener: (activity: {
          readonly threadId: unknown;
          readonly agentActive: boolean;
        }) => void,
      ) =>
        () =>
          undefined,
    ),
  };
  const rightPanelRegistration: {
    current: { readonly open: () => void } | null;
  } = { current: null };
  const openRightPanelMock = vi.fn(() => {
    rightPanelRegistration.current?.open();
    return true;
  });
  return {
    browserClient,
    openRightPanelMock,
    readEnvironmentConnectionMock: vi.fn(),
    rightPanelRegistration,
    subscribeEnvironmentConnectionsMock: vi.fn(() => () => undefined),
  };
});

vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: readEnvironmentConnectionMock,
  subscribeEnvironmentConnections: subscribeEnvironmentConnectionsMock,
}));

vi.mock("../hooks/useMobileEdgeSwipe", () => ({
  useMobileEdgeSwipe: vi.fn(),
}));

vi.mock("../rightPanelContentRegistry", () => ({
  useRegisterBrowserRightPanelContent: vi.fn(),
}));

vi.mock("../rightPanelGesture", () => ({
  markRightPanelUsed: vi.fn(),
  openRightPanel: openRightPanelMock,
  useRegisterRightPanel: vi.fn((registration) => {
    rightPanelRegistration.current = registration;
  }),
}));

vi.mock("../browser/browserSurfaceStreamLease", () => ({
  createBrowserSurfaceStreamLease: vi.fn(() => ({
    dispose: vi.fn(),
    setSurface: vi.fn(),
  })),
  resolveBrowserViewportSurface: vi.fn(() => "hidden"),
}));

const environmentId = EnvironmentId.make("environment-browser-controller");
const threadId = ThreadId.make("thread-browser-controller");

function sessionState(): BrowserSessionState {
  return {
    threadId,
    status: "stopped",
    tabs: [],
    executable: null,
    viewport: { width: 800, height: 600 },
  };
}

function Harness(props: { readonly showAgentPreview?: boolean }) {
  const browserPanel = useBrowserPanelController({
    agentAccessNotice: null,
    enabled: true,
    environmentId,
    showAgentPreview: props.showAgentPreview ?? false,
    threadId,
    useSheet: true,
  });
  return (
    <button type="button" onClick={browserPanel.toggle}>
      Open browser
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  browserClient.getState.mockReset().mockResolvedValue(sessionState());
  browserClient.subscribeAgentActivity.mockClear();
  readEnvironmentConnectionMock.mockReset().mockReturnValue({ client: { browser: browserClient } });
  subscribeEnvironmentConnectionsMock.mockClear();
  openRightPanelMock.mockClear();
  rightPanelRegistration.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBrowserPanelController", () => {
  it("does not read or poll browser state until the panel opens", async () => {
    const screen = await render(<Harness />);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(browserClient.getState).not.toHaveBeenCalled();
    expect(subscribeEnvironmentConnectionsMock).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Open browser" }).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(browserClient.getState).toHaveBeenCalledOnce();
    expect(browserClient.getState).toHaveBeenCalledWith({ threadId });

    await screen.unmount();
  });

  it("keeps agent-preview activity event driven while the panel is closed", async () => {
    const screen = await render(<Harness showAgentPreview />);

    await vi.waitFor(() => {
      expect(browserClient.subscribeAgentActivity).toHaveBeenCalledOnce();
    });
    expect(browserClient.getState).not.toHaveBeenCalled();

    const activityListener = browserClient.subscribeAgentActivity.mock.calls[0]?.[1];
    activityListener?.({ threadId, agentActive: true });
    await vi.waitFor(() => {
      expect(browserClient.getState).toHaveBeenCalledOnce();
    });

    await screen.unmount();
  });
});
