import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BrowserSessionStatus = Schema.Literals(["stopped", "starting", "running", "crashed"]);
export type BrowserSessionStatus = typeof BrowserSessionStatus.Type;

export const BrowserTab = Schema.Struct({
  targetId: TrimmedNonEmptyString,
  title: Schema.String,
  url: Schema.String,
  active: Schema.Boolean,
});
export type BrowserTab = typeof BrowserTab.Type;

export const BrowserExecutableSource = Schema.Literals(["environment", "setting", "channel"]);
export type BrowserExecutableSource = typeof BrowserExecutableSource.Type;

export const BrowserExecutableInfo = Schema.Struct({
  source: BrowserExecutableSource,
  resolution: TrimmedNonEmptyString,
  executablePath: TrimmedNonEmptyString,
});
export type BrowserExecutableInfo = typeof BrowserExecutableInfo.Type;

export const BrowserExecutableResolutionAttempt = Schema.Struct({
  source: BrowserExecutableSource,
  resolution: TrimmedNonEmptyString,
  error: Schema.String,
});
export type BrowserExecutableResolutionAttempt = typeof BrowserExecutableResolutionAttempt.Type;

export const BrowserSessionState = Schema.Struct({
  threadId: ThreadId,
  status: BrowserSessionStatus,
  tabs: Schema.Array(BrowserTab),
  executable: Schema.NullOr(BrowserExecutableInfo),
  error: Schema.optionalKey(Schema.String),
});
export type BrowserSessionState = typeof BrowserSessionState.Type;

export const BrowserThreadInput = Schema.Struct({ threadId: ThreadId });
export type BrowserThreadInput = typeof BrowserThreadInput.Type;

export const BrowserSetActiveTabInput = Schema.Struct({
  threadId: ThreadId,
  targetId: TrimmedNonEmptyString,
});
export type BrowserSetActiveTabInput = typeof BrowserSetActiveTabInput.Type;

export const BrowserOpenTabInput = Schema.Struct({
  threadId: ThreadId,
  url: TrimmedNonEmptyString,
});
export type BrowserOpenTabInput = typeof BrowserOpenTabInput.Type;

export const BrowserCloseTabInput = BrowserSetActiveTabInput;
export type BrowserCloseTabInput = typeof BrowserCloseTabInput.Type;

export const BrowserViewportFrame = Schema.TaggedStruct("Frame", {
  threadId: ThreadId,
  targetId: TrimmedNonEmptyString,
  dataBase64: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
  seq: NonNegativeInt,
  capturedAt: Schema.DateTimeUtc,
});
export type BrowserViewportFrame = typeof BrowserViewportFrame.Type;

export const BrowserViewportTabs = Schema.TaggedStruct("Tabs", {
  threadId: ThreadId,
  tabs: Schema.Array(BrowserTab),
});
export type BrowserViewportTabs = typeof BrowserViewportTabs.Type;

export const BrowserViewportStatus = Schema.TaggedStruct("Status", {
  threadId: ThreadId,
  status: BrowserSessionStatus,
  error: Schema.optionalKey(Schema.String),
});
export type BrowserViewportStatus = typeof BrowserViewportStatus.Type;

export const BrowserViewportEvent = Schema.Union([
  BrowserViewportFrame,
  BrowserViewportTabs,
  BrowserViewportStatus,
]);
export type BrowserViewportEvent = typeof BrowserViewportEvent.Type;

export class BrowserUnavailable extends Schema.TaggedErrorClass<BrowserUnavailable>()(
  "BrowserUnavailable",
  {
    message: Schema.String,
    attempts: Schema.Array(BrowserExecutableResolutionAttempt),
  },
) {}

export class BrowserCrashed extends Schema.TaggedErrorClass<BrowserCrashed>()("BrowserCrashed", {
  threadId: ThreadId,
  message: Schema.String,
}) {}

export class ThreadNotFound extends Schema.TaggedErrorClass<ThreadNotFound>()("ThreadNotFound", {
  threadId: ThreadId,
  message: Schema.String,
}) {}

export class BrowserTabNotFound extends Schema.TaggedErrorClass<BrowserTabNotFound>()(
  "BrowserTabNotFound",
  {
    threadId: ThreadId,
    targetId: TrimmedNonEmptyString,
    message: Schema.String,
  },
) {}

export class BrowserOperationError extends Schema.TaggedErrorClass<BrowserOperationError>()(
  "BrowserOperationError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const BrowserRpcError = Schema.Union([
  BrowserUnavailable,
  BrowserCrashed,
  ThreadNotFound,
  BrowserTabNotFound,
  BrowserOperationError,
]);
export type BrowserRpcError = typeof BrowserRpcError.Type;
