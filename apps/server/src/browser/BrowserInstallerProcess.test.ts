import { describe, expect, it } from "vitest";

import { parseBrowserInstallerWorkerMessage } from "./BrowserInstallerProcess.ts";

describe("browser installer worker messages", () => {
  it("parses exact byte progress from Playwright's downloader bridge", () => {
    expect(
      parseBrowserInstallerWorkerMessage(
        'SALCHI_BROWSER_INSTALL:{"type":"progress","done":42,"total":100}',
      ),
    ).toEqual({ type: "progress", done: 42, total: 100 });
  });

  it("ignores ordinary installer output and malformed tagged messages", () => {
    expect(parseBrowserInstallerWorkerMessage("Chromium downloaded")).toBe(undefined);
    expect(parseBrowserInstallerWorkerMessage("SALCHI_BROWSER_INSTALL:not-json")).toBe(undefined);
  });
});
