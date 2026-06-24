import { afterEach, describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import {
  clearLatestProviderVersionCacheForTests,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

interface ProviderStatusWaiter {
  readonly instanceId: ProviderInstanceId;
  readonly status: ServerProviderUpdateState["status"];
  readonly deferred: Deferred.Deferred<ServerProvider>;
}

const providerStatusWaiters = new WeakMap<
  ProviderRegistryShape,
  (
    instanceId: ProviderInstanceId,
    status: ServerProviderUpdateState["status"],
  ) => Effect.Effect<ServerProvider>
>();

afterEach(() => {
  clearLatestProviderVersionCacheForTests();
});

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === CURSOR_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseCursorProvider: ServerProvider = {
  ...baseProvider,
  instanceId: CURSOR_INSTANCE_ID,
  driver: CURSOR_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const latestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly onKill?: () => void;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.sync(() => result.onKill?.()),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly onKill?: () => void;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);
    const statusWaitersRef = yield* Ref.make<ReadonlyArray<ProviderStatusWaiter>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      const providers = yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
      const updatedProvider = providers.find(
        (provider) => provider.instanceId === input.instanceId,
      );
      if (updateState && updatedProvider) {
        const matchingWaiters = yield* Ref.modify(statusWaitersRef, (waiters) => {
          const matching: ProviderStatusWaiter[] = [];
          const remaining: ProviderStatusWaiter[] = [];
          for (const waiter of waiters) {
            if (waiter.instanceId === input.instanceId && waiter.status === updateState.status) {
              matching.push(waiter);
            } else {
              remaining.push(waiter);
            }
          }
          return [matching, remaining] as const;
        });
        yield* Effect.forEach(
          matchingWaiters,
          (waiter) => Deferred.succeed(waiter.deferred, updatedProvider),
          { discard: true },
        );
      }
      return providers;
    });

    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    providerStatusWaiters.set(
      registry,
      (instanceId: ProviderInstanceId, status: ServerProviderUpdateState["status"]) =>
        Effect.gen(function* () {
          const existingProvider = (yield* Ref.get(providersRef)).find(
            (provider) => provider.instanceId === instanceId,
          );
          if (existingProvider?.updateState?.status === status) {
            return existingProvider;
          }

          const deferred = yield* Deferred.make<ServerProvider>();
          const waiter: ProviderStatusWaiter = {
            instanceId,
            status,
            deferred,
          };
          yield* Ref.update(statusWaitersRef, (waiters) => [...waiters, waiter]);

          const providerAfterRegister = (yield* Ref.get(providersRef)).find(
            (provider) => provider.instanceId === instanceId,
          );
          if (providerAfterRegister?.updateState?.status === status) {
            yield* Ref.update(statusWaitersRef, (waiters) =>
              waiters.filter((candidate) => candidate !== waiter),
            );
            return providerAfterRegister;
          }

          return yield* Deferred.await(deferred);
        }),
    );

    return {
      registry,
      updateStatesRef,
    };
  });
}

const makeScopedTestRunner = (registry: ProviderRegistryShape) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const layer = ProviderMaintenanceRunner.layer.pipe(
      Layer.provide(Layer.succeed(ProviderRegistry, registry)),
    );
    const context = yield* Layer.buildWithScope(layer, scope);
    return {
      runner: Context.get(context, ProviderMaintenanceRunner.ProviderMaintenanceRunner),
      close: Scope.close(scope, Exit.void),
    };
  });

const makeTestRunner = (registry: ProviderRegistryShape) =>
  makeScopedTestRunner(registry).pipe(
    Effect.tap(({ close }) => Effect.addFinalizer(() => close)),
    Effect.map(({ runner }) => runner),
  );

const waitForProviderUpdateStatus = (
  registry: ProviderRegistryShape,
  instanceId: ProviderInstanceId,
  status: ServerProviderUpdateState["status"],
) =>
  Effect.gen(function* () {
    const waitForStatus = providerStatusWaiters.get(registry);
    if (!waitForStatus) {
      assert.fail("Provider registry does not support test status waiting.");
    }
    return yield* waitForStatus(instanceId, status);
  });

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseCursorProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CURSOR_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "queued");
      const completedProvider = yield* waitForProviderUpdateStatus(
        registry,
        CURSOR_INSTANCE_ID,
        "succeeded",
      );
      assert.deepStrictEqual(calls, [
        {
          command: "agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(completedProvider.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "succeeded"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      yield* waitForProviderUpdateStatus(registry, CODEX_INSTANCE_ID, "succeeded");
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "runs update commands through Effect ChildProcess when no test runner is injected",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider(CODEX_DRIVER);
        assert.strictEqual(result.providers[0]?.updateState?.status, "queued");
        const completedProvider = yield* waitForProviderUpdateStatus(
          registry,
          CODEX_INSTANCE_ID,
          "succeeded",
        );

        assert.deepStrictEqual(calls, [
          {
            command: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
          },
        ]);
        assert.strictEqual(completedProvider.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer((command, args) => {
              calls.push({ command, args });
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];
      const { registry } = yield* makeRegistry([
        {
          ...baseProvider,
          instanceId: personalInstanceId,
          version: "0.124.0-alpha.3",
        },
        {
          ...baseProvider,
          instanceId: workInstanceId,
          version: "0.124.0-alpha.3",
        },
      ]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "queued");
      yield* waitForProviderUpdateStatus(registry, personalInstanceId, "succeeded");
      const completedProviders = yield* registry.getProviders;

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(completedProviders[0]?.instanceId, personalInstanceId);
      assert.strictEqual(completedProviders[0]?.updateState?.status, "succeeded");
      assert.strictEqual(completedProviders[1]?.instanceId, workInstanceId);
      assert.strictEqual(completedProviders[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.124.0-alpha.3"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "queued");
      const failedProvider = yield* waitForProviderUpdateStatus(
        registry,
        CODEX_INSTANCE_ID,
        "failed",
      );
      const updateState = failedProvider.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });
        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);
        assert.strictEqual(result.providers[0]?.updateState?.status, "queued");
        const unchangedProvider = yield* waitForProviderUpdateStatus(
          registry,
          CODEX_INSTANCE_ID,
          "unchanged",
        );

        assert.strictEqual(unchangedProvider.updateState?.status, "unchanged");
        assert.include(unchangedProvider.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("9.9.9"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect(
    "attaches duplicate update calls for the same provider instance to the active job",
    () => {
      const startedLatch: { resolve: () => void } = { resolve: () => {} };
      const releaseLatch: { resolve: () => void } = { resolve: () => {} };
      const started = new Promise<void>((resolve) => {
        startedLatch.resolve = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLatch.resolve = resolve;
      });
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry();
        const updater = yield* makeTestRunner(registry);

        const first = yield* updater.updateProvider(CODEX_DRIVER);
        assert.strictEqual(first.providers[0]?.updateState?.status, "queued");
        yield* Effect.promise(() => started);

        const second = yield* updater.updateProvider(CODEX_DRIVER);
        assert.strictEqual(second.providers[0]?.updateState?.status, "running");
        assert.deepStrictEqual(calls, ["npm install -g @openai/codex@latest"]);

        releaseLatch.resolve();
        const completedProvider = yield* waitForProviderUpdateStatus(
          registry,
          CODEX_INSTANCE_ID,
          "succeeded",
        );
        assert.strictEqual(completedProvider.updateState?.status, "succeeded");
        assert.deepStrictEqual(calls, ["npm install -g @openai/codex@latest"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer((command, args) => {
              calls.push([command, ...args].join(" "));
              startedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => release).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }),
          ),
        ),
      );
    },
  );

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(first.providers[0]?.updateState?.status, "queued");
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER);
      assert.strictEqual(
        second.providers.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;
        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* waitForProviderUpdateStatus(registry, CODEX_INSTANCE_ID, "succeeded");
      yield* waitForProviderUpdateStatus(registry, OPENCODE_INSTANCE_ID, "succeeded");
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            if (calls.length === 1) {
              firstStartedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "queued");
      const completedProvider = yield* waitForProviderUpdateStatus(
        registry,
        CODEX_INSTANCE_ID,
        "succeeded",
      );
      assert.strictEqual(completedProvider.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("continues the update job after the caller scope closes", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner(registry);
      const callerScope = yield* Scope.make("sequential");

      const launch = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkIn(callerScope));
      const launchResult = yield* Fiber.join(launch);
      assert.strictEqual(launchResult.providers[0]?.updateState?.status, "queued");

      yield* Effect.promise(() => started);
      yield* Scope.close(callerScope, Exit.void);
      assert.strictEqual((yield* registry.getProviders)[0]?.updateState?.status, "running");

      releaseLatch.resolve();
      const completedProvider = yield* waitForProviderUpdateStatus(
        registry,
        CODEX_INSTANCE_ID,
        "succeeded",
      );
      assert.strictEqual(completedProvider.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("continues the update job when the caller fiber is interrupted during launch", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const launchWriteStarted = yield* Deferred.make<void>();
      const releaseLaunchWrite = yield* Deferred.make<void>();
      const { registry: delegateRegistry } = yield* makeRegistry(baseProvider);
      const registry: ProviderRegistryShape = {
        ...delegateRegistry,
        setProviderMaintenanceActionState: (input) => {
          if (input.instanceId === CODEX_INSTANCE_ID && input.state?.status === "queued") {
            return Deferred.succeed(launchWriteStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLaunchWrite)),
              Effect.andThen(delegateRegistry.setProviderMaintenanceActionState(input)),
            );
          }
          return delegateRegistry.setProviderMaintenanceActionState(input);
        },
      };
      const waitForStatus = providerStatusWaiters.get(delegateRegistry);
      if (waitForStatus) {
        providerStatusWaiters.set(registry, waitForStatus);
      }
      const updater = yield* makeTestRunner(registry);
      const callerScope = yield* Scope.make("sequential");
      const interruptScope = yield* Scope.make("sequential");

      const launchFiber = yield* updater
        .updateProvider(CODEX_DRIVER)
        .pipe(Effect.forkIn(callerScope, { startImmediately: true }));
      yield* Deferred.await(launchWriteStarted);
      const interruptFiber = yield* Fiber.interrupt(launchFiber).pipe(
        Effect.forkIn(interruptScope, { startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseLaunchWrite, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Scope.close(interruptScope, Exit.void);
      yield* Scope.close(callerScope, Exit.void);

      yield* Effect.promise(() => started);
      assert.strictEqual((yield* registry.getProviders)[0]?.updateState?.status, "running");

      releaseLatch.resolve();
      const completedProvider = yield* waitForProviderUpdateStatus(
        registry,
        CODEX_INSTANCE_ID,
        "succeeded",
      );
      assert.strictEqual(completedProvider.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("interrupts an active update job when the runner scope closes", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const neverRelease = new Promise<void>(() => undefined);
    let killCalls = 0;

    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const { runner, close } = yield* makeScopedTestRunner(registry);

      const launchResult = yield* runner.updateProvider(CODEX_DRIVER);
      assert.strictEqual(launchResult.providers[0]?.updateState?.status, "queued");
      yield* Effect.promise(() => started);

      yield* close;
      assert.strictEqual(killCalls, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => neverRelease).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              onKill: () => {
                killCalls += 1;
              },
            };
          }),
        ),
      ),
    );
  });
});
