import { describe, expect, it } from "vitest";

import { browserStealthUserAgent, BROWSER_STEALTH_WEBDRIVER_SCRIPT } from "./BrowserStealth.ts";
import { shouldUseManagedChromeNewHeadless } from "./PlaywrightBrowserRuntime.ts";

describe("browser stealth overrides", () => {
  it("retains the launched Chrome version while removing the headless marker", () => {
    expect(
      browserStealthUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) HeadlessChrome/151.0.8123.4 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/151.0.8123.4 Safari/537.36",
    );
  });

  it("leaves an already non-headless stable Chrome user agent unchanged", () => {
    const userAgent = "Mozilla/5.0 Chrome/151.0.8123.4 Safari/537.36";
    expect(browserStealthUserAgent(userAgent)).toBe(userAgent);
  });

  it("installs a webdriver getter on Navigator.prototype", () => {
    expect(BROWSER_STEALTH_WEBDRIVER_SCRIPT).toContain("Navigator.prototype");
    expect(BROWSER_STEALTH_WEBDRIVER_SCRIPT).toContain('"webdriver"');
    expect(BROWSER_STEALTH_WEBDRIVER_SCRIPT).toContain("undefined");
  });

  it("selects explicit new-headless only for the preferred branded Chrome in stealth mode", () => {
    const chromeChannel = {
      source: "channel" as const,
      resolution: "chrome",
      launchOptions: { channel: "chrome" },
    };
    expect(
      shouldUseManagedChromeNewHeadless({
        candidate: chromeChannel,
        managedVariant: "chrome",
        stealthMode: true,
      }),
    ).toBe(true);
    expect(
      shouldUseManagedChromeNewHeadless({
        candidate: chromeChannel,
        managedVariant: "headless-shell",
        stealthMode: true,
      }),
    ).toBe(false);
    expect(
      shouldUseManagedChromeNewHeadless({
        candidate: {
          source: "channel",
          resolution: "chromium",
          launchOptions: { channel: "chromium" },
        },
        managedVariant: "chrome",
        stealthMode: true,
      }),
    ).toBe(false);
  });
});
