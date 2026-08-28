import type { ThreadId } from "@salchi/contracts";
import type * as Effect from "effect/Effect";

export const SALCHI_BROWSER_CDP_URL_ENV = "SALCHI_BROWSER_CDP_URL";

export interface BrowserAgentSessionAccess {
  readonly environment: NodeJS.ProcessEnv;
  readonly release: Effect.Effect<void>;
}

export type AcquireBrowserAgentSessionAccess = (
  threadId: ThreadId,
) => Effect.Effect<BrowserAgentSessionAccess>;

export function mergeBrowserAgentEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  browserEnvironment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (environment === undefined && browserEnvironment === undefined) return undefined;
  return {
    ...environment,
    ...browserEnvironment,
  };
}
