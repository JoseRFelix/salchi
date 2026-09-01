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
import { ChatRightPanels, MOBILE_WORKER_POOL_IDLE_GRACE_MS } from "./ChatRightPanels";

vi.mock("../DiffPanel", () => ({
  default: () => <div>Diff panel content</div>,
}));

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({
    children,
    profile = "standard",
  }: {
    children?: React.ReactNode;
    profile?: "memory-constrained" | "standard";
  }) => <div data-diff-worker-pool-profile={profile}>{children}</div>,
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
    renderDiffContent?: boolean;
    renderFileContent?: boolean;
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
        renderDiffContent={props.renderDiffContent ?? true}
        renderFileContent={props.renderFileContent ?? true}
        useSheet={props.useSheet}
      />
    );
  }

  const renderPanels = (
    activeView: "diff" | "files" | null,
    useSheet: boolean,
    planOpen = false,
    browserOpen = false,
    renderContent: { diff: boolean; files: boolean } = { diff: true, files: true },
  ) => (
    <PanelHarness
      activeView={activeView}
      browserOpen={browserOpen}
      planOpen={planOpen}
      renderDiffContent={renderContent.diff}
      renderFileContent={renderContent.files}
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

  it("reuses one memory-constrained worker pool while mobile diff content is reopened", async () => {
    await page.viewport(390, 844);
    const screen = await render(
      renderPanels("diff", true, false, false, { diff: true, files: false }),
    );

    try {
      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      const workerPool = document.querySelector<HTMLElement>("[data-diff-worker-pool-profile]");
      expect(workerPool).not.toBeNull();
      expect(workerPool?.dataset.diffWorkerPoolProfile).toBe("memory-constrained");

      await screen.rerender(renderPanels(null, true, false, false, { diff: false, files: false }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("Diff panel content");
        },
        { timeout: 2_000 },
      );
      expect(document.querySelector("[data-diff-worker-pool-profile]")).toBe(workerPool);

      await screen.rerender(renderPanels("diff", true, false, false, { diff: true, files: false }));

      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      expect(document.querySelector("[data-diff-worker-pool-profile]")).toBe(workerPool);
      expect(document.querySelectorAll("[data-diff-worker-pool-profile]")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("releases the retained mobile worker pool after its idle grace period", async () => {
    await page.viewport(390, 844);
    const screen = await render(
      renderPanels("diff", true, false, false, { diff: true, files: false }),
    );

    try {
      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
      vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout = 0) =>
        nativeSetTimeout(handler, timeout === MOBILE_WORKER_POOL_IDLE_GRACE_MS ? 0 : timeout),
      );

      await screen.rerender(renderPanels(null, true, false, false, { diff: false, files: false }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("Diff panel content");
          expect(document.querySelector("[data-diff-worker-pool-profile]")).toBeNull();
        },
        { timeout: 2_000 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("fully replaces the worker pool before switching to the mobile profile", async () => {
    await page.viewport(1200, 800);
    const screen = await render(
      renderPanels("diff", false, false, false, { diff: true, files: false }),
    );

    try {
      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      const standardPool = document.querySelector<HTMLElement>(
        "[data-diff-worker-pool-profile='standard']",
      );
      expect(standardPool).not.toBeNull();

      await screen.rerender(renderPanels("diff", true, false, false, { diff: true, files: false }));

      await vi.waitFor(() => {
        const mobilePool = document.querySelector<HTMLElement>(
          "[data-diff-worker-pool-profile='memory-constrained']",
        );
        expect(mobilePool).not.toBeNull();
        expect(mobilePool).not.toBe(standardPool);
        expect(document.querySelectorAll("[data-diff-worker-pool-profile]")).toHaveLength(1);
      });
    } finally {
      await screen.unmount();
    }
  });
});
