import type {
  BrowserRpcError,
  BrowserSessionState,
  BrowserViewportEvent,
  ThreadId,
} from "@salchi/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface BrowserSessionManagerShape {
  readonly start: (threadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly stop: (threadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly getState: (threadId: ThreadId) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly setActiveTab: (
    threadId: ThreadId,
    targetId: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly openTab: (
    threadId: ThreadId,
    url: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly closeTab: (
    threadId: ThreadId,
    targetId: string,
  ) => Effect.Effect<BrowserSessionState, BrowserRpcError>;
  readonly subscribeViewport: (
    threadId: ThreadId,
  ) => Stream.Stream<BrowserViewportEvent, BrowserRpcError>;
}

export class BrowserSessionManager extends Context.Service<
  BrowserSessionManager,
  BrowserSessionManagerShape
>()("salchi/browser/Services/BrowserSessionManager") {}
