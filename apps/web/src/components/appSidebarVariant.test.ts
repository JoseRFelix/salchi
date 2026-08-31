import { describe, expect, it } from "vitest";

import {
  isSettingsSidebarPath,
  resolveAppSidebarVariant,
  shouldShowInboxIntroduction,
  sidebarNavigationChoicePatch,
} from "./appSidebarVariant";

describe("isSettingsSidebarPath", () => {
  it.each(["/settings", "/settings/general", "/settings/providers", "/themes"])(
    "selects the settings sidebar for %s",
    (pathname) => {
      expect(isSettingsSidebarPath(pathname)).toBe(true);
    },
  );

  it.each(["/", "/thread/123", "/settings-preview", "/themes-preview"])(
    "keeps the configured sidebar for %s",
    (pathname) => {
      expect(isSettingsSidebarPath(pathname)).toBe(false);
    },
  );
});

describe("resolveAppSidebarVariant", () => {
  it("keeps the settings sidebar independent from the user's navigation mode", () => {
    expect(
      resolveAppSidebarVariant({
        pathname: "/settings/inbox",
        sidebarNavigationMode: "inbox",
      }),
    ).toBe("settings");
    expect(
      resolveAppSidebarVariant({
        pathname: "/settings/general",
        sidebarNavigationMode: "project",
      }),
    ).toBe("settings");
  });

  it.each(["project", "inbox"] as const)("renders the configured %s view in chat", (mode) => {
    expect(
      resolveAppSidebarVariant({ pathname: "/environment/thread", sidebarNavigationMode: mode }),
    ).toBe(mode);
  });
});

describe("Inbox introduction", () => {
  const baseInput = {
    hasSeenInboxIntroduction: false,
    pathname: "/",
    settingsHydrated: true,
    sidebarNavigationMode: "project" as const,
  };

  it("appears once for a hydrated Project view outside Settings", () => {
    expect(shouldShowInboxIntroduction(baseInput)).toBe(true);
    expect(shouldShowInboxIntroduction({ ...baseInput, settingsHydrated: false })).toBe(false);
    expect(shouldShowInboxIntroduction({ ...baseInput, hasSeenInboxIntroduction: true })).toBe(
      false,
    );
    expect(shouldShowInboxIntroduction({ ...baseInput, sidebarNavigationMode: "inbox" })).toBe(
      false,
    );
    expect(shouldShowInboxIntroduction({ ...baseInput, pathname: "/settings/inbox" })).toBe(false);
  });

  it.each(["project", "inbox"] as const)(
    "persists the %s choice and dismisses the introduction",
    (mode) => {
      expect(sidebarNavigationChoicePatch(mode)).toEqual({
        hasSeenInboxIntroduction: true,
        sidebarNavigationMode: mode,
      });
    },
  );
});
