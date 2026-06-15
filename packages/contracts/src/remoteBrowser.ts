import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RemoteBrowserProvider = Schema.Literals(["disabled", "remote-url", "managed-neko"]);
export type RemoteBrowserProvider = typeof RemoteBrowserProvider.Type;

export const RemoteBrowserScreen = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[1-9][0-9]{2,4}x[1-9][0-9]{2,4}@[1-9][0-9]{0,2}$/u),
);
export type RemoteBrowserScreen = typeof RemoteBrowserScreen.Type;

export const RemoteBrowserAgentControlState = Schema.Struct({
  state: Schema.Literals(["disabled", "connecting", "ready", "error"]),
  message: Schema.NullOr(Schema.String),
});
export type RemoteBrowserAgentControlState = typeof RemoteBrowserAgentControlState.Type;

export const RemoteBrowserConfig = Schema.Struct({
  enabled: Schema.Boolean,
  provider: RemoteBrowserProvider,
  prewarm: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  cdpUrl: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  containerName: Schema.NullOr(TrimmedNonEmptyString),
  httpPort: PortSchema.pipe(Schema.withDecodingDefault(Effect.succeed(8080))),
  screen: RemoteBrowserScreen.pipe(Schema.withDecodingDefault(Effect.succeed("1280x720@30"))),
});
export type RemoteBrowserConfig = typeof RemoteBrowserConfig.Type;

export const DEFAULT_REMOTE_BROWSER_CONFIG: RemoteBrowserConfig = {
  enabled: false,
  provider: "disabled",
  prewarm: false,
  url: null,
  cdpUrl: null,
  image: null,
  containerName: null,
  httpPort: 8080,
  screen: "1280x720@30",
};

export const RemoteBrowserStartInput = Schema.Struct({
  screen: Schema.optional(RemoteBrowserScreen),
});
export type RemoteBrowserStartInput = typeof RemoteBrowserStartInput.Type;

export const RemoteBrowserNavigateInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type RemoteBrowserNavigateInput = typeof RemoteBrowserNavigateInput.Type;

export const RemoteBrowserStatus = Schema.Struct({
  enabled: Schema.Boolean,
  provider: RemoteBrowserProvider,
  state: Schema.Literals([
    "disabled",
    "idle",
    "checking-docker",
    "pulling-image",
    "starting-container",
    "ready",
    "error",
  ]),
  url: Schema.NullOr(Schema.String),
  pageUrl: Schema.NullOr(Schema.String),
  cdpUrl: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  containerName: Schema.NullOr(TrimmedNonEmptyString),
  screen: RemoteBrowserScreen,
  progress: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  agentControl: RemoteBrowserAgentControlState,
});
export type RemoteBrowserStatus = typeof RemoteBrowserStatus.Type;

export const DEFAULT_REMOTE_BROWSER_STATUS: RemoteBrowserStatus = {
  enabled: false,
  provider: "disabled",
  state: "disabled",
  url: null,
  pageUrl: null,
  cdpUrl: null,
  image: null,
  containerName: null,
  screen: "1280x720@30",
  progress: null,
  message: "Remote browser is disabled.",
  retryable: false,
  agentControl: { state: "disabled", message: null },
};
