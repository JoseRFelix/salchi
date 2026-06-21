// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  INDEPENDENT_THREAD_TOOL_NAME,
  INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
} from "../IndependentThreadTool.ts";
import { makeSalchiAcpMcpServers } from "./SalchiAcpMcpServer.ts";

async function runMcpRequest(request: unknown): Promise<Record<string, unknown>> {
  const [server] = makeSalchiAcpMcpServers();
  if (!server || !("command" in server)) {
    throw new Error("Expected Salchi ACP MCP server config");
  }

  const child = spawn(server.command, Array.from(server.args), {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`MCP server exited with ${exitCode}: ${stderr}`);
  }

  const [line] = stdout.trim().split(/\r?\n/);
  if (!line) {
    throw new Error("Expected MCP server response");
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe("SalchiAcpMcpServer", () => {
  it("rejects create_thread calls with missing required arguments", async () => {
    const response = await runMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: INDEPENDENT_THREAD_TOOL_NAME,
        arguments: { title: "Missing prompt" },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "Invalid arguments: title and initialPrompt are required.",
      },
    });
  });

  it("returns the independent-thread marker for valid create_thread calls", async () => {
    const response = await runMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: INDEPENDENT_THREAD_TOOL_NAME,
        arguments: {
          title: "Investigate",
          initialPrompt: "Check the reconnect flow.",
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        structuredContent: {
          type: INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
          version: 1,
          arguments: {
            title: "Investigate",
            initialPrompt: "Check the reconnect flow.",
          },
        },
      },
    });
  });
});
