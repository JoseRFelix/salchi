import type { ThreadId } from "@salchi/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { BrowserAgentSessionAccess } from "../BrowserAgentAccess.ts";

export interface BrowserAgentBrokerShape {
  readonly port: number;
  readonly acquireSessionAccess: (threadId: ThreadId) => Effect.Effect<BrowserAgentSessionAccess>;
}

export class BrowserAgentBroker extends Context.Service<
  BrowserAgentBroker,
  BrowserAgentBrokerShape
>()("salchi/browser/Services/BrowserAgentBroker") {}

export const BrowserAgentBrokerDisabled = Layer.succeed(BrowserAgentBroker, {
  port: 0,
  acquireSessionAccess: () =>
    Effect.succeed({
      environment: {},
      release: Effect.void,
    }),
});
