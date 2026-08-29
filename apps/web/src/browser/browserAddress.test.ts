import { describe, expect, it } from "vitest";

import { browserAddressValue, resolveBrowserAddress } from "./browserAddress";

describe("browser address bar", () => {
  it("presents about:blank as an empty new-tab address", () => {
    expect(browserAddressValue("about:blank")).toBe("");
    expect(browserAddressValue("https://example.com/")).toBe("https://example.com/");
  });

  it("keeps explicit URLs and adds a scheme to hostnames", () => {
    expect(resolveBrowserAddress(" https://example.com/docs ")).toBe("https://example.com/docs");
    expect(resolveBrowserAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(resolveBrowserAddress("localhost:5173")).toBe("http://localhost:5173");
  });

  it("turns plain text into a browser-style search", () => {
    expect(resolveBrowserAddress("youtube cats")).toBe(
      "https://www.google.com/search?q=youtube%20cats",
    );
    expect(resolveBrowserAddress("   ")).toBeNull();
  });
});
