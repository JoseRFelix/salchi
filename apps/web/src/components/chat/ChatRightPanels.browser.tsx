import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
  it("reuses the expanded inline panel shell when source control hands off to a diff", async () => {
    await page.viewport(1200, 800);
    const onCloseDiff = vi.fn();
    const onOpenDiff = vi.fn();
    const onReturnFromFileToDiff = vi.fn();
    const renderPanels = (diffOpen: boolean, fileOpen: boolean) => (
      <ChatRightPanels
        diff={{
          open: diffOpen,
          onClose: onCloseDiff,
          onOpen: onOpenDiff,
          renderContent: diffOpen,
        }}
        fileOpen={fileOpen}
        onReturnFromFileToDiff={onReturnFromFileToDiff}
        renderFileContent={fileOpen}
        useSheet={false}
      />
    );

    const screen = await render(renderPanels(false, true));
    try {
      await expect.element(page.getByText("Source control panel content")).toBeVisible();
      const primaryShell = document.querySelector<HTMLElement>(
        '[data-chat-right-panel-primary="true"]',
      );
      expect(primaryShell).not.toBeNull();
      expect(
        primaryShell?.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]')?.dataset
          .state,
      ).toBe("expanded");

      await screen.rerender(renderPanels(true, false));

      await expect.element(page.getByText("Diff panel content")).toBeVisible();
      const handedOffShell = document.querySelector<HTMLElement>(
        '[data-chat-right-panel-primary="true"]',
      );
      expect(handedOffShell).toBe(primaryShell);
      expect(
        handedOffShell?.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]')?.dataset
          .state,
      ).toBe("expanded");
    } finally {
      await screen.unmount();
    }
  });
});
