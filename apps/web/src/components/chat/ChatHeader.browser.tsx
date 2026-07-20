import "../../index.css";

import { EnvironmentId, type ResolvedKeybindingsConfig } from "@salchi/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { usePwaServiceWorkerUpdateStore } from "../../pwa/serviceWorkerUpdateState";
import type { DevServerLink } from "../../devServerLinks";
import { SidebarProvider } from "../ui/sidebar";
import { __resetDevServerWindowForTests, ChatHeader } from "./ChatHeader";

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string | undefined>) => unknown }) =>
    options?.select ? options.select({}) : {},
}));

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const DEV_SERVER_LINK: DevServerLink = {
  url: "http://localhost:5173/",
  displayUrl: "http://localhost:5173",
  label: "Local localhost:5173",
  host: "localhost:5173",
  port: "5173",
};

function ChatHeaderHarness({
  devServerLinks = [],
}: {
  readonly devServerLinks?: ReadonlyArray<DevServerLink>;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false);
  const [sourceControlOpen, setSourceControlOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  return (
    <SidebarProvider>
      <header className="flex w-full border-b px-3 py-2">
        <ChatHeader
          activeThreadEnvironmentId={LOCAL_ENVIRONMENT_ID}
          activeThreadTitle="Responsive compact controls"
          activeProjectName="salchi"
          isGitRepo={true}
          openInCwd="/repo/salchi"
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={EMPTY_KEYBINDINGS}
          availableEditors={[]}
          terminalAvailable={true}
          terminalOpen={terminalOpen}
          terminalToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          sourceControlToggleShortcutLabel={null}
          gitCwd="/repo/salchi"
          diffOpen={diffOpen}
          sourceControlOpen={sourceControlOpen}
          devServerLinks={devServerLinks}
          devServerProbeBrowserHostname={null}
          probeDevServerUrl={async () => true}
          fileExplorerAvailable={true}
          fileExplorerOpen={fileExplorerOpen}
          onRunProjectScript={() => undefined}
          onAddProjectScript={async () => undefined}
          onUpdateProjectScript={async () => undefined}
          onDeleteProjectScript={async () => undefined}
          onToggleFileExplorer={() => setFileExplorerOpen((open) => !open)}
          onToggleTerminal={() => setTerminalOpen((open) => !open)}
          onToggleDiff={() => setDiffOpen((open) => !open)}
          onToggleSourceControl={() => setSourceControlOpen((open) => !open)}
        />
      </header>
    </SidebarProvider>
  );
}

function getHeaderActionButtons(): HTMLButtonElement[] {
  const container = document.querySelector<HTMLElement>('[data-slot="chat-header-icon-actions"]');
  expect(container).not.toBeNull();
  return Array.from(container!.querySelectorAll<HTMLButtonElement>("button"));
}

function expectSquareControls(controls: ReadonlyArray<HTMLElement>, expectedSize: number) {
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    expect(box.width).toBe(expectedSize);
    expect(box.height).toBe(expectedSize);
  }
}

function expectControlIcons(controls: ReadonlyArray<HTMLElement>, expectedSize: number) {
  for (const control of controls) {
    const icon = control.querySelector<SVGElement>("svg");
    expect(icon).not.toBeNull();
    const box = icon!.getBoundingClientRect();
    expect(box.width).toBe(expectedSize);
    expect(box.height).toBe(expectedSize);
  }
}

function expectControlsDoNotOverlap(controls: ReadonlyArray<HTMLElement>) {
  for (let index = 1; index < controls.length; index += 1) {
    const previousBox = controls[index - 1]!.getBoundingClientRect();
    const currentBox = controls[index]!.getBoundingClientRect();
    expect(currentBox.left).toBeGreaterThanOrEqual(previousBox.right);
  }
}

describe("ChatHeader responsive controls", () => {
  afterEach(async () => {
    __resetDevServerWindowForTests();
    vi.restoreAllMocks();
    usePwaServiceWorkerUpdateStore.setState(usePwaServiceWorkerUpdateStore.getInitialState(), true);
    document.body.innerHTML = "";
    await page.viewport(1024, 768);
  });

  it("opens the selector before navigating when only one dev server is detected", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const screen = await render(<ChatHeaderHarness devServerLinks={[DEV_SERVER_LINK]} />);

    try {
      await page.getByRole("button", { name: "Select dev server" }).click();

      expect(open).not.toHaveBeenCalled();
      const menuItem = page.getByRole("menuitem", { name: DEV_SERVER_LINK.displayUrl });
      await expect.element(menuItem).toBeVisible();

      await menuItem.click();
      expect(open).toHaveBeenCalledWith(DEV_SERVER_LINK.url, "salchi-dev-server-preview");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps every compact action square and non-overlapping through the inclusive breakpoint", async () => {
    await page.viewport(320, 700);
    const screen = await render(<ChatHeaderHarness />);

    try {
      for (const width of [320, 390, 639, 640, 700, 759, 760]) {
        await page.viewport(width, 700);

        await vi.waitFor(() => {
          const controls = getHeaderActionButtons();
          expect(controls).toHaveLength(4);
          expectSquareControls(controls, 44);
          expectControlIcons(controls, 18);
          expectControlsDoNotOverlap(controls);
        });
      }
    } finally {
      await screen.unmount();
    }
  });

  it("returns to the standard desktop actions immediately above the compact breakpoint", async () => {
    await page.viewport(760, 700);
    const screen = await render(<ChatHeaderHarness />);

    try {
      await vi.waitFor(() => {
        expectSquareControls(getHeaderActionButtons(), 44);
      });

      for (const width of [761, 767, 768]) {
        await page.viewport(width, 700);

        await vi.waitFor(() => {
          const controls = getHeaderActionButtons();
          expect(controls).toHaveLength(5);
          expectSquareControls(controls, 24);
          expectControlsDoNotOverlap(controls);
        });
      }
    } finally {
      await screen.unmount();
    }
  });

  it("preserves accessible toggle state while resizing across the breakpoint", async () => {
    await page.viewport(700, 700);
    const screen = await render(<ChatHeaderHarness />);

    try {
      const sourceControl = page.getByRole("button", { name: "Toggle source control" });
      const terminal = page.getByRole("button", { name: "Toggle terminal drawer" });
      const disabledDevServer = page.getByRole("button", { name: "No running dev servers" });
      const moreActions = page.getByRole("button", { name: "More thread actions" });
      const sourceControlElement = document.querySelector<HTMLElement>(
        '[aria-label="Toggle source control"]',
      );

      expect(sourceControlElement).not.toBeNull();
      const sourceControlBackgroundBefore = getComputedStyle(sourceControlElement!).backgroundColor;

      await expect.element(sourceControl).toHaveAttribute("aria-pressed", "false");
      await expect.element(terminal).toHaveAttribute("aria-pressed", "false");
      await expect.element(disabledDevServer).toHaveAttribute("aria-disabled", "true");
      await expect.element(moreActions).toBeVisible();

      await sourceControl.click();
      await terminal.click();

      await expect.element(sourceControl).toHaveAttribute("aria-pressed", "true");
      await expect.element(terminal).toHaveAttribute("aria-pressed", "true");
      expect(getComputedStyle(sourceControlElement!).backgroundColor).not.toBe(
        sourceControlBackgroundBefore,
      );

      await page.viewport(761, 700);

      await expect.element(sourceControl).toHaveAttribute("aria-pressed", "true");
      await expect.element(terminal).toHaveAttribute("aria-pressed", "true");
      await expect
        .element(page.getByRole("button", { name: "Toggle file explorer" }))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Toggle diff panel" })).toBeVisible();
      await vi.waitFor(() => expectSquareControls(getHeaderActionButtons(), 24));
    } finally {
      await screen.unmount();
    }
  });

  it("keeps sidebar loading and update indicators anchored inside the compact trigger", async () => {
    await page.viewport(700, 700);
    usePwaServiceWorkerUpdateStore.getState().setCheckPhase("checking");
    const screen = await render(<ChatHeaderHarness />);

    try {
      const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
      const triggerSlot = document.querySelector<HTMLElement>(
        '[data-slot="compact-sidebar-trigger-slot"]',
      );
      const loadingIndicator = document.querySelector<SVGElement>(
        '[data-slot="sidebar-trigger-loading-indicator"]',
      );

      expect(trigger).not.toBeNull();
      expect(triggerSlot).not.toBeNull();
      expect(loadingIndicator).not.toBeNull();
      expectSquareControls([triggerSlot!], 44);

      const triggerBox = trigger!.getBoundingClientRect();
      const loadingBox = loadingIndicator!.getBoundingClientRect();
      expect(Math.abs(loadingBox.top - triggerBox.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(loadingBox.right - triggerBox.right)).toBeLessThanOrEqual(1);

      usePwaServiceWorkerUpdateStore.getState().showUpdateAvailable(async () => undefined);

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-slot="sidebar-trigger-loading-indicator"]'),
        ).toBeNull();
        const updateIndicator = document.querySelector<HTMLElement>(
          '[data-slot="sidebar-trigger-update-indicator"]',
        );
        expect(updateIndicator).not.toBeNull();
        const updateBox = updateIndicator!.getBoundingClientRect();
        expect(updateBox.top).toBeGreaterThanOrEqual(triggerBox.top);
        expect(updateBox.right).toBeLessThanOrEqual(triggerBox.right);
        expect(updateBox.bottom).toBeLessThanOrEqual(triggerBox.bottom);
        expect(updateBox.left).toBeGreaterThanOrEqual(triggerBox.left);
      });
    } finally {
      await screen.unmount();
    }
  });
});
