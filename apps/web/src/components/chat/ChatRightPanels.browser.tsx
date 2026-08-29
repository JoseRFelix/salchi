import "../../index.css";

import { page } from "vitest/browser";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { isStandalonePwa } from "../../env";
import {
  __resetRightPanelContentRegistryForTests,
  useRegisterBrowserRightPanelContent,
  useRegisterPlanRightPanelContent,
} from "../../rightPanelContentRegistry";
import { ChatRightPanels } from "./ChatRightPanels";

vi.mock("../DiffPanel", () => ({
  default: () => <div>Diff panel content</div>,
}));

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("../WorkspaceFilesPanel", () => ({
  WorkspaceFilesPanel: () => <div>Source control panel content</div>,
}));

describe("ChatRightPanels", () => {
  afterEach(() => {
    __resetRightPanelContentRegistryForTests();
    vi.restoreAllMocks();
  });

  function PanelHarness(props: {
    activeView: "diff" | "files" | null;
    browserOpen?: boolean;
    planOpen?: boolean;
    useSheet: boolean;
  }) {
    const planRegistration = useMemo(
      () => ({
        open: props.planOpen ?? false,
        onClose: vi.fn(),
        render: () => <div>Plan panel content</div>,
      }),
      [props.planOpen],
    );
    useRegisterPlanRightPanelContent(planRegistration);
    const browserRegistration = useMemo(
      () => ({
        open: props.browserOpen ?? false,
        onClose: vi.fn(),
        render: () => <div>Browser panel content</div>,
      }),
      [props.browserOpen],
    );
    useRegisterBrowserRightPanelContent(browserRegistration);
    return (
      <ChatRightPanels
        activeView={props.activeView}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onReturnFromFileToDiff={vi.fn()}
        renderDiffContent
        renderFileContent
        useSheet={props.useSheet}
      />
    );
  }

  const renderPanels = (
    activeView: "diff" | "files" | null,
    useSheet: boolean,
    planOpen = false,
    browserOpen = false,
  ) => (
    <PanelHarness
      activeView={activeView}
      browserOpen={browserOpen}
      planOpen={planOpen}
      useSheet={useSheet}
    />
  );

  it("uses one expanded web sidebar while the active stack view changes", async () => {
    await page.viewport(1200, 800);

    const screen = await render(renderPanels("files", false));
    try {
      await expect.element(page.getByText("Source control panel content")).toBeVisible();
      const primaryShell = document.querySelector<HTMLElement>(
        '[data-chat-right-panel-primary="true"]',
      );
      expect(primaryShell).not.toBeNull();
      expect(document.querySelectorAll('[data-slot="sidebar"]')).toHaveLength(1);
      expect(
        primaryShell?.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]')?.dataset
          .state,
      ).toBe("expanded");

      await screen.rerender(renderPanels("diff", false));

      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      const handedOffShell = document.querySelector<HTMLElement>(
        '[data-chat-right-panel-primary="true"]',
      );
      expect(handedOffShell).toBe(primaryShell);
      expect(document.querySelectorAll('[data-slot="sidebar"]')).toHaveLength(1);
      expect(
        handedOffShell?.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]')?.dataset
          .state,
      ).toBe("expanded");

      await screen.rerender(renderPanels(null, false, true));
      await expect.element(page.getByText("Plan panel content")).toBeVisible();
      expect(document.querySelector('[data-chat-right-panel-primary="true"]')).toBe(primaryShell);
      expect(document.querySelectorAll('[data-slot="sidebar"]')).toHaveLength(1);

      await screen.rerender(renderPanels(null, false, false, true));
      await expect.element(page.getByText("Browser panel content")).toBeVisible();
      expect(document.querySelector('[data-chat-right-panel-primary="true"]')).toBe(primaryShell);
      expect(document.querySelectorAll('[data-slot="sidebar"]')).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("uses one sheet for stack navigation in an installed mobile PWA", async () => {
    await page.viewport(390, 844);
    const nativeMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = nativeMatchMedia(query);
      if (query !== "(display-mode: standalone)") {
        return result;
      }
      return {
        matches: true,
        media: result.media,
        onchange: result.onchange,
        addListener: result.addListener.bind(result),
        removeListener: result.removeListener.bind(result),
        addEventListener: result.addEventListener.bind(result),
        removeEventListener: result.removeEventListener.bind(result),
        dispatchEvent: result.dispatchEvent.bind(result),
      };
    });
    expect(isStandalonePwa()).toBe(true);

    const screen = await render(renderPanels("files", true));
    try {
      await expect.element(page.getByText("Source control panel content")).toBeVisible();
      const sheet = document.querySelector('[data-right-panel-sheet="true"]');
      expect(sheet).not.toBeNull();
      expect(document.querySelectorAll('[data-right-panel-sheet="true"]')).toHaveLength(1);

      await screen.rerender(renderPanels("diff", true));
      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      expect(document.querySelector('[data-right-panel-sheet="true"]')).toBe(sheet);
      expect(document.querySelectorAll('[data-right-panel-sheet="true"]')).toHaveLength(1);

      await screen.rerender(renderPanels("files", true));
      await expect.element(page.getByText("Source control panel content")).toBeVisible();
      expect(document.querySelector('[data-right-panel-sheet="true"]')).toBe(sheet);
    } finally {
      await screen.unmount();
    }
  });
});
