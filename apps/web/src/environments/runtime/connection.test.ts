import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { createEnvironmentConnection, EnvironmentShellBootstrapTimeoutError } from "./connection";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

function createTestClient() {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const terminalListeners = new Set<(event: any) => void>();
  const shellListeners = new Set<(event: any) => void>();
  let shellResubscribe: (() => void) | undefined;
  let terminalUnsubscribeCount = 0;

  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => {
      shellResubscribe?.();
    }),
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.make("env-1"),
        },
      })),
      subscribeConfig: vi.fn((listener: (event: any) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      }),
      subscribeLifecycle: vi.fn((listener: (event: any) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      }),
      subscribeAuthAccess: () => () => undefined,
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      subscribeShell: vi.fn(
        (listener: (event: any) => void, options?: { onResubscribe?: () => void }) => {
          shellListeners.add(listener);
          shellResubscribe = options?.onResubscribe;
          queueMicrotask(() => {
            listener({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 1,
                projects: [],
                threads: [],
                updatedAt: "2026-04-12T00:00:00.000Z",
              },
            });
          });
          return () => {
            shellListeners.delete(listener);
            if (shellResubscribe === options?.onResubscribe) {
              shellResubscribe = undefined;
            }
          };
        },
      ),
      subscribeThread: vi.fn(() => () => undefined),
    },
    terminal: {
      open: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn((listener: (event: any) => void) => {
        terminalListeners.add(listener);
        return () => {
          if (terminalListeners.delete(listener)) {
            terminalUnsubscribeCount += 1;
          }
        };
      }),
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      listDirectoryEntries: vi.fn(async () => ({ entries: [], truncated: false })),
      readFile: vi.fn(async () => ({
        contents: "",
        relativePath: "README.md",
        sizeBytes: 0,
        truncated: false,
      })),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      runStackedAction: vi.fn(async () => ({}) as any),
      generateCommitMessage: vi.fn(async () => ({}) as any),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
  } as unknown as WsRpcClient;

  return {
    client,
    emitWelcome: (environmentId: EnvironmentId) => {
      for (const listener of lifecycleListeners) {
        listener({
          type: "welcome",
          payload: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigSnapshot: (environmentId: EnvironmentId) => {
      for (const listener of configListeners) {
        listener({
          type: "snapshot",
          config: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitShellSnapshot: (snapshotSequence: number) => {
      for (const listener of shellListeners) {
        listener({
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            projects: [],
            threads: [],
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        });
      }
    },
    emitTerminalEvent: (event: any) => {
      for (const listener of terminalListeners) {
        listener(event);
      }
    },
    getShellListenerCount: () => shellListeners.size,
    getTerminalListenerCount: () => terminalListeners.size,
    getTerminalListeners: () => [...terminalListeners],
    getTerminalUnsubscribeCount: () => terminalUnsubscribeCount,
  };
}

describe("createEnvironmentConnection", () => {
  it("bootstraps from the shell subscription snapshot", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    expect(syncShellSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotSequence: 1 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("rejects welcome/config identity drift", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitWelcome } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    expect(() => emitWelcome(EnvironmentId.make("env-2"))).toThrow(
      "Environment connection env-1 changed identity to env-2 via server lifecycle welcome.",
    );

    await connection.dispose();
  });

  it("waits for a fresh shell snapshot after reconnect", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await Promise.resolve();
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);

    emitShellSnapshot(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(syncShellSnapshot).toHaveBeenCalledTimes(2);
    expect(syncShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 2 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("rejects reconnect when shell bootstrap wait times out", async () => {
    vi.useFakeTimers();
    try {
      const environmentId = EnvironmentId.make("env-1");
      const { client } = createTestClient();
      const syncShellSnapshot = vi.fn();

      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          id: "env-1",
          label: "Remote env",
          source: "manual",
          target: {
            httpBaseUrl: "http://example.test",
            wsBaseUrl: "ws://example.test",
          },
          environmentId,
        },
        client,
        applyShellEvent: vi.fn(),
        syncShellSnapshot,
        applyTerminalEvent: vi.fn(),
      });

      await connection.ensureBootstrapped();

      const reconnectPromise = connection.reconnect({
        reason: "test",
        shellBootstrapTimeoutMs: 12_000,
      });
      const expectation = expect(reconnectPromise).rejects.toBeInstanceOf(
        EnvironmentShellBootstrapTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(12_000);
      await expectation;
      expect(client.reconnect).toHaveBeenCalledTimes(1);

      await connection.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the default shell bootstrap timeout when reconnect has no explicit timeout", async () => {
    vi.useFakeTimers();
    try {
      const environmentId = EnvironmentId.make("env-1");
      const { client } = createTestClient();
      const syncShellSnapshot = vi.fn();

      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          id: "env-1",
          label: "Remote env",
          source: "manual",
          target: {
            httpBaseUrl: "http://example.test",
            wsBaseUrl: "ws://example.test",
          },
          environmentId,
        },
        client,
        applyShellEvent: vi.fn(),
        syncShellSnapshot,
        applyTerminalEvent: vi.fn(),
      });

      await connection.ensureBootstrapped();

      const reconnectPromise = connection.reconnect({ reason: "test-default-timeout" });
      const expectation = expect(reconnectPromise).rejects.toMatchObject({
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(client.reconnect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expectation;

      await connection.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens future bootstrap waiters when a late shell snapshot arrives after timeout", async () => {
    vi.useFakeTimers();
    try {
      const environmentId = EnvironmentId.make("env-1");
      const { client, emitShellSnapshot, getShellListenerCount } = createTestClient();
      const syncShellSnapshot = vi.fn();

      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          id: "env-1",
          label: "Remote env",
          source: "manual",
          target: {
            httpBaseUrl: "http://example.test",
            wsBaseUrl: "ws://example.test",
          },
          environmentId,
        },
        client,
        applyShellEvent: vi.fn(),
        syncShellSnapshot,
        applyTerminalEvent: vi.fn(),
      });

      await connection.ensureBootstrapped();

      const reconnectPromise = connection.reconnect({
        shellBootstrapTimeoutMs: 12_000,
      });
      const expectation = expect(reconnectPromise).rejects.toBeInstanceOf(
        EnvironmentShellBootstrapTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(12_000);
      await expectation;
      expect(getShellListenerCount()).toBe(1);

      emitShellSnapshot(2);
      await connection.ensureBootstrapped();

      expect(getShellListenerCount()).toBe(1);
      expect(syncShellSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshotSequence: 2 }),
        environmentId,
      );

      await connection.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps in-flight bootstrap waiters pending when reconnect bootstrap times out", async () => {
    vi.useFakeTimers();
    try {
      const environmentId = EnvironmentId.make("env-1");
      const { client, emitShellSnapshot } = createTestClient();
      const syncShellSnapshot = vi.fn();

      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          id: "env-1",
          label: "Remote env",
          source: "manual",
          target: {
            httpBaseUrl: "http://example.test",
            wsBaseUrl: "ws://example.test",
          },
          environmentId,
        },
        client,
        applyShellEvent: vi.fn(),
        syncShellSnapshot,
        applyTerminalEvent: vi.fn(),
      });

      await connection.ensureBootstrapped();

      const reconnectPromise = connection.reconnect({
        shellBootstrapTimeoutMs: 12_000,
      });
      const ensurePromise = connection.ensureBootstrapped();
      const ensureRejected = vi.fn();
      void ensurePromise.catch(ensureRejected);
      const reconnectExpectation = expect(reconnectPromise).rejects.toBeInstanceOf(
        EnvironmentShellBootstrapTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(12_000);
      await reconnectExpectation;
      expect(ensureRejected).not.toHaveBeenCalled();

      emitShellSnapshot(2);
      await ensurePromise;
      expect(ensureRejected).not.toHaveBeenCalled();
      expect(syncShellSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshotSequence: 2 }),
        environmentId,
      );

      await connection.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pending reconnect waiters across repeated bootstrap resets", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    const firstReconnect = connection.reconnect();
    const secondReconnect = connection.reconnect();
    await Promise.resolve();
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);

    emitShellSnapshot(2);
    await Promise.all([firstReconnect, secondReconnect]);

    expect(client.reconnect).toHaveBeenCalledTimes(2);
    expect(syncShellSnapshot).toHaveBeenCalledTimes(2);
    expect(syncShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 2 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("starts projection catch-up after reconnect without gating shell bootstrap", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const catchUpProjection = vi.fn(() => new Promise<void>(() => undefined));

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      catchUpProjection,
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await vi.waitFor(() => {
      expect(catchUpProjection).toHaveBeenCalledTimes(1);
    });

    emitShellSnapshot(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(catchUpProjection).toHaveBeenCalledTimes(1);

    await connection.dispose();
  });

  it("swallows projection catch-up errors during reconnect", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const catchUpProjection = vi.fn(async () => {
      throw new Error("catch-up failed");
    });

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      catchUpProjection,
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await vi.waitFor(() => {
      expect(catchUpProjection).toHaveBeenCalledTimes(1);
    });

    emitShellSnapshot(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);

    await connection.dispose();
  });

  it("recovers terminal event streams without reconnecting or running projection recovery", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const {
      client,
      emitTerminalEvent,
      getTerminalListenerCount,
      getTerminalListeners,
      getTerminalUnsubscribeCount,
    } = createTestClient();
    const applyTerminalEvent = vi.fn();
    const catchUpProjection = vi.fn(async () => undefined);

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent,
      catchUpProjection,
    });

    await connection.ensureBootstrapped();

    expect(client.terminal.onEvent).toHaveBeenCalledTimes(1);
    expect(getTerminalListenerCount()).toBe(1);

    const [firstListener] = getTerminalListeners();
    expect(firstListener).toBeDefined();

    const firstEvent = {
      type: "activity",
      threadId: "thread-1",
      terminalId: "terminal",
      createdAt: "2026-04-12T00:00:00.000Z",
      hasRunningSubprocess: false,
    };
    emitTerminalEvent(firstEvent);
    expect(applyTerminalEvent).toHaveBeenCalledWith(firstEvent, environmentId);

    connection.recoverTerminalEventStream({ reason: "terminal-write-stall" });

    expect(client.reconnect).not.toHaveBeenCalled();
    expect(catchUpProjection).not.toHaveBeenCalled();
    expect(client.terminal.onEvent).toHaveBeenCalledTimes(2);
    expect(getTerminalUnsubscribeCount()).toBe(1);
    expect(getTerminalListenerCount()).toBe(1);

    const [secondListener] = getTerminalListeners();
    expect(secondListener).toBeDefined();
    expect(secondListener).not.toBe(firstListener);

    firstListener?.({
      ...firstEvent,
      createdAt: "2026-04-12T00:00:01.000Z",
    });
    expect(applyTerminalEvent).toHaveBeenCalledTimes(1);

    const secondEvent = {
      ...firstEvent,
      createdAt: "2026-04-12T00:00:02.000Z",
    };
    secondListener?.(secondEvent);
    expect(applyTerminalEvent).toHaveBeenCalledTimes(2);
    expect(applyTerminalEvent).toHaveBeenLastCalledWith(secondEvent, environmentId);

    await connection.dispose();

    expect(getTerminalUnsubscribeCount()).toBe(2);
    expect(getTerminalListenerCount()).toBe(0);
  });

  it("skips primary lifecycle/config subscriptions when no handlers are registered", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: {
        id: "env-1",
        label: "Local env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    expect(client.server.subscribeLifecycle).not.toHaveBeenCalled();
    expect(client.server.subscribeConfig).not.toHaveBeenCalled();
    expect(client.orchestration.subscribeShell).toHaveBeenCalledOnce();

    await connection.dispose();
  });
});
