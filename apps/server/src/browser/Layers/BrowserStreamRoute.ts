import {
  AuthBrowserOperateScope,
  ThreadId,
  type BrowserRpcError,
  type BrowserTab,
} from "@salchi/contracts";
import {
  BROWSER_STREAM_UNKNOWN_TAB_INDEX,
  decodeBrowserStreamInput,
  encodeBrowserStreamFrame,
  encodeBrowserStreamMeta,
} from "@salchi/shared/browserStreamProtocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { requireAuthScope } from "../../auth/scopes.ts";
import { respondToAuthError } from "../../auth/http.ts";
import { ServerAuth } from "../../auth/Services/ServerAuth.ts";
import {
  DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES,
  makeBrowserStreamOutbox,
} from "../BrowserStreamOutbox.ts";
import {
  browserMonotonicMillis,
  browserStreamDebugEnabled,
  getBrowserFrameTiming,
  logBrowserHandlerTiming,
} from "../BrowserStreamDiagnostics.ts";
import { BrowserSessionManager } from "../Services/BrowserSessionManager.ts";
import type { BrowserSessionManagerShape } from "../Services/BrowserSessionManager.ts";
import type { BrowserBinaryViewportFrame } from "../LatestViewportMailbox.ts";

export const BROWSER_STREAM_ROUTE = "/browser-stream/:threadId";

interface NodeWritableRequestSource {
  readonly socket?: {
    readonly writableLength?: number;
  };
}

interface EncodedFrame {
  readonly bytes: Uint8Array;
  readonly cdpReceivedAtMonotonicMillis: number;
  readonly mailboxPublishedAtMonotonicMillis: number;
  readonly seq: number;
  readonly targetId: string;
}

function browserStreamErrorResponse(error: BrowserRpcError): HttpServerResponse.HttpServerResponse {
  const status = error._tag === "ThreadNotFound" ? 404 : 409;
  return HttpServerResponse.jsonUnsafe({ error: error.message }, { status });
}

export function browserStreamBufferedBytes(source: object): number {
  const writableLength = (source as NodeWritableRequestSource).socket?.writableLength;
  return typeof writableLength === "number" && Number.isFinite(writableLength)
    ? Math.max(0, writableLength)
    : 0;
}

function tabIndexHint(tabs: ReadonlyArray<BrowserTab>, targetId: string): number {
  const index = tabs.findIndex((tab) => tab.targetId === targetId);
  return index >= 0 && index < BROWSER_STREAM_UNKNOWN_TAB_INDEX
    ? index
    : BROWSER_STREAM_UNKNOWN_TAB_INDEX;
}

export function runBrowserStreamConnection(input: {
  readonly browserManager: BrowserSessionManagerShape;
  readonly getBufferedBytes: () => number;
  readonly socket: Socket.Socket;
  readonly threadId: ThreadId;
  readonly bufferThresholdBytes?: number;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* input.socket.writer;
      const streamDebug = browserStreamDebugEnabled();
      const outbox = yield* makeBrowserStreamOutbox<EncodedFrame, Uint8Array, Socket.SocketError>({
        getBufferedBytes: input.getBufferedBytes,
        bufferThresholdBytes:
          input.bufferThresholdBytes ?? DEFAULT_BROWSER_STREAM_BUFFER_THRESHOLD_BYTES,
        writeFrame: (frame) =>
          writer(frame.bytes).pipe(
            Effect.tap(() =>
              streamDebug
                ? Effect.suspend(() => {
                    const socketWrittenAtMonotonicMillis = browserMonotonicMillis();
                    const fields = {
                      threadId: input.threadId,
                      targetId: frame.targetId,
                      seq: frame.seq,
                      cdpReceiveToMailboxPublishMs: Math.max(
                        0,
                        frame.mailboxPublishedAtMonotonicMillis -
                          frame.cdpReceivedAtMonotonicMillis,
                      ),
                      mailboxPublishToSocketWriteMs: Math.max(
                        0,
                        socketWrittenAtMonotonicMillis - frame.mailboxPublishedAtMonotonicMillis,
                      ),
                      cdpReceiveToSocketWriteMs: Math.max(
                        0,
                        socketWrittenAtMonotonicMillis - frame.cdpReceivedAtMonotonicMillis,
                      ),
                      bytes: frame.bytes.byteLength,
                    };
                    return Effect.logDebug("browser stream frame timing", fields).pipe(
                      Effect.andThen(
                        logBrowserHandlerTiming(
                          "browser.frame.cdp-receive-to-socket-write",
                          frame.cdpReceivedAtMonotonicMillis,
                          fields,
                        ),
                      ),
                    );
                  })
                : Effect.void,
            ),
          ),
        writeMeta: writer,
        onFrameSkipped: (frame, bufferedBytes) =>
          streamDebug
            ? Effect.logDebug("browser stream frame skipped for backpressure", {
                threadId: input.threadId,
                targetId: frame.targetId,
                seq: frame.seq,
                bufferedBytes,
              })
            : Effect.void,
      });
      let tabs: ReadonlyArray<BrowserTab> = [];

      const viewportEvents = input.browserManager
        .subscribeViewportBinary(input.threadId, "binary-surface")
        .pipe(Stream.map((event) => ({ _tag: "Viewport" as const, event })));
      const agentActivityEvents = input.browserManager
        .subscribeAgentActivity(input.threadId)
        .pipe(Stream.map((agentActive) => ({ _tag: "AgentActivity" as const, agentActive })));
      const outbound = Stream.merge(viewportEvents, agentActivityEvents).pipe(
        Stream.runForEach((outboundEvent) => {
          if (outboundEvent._tag === "AgentActivity") {
            return outbox.offerMeta(
              "activity",
              encodeBrowserStreamMeta({ agentActive: outboundEvent.agentActive }),
            );
          }
          const event = outboundEvent.event;
          if (event._tag === "Tabs") {
            tabs = event.tabs;
            return outbox.offerMeta("tabs", encodeBrowserStreamMeta(event));
          }
          if (event._tag === "Status") {
            return outbox.offerMeta("status", encodeBrowserStreamMeta(event));
          }

          const frame = event satisfies BrowserBinaryViewportFrame;
          const handlerStartedAt = streamDebug ? browserMonotonicMillis() : 0;
          const timing = streamDebug
            ? (getBrowserFrameTiming(frame) ??
              (() => {
                const fallbackTiming = browserMonotonicMillis();
                return {
                  cdpReceivedAtMonotonicMillis: fallbackTiming,
                  mailboxPublishedAtMonotonicMillis: fallbackTiming,
                };
              })())
            : {
                cdpReceivedAtMonotonicMillis: 0,
                mailboxPublishedAtMonotonicMillis: 0,
              };
          return outbox
            .offerFrame({
              bytes: encodeBrowserStreamFrame({
                seq: frame.seq,
                width: frame.width,
                height: frame.height,
                tabIndexHint: tabIndexHint(tabs, frame.targetId),
                jpegBytes: frame.jpegBytes,
              }),
              ...timing,
              seq: frame.seq,
              targetId: frame.targetId,
            })
            .pipe(
              Effect.andThen(
                streamDebug
                  ? logBrowserHandlerTiming(
                      "browser.stream.frame-mailbox-handler",
                      handlerStartedAt,
                      {
                        threadId: input.threadId,
                        targetId: frame.targetId,
                        seq: frame.seq,
                      },
                    )
                  : Effect.void,
              ),
            );
        }),
      );

      const incoming = input.socket.runRaw((message) => {
        const inputReceivedAtMonotonicMillis = streamDebug ? browserMonotonicMillis() : 0;
        if (typeof message === "string") {
          return Effect.logDebug("Ignoring text browser stream message", {
            threadId: input.threadId,
          });
        }
        return Effect.sync(() => {
          try {
            return { _tag: "Success", value: decodeBrowserStreamInput(message) } as const;
          } catch (cause) {
            return { _tag: "Failure", cause } as const;
          }
        }).pipe(
          Effect.flatMap((result) =>
            result._tag === "Failure"
              ? Effect.logDebug("Ignoring invalid browser stream input", {
                  threadId: input.threadId,
                  cause: result.cause,
                })
              : input.browserManager
                  .dispatchInput(input.threadId, result.value.targetId, result.value.event)
                  .pipe(
                    Effect.tap(() =>
                      streamDebug
                        ? logBrowserHandlerTiming(
                            "browser.input.socket-receive-to-cdp-complete",
                            inputReceivedAtMonotonicMillis,
                            {
                              threadId: input.threadId,
                              targetId: result.value.targetId,
                              inputType: result.value.event._tag,
                            },
                          )
                        : Effect.void,
                    ),
                    Effect.catch((error) =>
                      Effect.logDebug("Browser stream input was not dispatched", {
                        threadId: input.threadId,
                        targetId: result.value.targetId,
                        error: error.message,
                      }),
                    ),
                  ),
          ),
        );
      });

      yield* Effect.raceFirst(incoming, Effect.raceFirst(outbound, outbox.run));
    }),
  );
}

const browserStreamHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const browserManager = yield* BrowserSessionManager;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
  yield* requireAuthScope(session.scopes, AuthBrowserOperateScope);

  const routeParams = yield* HttpRouter.params;
  const rawThreadId = routeParams.threadId;
  if (rawThreadId === undefined || rawThreadId.trim().length === 0) {
    return HttpServerResponse.text("Invalid browser stream thread.", { status: 400 });
  }
  const threadId = ThreadId.make(rawThreadId);
  const state = yield* Effect.result(browserManager.getState(threadId));
  if (state._tag === "Failure") return browserStreamErrorResponse(state.failure);

  const socket = yield* request.upgrade;
  yield* runBrowserStreamConnection({
    browserManager,
    getBufferedBytes: () => browserStreamBufferedBytes(request.source),
    socket,
    threadId,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("Browser stream connection closed", {
        threadId,
        cause,
      }),
    ),
  );
  return HttpServerResponse.empty();
}).pipe(
  Effect.catchTag("AuthError", respondToAuthError),
  Effect.catchTag("EnvironmentAuthorizationError", () =>
    Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 })),
  ),
);

export const browserStreamRouteLayer = HttpRouter.add(
  "GET",
  BROWSER_STREAM_ROUTE,
  browserStreamHandler,
);
