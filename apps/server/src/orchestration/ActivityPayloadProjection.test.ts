import {
  EventId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
} from "@salchi/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

function activity(
  id: string,
  kind: string,
  payload: unknown,
  turnId = "turn-a",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind,
    summary: "File change",
    payload,
    turnId: TurnId.make(turnId),
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function snapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadDetailSnapshot {
  return {
    snapshotSequence: 7,
    thread: { activities },
  } as unknown as OrchestrationThreadDetailSnapshot;
}

describe("activity payload projection", () => {
  it("slims Codex-shaped MCP results to renderable fields and a short summary", () => {
    const projected = projectActivityPayload(
      activity("mcp-1", "tool.completed", {
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5_000)}` }],
              structuredContent: { huge: "y".repeat(5_000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;

    expect(item).toMatchObject({
      tool: "fetch_pr",
      server: "github",
      arguments: { pr: 42 },
      result: { content: "PR body line one" },
    });
    expect(item._meta).toBeUndefined();
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped MCP results", () => {
    const projected = projectActivityPayload(
      activity("mcp-2", "tool.completed", {
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            content: [{ type: "text", text: `first line\n${"z".repeat(5_000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;

    expect(data).toEqual({
      toolName: "mcp__github__fetch_pr",
      input: { pr: 42 },
      result: { content: "first line" },
    });
  });

  it("drops tool updates superseded by a later completion in the same turn", () => {
    const update = activity("update", "tool.updated", {
      itemType: "file_change",
      title: "File change",
      data: { toolCallId: "call-1", patch: "large".repeat(1_000) },
    });
    const complete = activity("complete", "tool.completed", {
      itemType: "file_change",
      title: "File change completed",
      data: { toolCallId: "call-1", filePath: "src/app.ts" },
    });

    const projected = projectThreadDetailSnapshot(snapshot([update, complete]));
    expect(projected.thread.activities.map(({ id }) => id)).toEqual([complete.id]);
  });

  it("keeps updates when the completion belongs to another turn", () => {
    const update = activity("update", "tool.updated", {
      itemType: "file_change",
      data: { toolCallId: "call-1" },
    });
    const complete = activity(
      "complete",
      "tool.completed",
      { itemType: "file_change", data: { toolCallId: "call-1" } },
      "turn-b",
    );

    expect(
      projectThreadDetailSnapshot(snapshot([update, complete])).thread.activities,
    ).toHaveLength(2);
  });
});
