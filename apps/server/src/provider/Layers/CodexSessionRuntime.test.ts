import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS,
  INDEPENDENT_THREAD_TOOL_SPEC,
} from "../IndependentThreadTool.ts";
import {
  buildTurnStartParams,
  buildTurnSteerParams,
  isRecoverableThreadResumeError,
  openCodexThread,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: threadId,
      cliVersion: "0.0.0-test",
      createdAt: 1_713_398_400,
      cwd: "/tmp/project",
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "appServer",
      turns: [],
      status: {
        type: "idle",
      },
      updatedAt: 1_713_398_400,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("Codex developer instructions", () => {
  it("advertises independent thread creation in both collaboration modes", () => {
    assert.ok(
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS.includes(INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS),
    );
    assert.ok(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS.includes(
        INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS,
      ),
    );
  });
});

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes PDF attachments as mention inputs", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Read this",
        attachments: [
          {
            type: "mention",
            name: "report.pdf",
            path: "/tmp/report.pdf",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params.input, [
      {
        type: "text",
        text: "Read this",
      },
      {
        type: "mention",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
  });

  it("includes automatic approval review when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        approvalsReviewer: "auto_review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildTurnSteerParams", () => {
  it("includes the active-turn precondition and client message id", () => {
    const params = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-1"),
        messageId: MessageId.make("message-2"),
        prompt: "Change course",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "message-2",
      input: [
        { type: "text", text: "Change course" },
        { type: "image", url: "data:image/png;base64,abc" },
      ],
    });
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it("registers the independent thread dynamic tool when starting a new thread", async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      raw: {
        request: (method: string, payload?: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(started);
        },
      },
      request: <M extends "thread/start" | "thread/resume">(
        _method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]),
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        approvalsReviewer: undefined,
        resumeThreadId: undefined,
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(calls, [
      {
        method: "thread/start",
        payload: {
          cwd: "/tmp/project",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          dynamicTools: [INDEPENDENT_THREAD_TOOL_SPEC],
          model: "gpt-5.3-codex",
        },
      },
    ]);
  });

  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      raw: {
        request: (method: string, payload?: unknown) => {
          calls.push({ method: method as "thread/start" | "thread/resume", payload });
          return Effect.succeed(started);
        },
      },
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        approvalsReviewer: "auto_review",
        resumeThreadId: "stale-thread",
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
    assert.deepStrictEqual(calls[0]?.payload, {
      threadId: "stale-thread",
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5.3-codex",
      approvalsReviewer: "auto_review",
    });
    assert.deepStrictEqual(calls[1]?.payload, {
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      dynamicTools: [INDEPENDENT_THREAD_TOOL_SPEC],
      model: "gpt-5.3-codex",
      approvalsReviewer: "auto_review",
    });
  });

  it("propagates non-recoverable resume failures", async () => {
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      raw: {
        request: (_method: string, _payload?: unknown) => Effect.succeed(started),
      },
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          approvalsReviewer: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        isCodexAppServerRequestError(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
