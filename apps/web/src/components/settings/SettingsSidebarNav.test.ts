import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_GROUPS, SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("settings navigation information architecture", () => {
  it("groups the accepted preferences, integrations, and data destinations", () => {
    expect(
      SETTINGS_NAV_GROUPS.map((group) => ({
        label: group.label,
        items: group.items.map((item) => item.label),
      })),
    ).toEqual([
      {
        label: "Preferences",
        items: ["General", "Inbox", "Workspace", "Chat", "Keybindings", "Themes"],
      },
      {
        label: "Integrations",
        items: ["Providers", "Source Control", "Connections"],
      },
      { label: "Data", items: ["Archive"] },
    ]);
  });

  it("exposes every destination exactly once", () => {
    const routes = SETTINGS_NAV_ITEMS.map((item) => item.to);

    expect(routes).toEqual([
      "/settings/general",
      "/settings/inbox",
      "/settings/workspace",
      "/settings/chat",
      "/settings/keybindings",
      "/themes",
      "/settings/providers",
      "/settings/source-control",
      "/settings/connections",
      "/settings/archived",
    ]);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
