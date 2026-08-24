import { EnvironmentId, type ResolvedKeybindingsConfig } from "@salchi/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatHeader } from "./ChatHeader";
import type { DevServerLink } from "../../devServerLinks";

const { useMediaQueryMock } = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(() => false),
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: useMediaQueryMock,
}));

vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button aria-label="Toggle sidebar" className={className} type="button" />
  ),
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

function renderHeader(devServerLinks: ReadonlyArray<DevServerLink>) {
  return renderToStaticMarkup(
    <ChatHeader
      activeThreadEnvironmentId={LOCAL_ENVIRONMENT_ID}
      activeThreadTitle="Implement chat header"
      activeProjectName="salchi"
      activeProjectCwd="/repo/salchi"
      isGitRepo={true}
      openInCwd="/repo/salchi"
      activeProjectScripts={undefined}
      preferredScriptId={null}
      keybindings={EMPTY_KEYBINDINGS}
      availableEditors={[]}
      terminalAvailable={true}
      terminalOpen={false}
      terminalToggleShortcutLabel={null}
      diffToggleShortcutLabel={null}
      sourceControlToggleShortcutLabel={null}
      gitCwd="/repo/salchi"
      diffOpen={false}
      sourceControlOpen={false}
      devServerLinks={devServerLinks}
      devServerProbeBrowserHostname={null}
      probeDevServerUrl={async () => true}
      fileExplorerAvailable={true}
      fileExplorerOpen={false}
      onRunProjectScript={() => undefined}
      onAddProjectScript={async () => undefined}
      onUpdateProjectScript={async () => undefined}
      onDeleteProjectScript={async () => undefined}
      onToggleFileExplorer={() => undefined}
      onToggleTerminal={() => undefined}
      onToggleDiff={() => undefined}
      onToggleSourceControl={() => undefined}
    />,
  );
}

describe("ChatHeader", () => {
  beforeEach(() => {
    useMediaQueryMock.mockReturnValue(false);
  });

  it("renders a dev server selector for a single detected link", () => {
    const markup = renderHeader([DEV_SERVER_LINK]);

    expect(markup).toContain('aria-label="Select dev server"');
    expect(markup).toContain('aria-haspopup="menu"');
  });

  it("renders the project icon, project name, separator, and thread name in order", () => {
    const markup = renderHeader([]);
    const projectIconIndex = markup.indexOf('data-slot="chat-header-project-icon"');
    const projectNameIndex = markup.indexOf('data-slot="chat-header-project-name"');
    const separatorIndex = markup.indexOf('data-slot="chat-header-title-separator"');
    const threadNameIndex = markup.indexOf('data-slot="chat-header-thread-name"');

    expect(projectIconIndex).toBeGreaterThan(-1);
    expect(projectNameIndex).toBeGreaterThan(projectIconIndex);
    expect(separatorIndex).toBeGreaterThan(projectNameIndex);
    expect(threadNameIndex).toBeGreaterThan(separatorIndex);
    expect(markup).toContain('aria-label="salchi / Implement chat header"');
    expect(markup).toContain('title="salchi / Implement chat header"');
  });

  it("uses non-overlapping 44px subtle outline controls in the compact header", () => {
    useMediaQueryMock.mockReturnValue(true);

    const markup = renderHeader([]);

    expect(markup.match(/sm:size-11/g)).toHaveLength(4);
    expect(markup.match(/rounded-xl/g)).toHaveLength(4);
    expect(markup.match(/pointer-coarse:after:hidden/g)).toHaveLength(4);
    expect(markup).toContain('data-slot="compact-sidebar-trigger-slot"');
    expect(markup).toContain("h-11 w-8");
    expect(markup).toContain("pointer-coarse:after:-translate-x-1/2");
    expect(markup).toContain("pointer-coarse:after:-translate-y-1/2");
    expect(markup).toContain("border-border/35 bg-background");
    expect(markup).not.toContain("border-input bg-background");
    expect(markup).not.toContain("max-[760px]");
    expect(markup).not.toContain("sm:size-3");
  });
});
