import {
  CommandId,
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusStreamEvent,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WsRpcProtocolClient } from "./protocol";
import { isTransportConnectionErrorMessage } from "./transportError";

vi.mock("./wsTransport", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import {
  createWsRpcClient,
  DISPATCH_COMMAND_MAX_RETRY_COUNT,
  DISPATCH_COMMAND_REQUEST_TIMEOUT_MS,
  DISPATCH_COMMAND_RETRY_BASE_DELAY_MS,
} from "./wsRpcClient";
import { type WsTransport } from "./wsTransport";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
    staged: { files: [], insertions: 0, deletions: 0 },
    unstaged: { files: [], insertions: 0, deletions: 0 },
  },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function makeDispatchInput() {
  return {
    type: "thread.create" as const,
    commandId: CommandId.make("command-dispatch"),
    threadId: ThreadId.make("thread-dispatch"),
    projectId: ProjectId.make("project-dispatch"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt: "2026-04-13T00:00:00.000Z",
  };
}

describe("wsRpcClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards orchestration sync probes through the websocket transport", async () => {
    const result = {
      clientSequence: 4,
      serverSequence: 7,
      behind: true,
    };
    const protocolProbeSync = vi.fn(() => Effect.succeed(result));
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.probeSync]: protocolProbeSync,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => Effect.runPromise(execute(protocolClient)),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);

    await expect(client.orchestration.probeSync({ clientSequence: 4 })).resolves.toEqual(result);

    expect(request).toHaveBeenCalledTimes(1);
    expect(protocolProbeSync).toHaveBeenCalledWith({ clientSequence: 4 });
  });

  it("forwards thread detail page requests through the websocket transport", async () => {
    const threadId = ThreadId.make("thread-page");
    const result = {
      snapshotSequence: 7,
      thread: {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
      pageInfo: EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
    };
    const protocolGetThreadDetailPage = vi.fn(() => Effect.succeed(result));
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.getThreadDetailPage]: protocolGetThreadDetailPage,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => Effect.runPromise(execute(protocolClient)),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = {
      threadId,
      page: {
        before: {
          messages: {
            id: "message-10",
            createdAt: "2026-04-13T00:00:10.000Z",
          },
        },
        limits: {
          messages: 25,
        },
      },
    };

    await expect(client.orchestration.getThreadDetailPage(input)).resolves.toEqual(result);

    expect(request).toHaveBeenCalledTimes(1);
    expect(protocolGetThreadDetailPage).toHaveBeenCalledWith(input);
  });

  it("rejects dispatchCommand after every request retry times out", async () => {
    vi.useFakeTimers();
    const protocolDispatch = vi.fn(() => Effect.void);
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: protocolDispatch,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
        _options?: { readonly signal?: AbortSignal },
      ) => {
        void Effect.runPromise(execute(protocolClient));
        return new Promise<TSuccess>(() => undefined);
      },
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = makeDispatchInput();

    const promise = client.orchestration.dispatchCommand(input);
    const expectation = expect(promise).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && isTransportConnectionErrorMessage(error.message),
    );
    await vi.runAllTimersAsync();

    await expectation;
    expect(transport.reconnect).toHaveBeenCalledTimes(DISPATCH_COMMAND_MAX_RETRY_COUNT);
    expect(transport.request).toHaveBeenCalledTimes(DISPATCH_COMMAND_MAX_RETRY_COUNT + 1);
    expect(protocolDispatch).toHaveBeenCalledTimes(DISPATCH_COMMAND_MAX_RETRY_COUNT + 1);
    for (let callIndex = 1; callIndex <= DISPATCH_COMMAND_MAX_RETRY_COUNT + 1; callIndex += 1) {
      expect(protocolDispatch).toHaveBeenNthCalledWith(callIndex, input);
    }
    for (const [, options] of request.mock.calls) {
      expect(options?.signal?.aborted).toBe(true);
    }
  });

  it("reconnects before dispatchCommand when the heartbeat is stale", async () => {
    const protocolDispatch = vi.fn(() => Effect.void);
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: protocolDispatch,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => Effect.runPromise(execute(protocolClient)),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => false),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = makeDispatchInput();

    await expect(client.orchestration.dispatchCommand(input)).resolves.toBeUndefined();

    expect(transport.reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(transport.reconnect.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0]!,
    );
    expect(protocolDispatch).toHaveBeenCalledWith(input);
  });

  it("retries a timed out dispatchCommand after reconnecting with the same commandId", async () => {
    vi.useFakeTimers();
    const protocolDispatch = vi.fn(() => Effect.void);
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: protocolDispatch,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => {
        if (request.mock.calls.length === 1) {
          void Effect.runPromise(execute(protocolClient));
          return new Promise<TSuccess>(() => undefined);
        }
        return Effect.runPromise(execute(protocolClient));
      },
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = makeDispatchInput();
    const promise = client.orchestration.dispatchCommand(input);

    await vi.advanceTimersByTimeAsync(
      DISPATCH_COMMAND_REQUEST_TIMEOUT_MS + DISPATCH_COMMAND_RETRY_BASE_DELAY_MS,
    );

    await expect(promise).resolves.toBeUndefined();
    expect(transport.reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(protocolDispatch).toHaveBeenCalledTimes(2);
    expect(protocolDispatch).toHaveBeenNthCalledWith(1, input);
    expect(protocolDispatch).toHaveBeenNthCalledWith(2, input);
  });

  it("retries an immediate connection failure and sends after reconnecting", async () => {
    vi.useFakeTimers();
    const protocolDispatch = vi.fn(() => Effect.void);
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: protocolDispatch,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => {
        if (request.mock.calls.length === 1) {
          throw new Error("SocketCloseError: WebSocket closed");
        }
        return Effect.runPromise(execute(protocolClient));
      },
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = makeDispatchInput();
    const promise = client.orchestration.dispatchCommand(input);

    await vi.advanceTimersByTimeAsync(DISPATCH_COMMAND_RETRY_BASE_DELAY_MS);

    await expect(promise).resolves.toBeUndefined();
    expect(transport.reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(protocolDispatch).toHaveBeenCalledWith(input);
  });

  it("keeps retrying failed reconnects until the command can be sent", async () => {
    vi.useFakeTimers();
    const protocolDispatch = vi.fn(() => Effect.void);
    const protocolClient = {
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: protocolDispatch,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => Effect.runPromise(execute(protocolClient)),
    );
    const reconnect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("SocketOpenError: offline"))
      .mockRejectedValueOnce(new Error("SocketOpenError: still offline"))
      .mockResolvedValue(undefined);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect,
      isHeartbeatFresh: vi.fn(() => false),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = makeDispatchInput();
    const promise = client.orchestration.dispatchCommand(input);

    await vi.advanceTimersByTimeAsync(
      DISPATCH_COMMAND_RETRY_BASE_DELAY_MS + DISPATCH_COMMAND_RETRY_BASE_DELAY_MS * 2,
    );

    await expect(promise).resolves.toBeUndefined();
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledTimes(1);
    expect(protocolDispatch).toHaveBeenCalledWith(input);
  });

  it("does not retry non-connection command failures", async () => {
    const commandError = new Error("Project not found");
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(async () => Promise.reject(commandError)) as unknown as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;
    const client = createWsRpcClient(transport as unknown as WsTransport);

    await expect(client.orchestration.dispatchCommand(makeDispatchInput())).rejects.toBe(
      commandError,
    );
    expect(transport.reconnect).not.toHaveBeenCalled();
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("reduces vcs status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
  });

  it("forwards working tree diff requests through the websocket transport", async () => {
    const result = { diff: "patch" };
    const protocolGetWorkingTreeDiff = vi.fn(() => Effect.succeed(result));
    const protocolClient = {
      [WS_METHODS.vcsGetWorkingTreeDiff]: protocolGetWorkingTreeDiff,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => Effect.runPromise(execute(protocolClient)),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = {
      cwd: "/repo",
      target: "staged" as const,
      ignoreWhitespace: true,
    };

    await expect(client.vcs.getWorkingTreeDiff(input)).resolves.toEqual(result);

    expect(request).toHaveBeenCalledTimes(1);
    expect(protocolGetWorkingTreeDiff).toHaveBeenCalledWith(input);
  });

  it("forwards commit message generation through the websocket transport", async () => {
    const result = {
      subject: "Update project files",
      body: "",
      commitMessage: "Update project files",
    };
    const protocolGenerateCommitMessage = vi.fn(() => Effect.succeed(result));
    const protocolClient = {
      [WS_METHODS.gitGenerateCommitMessage]: protocolGenerateCommitMessage,
    } as unknown as WsRpcProtocolClient;
    const request = vi.fn(
      async <TSuccess>(
        execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
      ) => Effect.runPromise(execute(protocolClient)),
    );
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: request as WsTransport["request"],
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "isHeartbeatFresh" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = {
      cwd: "/repo",
      filePaths: ["src/app.ts"],
    };

    await expect(client.git.generateCommitMessage(input)).resolves.toEqual(result);

    expect(request).toHaveBeenCalledTimes(1);
    expect(protocolGenerateCommitMessage).toHaveBeenCalledWith(input);
  });
});
