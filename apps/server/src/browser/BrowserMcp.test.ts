import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import { describe, it } from "vitest";

import { SALCHI_BROWSER_CDP_URL_ENV } from "./BrowserAgentAccess.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  prepareBrowserMcpServer,
  PLAYWRIGHT_MCP_VERSION,
} from "./BrowserMcp.ts";

const cdpUrl = `ws://127.0.0.1:43130/internal/browser/cdp/thread-mcp/${"a".repeat(64)}`;

describe("prepareBrowserMcpServer", () => {
  it("omits registration when browser agent access is disabled", async () => {
    let resolverCalled = false;
    const prepared = await Effect.runPromise(
      prepareBrowserMcpServer(
        {},
        {
          resolveCliPath: async () => {
            resolverCalled = true;
            return "/opt/salchi/playwright-mcp/cli.js";
          },
        },
      ),
    );

    assert.equal(prepared, undefined);
    assert.equal(resolverCalled, false);
  });

  it("builds a pinned local stdio command for the stable proxy URL", async () => {
    const prepared = await Effect.runPromise(
      prepareBrowserMcpServer(
        { [SALCHI_BROWSER_CDP_URL_ENV]: cdpUrl },
        { resolveCliPath: async () => "/opt/salchi/playwright-mcp/cli.js" },
      ),
    );

    assert.deepEqual(prepared, {
      name: BROWSER_MCP_SERVER_NAME,
      command: process.execPath,
      args: ["/opt/salchi/playwright-mcp/cli.js", "--cdp-endpoint", cdpUrl],
      environment: { [SALCHI_BROWSER_CDP_URL_ENV]: cdpUrl },
    });
    assert.equal(PLAYWRIGHT_MCP_VERSION, "0.0.74");
  });

  it("keeps provider startup available when local MCP resolution fails", async () => {
    const prepared = await Effect.runPromise(
      prepareBrowserMcpServer(
        { [SALCHI_BROWSER_CDP_URL_ENV]: cdpUrl },
        {
          resolveCliPath: async () => {
            throw new Error("package unavailable");
          },
        },
      ),
    );

    assert.equal(prepared, undefined);
  });
});
