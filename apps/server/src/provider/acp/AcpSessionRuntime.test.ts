// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vitest";

import {
  AcpSessionRuntime,
  type AcpSessionRequestLogEvent,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";
import type { AcpParsedSessionEvent } from "./AcpRuntimeModel.ts";
import { INDEPENDENT_THREAD_MCP_SERVER_NAME } from "../IndependentThreadTool.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const resumedSessionId = "mock-session-1";
const assistantItemIdPattern = /^assistant:mock-session-1:run:[0-9a-f]+:segment:0$/;

class AcpRuntimeTestTimeout extends Data.TaggedError("AcpRuntimeTestTimeout")<{
  readonly message: string;
}> {}

function runtimeLayer({
  env,
  requestEvents,
  resumeSessionId = resumedSessionId,
}: {
  readonly env?: NodeJS.ProcessEnv;
  readonly requestEvents?: Array<AcpSessionRequestLogEvent>;
  readonly resumeSessionId?: string;
} = {}) {
  return AcpSessionRuntime.layer({
    spawn: {
      command: mockAgentCommand,
      args: [mockAgentPath],
      ...(env ? { env } : {}),
    },
    cwd: process.cwd(),
    clientInfo: { name: "salchi-test", version: "0.0.0" },
    authMethodId: "test",
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(requestEvents
      ? {
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }
      : {}),
  });
}

function collectEvents(
  runtime: AcpSessionRuntimeShape,
  count: number,
): Effect.Effect<ReadonlyArray<AcpParsedSessionEvent>, AcpRuntimeTestTimeout> {
  return Stream.runCollect(Stream.take(runtime.getEvents(), count)).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(
            new AcpRuntimeTestTimeout({
              message: `Timed out collecting ${count} ACP runtime events`,
            }),
          ),
        onSome: (events) => Effect.succeed(Array.from(events)),
      }),
    ),
  );
}

const promptAndCollectLiveEvents = Effect.gen(function* () {
  const runtime = yield* AcpSessionRuntime;
  const started = yield* runtime.start();
  expect(started.sessionId).toBe(resumedSessionId);

  const promptResult = yield* runtime.prompt({
    prompt: [{ type: "text", text: "hi" }],
  });
  expect(promptResult).toMatchObject({ stopReason: "end_turn" });

  return yield* collectEvents(runtime, 4);
});

function firstAssistantItemId(env?: NodeJS.ProcessEnv) {
  return Effect.gen(function* () {
    const events = yield* promptAndCollectLiveEvents;
    const started = events.find((event) => event._tag === "AssistantItemStarted");
    expect(started?._tag).toBe("AssistantItemStarted");
    if (started?._tag !== "AssistantItemStarted") {
      return "";
    }
    return String(started.itemId);
  }).pipe(Effect.provide(runtimeLayer(env ? { env } : {})), Effect.scoped);
}

describe("AcpSessionRuntime resume", () => {
  it.effect("registers the Salchi MCP server when loading an ACP session", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];

    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const loadStarted = requestEvents.find(
        (event) => event.method === "session/load" && event.status === "started",
      );
      const payload = loadStarted?.payload as
        | {
            readonly mcpServers?: ReadonlyArray<{
              readonly name?: string;
              readonly command?: string;
              readonly args?: ReadonlyArray<string>;
              readonly env?: ReadonlyArray<unknown>;
            }>;
          }
        | undefined;
      const salchiServer = payload?.mcpServers?.find(
        (server) => server.name === INDEPENDENT_THREAD_MCP_SERVER_NAME,
      );

      expect(salchiServer).toMatchObject({
        name: INDEPENDENT_THREAD_MCP_SERVER_NAME,
        command: process.execPath,
        env: [],
      });
      expect(salchiServer?.args).toContain("--input-type=module");
      expect(salchiServer?.args).toContain("--eval");
      expect(salchiServer?.args?.at(-1)).toContain("create_thread");
    }).pipe(
      Effect.provide(runtimeLayer({ requestEvents })),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("suppresses replayed assistant and tool updates during session/load", () =>
    Effect.gen(function* () {
      const events = yield* promptAndCollectLiveEvents;

      expect(events.map((event) => event._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(events.some((event) => event._tag === "ToolCallUpdated")).toBe(false);

      const delta = events.find((event) => event._tag === "ContentDelta");
      expect(delta?._tag).toBe("ContentDelta");
      if (delta?._tag === "ContentDelta") {
        expect(delta.text).toBe("live after resume");
        expect(String(delta.itemId)).toMatch(assistantItemIdPattern);
      }
    }).pipe(
      Effect.provide(
        runtimeLayer({
          env: {
            SALCHI_ACP_LOAD_REPLAY_HISTORY: "1",
            SALCHI_ACP_PROMPT_RESPONSE_TEXT: "live after resume",
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("clears load replay suppression before session/new fallback after load failure", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];

    return Effect.gen(function* () {
      const events = yield* promptAndCollectLiveEvents;

      expect(
        requestEvents.some((event) => event.method === "session/load" && event.status === "failed"),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/new" && event.status === "succeeded",
        ),
      ).toBe(true);

      const delta = events.find((event) => event._tag === "ContentDelta");
      expect(delta?._tag).toBe("ContentDelta");
      if (delta?._tag === "ContentDelta") {
        expect(delta.text).toBe("live after fallback");
        expect(String(delta.itemId)).toMatch(assistantItemIdPattern);
      }
    }).pipe(
      Effect.provide(
        runtimeLayer({
          env: {
            SALCHI_ACP_FAIL_LOAD_SESSION: "1",
            SALCHI_ACP_PROMPT_RESPONSE_TEXT: "live after fallback",
          },
          requestEvents,
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("uses a fresh assistant item id epoch for each resumed runtime", () =>
    Effect.gen(function* () {
      const firstItemId = yield* firstAssistantItemId({
        SALCHI_ACP_PROMPT_RESPONSE_TEXT: "first runtime",
      });
      const secondItemId = yield* firstAssistantItemId({
        SALCHI_ACP_PROMPT_RESPONSE_TEXT: "second runtime",
      });

      expect(firstItemId).toMatch(assistantItemIdPattern);
      expect(secondItemId).toMatch(assistantItemIdPattern);
      expect(secondItemId).not.toBe(firstItemId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps mode state current when load replay includes a mode update", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const modeState = yield* runtime.getModeState;
      expect(modeState?.currentModeId).toBe("code");
    }).pipe(
      Effect.provide(
        runtimeLayer({
          env: {
            SALCHI_ACP_LOAD_REPLAY_HISTORY: "1",
            SALCHI_ACP_LOAD_REPLAY_MODE_ID: "code",
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
