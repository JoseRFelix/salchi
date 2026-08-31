import { describe, expect, it } from "vitest";

import { resolveSidebarNavigationMode } from "./hooks/useSettings";

describe("sidebar navigation hydration", () => {
  it("holds the Project default until persisted settings hydrate", () => {
    expect(
      resolveSidebarNavigationMode({
        settingsHydrated: false,
        configuredMode: "inbox",
      }),
    ).toBe("project");
  });

  it("uses the persisted mode after hydration", () => {
    expect(
      resolveSidebarNavigationMode({
        settingsHydrated: true,
        configuredMode: "inbox",
      }),
    ).toBe("inbox");
    expect(
      resolveSidebarNavigationMode({
        settingsHydrated: true,
        configuredMode: "project",
      }),
    ).toBe("project");
  });
});
