// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  type CodexAppServerClientHandle,
  type CodexSpawnedChildThreadListOptions,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import { makeCodexAdapter } from "./CodexAdapter.ts";
import {
  codexChildThreadId,
  extractCodexSubagentMetadata,
  extractCodexThreadSpawnMetadata,
} from "./CodexChildThreads.ts";
import { INDEPENDENT_THREAD_TOOL_METHOD } from "../IndependentThreadTool.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "salchi/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

function makeCodexSpawnedThread(input: {
  readonly providerThreadId: string;
  readonly providerParentThreadId: string;
  readonly nickname?: string | undefined;
  readonly role?: string | undefined;
  readonly path?: string | undefined;
}): Record<string, unknown> {
  return {
    id: input.providerThreadId,
    cliVersion: "test",
    createdAt: 1_778_000_000,
    cwd: process.cwd(),
    ephemeral: false,
    modelProvider: "openai",
    preview: "",
    sessionId: "session-1",
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: input.providerParentThreadId,
          agent_nickname: input.nickname ?? null,
          agent_role: input.role ?? null,
          agent_path: input.path ?? null,
          depth: 1,
        },
      },
    },
    status: { type: "idle" },
    turns: [],
    updatedAt: 1_778_000_000,
  };
}

function makeCodexChildThreadStartedEvent(input: {
  readonly eventId: string;
  readonly threadId: ThreadId;
  readonly providerThreadId: string;
  readonly parentThreadId: ThreadId;
  readonly providerParentThreadId?: string | undefined;
  readonly nickname?: string | undefined;
  readonly role?: string | undefined;
  readonly path?: string | undefined;
}): ProviderEvent {
  const providerParentThreadId = input.providerParentThreadId ?? "provider-thread-1";
  return {
    id: asEventId(input.eventId),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    createdAt: "2026-01-01T00:00:00.000Z",
    method: "thread/started",
    threadId: input.threadId,
    payload: {
      thread: makeCodexSpawnedThread({
        providerThreadId: input.providerThreadId,
        providerParentThreadId,
        nickname: input.nickname,
        role: input.role,
        path: input.path,
      }),
      salchiParentThreadId: input.parentThreadId,
    },
  };
}

function makeCollabAgentCompletedEvent(input: {
  readonly eventId: string;
  readonly itemId: string;
  readonly threadId: ThreadId;
  readonly tool: "spawnAgent" | "wait" | "closeAgent";
  readonly receiverThreadIds: readonly string[];
  readonly status?: string | undefined;
  readonly nickname?: string | undefined;
  readonly role?: string | undefined;
  readonly path?: string | undefined;
  readonly prompt?: string | undefined;
}): ProviderEvent {
  const agentsStates = Object.fromEntries(
    input.receiverThreadIds.map((receiverThreadId) => [
      receiverThreadId,
      {
        status: "running",
        ...(input.nickname ? { agentNickname: input.nickname } : {}),
        ...(input.role ? { agentRole: input.role } : {}),
        ...(input.path ? { agentPath: input.path } : {}),
      },
    ]),
  );
  return {
    id: asEventId(input.eventId),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    createdAt: "2026-01-01T00:00:00.000Z",
    method: "item/completed",
    threadId: input.threadId,
    turnId: asTurnId("turn-1"),
    itemId: asItemId(input.itemId),
    payload: {
      completedAtMs: 1_778_000_000_000,
      threadId: String(input.threadId),
      turnId: "turn-1",
      item: {
        type: "collabAgentToolCall",
        id: input.itemId,
        agentsStates,
        model: "gpt-5",
        prompt: input.prompt ?? "Run the subagent",
        reasoningEffort: null,
        receiverThreadIds: [...input.receiverThreadIds],
        senderThreadId: String(input.threadId),
        status: input.status ?? "completed",
        tool: input.tool,
      },
    },
  };
}

it("maps Codex child provider thread ids to deterministic Salchi thread ids", () => {
  const first = codexChildThreadId(ProviderInstanceId.make("codex-main"), "provider-child");
  const second = codexChildThreadId(ProviderInstanceId.make("codex-main"), "provider-child");
  const differentInstance = codexChildThreadId(
    ProviderInstanceId.make("codex-other"),
    "provider-child",
  );

  assert.equal(first, second);
  assert.match(first, /^codex-child-[a-f0-9]{32}$/);
  assert.notEqual(first, differentInstance);
});

it("extracts Codex thread_spawn metadata from thread objects", () => {
  const metadata = extractCodexThreadSpawnMetadata({
    id: "provider-child",
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: "provider-parent",
          agent_nickname: "planner",
          agent_role: "Planning",
          agent_path: "agents/planner.md",
          depth: 1,
        },
      },
    },
  });

  assert.deepEqual(metadata, {
    providerParentThreadId: "provider-parent",
    subagentKind: "thread_spawn",
    subagentNickname: "planner",
    subagentRole: "Planning",
    subagentPath: "agents/planner.md",
    hiddenFromThreadList: false,
  });
});

it("extracts Codex thread_spawn metadata from alternate persisted shapes", () => {
  assert.deepEqual(
    extractCodexThreadSpawnMetadata({
      id: "provider-child-lowercase",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "provider-parent",
            agent_nickname: "aquinas",
          },
        },
      },
    }),
    {
      providerParentThreadId: "provider-parent",
      subagentKind: "thread_spawn",
      subagentNickname: "aquinas",
      hiddenFromThreadList: false,
    },
  );

  assert.deepEqual(
    extractCodexThreadSpawnMetadata({
      id: "provider-child-json",
      source: JSON.stringify({
        subagent: {
          thread_spawn: {
            parent_thread_id: "provider-parent",
            agent_role: "Research",
          },
        },
      }),
    }),
    {
      providerParentThreadId: "provider-parent",
      subagentKind: "thread_spawn",
      subagentRole: "Research",
      hiddenFromThreadList: false,
    },
  );

  assert.deepEqual(
    extractCodexThreadSpawnMetadata({
      id: "provider-child-top-level",
      threadSource: "subagent",
      parent_thread_id: "provider-parent",
      agent_nickname: "noether",
      agent_role: "Math",
    }),
    {
      providerParentThreadId: "provider-parent",
      subagentKind: "thread_spawn",
      subagentNickname: "noether",
      subagentRole: "Math",
      hiddenFromThreadList: false,
    },
  );
});

it("keeps Codex review, compact, and memory subagents hidden", () => {
  for (const subagentKind of ["review", "compact", "memory_consolidation"]) {
    assert.deepEqual(
      extractCodexSubagentMetadata({
        id: `provider-${subagentKind}`,
        source: {
          subAgent: subagentKind,
        },
      }),
      {
        subagentKind,
        hiddenFromThreadList: true,
      },
    );
  }
});

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.resumeCursor ? { resumeCursor: this.options.resumeCursor } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );
  public readonly sendTurnToProviderThreadImpl = vi.fn(
    (
      providerThreadId: string,
      _input: CodexSessionRuntimeSendTurnInput,
    ): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId:
          providerThreadId === this.options.resumeCursor?.threadId
            ? this.options.threadId
            : asThreadId(`child:${providerThreadId}`),
        turnId: asTurnId("turn-1"),
        resumeCursor: { threadId: providerThreadId },
      }),
  );

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );
  public readonly interruptProviderThreadTurnImpl = vi.fn(
    (_providerThreadId: string, _turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );
  public readonly readProviderThreadImpl = vi.fn(
    (providerThreadId: string): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: providerThreadId,
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );
  public readonly rollbackProviderThreadImpl = vi.fn(
    (providerThreadId: string, _numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: providerThreadId,
        turns: [],
      }),
  );

  public readonly registerProviderThreadBindingImpl = vi.fn(
    (_input: {
      readonly providerThreadId: string;
      readonly threadId: ThreadId;
      readonly parentThreadId?: ThreadId;
    }): Promise<void> => Promise.resolve(undefined),
  );
  public readonly listSpawnedChildThreadsImpl = vi.fn(
    (
      _parentProviderThreadId: string,
      _options?: CodexSpawnedChildThreadListOptions,
    ): Promise<ReadonlyArray<EffectCodexSchema.V2ThreadListResponse["data"][number]>> =>
      Promise.resolve([]),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  registerProviderThreadBinding(input: {
    readonly providerThreadId: string;
    readonly threadId: ThreadId;
    readonly parentThreadId?: ThreadId;
  }) {
    return Effect.promise(() => this.registerProviderThreadBindingImpl(input));
  }

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  sendTurnToProviderThread(providerThreadId: string, input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnToProviderThreadImpl(providerThreadId, input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  interruptProviderThreadTurn(providerThreadId: string, turnId?: TurnId) {
    return Effect.promise(() => this.interruptProviderThreadTurnImpl(providerThreadId, turnId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  readProviderThread(providerThreadId: string) {
    return Effect.promise(() => this.readProviderThreadImpl(providerThreadId));
  }

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  rollbackProviderThread(providerThreadId: string, numTurns: number) {
    return Effect.promise(() => this.rollbackProviderThreadImpl(providerThreadId, numTurns));
  }

  listSpawnedChildThreads(
    _parentProviderThreadId: string,
    _options?: CodexSpawnedChildThreadListOptions,
  ) {
    return Effect.promise(() =>
      this.listSpawnedChildThreadsImpl(_parentProviderThreadId, _options),
    );
  }

  readonly refreshUsage = Effect.void;

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
          { id: "autoReview", value: true },
        ]),
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        approvalsReviewer: "auto_review",
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
            { id: "autoReview", value: false },
          ]),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
        approvalsReviewer: "user",
      });
    }),
  );

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "flex" },
              { id: "autoReview", value: true },
            ],
          ),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "flex",
        approvalsReviewer: "auto_review",
      });
    }).pipe(Effect.provide(customLayer));
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    assert.ok(runtime);
    return { adapter, runtime };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps Codex collab agent tool calls to subagent started events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-subagent-spawn"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("collab_1"),
        payload: {
          startedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            id: "collab_1",
            agentsStates: {
              "child-thread-1": {
                status: "running",
                agentPath: "agents/Mill.md",
              },
            },
            model: "gpt-5",
            prompt: "Inspect the failing tests",
            reasoningEffort: null,
            receiverThreadIds: ["child-thread-1"],
            senderThreadId: "thread-1",
            status: "inProgress",
            tool: "spawnAgent",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.length, 2);

      const itemEvent = events[0];
      assert.equal(itemEvent?.type, "item.started");
      if (itemEvent?.type === "item.started") {
        assert.equal(itemEvent.payload.itemType, "collab_agent_tool_call");
      }

      const subagentEvent = events[1];
      assert.equal(subagentEvent?.type, "subagent.started");
      if (subagentEvent?.type === "subagent.started") {
        assert.equal(subagentEvent.payload.subagentId, "child-thread-1");
        assert.equal(subagentEvent.payload.providerThreadId, "child-thread-1");
        assert.equal(subagentEvent.payload.sourceItemId, "collab_1");
        assert.equal(subagentEvent.payload.model, "gpt-5");
        assert.equal(subagentEvent.payload.prompt, "Inspect the failing tests");
        assert.equal(subagentEvent.payload.role, "agents/Mill.md");
        assert.equal(subagentEvent.payload.nickname, "Mill");
        assert.equal(subagentEvent.payload.status, "running");
      }
    }),
  );

  it.effect("hydrates collab-agent spawn receiver children immediately", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const parentThreadId = asThreadId("thread-live-spawn-parent");
      const providerParentThreadId = "provider-parent-live-spawn";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        resumeCursor: { threadId: providerParentThreadId },
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const providerChildThreadId = "provider-child-bohr";
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        providerChildThreadId,
      );
      runtime.listSpawnedChildThreadsImpl.mockImplementation(() =>
        Promise.resolve([
          makeCodexSpawnedThread({
            providerThreadId: "provider-child-unrelated",
            providerParentThreadId,
            nickname: "Unrelated",
          }) as EffectCodexSchema.V2ThreadListResponse["data"][number],
          makeCodexSpawnedThread({
            providerThreadId: providerChildThreadId,
            providerParentThreadId,
            nickname: "Bohr",
            role: "default",
            path: "agents/Bohr.md",
          }) as EffectCodexSchema.V2ThreadListResponse["data"][number],
        ]),
      );

      const threadStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.started" &&
            event.payload.providerThreadId === providerChildThreadId,
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-spawn-bohr",
          itemId: "collab_bohr",
          threadId: parentThreadId,
          tool: "spawnAgent",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
          nickname: "Bohr",
          role: "default",
          path: "agents/Bohr.md",
        }),
      );

      const threadStartedOption = yield* Fiber.join(threadStartedFiber);
      assert.equal(threadStartedOption._tag, "Some");
      const threadStarted = threadStartedOption._tag === "Some" ? threadStartedOption.value : null;
      assert.ok(threadStarted);
      assert.equal(threadStarted.threadId, childThreadId);
      if (threadStarted.type === "thread.started") {
        assert.equal(threadStarted.payload.parentThreadId, parentThreadId);
        assert.equal(threadStarted.payload.providerThreadId, providerChildThreadId);
        assert.equal(threadStarted.payload.providerParentThreadId, providerParentThreadId);
        assert.equal(threadStarted.payload.subagentNickname, "Bohr");
        assert.equal(threadStarted.payload.subagentRole, "default");
      }

      assert.deepStrictEqual(
        runtime.registerProviderThreadBindingImpl.mock.calls
          .map(([input]) => ({
            providerThreadId: input.providerThreadId,
            threadId: input.threadId,
            parentThreadId: input.parentThreadId,
          }))
          .filter((binding) => binding.providerThreadId === providerChildThreadId),
        [
          {
            providerThreadId: providerChildThreadId,
            threadId: childThreadId,
            parentThreadId,
          },
        ],
      );
    }),
  );

  it.effect("materializes collab-agent receiver children when thread/list is empty", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const parentThreadId = asThreadId("thread-live-placeholder-parent");
      const providerParentThreadId = "provider-parent-live-placeholder";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        resumeCursor: { threadId: providerParentThreadId },
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const providerChildThreadId = "provider-child-placeholder";
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        providerChildThreadId,
      );
      runtime.listSpawnedChildThreadsImpl.mockResolvedValue([]);

      const threadStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.started" &&
            event.payload.providerThreadId === providerChildThreadId,
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-placeholder",
          itemId: "collab_placeholder",
          threadId: parentThreadId,
          tool: "spawnAgent",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
          prompt: "Your nickname is Aquinas. Work independently and report back.",
        }),
      );

      const threadStartedOption = yield* Fiber.join(threadStartedFiber);
      assert.equal(threadStartedOption._tag, "Some");
      const threadStarted = threadStartedOption._tag === "Some" ? threadStartedOption.value : null;
      assert.ok(threadStarted);
      assert.equal(threadStarted.threadId, childThreadId);
      if (threadStarted.type === "thread.started") {
        assert.equal(threadStarted.payload.parentThreadId, parentThreadId);
        assert.equal(threadStarted.payload.providerThreadId, providerChildThreadId);
        assert.equal(threadStarted.payload.providerParentThreadId, providerParentThreadId);
        assert.equal(threadStarted.payload.subagentKind, "thread_spawn");
        assert.equal(threadStarted.payload.hiddenFromThreadList, false);
        assert.equal(threadStarted.payload.subagentNickname, "Aquinas");
      }

      assert.deepStrictEqual(
        runtime.registerProviderThreadBindingImpl.mock.calls
          .map(([input]) => input.providerThreadId)
          .filter((providerThreadId) => providerThreadId === providerChildThreadId),
        [providerChildThreadId],
      );
    }),
  );

  it.effect("retries collab-agent child hydration from wait events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const parentThreadId = asThreadId("thread-live-wait-parent");
      const providerParentThreadId = "provider-parent-live-wait";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        resumeCursor: { threadId: providerParentThreadId },
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const providerChildThreadId = "provider-child-wait-bohr";
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        providerChildThreadId,
      );
      let candidateListCalls = 0;
      runtime.listSpawnedChildThreadsImpl.mockImplementation((_parentThreadId, options) => {
        if (!options?.candidateProviderThreadIds?.has(providerChildThreadId)) {
          return Promise.resolve([]);
        }
        candidateListCalls += 1;
        return Promise.resolve(
          candidateListCalls === 1
            ? []
            : [
                makeCodexSpawnedThread({
                  providerThreadId: providerChildThreadId,
                  providerParentThreadId,
                  nickname: "Bohr",
                  role: "default",
                }) as EffectCodexSchema.V2ThreadListResponse["data"][number],
              ],
        );
      });

      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-spawn-not-ready",
          itemId: "collab_wait_spawn",
          threadId: parentThreadId,
          tool: "spawnAgent",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
        }),
      );
      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-wait-ready",
          itemId: "collab_wait_ready",
          threadId: parentThreadId,
          tool: "wait",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
        }),
      );

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const threadStartedEvents = events.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 2);
      assert.equal(threadStartedEvents[0]?.threadId, childThreadId);
      assert.equal(threadStartedEvents[1]?.threadId, childThreadId);
      if (threadStartedEvents[0]?.type === "thread.started") {
        assert.equal(threadStartedEvents[0].payload.subagentNickname, undefined);
      }
      if (threadStartedEvents[1]?.type === "thread.started") {
        assert.equal(threadStartedEvents[1].payload.subagentNickname, "Bohr");
        assert.equal(threadStartedEvents[1].payload.subagentRole, "default");
      }
      assert.deepStrictEqual(
        runtime.registerProviderThreadBindingImpl.mock.calls.map(
          ([input]) => input.providerThreadId,
        ),
        [providerChildThreadId],
      );
    }),
  );

  it.effect("does not duplicate hydrated children from repeated wait and close events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const parentThreadId = asThreadId("thread-live-duplicate-parent");
      const providerParentThreadId = "provider-parent-live-duplicate";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        resumeCursor: { threadId: providerParentThreadId },
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const providerChildThreadId = "provider-child-duplicate-bohr";
      const childThread = makeCodexSpawnedThread({
        providerThreadId: providerChildThreadId,
        providerParentThreadId,
        nickname: "Bohr",
        role: "default",
      }) as EffectCodexSchema.V2ThreadListResponse["data"][number];
      runtime.listSpawnedChildThreadsImpl.mockResolvedValue([childThread]);

      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-duplicate-spawn",
          itemId: "collab_duplicate_spawn",
          threadId: parentThreadId,
          tool: "spawnAgent",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
          nickname: "Bohr",
          role: "default",
        }),
      );
      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-duplicate-wait",
          itemId: "collab_duplicate_wait",
          threadId: parentThreadId,
          tool: "wait",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
          nickname: "Bohr",
          role: "default",
        }),
      );
      yield* runtime.emit(
        makeCollabAgentCompletedEvent({
          eventId: "evt-collab-duplicate-close",
          itemId: "collab_duplicate_close",
          threadId: parentThreadId,
          tool: "closeAgent",
          receiverThreadIds: [providerChildThreadId],
          status: "completed",
          nickname: "Bohr",
          role: "default",
        }),
      );

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.filter((event) => event.type === "thread.started").length, 1);
      assert.deepStrictEqual(
        runtime.registerProviderThreadBindingImpl.mock.calls.map(
          ([input]) => input.providerThreadId,
        ),
        [providerChildThreadId],
      );
    }),
  );

  it.effect("maps Codex subagent activity items to terminal subagent events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-subagent-interrupted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("activity_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "subAgentActivity",
            id: "activity_1",
            agentPath: "root/reviewer.md",
            agentThreadId: "child-thread-1",
            kind: "interrupted",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.length, 2);

      const itemEvent = events[0];
      assert.equal(itemEvent?.type, "item.completed");
      if (itemEvent?.type === "item.completed") {
        assert.equal(itemEvent.payload.itemType, "collab_agent_tool_call");
      }

      const subagentEvent = events[1];
      assert.equal(subagentEvent?.type, "subagent.completed");
      if (subagentEvent?.type === "subagent.completed") {
        assert.equal(subagentEvent.payload.subagentId, "child-thread-1");
        assert.equal(subagentEvent.payload.status, "interrupted");
        assert.equal(subagentEvent.payload.role, "root/reviewer.md");
        assert.equal(subagentEvent.payload.nickname, "reviewer");
      }
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps completed Codex image generation raw response items to generated images", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-image-generated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "rawResponseItem/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("ig_1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "image_generation_call",
            id: "ig_1",
            status: "generating",
            result: "aGVsbG8=",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "image.generated");
      if (firstEvent.value.type !== "image.generated") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "ig_1");
      assert.equal(firstEvent.value.payload.name, "ig_1.png");
      assert.equal(firstEvent.value.payload.dataUrl, "data:image/png;base64,aGVsbG8=");
    }),
  );

  it.effect("maps completed Codex image generation lifecycle items to generated images", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-image-generation-item-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("ig_2"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "imageGeneration",
            id: "ig_2",
            status: "generating",
            result: "aGVsbG8=",
            revisedPrompt: "A generated test image",
            savedPath: "/tmp/ig_2.png",
          },
        },
      } satisfies ProviderEvent);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const generatedEvent = events[0];
      assert.equal(generatedEvent?.type, "image.generated");
      if (generatedEvent?.type === "image.generated") {
        assert.equal(generatedEvent.turnId, "turn-1");
        assert.equal(generatedEvent.itemId, "ig_2");
        assert.equal(generatedEvent.payload.name, "ig_2.png");
        assert.equal(generatedEvent.payload.dataUrl, "data:image/png;base64,aGVsbG8=");
      }

      const completedEvent = events[1];
      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        assert.equal(completedEvent.payload.itemType, "image_view");
      }
    }),
  );

  it.effect("maps started Codex image generation lifecycle items to generated images", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-image-generation-item-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("ig_started"),
        payload: {
          startedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "imageGeneration",
            id: "ig_started",
            status: "generating",
            result: "aGVsbG8=",
            revisedPrompt: "A generated test image",
            savedPath: null,
          },
        },
      } satisfies ProviderEvent);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const generatedEvent = events[0];
      assert.equal(generatedEvent?.type, "image.generated");
      if (generatedEvent?.type === "image.generated") {
        assert.equal(generatedEvent.turnId, "turn-1");
        assert.equal(generatedEvent.itemId, "ig_started");
        assert.equal(generatedEvent.payload.name, "ig_started.png");
        assert.equal(generatedEvent.payload.dataUrl, "data:image/png;base64,aGVsbG8=");
      }

      const startedEvent = events[1];
      assert.equal(startedEvent?.type, "item.started");
      if (startedEvent?.type === "item.started") {
        assert.equal(startedEvent.payload.itemType, "image_view");
        assert.equal(startedEvent.payload.status, "inProgress");
      }
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("registers Codex spawned child threads as virtual sessions", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        "provider-child-1",
      );
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit(
        makeCodexChildThreadStartedEvent({
          eventId: "evt-child-thread-started",
          threadId: childThreadId,
          providerThreadId: "provider-child-1",
          parentThreadId: asThreadId("thread-1"),
          nickname: "planner",
          role: "Planning",
          path: "agents/planner.md",
        }),
      );
      const event = yield* Fiber.join(eventFiber);

      assert.equal(event._tag, "Some");
      if (event._tag !== "Some") {
        return;
      }
      assert.equal(event.value.type, "thread.started");
      if (event.value.type === "thread.started") {
        assert.equal(event.value.threadId, childThreadId);
        assert.equal(event.value.payload.providerThreadId, "provider-child-1");
        assert.equal(event.value.payload.parentThreadId, "thread-1");
        assert.equal(event.value.payload.providerParentThreadId, "provider-thread-1");
        assert.equal(event.value.payload.subagentKind, "thread_spawn");
        assert.equal(event.value.payload.subagentNickname, "planner");
        assert.equal(event.value.payload.subagentRole, "Planning");
        assert.equal(event.value.payload.subagentPath, "agents/planner.md");
        assert.equal(event.value.payload.hiddenFromThreadList, false);
      }
      assert.equal(yield* adapter.hasSession(childThreadId), true);
      assert.deepStrictEqual(runtime.registerProviderThreadBindingImpl.mock.calls.at(-1)?.[0], {
        providerThreadId: "provider-child-1",
        threadId: childThreadId,
        parentThreadId: asThreadId("thread-1"),
      });
    }),
  );

  it.effect("routes child turns and thread operations to the child provider thread id", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        "provider-child-2",
      );
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit(
        makeCodexChildThreadStartedEvent({
          eventId: "evt-child-thread-routing",
          threadId: childThreadId,
          providerThreadId: "provider-child-2",
          parentThreadId: asThreadId("thread-1"),
        }),
      );
      yield* Fiber.join(eventFiber);

      const turn = yield* adapter.sendTurn({
        threadId: childThreadId,
        input: "continue in child",
        attachments: [],
      });
      const read = yield* adapter.readThread(childThreadId);
      const rolledBack = yield* adapter.rollbackThread(childThreadId, 1);
      yield* adapter.interruptTurn(childThreadId, asTurnId("turn-child-2"));

      assert.equal(turn.threadId, childThreadId);
      assert.equal(read.threadId, childThreadId);
      assert.equal(rolledBack.threadId, childThreadId);
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(runtime.sendTurnToProviderThreadImpl.mock.calls.at(-1)?.[0], "provider-child-2");
      assert.deepStrictEqual(runtime.sendTurnToProviderThreadImpl.mock.calls.at(-1)?.[1], {
        input: "continue in child",
      });
      assert.equal(runtime.readProviderThreadImpl.mock.calls.at(-1)?.[0], "provider-child-2");
      assert.equal(runtime.rollbackProviderThreadImpl.mock.calls.at(-1)?.[0], "provider-child-2");
      assert.equal(runtime.rollbackProviderThreadImpl.mock.calls.at(-1)?.[1], 1);
      assert.equal(
        runtime.interruptProviderThreadTurnImpl.mock.calls.at(-1)?.[0],
        "provider-child-2",
      );
      assert.equal(
        runtime.interruptProviderThreadTurnImpl.mock.calls.at(-1)?.[1],
        asTurnId("turn-child-2"),
      );
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          assert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps Salchi create-thread notifications to independent thread events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-salchi-create-thread"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: INDEPENDENT_THREAD_TOOL_METHOD,
        turnId: asTurnId("turn-1"),
        itemId: asItemId("tool-create-thread"),
        payload: {
          threadId: asThreadId("independent-thread-1"),
          title: "Investigate retry behavior",
          initialPrompt: "Review retry behavior and report findings.",
          initialMessageId: "codex-tool:tool-create-thread:initial-message",
          createdByThreadId: asThreadId("thread-1"),
          sourceItemId: asItemId("tool-create-thread"),
          branch: "feature/retry-behavior",
          worktreePath: "/tmp/retry-behavior-worktree",
          workspaceRoot: "/tmp/retry-behavior-project",
        },
      } satisfies ProviderEvent);

      const event = Option.getOrThrow(yield* Fiber.join(eventFiber));
      assert.equal(event.type, "thread.independent.created");
      if (event.type !== "thread.independent.created") {
        return;
      }
      assert.equal(event.threadId, "thread-1");
      assert.equal(event.turnId, "turn-1");
      assert.equal(event.itemId, "tool-create-thread");
      assert.deepEqual(event.payload, {
        threadId: asThreadId("independent-thread-1"),
        title: "Investigate retry behavior",
        createdByThreadId: asThreadId("thread-1"),
        initialPrompt: "Review retry behavior and report findings.",
        initialMessageId: "codex-tool:tool-create-thread:initial-message",
        sourceItemId: asItemId("tool-create-thread"),
        branch: "feature/retry-behavior",
        worktreePath: "/tmp/retry-behavior-worktree",
        workspaceRoot: "/tmp/retry-behavior-project",
      });
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );
});

it.effect("hydrates existing Codex spawned child threads via thread/list on root start", () => {
  const childThread = makeCodexSpawnedThread({
    providerThreadId: "provider-child-hydrated",
    providerParentThreadId: "provider-parent-hydrate",
    nickname: "researcher",
    role: "Research",
    path: "agents/researcher.md",
  });
  const hydratedRuntimes: FakeCodexRuntime[] = [];
  const hydratedRuntimeFactory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtime.listSpawnedChildThreadsImpl.mockImplementation(() =>
      Promise.resolve([childThread as EffectCodexSchema.V2ThreadListResponse["data"][number]]),
    );
    runtime.readProviderThreadImpl.mockImplementation((providerThreadId) =>
      Promise.resolve({
        threadId: providerThreadId,
        turns:
          providerThreadId === "provider-child-hydrated"
            ? [
                {
                  id: asTurnId("turn-child-hydrated"),
                  status: "completed",
                  startedAt: 1_778_000_001,
                  completedAt: 1_778_000_002,
                  items: [
                    {
                      id: "msg-child-hydrated",
                      text: "Child analysis complete.",
                      type: "agentMessage",
                    },
                  ],
                },
              ]
            : [],
      }),
    );
    hydratedRuntimes.push(runtime);
    return Effect.succeed(runtime);
  });
  const layer = Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: hydratedRuntimeFactory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const parentThreadId = asThreadId("thread-hydrate-parent");
    const childThreadId = codexChildThreadId(
      ProviderInstanceId.make("codex"),
      "provider-child-hydrated",
    );
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
      Effect.forkChild,
    );

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: parentThreadId,
      resumeCursor: { threadId: "provider-parent-hydrate" },
      runtimeMode: "full-access",
    });

    const events = Array.from(yield* Fiber.join(eventsFiber));
    const runtime = hydratedRuntimes[0];
    assert.ok(runtime);

    const threadStarted = events.find((event) => event.type === "thread.started");
    assert.ok(threadStarted);
    assert.equal(threadStarted.threadId, childThreadId);
    if (threadStarted.type === "thread.started") {
      assert.equal(threadStarted.payload.parentThreadId, parentThreadId);
      assert.equal(threadStarted.payload.providerThreadId, "provider-child-hydrated");
      assert.equal(threadStarted.payload.providerParentThreadId, "provider-parent-hydrate");
      assert.equal(threadStarted.payload.subagentNickname, "researcher");
      assert.equal(threadStarted.payload.subagentRole, "Research");
    }

    const assistantMessage = events.find(
      (event) =>
        event.type === "item.completed" &&
        event.itemId === "msg-child-hydrated" &&
        event.payload.itemType === "assistant_message",
    );
    assert.ok(assistantMessage);
    assert.equal(assistantMessage.threadId, childThreadId);
    if (assistantMessage.type === "item.completed") {
      assert.equal(assistantMessage.payload.detail, "Child analysis complete.");
    }

    assert.equal(yield* adapter.hasSession(childThreadId), true);
    assert.deepStrictEqual(
      runtime.listSpawnedChildThreadsImpl.mock.calls.map(([parentThreadId]) => parentThreadId),
      ["provider-parent-hydrate"],
    );
    assert.equal(runtime.listSpawnedChildThreadsImpl.mock.calls[0]?.[1]?.allowScanRepair, true);
    assert.deepStrictEqual(runtime.readProviderThreadImpl.mock.calls, [
      ["provider-child-hydrated"],
    ]);
    const sessions = yield* adapter.listSessions();
    const childSession = sessions.find((session) => session.threadId === childThreadId);
    assert.ok(childSession);
    assert.deepStrictEqual(childSession.resumeCursor, { threadId: "provider-child-hydrated" });
  }).pipe(Effect.provide(layer));
});

it.effect("backfills resumed materialized Codex child thread snapshots on direct start", () => {
  const resumedRuntimes: FakeCodexRuntime[] = [];
  const resumedRuntimeFactory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtime.readProviderThreadImpl.mockImplementation((providerThreadId) =>
      Promise.resolve({
        threadId: providerThreadId,
        turns:
          providerThreadId === "provider-child-resumed"
            ? [
                {
                  id: asTurnId("turn-child-resumed"),
                  status: "completed",
                  startedAt: 1_778_000_011,
                  completedAt: 1_778_000_012,
                  items: [
                    {
                      id: "msg-child-resumed",
                      text: "Resumed child analysis.",
                      type: "agentMessage",
                    },
                  ],
                },
              ]
            : [],
      }),
    );
    resumedRuntimes.push(runtime);
    return Effect.succeed(runtime);
  });
  const layer = Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: resumedRuntimeFactory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const childThreadId = codexChildThreadId(
      ProviderInstanceId.make("codex"),
      "provider-child-resumed",
    );
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
      Effect.forkChild,
    );

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: childThreadId,
      resumeCursor: { threadId: "provider-child-resumed" },
      runtimeMode: "full-access",
    });

    const events = Array.from(yield* Fiber.join(eventsFiber));
    const runtime = resumedRuntimes[0];
    assert.ok(runtime);

    const assistantMessage = events.find(
      (event) =>
        event.type === "item.completed" &&
        event.itemId === "msg-child-resumed" &&
        event.payload.itemType === "assistant_message",
    );
    assert.ok(assistantMessage);
    assert.equal(assistantMessage.threadId, childThreadId);
    if (assistantMessage.type === "item.completed") {
      assert.equal(assistantMessage.payload.detail, "Resumed child analysis.");
    }
    assert.deepStrictEqual(runtime.readProviderThreadImpl.mock.calls, [["provider-child-resumed"]]);
  }).pipe(Effect.provide(layer));
});

it.effect("backfills in-progress Codex child snapshot items as updates", () => {
  const resumedRuntimes: FakeCodexRuntime[] = [];
  const resumedRuntimeFactory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtime.readProviderThreadImpl.mockImplementation((providerThreadId) =>
      Promise.resolve({
        threadId: providerThreadId,
        turns:
          providerThreadId === "provider-child-in-progress"
            ? [
                {
                  id: asTurnId("turn-child-in-progress"),
                  status: "running",
                  startedAt: 1_778_000_021,
                  completedAt: null,
                  items: [
                    {
                      id: "msg-child-in-progress",
                      text: "Still working.",
                      type: "agentMessage",
                      status: "inProgress",
                    },
                  ],
                },
              ]
            : [],
      }),
    );
    resumedRuntimes.push(runtime);
    return Effect.succeed(runtime);
  });
  const layer = Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: resumedRuntimeFactory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const childThreadId = codexChildThreadId(
      ProviderInstanceId.make("codex"),
      "provider-child-in-progress",
    );
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.filter(
        (event) => event.type === "item.updated" && event.itemId === "msg-child-in-progress",
      ),
      Stream.runHead,
      Effect.forkChild,
    );

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: childThreadId,
      resumeCursor: { threadId: "provider-child-in-progress" },
      runtimeMode: "full-access",
    });

    const event = yield* Fiber.join(eventFiber);
    assert.equal(event._tag, "Some");
    if (event._tag === "Some") {
      assert.equal(event.value.threadId, childThreadId);
      assert.equal(event.value.type, "item.updated");
      assert.equal(event.value.payload.status, "inProgress");
    }
  }).pipe(Effect.provide(layer));
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );

  it.effect("stopping a virtual child keeps the parent runtime and scope alive", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;
      const parentThreadId = asThreadId("thread-parent-stop-child");
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        "provider-child-stop",
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit(
        makeCodexChildThreadStartedEvent({
          eventId: "evt-child-thread-stop",
          threadId: childThreadId,
          providerThreadId: "provider-child-stop",
          parentThreadId,
        }),
      );
      yield* Fiber.join(eventFiber);

      assert.equal(yield* adapter.hasSession(parentThreadId), true);
      assert.equal(yield* adapter.hasSession(childThreadId), true);

      yield* adapter.stopSession(childThreadId);

      assert.equal(runtime.closeImpl.mock.calls.length, 0);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, []);
      assert.equal(yield* adapter.hasSession(parentThreadId), true);
      assert.equal(yield* adapter.hasSession(childThreadId), false);

      yield* adapter.stopSession(parentThreadId);

      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [parentThreadId]);
      assert.equal(yield* adapter.hasSession(parentThreadId), false);
    }),
  );

  it.effect("does not block runtime events behind child snapshot backfill", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;
      const parentThreadId = asThreadId("thread-parent-nonblocking-child-backfill");
      const childThreadId = codexChildThreadId(
        ProviderInstanceId.make("codex"),
        "provider-child-nonblocking",
      );
      let finishBackfill: ((snapshot: CodexThreadSnapshot) => void) | undefined;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: parentThreadId,
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.readProviderThreadImpl.mockImplementation(
        (providerThreadId) =>
          new Promise<CodexThreadSnapshot>((resolve) => {
            finishBackfill = resolve;
            assert.equal(providerThreadId, "provider-child-nonblocking");
          }),
      );

      const turnStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn.started" && event.turnId === asTurnId("turn-root-after-child"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(
        makeCodexChildThreadStartedEvent({
          eventId: "evt-child-thread-nonblocking",
          threadId: childThreadId,
          providerThreadId: "provider-child-nonblocking",
          parentThreadId,
        }),
      );
      yield* runtime.emit({
        id: asEventId("evt-root-turn-after-child"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/started",
        threadId: parentThreadId,
        turnId: asTurnId("turn-root-after-child"),
        payload: {
          threadId: "provider-thread-1",
          turn: {
            id: "turn-root-after-child",
            status: "running",
          },
        },
      } satisfies ProviderEvent);

      const turnStarted = yield* Fiber.join(turnStartedFiber);
      assert.equal(turnStarted._tag, "Some");
      if (turnStarted._tag === "Some") {
        assert.equal(turnStarted.value.threadId, parentThreadId);
      }

      assert.ok(finishBackfill);
      finishBackfill({
        threadId: "provider-child-nonblocking",
        turns: [],
      });
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      assert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("reuses a lazy account client for getAccountRateLimits and closes it on shutdown", () =>
  Effect.gen(function* () {
    const request = vi.fn(() =>
      Effect.succeed({
        rateLimits: {
          primary: {
            usedPercent: 41,
            windowDurationMins: 300,
          },
        },
      }),
    );
    const createAccountClient = vi.fn(
      (): Effect.Effect<CodexAppServerClientHandle, CodexErrors.CodexAppServerError> =>
        Effect.succeed({
          client: {
            request,
          } as unknown as CodexClient.CodexAppServerClientShape,
          child: {} as ChildProcessHandle,
        }),
    );
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeCodexAppServerClient: createAccountClient,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));
      const getAccountRateLimits = adapter.getAccountRateLimits;
      assert.ok(getAccountRateLimits);

      const first = yield* getAccountRateLimits();
      const second = yield* getAccountRateLimits();
      assert.equal(createAccountClient.mock.calls.length, 1);
      assert.equal(request.mock.calls.length, 2);
      assert.deepEqual(first, {
        rateLimits: {
          primary: {
            usedPercent: 41,
            windowDurationMins: 300,
          },
        },
      });
      assert.deepEqual(second, first);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
    }
  }),
);

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-codex-adapter-native-log-"));
    const basePath = path.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      assert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = path.join(tempDir, "thread-logger.log");
      assert.equal(fs.existsSync(threadLogPath), true);
      const contents = fs.readFileSync(threadLogPath, "utf8");
      assert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
