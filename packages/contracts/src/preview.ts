/**
 * Preview - Schemas for the in-app browser preview surface.
 *
 * The preview server tracks per-thread tab metadata so it survives client
 * reconnects and multi-window. Desktop renderers own Chromium <webview>
 * instances; web/mobile clients can use a server-hosted browser provider.
 *
 * @module Preview
 */
import { Schema } from "effect";
import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const Title = Schema.String.check(Schema.isMaxLength(512));

export const PreviewTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewTabId = typeof PreviewTabId.Type;

export const PreviewNavStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("Success", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("LoadFailed", {
    url: Url,
    title: Title,
    code: Schema.Int,
    description: Schema.String,
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewViewportSize = Schema.Struct({
  width: PositiveInt,
  height: PositiveInt,
});
export type PreviewViewportSize = typeof PreviewViewportSize.Type;

export const PreviewSessionHost = Schema.Union([
  Schema.TaggedStruct("Desktop", {}),
  Schema.TaggedStruct("Steel", {
    sessionId: TrimmedNonEmptyString,
    viewerUrl: Url,
    viewportSize: Schema.optional(PreviewViewportSize),
  }),
]);
export type PreviewSessionHost = typeof PreviewSessionHost.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  host: Schema.optional(PreviewSessionHost),
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to create an empty (Idle) tab the user can type into. */
  url: Schema.optional(Url),
  /** Prefer the local desktop webview or a configured server-hosted provider. */
  hostPreference: Schema.optional(Schema.Literals(["desktop", "steel"])),
  /** Optional renderer viewport for server-hosted preview providers. */
  viewportSize: Schema.optional(PreviewViewportSize),
});
export type PreviewOpenInput = typeof PreviewOpenInput.Type;

export const PreviewNavigateInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  url: Url,
  resolvedTitle: Schema.optional(Title),
  /** Optional renderer viewport for server-hosted preview providers. */
  viewportSize: Schema.optional(PreviewViewportSize),
});
export type PreviewNavigateInput = typeof PreviewNavigateInput.Type;

export const PreviewReportStatusInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
});
export type PreviewReportStatusInput = typeof PreviewReportStatusInput.Type;

export const PreviewRefreshInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewRefreshInput = typeof PreviewRefreshInput.Type;

export const PreviewHistoryInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewHistoryInput = typeof PreviewHistoryInput.Type;

export const PreviewKeyboardInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  action: Schema.Union([
    Schema.TaggedStruct("InsertText", {
      text: Schema.String.check(Schema.isMaxLength(4096)),
    }),
    Schema.TaggedStruct("PressKey", {
      key: Schema.Literals(["Backspace", "Delete", "Enter", "Tab"]),
    }),
  ]),
});
export type PreviewKeyboardInput = typeof PreviewKeyboardInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const PreviewListInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewListInput = typeof PreviewListInput.Type;

export const PreviewListResult = Schema.Struct({
  sessions: Schema.Array(PreviewSessionSnapshot),
});
export type PreviewListResult = typeof PreviewListResult.Type;

const PreviewEventBaseSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
});

const PreviewOpenedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("opened"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewNavigatedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("navigated"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewFailedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("failed"),
  url: Url,
  title: Title,
  code: Schema.Int,
  description: Schema.String,
});

const PreviewClosedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

export const PreviewEvent = Schema.Union([
  PreviewOpenedEvent,
  PreviewNavigatedEvent,
  PreviewFailedEvent,
  PreviewClosedEvent,
]);
export type PreviewEvent = typeof PreviewEvent.Type;

/**
 * A localhost server detected by the port scanner. Used to populate the
 * "Local" recommendations in the empty-state of the preview panel.
 */
export const DiscoveredLocalServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536)),
  url: Url,
  processName: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  terminal: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
  ),
});
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type;

export const DiscoveredLocalServerList = Schema.Struct({
  servers: Schema.Array(DiscoveredLocalServer),
  scannedAt: Schema.String,
});
export type DiscoveredLocalServerList = typeof DiscoveredLocalServerList.Type;

export class PreviewSessionLookupError extends Schema.TaggedErrorClass<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedErrorClass<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  {
    rawUrl: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.detail
      ? `Invalid preview URL: ${this.rawUrl} (${this.detail})`
      : `Invalid preview URL: ${this.rawUrl}`;
  }
}

export class PreviewRemoteHostUnavailableError extends Schema.TaggedErrorClass<PreviewRemoteHostUnavailableError>()(
  "PreviewRemoteHostUnavailableError",
  {
    host: Schema.Literals(["steel"]),
    detail: Schema.String,
  },
) {
  override get message() {
    return `Preview remote host unavailable: ${this.host} (${this.detail})`;
  }
}

export const PreviewError = Schema.Union([
  PreviewSessionLookupError,
  PreviewInvalidUrlError,
  PreviewRemoteHostUnavailableError,
]);
export type PreviewError = typeof PreviewError.Type;
