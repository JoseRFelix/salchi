import type {
  BrowserHistoryAction,
  BrowserInputEvent,
  BrowserRpcError,
  BrowserSessionState,
  BrowserViewportEvent,
  ThreadId,
} from "@salchi/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface BrowserSessionManagerShape {
  readonly resolveRootThreadId?: (threadId: ThreadId) => Effect.Effect<ThreadId, BrowserRpcError>;
  readonly start: (threadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly stop: (threadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly getState: (threadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly getCdpWebSocketUrl: (threadId: ThreadId) => Effect.Effect<string, BrowserRpcError>;
  readonly agentConnectionOpened: (
    threadId: ThreadId,
    connectionId: string,
  ) => Effect.Effect<void, BrowserRpcError>;
  readonly recordAgentCdpActivity: (
    threadId: ThreadId,
    connectionId: string,
  ) => Effect.Effect<void>;
  readonly recordAgentCdpCommand: (threadId: ThreadId, connectionId: string) => Effect.Effect<void>;
  readonly agentConnectionClosed: (threadId: ThreadId, connectionId: string) => Effect.Effect<void>;
  readonly setActiveTab: (
    threadId: ThreadId,
    targetId: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly openTab: (
    threadId: ThreadId,
    url: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly navigate: (
    threadId: ThreadId,
    targetId: string,
    url: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly navigateHistory: (
    threadId: ThreadId,
    targetId: string,
    action: BrowserHistoryAction,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly closeTab: (
    threadId: ThreadId,
    targetId: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly dispatchInput: (
    threadId: ThreadId,
    targetId: string,
    event: BrowserInputEvent,
  ) => Effect.Effect<void, BrowserRpcError>;
  readonly subscribeViewport: (
    threadId: ThreadId,
  ) => Stream.Stream<BrowserViewportEvent, BrowserRpcError>;
  readonly subscribeAgentActivity: (threadId: ThreadId) => Stream.Stream<boolean, BrowserRpcError>;
}

export class BrowserSessionManager extends Context.Service<
  BrowserSessionManager,
  BrowserSessionManagerShape
>()("salchi/browser/Services/BrowserSessionManager") {}
