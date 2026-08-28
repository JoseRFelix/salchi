/**
 * Optional end-to-end probe for Claude SDK -> Playwright MCP -> Salchi CDP proxy -> Chromium.
 * Enable with: SALCHI_BROWSER_INTEGRATION=1 vp run test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@salchi/contracts";
import * as NetService from "@salchi/shared/Net";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect } from "vitest";

import { makeBrowserAgentBrokerWithOptions } from "./Layers/BrowserAgentBroker.ts";
import { makeBrowserSessionManagerWithOptions } from "./Layers/BrowserSessionManager.ts";
import { launchPlaywrightBrowser } from "./PlaywrightBrowserRuntime.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_MCP_USAGE_INSTRUCTION,
  prepareBrowserMcpServer,
} from "./BrowserMcp.ts";

const integrationThreadId = ThreadId.make("claude-browser-mcp-integration");

const idlePrompt = {
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
    };
  },
};

describe.runIf(process.env.SALCHI_BROWSER_INTEGRATION === "1")(
  "Claude browser MCP integration probe",
  () => {
    it.live("lists Playwright browser tools in a Claude provider session", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const netService = yield* NetService.NetService;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "salchi-claude-browser-mcp-",
        });
        const manager = yield* makeBrowserSessionManagerWithOptions({
          threadExists: () => Effect.succeed(true),
          getLaunchConfig: () =>
            Effect.succeed({
              idleTimeoutMillis: 60_000,
              screencastQuality: 45,
              screencastEveryNthFrame: 2,
              userDataDirectory: path.join(root, "profile"),
              processRegistryDirectory: path.join(root, "processes"),
              environmentExecutablePath: process.env.SALCHI_BROWSER_PATH,
              noSandbox: process.env.SALCHI_BROWSER_NO_SANDBOX === "1",
              serverHost: "127.0.0.1",
              serverPort: 3773,
            }),
          launchRuntime: (input) =>
            launchPlaywrightBrowser(input).pipe(
              Effect.provideService(NetService.NetService, netService),
            ),
        });
        const broker = yield* makeBrowserAgentBrokerWithOptions({
          browserManager: manager,
          accessEnabled: Effect.succeed(true),
        });
        const access = yield* broker.acquireSessionAccess(integrationThreadId);
        yield* Effect.addFinalizer(() => access.release);
        const browserMcpServer = yield* prepareBrowserMcpServer(access.environment);
        if (browserMcpServer === undefined) {
          return yield* Effect.die("The installed Playwright MCP package could not be prepared.");
        }

        const session = yield* Effect.acquireRelease(
          Effect.sync(() =>
            query({
              prompt: idlePrompt,
              options: {
                cwd: root,
                pathToClaudeCodeExecutable:
                  process.env.SALCHI_CLAUDE_PATH ?? process.env.CLAUDE_PATH ?? "claude",
                env: { ...process.env, ...access.environment },
                settingSources: [],
                systemPrompt: {
                  type: "preset",
                  preset: "claude_code",
                  append: BROWSER_MCP_USAGE_INSTRUCTION,
                },
                mcpServers: {
                  [BROWSER_MCP_SERVER_NAME]: {
                    type: "stdio",
                    command: browserMcpServer.command,
                    args: [...browserMcpServer.args],
                    env: { ...browserMcpServer.environment },
                  },
                },
              },
            }),
          ),
          (session) => Effect.sync(() => session.close()),
        );

        // Dynamic MCP servers stay pending until first use so provider startup
        // does not eagerly launch Chromium. Explicit reconnect simulates that
        // first use without sending a paid model request.
        yield* Effect.promise(() => session.reconnectMcpServer(BROWSER_MCP_SERVER_NAME)).pipe(
          Effect.timeout("30 seconds"),
        );
        const waitForConnectedStatus = (
          attempts: number,
        ): Effect.Effect<Awaited<ReturnType<typeof session.mcpServerStatus>>> =>
          Effect.gen(function* () {
            const statuses = yield* Effect.promise(() => session.mcpServerStatus());
            const browserStatus = statuses.find(
              (status) => status.name === BROWSER_MCP_SERVER_NAME,
            );
            if (browserStatus?.status === "connected" || attempts <= 0) return statuses;
            yield* Effect.sleep("100 millis");
            return yield* waitForConnectedStatus(attempts - 1);
          });
        const statuses = yield* waitForConnectedStatus(100).pipe(Effect.timeout("30 seconds"));
        expect(statuses).toContainEqual(
          expect.objectContaining({
            name: BROWSER_MCP_SERVER_NAME,
            status: "connected",
          }),
        );

        const contextUsage = yield* Effect.promise(() => session.getContextUsage()).pipe(
          Effect.timeout("30 seconds"),
        );
        expect(
          contextUsage.mcpTools.some(
            (tool) => tool.serverName === BROWSER_MCP_SERVER_NAME && tool.name.length > 0,
          ),
        ).toBe(true);
        // Listing MCP tools prepares the stdio server but does not use a
        // browser tool, so Chromium must remain lazy at this point.
        expect((yield* manager.getState(integrationThreadId)).status).toBe("stopped");
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NetService.layer, NodeServices.layer))),
    );
  },
);
