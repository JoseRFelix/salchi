import { describe, expect, it } from "vitest";

import { resolveSidebarNavigationMode } from "./hooks/useSettings";
import { resolveRenderedSidebarMode } from "./sidebarNavigationMode";

describe("sidebar navigation mode", () => {
  it("holds the project-first default until persisted client settings hydrate", () => {
    expect(
      resolveSidebarNavigationMode({
        settingsHydrated: false,
        configuredMode: "inbox",
      }),
    ).toBe("project");
  });

  it("switches to the persisted inbox mode after hydration", () => {
    expect(
      resolveSidebarNavigationMode({
        settingsHydrated: true,
        configuredMode: "inbox",
      }),
    ).toBe("inbox");
  });

  it("keeps settings navigation mounted while either mode is configured", () => {
    expect(
      resolveRenderedSidebarMode({ configuredMode: "inbox", pathname: "/settings/general" }),
    ).toBe("project");
    expect(resolveRenderedSidebarMode({ configuredMode: "inbox", pathname: "/thread" })).toBe(
      "inbox",
    );
    expect(resolveRenderedSidebarMode({ configuredMode: "project", pathname: "/thread" })).toBe(
      "project",
    );
  });
});
