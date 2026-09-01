// @effect-diagnostics nodeBuiltinImport:off
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

import { SALCHI_BROWSER_CDP_URL_ENV } from "./BrowserAgentAccess.ts";

export const BROWSER_MCP_SERVER_NAME = "salchi-browser";
export const PLAYWRIGHT_MCP_VERSION = "0.0.74";
export const BROWSER_MCP_USAGE_INSTRUCTION =
  "For web browsing tasks, use the salchi-browser MCP tools. Do not launch a separate browser. The browser viewport is visible live to the user.";

export interface PreparedBrowserMcpServer {
  readonly name: typeof BROWSER_MCP_SERVER_NAME;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export interface PrepareBrowserMcpServerOptions {
  readonly resolveCliPath?: () => Promise<string>;
}

const require = createRequire(import.meta.url);
let playwrightMcpCliPathPromise: Promise<string> | undefined;

class BrowserMcpPreparationError extends Data.TaggedError("BrowserMcpPreparationError")<{
  readonly detail: string;
}> {}

async function resolveInstalledPlaywrightMcpCliPath(): Promise<string> {
  playwrightMcpCliPathPromise ??= (async () => {
    const packageJsonPath = require.resolve("@playwright/mcp/package.json");
    const cliPath = path.join(path.dirname(packageJsonPath), "cli.js");
    await access(cliPath, fsConstants.R_OK);
    return cliPath;
  })();
  return playwrightMcpCliPathPromise;
}

export function prepareBrowserMcpServer(
  browserEnvironment: NodeJS.ProcessEnv | undefined,
  options: PrepareBrowserMcpServerOptions = {},
): Effect.Effect<PreparedBrowserMcpServer | undefined> {
  const cdpUrl = browserEnvironment?.[SALCHI_BROWSER_CDP_URL_ENV]?.trim();
  if (!cdpUrl) return Effect.succeed(undefined);

  return Effect.tryPromise({
    try: options.resolveCliPath ?? resolveInstalledPlaywrightMcpCliPath,
    catch: (cause) =>
      new BrowserMcpPreparationError({
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.map(
      (cliPath) =>
        ({
          name: BROWSER_MCP_SERVER_NAME,
          command: process.execPath,
          args: [cliPath, "--cdp-endpoint", cdpUrl],
          environment: {
            [SALCHI_BROWSER_CDP_URL_ENV]: cdpUrl,
          },
        }) satisfies PreparedBrowserMcpServer,
    ),
    Effect.catch((cause) =>
      Effect.logWarning("browser.mcp.prepare-failed", {
        package: `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
        detail: cause.detail,
      }).pipe(Effect.as(undefined)),
    ),
  );
}
