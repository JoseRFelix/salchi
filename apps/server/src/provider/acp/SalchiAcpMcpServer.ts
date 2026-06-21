import type * as EffectAcpSchema from "effect-acp/schema";

import {
  INDEPENDENT_THREAD_MCP_SERVER_NAME,
  INDEPENDENT_THREAD_TOOL_DESCRIPTION,
  INDEPENDENT_THREAD_TOOL_INPUT_SCHEMA,
  INDEPENDENT_THREAD_TOOL_MCP_INSTRUCTIONS,
  INDEPENDENT_THREAD_TOOL_NAME,
  INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
} from "../IndependentThreadTool.ts";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SALCHI_ACP_MCP_SERVER_VERSION = "0.1.0";

const SALCHI_ACP_MCP_SERVER_SCRIPT = `
import { createInterface } from "node:readline";

const protocolVersion = ${JSON.stringify(MCP_PROTOCOL_VERSION)};
const serverName = ${JSON.stringify(INDEPENDENT_THREAD_MCP_SERVER_NAME)};
const serverVersion = ${JSON.stringify(SALCHI_ACP_MCP_SERVER_VERSION)};
const toolName = ${JSON.stringify(INDEPENDENT_THREAD_TOOL_NAME)};
const toolDescription = ${JSON.stringify(INDEPENDENT_THREAD_TOOL_DESCRIPTION)};
const toolInputSchema = ${JSON.stringify(INDEPENDENT_THREAD_TOOL_INPUT_SCHEMA)};
const toolResultMarker = ${JSON.stringify(INDEPENDENT_THREAD_TOOL_RESULT_MARKER)};
const instructions = ${JSON.stringify(INDEPENDENT_THREAD_TOOL_MCP_INSTRUCTIONS)};

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function normalizeArgs(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }

  const { id, method, params } = request;
  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: serverVersion },
          instructions,
        });
        break;
      case "notifications/initialized":
        break;
      case "ping":
        respond(id, {});
        break;
      case "tools/list":
        respond(id, {
          tools: [
            {
              name: toolName,
              description: toolDescription,
              inputSchema: toolInputSchema,
              annotations: {
                title: "Create independent Salchi thread",
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
              },
            },
          ],
        });
        break;
      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        if (name !== toolName) {
          fail(id, -32602, "Unknown tool: " + name);
          break;
        }
        const args = normalizeArgs(params?.arguments);
        const structuredContent = {
          type: toolResultMarker,
          version: 1,
          arguments: args,
        };
        respond(id, {
          content: [
            {
              type: "text",
              text: toolResultMarker + " " + JSON.stringify(structuredContent),
            },
          ],
          structuredContent,
        });
        break;
      }
      default:
        fail(id, -32601, "Method not found: " + String(method));
        break;
    }
  } catch (error) {
    fail(id, -32603, error instanceof Error ? error.message : "Internal error");
  }
}
`.trim();

export function makeSalchiAcpMcpServers(): ReadonlyArray<EffectAcpSchema.McpServer> {
  return [
    {
      name: INDEPENDENT_THREAD_MCP_SERVER_NAME,
      command: process.execPath,
      args: ["--input-type=module", "--eval", SALCHI_ACP_MCP_SERVER_SCRIPT],
      env: [],
    },
  ];
}
