import { describe, expect, it } from "vitest";

import { isSettingsSidebarPath } from "./appSidebarVariant";

describe("isSettingsSidebarPath", () => {
  it.each(["/settings", "/settings/general", "/settings/providers", "/themes"])(
    "selects the settings sidebar for %s",
    (pathname) => {
      expect(isSettingsSidebarPath(pathname)).toBe(true);
    },
  );

  it.each(["/", "/thread/123", "/settings-preview", "/themes-preview"])(
    "keeps the inbox sidebar for %s",
    (pathname) => {
      expect(isSettingsSidebarPath(pathname)).toBe(false);
    },
  );
});
