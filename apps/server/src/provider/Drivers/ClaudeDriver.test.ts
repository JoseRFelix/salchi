import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const capabilitiesProbe = vi.hoisted(() => ({
  calls: 0,
  account: {
    email: undefined as string | undefined,
    tokenSource: "none" as string | undefined,
    apiProvider: "firstParty" as string | undefined,
  },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: () => {
      capabilitiesProbe.calls += 1;
      return {
        initializationResult: async () => ({
          account: { ...capabilitiesProbe.account },
          commands: [],
        }),
      };
    },
  };
});

const encoder = new TextEncoder();

const spawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode("2.1.214\n")),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "claude-driver-auth-refresh-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

describe("ClaudeDriver", () => {
  it.live("re-probes SDK authentication on every managed-provider refresh", () =>
    Effect.gen(function* () {
      capabilitiesProbe.calls = 0;
      capabilitiesProbe.account = {
        email: undefined,
        tokenSource: "none",
        apiProvider: "firstParty",
      };

      const instance = yield* ClaudeDriver.create({
        instanceId: ProviderInstanceId.make("claude_auth_refresh"),
        displayName: "Claude",
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: {
          ...ClaudeDriver.defaultConfig(),
          enabled: true,
          binaryPath: "claude",
        },
      });

      const loggedOut = yield* instance.snapshot.refresh;
      expect(loggedOut.auth.status).toBe("unauthenticated");

      capabilitiesProbe.account = {
        email: "claude@example.com",
        tokenSource: "keychain",
        apiProvider: "firstParty",
      };
      const loggedIn = yield* instance.snapshot.refresh;
      expect(loggedIn.auth.status).toBe("authenticated");
      expect(loggedIn.auth.email).toBe("claude@example.com");

      capabilitiesProbe.account = {
        email: undefined,
        tokenSource: "none",
        apiProvider: "firstParty",
      };
      const loggedOutAgain = yield* instance.snapshot.refresh;
      expect(loggedOutAgain.auth.status).toBe("unauthenticated");
      expect(capabilitiesProbe.calls).toBeGreaterThanOrEqual(3);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(TestLayer),
    ),
  );
});
