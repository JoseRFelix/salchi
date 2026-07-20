import assert from "node:assert/strict";

import { EventId, ProviderDriverKind, ThreadId } from "@salchi/contracts";
import { describe, it } from "vitest";

import {
  INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS,
  INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
  INDEPENDENT_THREAD_TOOL_NAME,
  INDEPENDENT_THREAD_TOOL_NAMESPACE,
  INDEPENDENT_THREAD_TOOL_SPEC,
  createIndependentThreadToolRuntimeResult,
  isIndependentThreadToolCall,
  makeIndependentThreadCreatedRuntimeEvent,
  parseIndependentThreadToolArguments,
} from "./IndependentThreadTool.ts";

describe("IndependentThreadTool", () => {
  it("defines the provider-neutral dynamic tool contract", () => {
    assert.equal(INDEPENDENT_THREAD_TOOL_SPEC.name, INDEPENDENT_THREAD_TOOL_NAME);
    assert.equal(INDEPENDENT_THREAD_TOOL_SPEC.namespace, INDEPENDENT_THREAD_TOOL_NAMESPACE);
    assert.match(INDEPENDENT_THREAD_TOOL_SPEC.description, /independent top-level Salchi thread/);
    assert.deepEqual(INDEPENDENT_THREAD_TOOL_SPEC.inputSchema.required, ["title", "initialPrompt"]);
    assert.ok("checkoutMode" in INDEPENDENT_THREAD_TOOL_SPEC.inputSchema.properties);
    assert.ok("worktreePath" in INDEPENDENT_THREAD_TOOL_SPEC.inputSchema.properties);
    assert.ok("projectRoot" in INDEPENDENT_THREAD_TOOL_SPEC.inputSchema.properties);
    assert.match(INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS, /create_thread/);
    assert.match(INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS, /not a subagent/);
    assert.match(INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS, /checkoutMode/);
    assert.match(INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS, /projectRoot/);
  });

  it("matches the canonical tool name and legacy aliases", () => {
    assert.equal(isIndependentThreadToolCall({ namespace: "salchi", tool: "create_thread" }), true);
    assert.equal(isIndependentThreadToolCall({ tool: "createThread" }), true);
    assert.equal(isIndependentThreadToolCall({ namespace: "other", tool: "create_thread" }), false);
    assert.equal(isIndependentThreadToolCall({ namespace: "salchi", tool: "unknown" }), false);
  });

  it("parses tool arguments with legacy field names", () => {
    const parsed = parseIndependentThreadToolArguments({
      name: "Retry audit",
      input: "Review retry behavior.",
      titleSeed: "retry",
      threadId: "thread-independent-1",
      checkoutMode: "worktree",
      branch: "feature/retry-audit",
      worktreePath: "/tmp/retry-audit",
      projectRoot: "/tmp/other-project",
    });

    assert.equal(parsed.title, "Retry audit");
    assert.equal(parsed.initialPrompt, "Review retry behavior.");
    assert.equal(parsed.titleSeed, "retry");
    assert.equal(parsed.requestedThreadId, "thread-independent-1");
    assert.equal(parsed.checkoutMode, "worktree");
    assert.equal(parsed.branch, "feature/retry-audit");
    assert.equal(parsed.worktreePath, "/tmp/retry-audit");
    assert.equal(parsed.workspaceRoot, "/tmp/other-project");
  });

  it("rejects malformed tool arguments before creating a payload", () => {
    assert.throws(
      () => parseIndependentThreadToolArguments(null),
      /create_thread arguments must be an object/,
    );
    assert.throws(
      () => parseIndependentThreadToolArguments({ title: "Missing prompt" }),
      /create_thread requires a non-empty initialPrompt/,
    );
    assert.throws(
      () => parseIndependentThreadToolArguments({ initialPrompt: "Missing title" }),
      /create_thread requires a non-empty title/,
    );
  });

  it("parses local checkout mode as an explicit worktree clear", () => {
    const parsed = parseIndependentThreadToolArguments({
      title: "Local checkout task",
      initialPrompt: "Run in the project root.",
      checkoutMode: "local",
      worktreePath: "/tmp/ignored-worktree",
    });

    assert.equal(parsed.checkoutMode, "local");
    assert.equal(parsed.branch, null);
    assert.equal(parsed.worktreePath, null);
  });

  it("builds a reusable runtime result for provider tool handlers", () => {
    const result = createIndependentThreadToolRuntimeResult({
      argumentsValue: {
        title: "Worktree audit",
        initialPrompt: "Audit the worktree implementation.",
        threadId: "thread-worktree-audit",
        checkoutMode: "worktree",
        branch: "feature/worktree-audit",
        worktreePath: "/tmp/worktree-audit",
        projectRoot: "/tmp/other-project",
      },
      sourceThreadId: ThreadId.make("thread-source"),
      idPrefix: "tool-call-1",
      sourceItemId: "tool-call-1",
      providerThreadId: "provider-thread-1",
    });

    assert.equal(result.structuredContent.type, INDEPENDENT_THREAD_TOOL_RESULT_MARKER);
    assert.equal(String(result.payload.threadId), "thread-worktree-audit");
    assert.equal(result.payload.title, "Worktree audit");
    assert.equal(result.payload.initialPrompt, "Audit the worktree implementation.");
    assert.equal(result.payload.branch, "feature/worktree-audit");
    assert.equal(result.payload.worktreePath, "/tmp/worktree-audit");
    assert.equal(result.payload.workspaceRoot, "/tmp/other-project");
    assert.equal(String(result.payload.createdByThreadId), "thread-source");
    assert.equal(String(result.payload.sourceItemId), "tool-call-1");
    assert.equal(result.payload.providerThreadId, "provider-thread-1");
  });

  it("builds the provider-neutral independent thread runtime event", () => {
    const event = makeIndependentThreadCreatedRuntimeEvent({
      provider: ProviderDriverKind.make("claudeAgent"),
      eventId: EventId.make("event-1"),
      createdAt: "2026-06-21T00:00:00.000Z",
      sourceThreadId: ThreadId.make("thread-source"),
      idPrefix: "tool-call-1",
      argumentsValue: {
        title: "Local checkout",
        initialPrompt: "Use the local checkout.",
        checkoutMode: "local",
      },
      sourceItemId: "tool-call-1",
    });

    assert.equal(event.type, "thread.independent.created");
    assert.equal(String(event.threadId), "thread-source");
    assert.equal(String(event.itemId), "tool-call-1");
    assert.equal(event.payload.title, "Local checkout");
    assert.equal(event.payload.branch, null);
    assert.equal(event.payload.worktreePath, null);
  });
});
