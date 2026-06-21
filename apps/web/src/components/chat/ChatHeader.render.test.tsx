import { EnvironmentId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatHeader } from "./ChatHeader";
import type { DevServerLink } from "../../devServerLinks";

vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: () => <button aria-label="Toggle sidebar" type="button" />,
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
  it("renders the dev server action in the desktop header", () => {
    const markup = renderHeader([DEV_SERVER_LINK]);

    expect(markup).toContain('aria-label="Open http://localhost:5173"');
  });
});
