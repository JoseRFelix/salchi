import { type ProjectScript, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../index.css";

import ProjectScriptsControl from "./ProjectScriptsControl";
import { Button } from "./ui/button";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

async function renderInMenu(scripts: ProjectScript[]) {
  const host = document.createElement("div");
  document.body.append(host);

  const screen = await render(
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="outline" aria-label="More project actions" />}
      />
      <MenuPopup>
        <ProjectScriptsControl
          scripts={scripts}
          keybindings={EMPTY_KEYBINDINGS}
          inMenu
          onRunScript={vi.fn()}
          onAddScript={vi.fn()}
          onUpdateScript={vi.fn()}
          onDeleteScript={vi.fn()}
        />
      </MenuPopup>
    </Menu>,
    { container: host },
  );

  return {
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProjectScriptsControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the add action dialog when rendered inside a menu", async () => {
    const screen = await renderInMenu([]);

    await page.getByLabelText("More project actions").click();
    await page.getByText("Add action").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Add Action");
      expect(document.body.textContent ?? "").toContain(
        "Actions are project-scoped commands you can run from the top bar or keybindings.",
      );
    });

    await screen.cleanup();
  });

  it("opens the nested add action dialog when scripts already exist", async () => {
    const screen = await renderInMenu([
      {
        id: "test",
        name: "Test",
        command: "bun run test",
        icon: "test",
        runOnWorktreeCreate: false,
      },
    ]);

    await page.getByLabelText("More project actions").click();
    await page.getByText("Run").click();
    await page.getByText("Add action").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Add Action");
    });

    await screen.cleanup();
  });
});
