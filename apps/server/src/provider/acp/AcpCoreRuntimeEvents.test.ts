import { ProviderDriverKind, RuntimeRequestId, TurnId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpIndependentThreadCreatedEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { INDEPENDENT_THREAD_TOOL_RESULT_MARKER } from "../IndependentThreadTool.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });

  it("maps completed Salchi MCP tool output to an independent thread event", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-06-21T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const marker = {
      type: INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
      version: 1,
      arguments: {
        title: "ACP audit",
        initialPrompt: "Audit from ACP.",
        threadId: "thread-acp-audit",
        checkoutMode: "worktree",
        branch: "feature/acp-audit",
        worktreePath: "/tmp/acp-audit",
      },
    };

    const event = makeAcpIndependentThreadCreatedEvent({
      stamp,
      provider: ProviderDriverKind.make("cursor"),
      threadId: "thread-source" as never,
      turnId,
      toolCall: {
        toolCallId: "tool-1",
        status: "completed",
        data: {
          rawOutput: {
            content: [
              {
                type: "text",
                text: `${INDEPENDENT_THREAD_TOOL_RESULT_MARKER} ${JSON.stringify(marker)}`,
              },
            ],
          },
        },
      },
      rawPayload: { sessionId: "session-1" },
    });

    expect(event).toMatchObject({
      type: "thread.independent.created",
      threadId: "thread-source",
      itemId: "tool-1",
      payload: {
        threadId: "thread-acp-audit",
        title: "ACP audit",
        initialPrompt: "Audit from ACP.",
        branch: "feature/acp-audit",
        worktreePath: "/tmp/acp-audit",
      },
      raw: {
        source: "acp.jsonrpc",
        method: "session/update",
      },
    });
  });

  it("ignores incomplete ACP Salchi MCP tool updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-06-21T00:00:00.000Z" };

    expect(
      makeAcpIndependentThreadCreatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-source" as never,
        turnId: undefined,
        toolCall: {
          toolCallId: "tool-1",
          status: "inProgress",
          data: {
            rawOutput: {
              structuredContent: {
                type: INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
                version: 1,
                arguments: {
                  title: "ACP audit",
                  initialPrompt: "Audit from ACP.",
                },
              },
            },
          },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toBeUndefined();
  });
});
