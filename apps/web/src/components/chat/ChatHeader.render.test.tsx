import { EnvironmentId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
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

  it("renders the dev server action in the desktop header", () => {
    const markup = renderHeader([DEV_SERVER_LINK]);

    expect(markup).toContain('aria-label="Open http://localhost:5173"');
  });

  it("uses non-overlapping 44px subtle outline controls in the compact header", () => {
    useMediaQueryMock.mockReturnValue(true);

    const markup = renderHeader([]);

    expect(markup.match(/sm:size-11/g)).toHaveLength(4);
    expect(markup.match(/rounded-xl/g)).toHaveLength(4);
    expect(markup.match(/pointer-coarse:after:hidden/g)).toHaveLength(4);
    expect(markup).toContain('data-slot="compact-sidebar-trigger-slot"');
    expect(markup).toContain("pointer-coarse:after:-translate-x-1/2");
    expect(markup).toContain("pointer-coarse:after:-translate-y-1/2");
    expect(markup).toContain("border-border/35 bg-background");
    expect(markup).not.toContain("border-input bg-background");
    expect(markup).not.toContain("max-[760px]");
    expect(markup).not.toContain("sm:size-3");
  });
});
