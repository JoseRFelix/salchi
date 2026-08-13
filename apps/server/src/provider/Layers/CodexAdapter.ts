/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  EventId,
  MessageId,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSubagentId,
  ProviderApprovalDecision,
  ThreadId,
  TrimmedNonEmptyString,
  ProviderSendTurnInput,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import {
  makeKeyedCoalescingWorker,
  type KeyedCoalescingWorker,
} from "@salchi/shared/KeyedCoalescingWorker";

import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@salchi/shared/model";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  formatPdfAttachmentReferenceText,
  toProviderAttachmentReference,
} from "../attachmentInputs.ts";
import {
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  CODEX_USAGE_REFRESH_TIMEOUT,
  makeCodexAppServerClient,
  makeCodexSessionRuntime,
  type CodexAppServerClientHandle,
  type CodexSpawnedChildThreadListOptions,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
  type MakeCodexAppServerClientOptions,
} from "./CodexSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  codexChildThreadId,
  extractCodexSubagentMetadata,
  extractCodexThreadSpawnMetadata,
} from "./CodexChildThreads.ts";
import { INDEPENDENT_THREAD_TOOL_METHOD } from "../IndependentThreadTool.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly makeCodexAppServerClient?: (
    options: MakeCodexAppServerClientOptions,
  ) => Effect.Effect<
    CodexAppServerClientHandle,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CodexAdapterRootSessionContext {
  readonly kind: "root";
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  readonly childThreadIds: Set<ThreadId>;
  readonly stoppedChildThreadIds: Set<ThreadId>;
  readonly stoppedChildProviderThreadIds: Set<string>;
  readonly childThreadStartedMetadataByProviderThreadId: Map<
    string,
    { readonly key: string; readonly score: number }
  >;
  readonly recoveryWorker: KeyedCoalescingWorker<ThreadId, CodexChildRecoveryWork>;
  providerThreadId?: string;
  stopped: boolean;
}

interface CodexAdapterChildSessionContext {
  readonly kind: "child";
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly rootThreadId: ThreadId;
  readonly providerThreadId: string;
  readonly runtime: CodexSessionRuntimeShape;
  stopped: boolean;
}

type CodexAdapterSessionContext = CodexAdapterRootSessionContext | CodexAdapterChildSessionContext;

interface CodexChildBackfillWork {
  readonly threadId: ThreadId;
  readonly providerThreadId: string;
}

interface CodexChildHydrationWork {
  readonly candidateProviderThreadIds?: ReadonlySet<string>;
  readonly allowScanRepair?: boolean;
  readonly maxPages?: number;
  readonly reason?: string;
}

interface CodexChildRecoveryWork {
  readonly root: CodexAdapterRootSessionContext;
  readonly backfills: ReadonlyMap<string, CodexChildBackfillWork>;
  readonly hydrations: ReadonlyArray<CodexChildHydrationWork>;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"]
  | CodexThreadSnapshot["turns"][number]["items"][number];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

const SalchiThreadCreateNotificationPayload = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  initialPrompt: Schema.optional(TrimmedNonEmptyString),
  initialMessageId: Schema.optional(MessageId),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  createdByThreadId: Schema.optional(ThreadId),
  sourceItemId: Schema.optional(RuntimeItemId),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function readSalchiParentThreadId(payload: unknown): ThreadId | undefined {
  if (!isRecord(payload)) return undefined;
  const raw = payload.salchiParentThreadId;
  return typeof raw === "string" && raw.trim().length > 0 ? ThreadId.make(raw) : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? trimText(value) : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = readString(entry);
        return text ? [text] : [];
      })
    : [];
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function resolveCodexApprovalsReviewer(
  modelSelection: ProviderSendTurnInput["modelSelection"] | undefined,
  boundInstanceId: ProviderInstanceId,
): EffectCodexSchema.V2TurnStartParams__ApprovalsReviewer | undefined {
  if (modelSelection?.instanceId !== boundInstanceId) {
    return undefined;
  }
  const autoReview = getModelSelectionBooleanOptionValue(modelSelection, "autoReview");
  if (autoReview === true) {
    return "auto_review";
  }
  if (autoReview === false) {
    return "user";
  }
  return undefined;
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab") || type.includes("sub agent") || type.includes("agent activity"))
    return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(item: CodexLifecycleItem): string | undefined {
  const candidates = [
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function isoFromUnixSeconds(value: number | null | undefined, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
}

function runtimeTurnStateFromSnapshotStatus(
  status: string,
): "completed" | "failed" | "interrupted" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return undefined;
  }
}

function runtimeItemStatusFromSnapshotItem(
  item: CodexThreadSnapshot["turns"][number]["items"][number],
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  if (!("status" in item) || typeof item.status !== "string") {
    return undefined;
  }
  switch (item.status) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
      return item.status;
    default:
      return undefined;
  }
}

function backfillEventId(...parts: ReadonlyArray<string>): EventId {
  return EventId.make(["codex-snapshot-backfill", ...parts].join(":"));
}

function codexThreadSnapshotBackfillEvents(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly snapshot: CodexThreadSnapshot;
  readonly fallbackCreatedAt: string;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const events: ProviderRuntimeEvent[] = [];

  for (const turn of input.snapshot.turns) {
    const turnStartedAt = isoFromUnixSeconds(turn.startedAt, input.fallbackCreatedAt);
    const turnCompletedAt = isoFromUnixSeconds(
      turn.completedAt ?? turn.startedAt,
      input.fallbackCreatedAt,
    );
    events.push({
      eventId: backfillEventId(input.snapshot.threadId, turn.id, "turn-started"),
      provider: PROVIDER,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
      turnId: turn.id,
      createdAt: turnStartedAt,
      type: "turn.started",
      payload: {},
    });

    for (const item of turn.items) {
      const itemId = RuntimeItemId.make(item.id);
      const itemType = toCanonicalItemType(item.type);
      const detail = itemDetail(item);
      const status = runtimeItemStatusFromSnapshotItem(item);
      const eventType = status === "inProgress" ? "item.updated" : "item.completed";
      const generatedImages = generatedImagePayloadsFromItem(item);
      for (const [index, generatedImage] of generatedImages.entries()) {
        events.push({
          eventId: backfillEventId(
            input.snapshot.threadId,
            turn.id,
            item.id,
            "image-generated",
            String(index),
          ),
          provider: PROVIDER,
          providerInstanceId: input.providerInstanceId,
          threadId: input.threadId,
          turnId: turn.id,
          itemId,
          createdAt: turnCompletedAt,
          type: "image.generated",
          payload: generatedImage,
        });
      }
      events.push({
        eventId: backfillEventId(input.snapshot.threadId, turn.id, item.id, eventType),
        provider: PROVIDER,
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        turnId: turn.id,
        itemId,
        createdAt: turnCompletedAt,
        type: eventType,
        payload: {
          itemType,
          ...(status ? { status } : {}),
          ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
          ...(detail ? { detail } : {}),
          data: {
            source: "codex.thread-read.backfill",
            providerThreadId: input.snapshot.threadId,
            item,
          },
        },
      });
    }

    const turnState = runtimeTurnStateFromSnapshotStatus(turn.status);
    if (turnState) {
      events.push({
        eventId: backfillEventId(input.snapshot.threadId, turn.id, "turn-completed"),
        provider: PROVIDER,
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        turnId: turn.id,
        createdAt: turnCompletedAt,
        type: "turn.completed",
        payload: {
          state: turnState,
          ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
        },
      });
    }
  }

  return events;
}

interface GeneratedImagePayload {
  readonly name: string;
  readonly dataUrl: string;
}

function imageDataUrl(value: unknown): string | undefined {
  const url = readString(value);
  return url && /^data:image\/[^;,]+;base64,/i.test(url) ? url : undefined;
}

function base64ImageDataUrl(input: {
  readonly data: unknown;
  readonly mimeType: unknown;
}): string | undefined {
  const data = readString(input.data);
  const mimeType = readString(input.mimeType)?.toLowerCase();
  if (!data || !mimeType?.startsWith("image/")) {
    return undefined;
  }
  return `data:${mimeType};base64,${data}`;
}

function imagePayloadFromToolContentItem(
  contentItem: unknown,
  name: string,
): GeneratedImagePayload | undefined {
  if (!isRecord(contentItem)) {
    return undefined;
  }

  const type = readString(contentItem.type);
  if (type === "inputImage") {
    const dataUrl = imageDataUrl(contentItem.imageUrl);
    return dataUrl ? { name, dataUrl } : undefined;
  }
  if (type === "input_image") {
    const dataUrl = imageDataUrl(contentItem.image_url);
    return dataUrl ? { name, dataUrl } : undefined;
  }
  if (type === "image") {
    const dataUrl = base64ImageDataUrl({
      data: contentItem.data,
      mimeType: contentItem.mimeType ?? contentItem.mime_type,
    });
    return dataUrl ? { name, dataUrl } : undefined;
  }
  if (type === "resource" && isRecord(contentItem.resource)) {
    const dataUrl = base64ImageDataUrl({
      data: contentItem.resource.blob,
      mimeType: contentItem.resource.mimeType ?? contentItem.resource.mime_type,
    });
    return dataUrl ? { name, dataUrl } : undefined;
  }
  return undefined;
}

function generatedImagePayloadsFromItem(item: unknown): ReadonlyArray<GeneratedImagePayload> {
  if (!isRecord(item)) {
    return [];
  }

  const type = readString(item.type);
  const itemId = readString(item.id) ?? "tool-output";
  if (type === "imageGeneration" || type === "image_generation_call") {
    const result = readString(item.result);
    if (!result) {
      return [];
    }
    return [
      {
        name: `${itemId}.png`,
        dataUrl: imageDataUrl(result) ?? `data:image/png;base64,${result}`,
      },
    ];
  }

  const contentItems =
    type === "dynamicToolCall"
      ? item.contentItems
      : type === "mcpToolCall" && isRecord(item.result)
        ? item.result.content
        : undefined;
  if (!Array.isArray(contentItems)) {
    return [];
  }

  const images: GeneratedImagePayload[] = [];
  for (const contentItem of contentItems) {
    const imageNumber = images.length + 1;
    const image = imagePayloadFromToolContentItem(contentItem, `${itemId}-image-${imageNumber}`);
    if (image) {
      images.push(image);
    }
  }
  return images;
}

function imageGeneratedRuntimeEventsFromItem(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  item: unknown,
): ReadonlyArray<ProviderRuntimeEvent> {
  return generatedImagePayloadsFromItem(item).map((generatedImage, index) => ({
    ...runtimeEventBase(event, canonicalThreadId),
    eventId: EventId.make(`${event.id}:image:${index}`),
    type: "image.generated",
    payload: generatedImage,
  }));
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeSubagentId(subagentId: string): RuntimeSubagentId {
  return RuntimeSubagentId.make(subagentId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function subagentNicknameFromPath(agentPath: string | undefined): string | undefined {
  if (!agentPath) {
    return undefined;
  }
  const segments = agentPath.split(/[\\/]/).map((segment) => trimText(segment));
  const basename = segments.findLast((segment) => segment !== undefined);
  if (!basename) {
    return undefined;
  }
  return trimText(basename.replace(/\.[^.]+$/, "")) ?? basename;
}

function subagentNicknameFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  const match = prompt.match(/\byour\s+nickname\s+is\s+([A-Za-z][\w-]{0,63})\b/i);
  return match?.[1] ? trimText(match[1]) : undefined;
}

function collabAgentMetadataFromState(
  record: Record<string, unknown>,
  subagentId: string,
): { readonly role?: string; readonly nickname?: string; readonly path?: string } {
  const agentsStates = isRecord(record.agentsStates) ? record.agentsStates : null;
  const state =
    agentsStates && isRecord(agentsStates[subagentId]) ? agentsStates[subagentId] : null;
  if (!state) {
    return {};
  }

  const agentPath =
    readString(state.agentPath) ?? readString(state.agent_path) ?? readString(state.path);
  const role = readString(state.agentRole) ?? readString(state.agent_role) ?? agentPath;
  const nickname =
    readString(state.agentNickname) ??
    readString(state.agent_nickname) ??
    readString(state.nickname) ??
    readString(state.agentName) ??
    readString(state.name) ??
    subagentNicknameFromPrompt(readString(record.prompt)) ??
    subagentNicknameFromPath(agentPath);

  return {
    ...(role ? { role } : {}),
    ...(nickname ? { nickname } : {}),
    ...(agentPath ? { path: agentPath } : {}),
  };
}

function readCollabAgentReceiverThreadIds(item: unknown): string[] {
  if (!isRecord(item) || readString(item.type) !== "collabAgentToolCall") {
    return [];
  }
  return [...readStringArray(item.receiverThreadIds)];
}

function shouldHydrateSpawnedChildrenFromCollabTool(item: unknown): boolean {
  if (!isRecord(item) || readCollabAgentReceiverThreadIds(item).length === 0) {
    return false;
  }
  if (readString(item.status) !== "completed") {
    return false;
  }

  switch (readString(item.tool)) {
    case "spawnAgent":
    case "wait":
    case "closeAgent":
      return true;
    default:
      return false;
  }
}

function subAgentActivityThreadId(item: unknown): string | undefined {
  if (
    !isRecord(item) ||
    readString(item.type) !== "subAgentActivity" ||
    readString(item.kind) !== "started"
  ) {
    return undefined;
  }
  return readString(item.agentThreadId);
}

function codexChildHydrationInputFromEvent(
  event: ProviderEvent,
): { readonly candidateProviderThreadIds: ReadonlySet<string>; readonly reason: string } | null {
  if (event.method !== "item/completed") {
    return null;
  }
  if (!isRecord(event.payload)) {
    return null;
  }
  const item = event.payload.item;
  const activityThreadId = subAgentActivityThreadId(item);
  if (activityThreadId) {
    return {
      candidateProviderThreadIds: new Set([activityThreadId]),
      reason: "subagent-activity:started",
    };
  }
  if (!shouldHydrateSpawnedChildrenFromCollabTool(item)) {
    return null;
  }
  const receiverThreadIds = readCollabAgentReceiverThreadIds(item);
  if (receiverThreadIds.length === 0) {
    return null;
  }
  const tool = isRecord(item) ? readString(item.tool) : undefined;
  return {
    candidateProviderThreadIds: new Set(receiverThreadIds),
    reason: tool ? `collab-agent:${tool}` : "collab-agent",
  };
}

function childThreadSpawnMetadataFromEvent(
  event: ProviderEvent,
  providerThreadId: string,
): {
  readonly subagentNickname?: string;
  readonly subagentRole?: string;
  readonly subagentPath?: string;
} {
  if (!isRecord(event.payload) || !isRecord(event.payload.item)) {
    return {};
  }
  const item = event.payload.item;
  if (
    readString(item.type) === "subAgentActivity" &&
    readString(item.agentThreadId) === providerThreadId
  ) {
    const path = readString(item.agentPath) ?? readString(item.agent_path);
    const role = readString(item.agentRole) ?? readString(item.agent_role) ?? path;
    const nickname =
      readString(item.agentNickname) ??
      readString(item.agent_nickname) ??
      subagentNicknameFromPath(path);
    return {
      ...(nickname ? { subagentNickname: nickname } : {}),
      ...(role ? { subagentRole: role } : {}),
      ...(path ? { subagentPath: path } : {}),
    };
  }

  const metadata = collabAgentMetadataFromState(item, providerThreadId);
  return {
    ...(metadata.nickname ? { subagentNickname: metadata.nickname } : {}),
    ...(metadata.role ? { subagentRole: metadata.role } : {}),
    ...(metadata.path ? { subagentPath: metadata.path } : {}),
  };
}

function codexCollabToolSummary(
  tool: string | undefined,
  lifecycle: "item.started" | "item.completed",
  status: string | undefined,
): string {
  if (status === "failed") {
    return "Subagent action failed";
  }

  switch (tool) {
    case "spawnAgent":
      return lifecycle === "item.started" ? "Subagent started" : "Subagent spawned";
    case "sendInput":
      return lifecycle === "item.started" ? "Sending input to subagent" : "Subagent input sent";
    case "resumeAgent":
      return lifecycle === "item.started" ? "Resuming subagent" : "Subagent resumed";
    case "wait":
      return lifecycle === "item.started" ? "Waiting on subagent" : "Subagent wait completed";
    case "closeAgent":
      return lifecycle === "item.started" ? "Closing subagent" : "Subagent closed";
    default:
      return lifecycle === "item.started"
        ? "Subagent activity started"
        : "Subagent activity completed";
  }
}

function codexSubagentEventsFromLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.completed",
  item: CodexLifecycleItem,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (!isRecord(item)) {
    return [];
  }

  const record = item as Record<string, unknown>;
  const itemType = readString(record.type);
  if (itemType === "subAgentActivity") {
    const subagentThreadId = readString(record.agentThreadId);
    if (!subagentThreadId) {
      return [];
    }

    const agentPath = readString(record.agentPath);
    const nickname = subagentNicknameFromPath(agentPath);
    const commonPayload = {
      subagentId: asRuntimeSubagentId(subagentThreadId),
      providerThreadId: subagentThreadId,
      ...(event.turnId ? { parentTurnId: event.turnId } : {}),
      ...(event.itemId ? { sourceItemId: asRuntimeItemId(event.itemId) } : {}),
      ...(agentPath ? { role: agentPath } : {}),
      ...(nickname && nickname !== agentPath ? { nickname } : {}),
    };

    switch (readString(record.kind)) {
      case "started":
        return [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "subagent.started",
            payload: {
              ...commonPayload,
              status: "running",
              summary: "Subagent started",
            },
          },
        ];
      case "interacted":
        return [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "subagent.updated",
            payload: {
              ...commonPayload,
              status: "running",
              summary: "Subagent active",
            },
          },
        ];
      case "interrupted":
        return [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "subagent.completed",
            payload: {
              ...commonPayload,
              status: "interrupted",
              summary: "Subagent interrupted",
            },
          },
        ];
      default:
        return [];
    }
  }

  if (itemType !== "collabAgentToolCall") {
    return [];
  }

  const receiverThreadIds = readStringArray(record.receiverThreadIds);
  const fallbackId = readString(record.id);
  const subagentIds =
    receiverThreadIds.length > 0 ? receiverThreadIds : fallbackId ? [fallbackId] : [];
  if (subagentIds.length === 0) {
    return [];
  }

  const tool = readString(record.tool);
  const status = readString(record.status);
  const model = readString(record.model);
  const prompt = readString(record.prompt);
  const receiverThreadIdSet = new Set(receiverThreadIds);
  const summary = codexCollabToolSummary(tool, lifecycle, status);

  return subagentIds.map((subagentId) => {
    const metadata = collabAgentMetadataFromState(record, subagentId);
    const commonPayload = {
      subagentId: asRuntimeSubagentId(subagentId),
      ...(receiverThreadIdSet.has(subagentId) ? { providerThreadId: subagentId } : {}),
      ...(event.turnId ? { parentTurnId: event.turnId } : {}),
      ...(event.itemId ? { sourceItemId: asRuntimeItemId(event.itemId) } : {}),
      ...metadata,
      ...(model ? { model } : {}),
      ...(prompt ? { prompt } : {}),
      summary,
    };

    if (tool === "spawnAgent" && lifecycle === "item.started") {
      return {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "subagent.started",
        payload: {
          ...commonPayload,
          status: "running",
        },
      };
    }

    if (tool === "spawnAgent" && lifecycle === "item.completed" && status === "failed") {
      return {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "subagent.completed",
        payload: {
          ...commonPayload,
          status: "failed",
          error: summary,
        },
      };
    }

    if (tool === "closeAgent" && lifecycle === "item.completed" && status === "completed") {
      return {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "subagent.completed",
        payload: {
          ...commonPayload,
          status: "stopped",
        },
      };
    }

    return {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "subagent.updated",
      payload: {
        ...commonPayload,
        ...(status === "failed" ? {} : { status: "running" }),
        ...(tool ? { lastToolName: tool } : {}),
      },
    };
  });
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === INDEPENDENT_THREAD_TOOL_METHOD) {
    const payload = readPayload(SalchiThreadCreateNotificationPayload, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.independent.created",
        payload: {
          threadId: payload.threadId,
          title: payload.title,
          createdByThreadId: payload.createdByThreadId ?? canonicalThreadId,
          ...(payload.initialPrompt ? { initialPrompt: payload.initialPrompt } : {}),
          ...(payload.initialMessageId ? { initialMessageId: payload.initialMessageId } : {}),
          ...(payload.titleSeed ? { titleSeed: payload.titleSeed } : {}),
          ...(payload.sourceItemId ? { sourceItemId: payload.sourceItemId } : {}),
          ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
          ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
          ...(payload.workspaceRoot !== undefined ? { workspaceRoot: payload.workspaceRoot } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const metadata = extractCodexSubagentMetadata(payload.thread);
    const parentThreadId = readSalchiParentThreadId(event.payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
          ...(metadata?.providerParentThreadId
            ? { providerParentThreadId: metadata.providerParentThreadId }
            : {}),
          ...(parentThreadId ? { parentThreadId } : {}),
          ...(metadata?.subagentKind ? { subagentKind: metadata.subagentKind } : {}),
          ...(metadata?.subagentNickname ? { subagentNickname: metadata.subagentNickname } : {}),
          ...(metadata?.subagentRole ? { subagentRole: metadata.subagentRole } : {}),
          ...(metadata?.subagentPath ? { subagentPath: metadata.subagentPath } : {}),
          ...(metadata ? { hiddenFromThreadList: metadata.hiddenFromThreadList } : {}),
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : payload
                    ? toThreadState(payload.status)
                    : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(payload.turn.status),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "rawResponseItem/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2RawResponseItemCompletedNotification,
      event.payload,
    );
    const generatedEvents = imageGeneratedRuntimeEventsFromItem(
      event,
      canonicalThreadId,
      payload?.item,
    );
    return generatedEvents;
  }

  if (event.method === "item/started") {
    const payload = readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload);
    const generatedEvents = imageGeneratedRuntimeEventsFromItem(
      event,
      canonicalThreadId,
      payload?.item,
    );
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    const subagentEvents = payload?.item
      ? codexSubagentEventsFromLifecycle(event, canonicalThreadId, "item.started", payload.item)
      : [];
    return [...generatedEvents, ...(started ? [started] : []), ...subagentEvents];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const generatedEvents = imageGeneratedRuntimeEventsFromItem(event, canonicalThreadId, item);
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    const subagentEvents = codexSubagentEventsFromLifecycle(
      event,
      canonicalThreadId,
      "item.completed",
      item,
    );
    return [...generatedEvents, ...(completed ? [completed] : []), ...subagentEvents];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();
  let accountClient:
    | {
        readonly scope: Scope.Scope;
        readonly client: CodexClient.CodexAppServerClientShape;
      }
    | undefined;

  const childThreadStartedMetadataKey = (input: {
    readonly providerThreadId: string;
    readonly providerParentThreadId: string;
    readonly parentThreadId: ThreadId;
    readonly subagentNickname?: string | undefined;
    readonly subagentRole?: string | undefined;
    readonly subagentPath?: string | undefined;
  }): string =>
    JSON.stringify({
      providerThreadId: input.providerThreadId,
      providerParentThreadId: input.providerParentThreadId,
      parentThreadId: input.parentThreadId,
      subagentKind: "thread_spawn",
      subagentNickname: input.subagentNickname ?? null,
      subagentRole: input.subagentRole ?? null,
      subagentPath: input.subagentPath ?? null,
      hiddenFromThreadList: false,
    });

  const childThreadStartedMetadataScore = (input: {
    readonly subagentNickname?: string | undefined;
    readonly subagentRole?: string | undefined;
    readonly subagentPath?: string | undefined;
  }): number =>
    (input.subagentNickname ? 1 : 0) + (input.subagentRole ? 1 : 0) + (input.subagentPath ? 1 : 0);

  const childThreadStartedEventId = (input: {
    readonly providerParentThreadId: string;
    readonly providerThreadId: string;
    readonly metadataKey: string;
  }): EventId => {
    const suffix = Buffer.from(input.metadataKey).toString("base64url").slice(0, 96);
    return EventId.make(
      [
        "codex-child-thread-started",
        input.providerParentThreadId,
        input.providerThreadId,
        suffix,
      ].join(":"),
    );
  };

  const registerVirtualChildSession = Effect.fn("registerVirtualChildSession")(function* (input: {
    readonly root: CodexAdapterRootSessionContext;
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly providerThreadId: string;
  }) {
    const existing = sessions.get(input.threadId);
    if (existing && !existing.stopped) {
      if (existing.kind === "child" && existing.providerThreadId === input.providerThreadId) {
        return;
      }
      yield* stopSessionInternal(existing);
    }

    yield* input.root.runtime.registerProviderThreadBinding({
      providerThreadId: input.providerThreadId,
      threadId: input.threadId,
      parentThreadId: input.parentThreadId,
    });
    input.root.childThreadIds.add(input.threadId);
    sessions.set(input.threadId, {
      kind: "child",
      threadId: input.threadId,
      parentThreadId: input.parentThreadId,
      rootThreadId: input.root.threadId,
      providerThreadId: input.providerThreadId,
      runtime: input.root.runtime,
      stopped: false,
    });
  });

  const emitMaterializedChildThreadStarted = Effect.fn("emitMaterializedChildThreadStarted")(
    function* (input: {
      readonly root: CodexAdapterRootSessionContext;
      readonly threadId: ThreadId;
      readonly providerThreadId: string;
      readonly createdAt: string;
      readonly subagentNickname?: string | undefined;
      readonly subagentRole?: string | undefined;
      readonly subagentPath?: string | undefined;
      readonly raw?: ProviderRuntimeEvent["raw"] | undefined;
      readonly providerRefs?: ProviderRuntimeEvent["providerRefs"] | undefined;
    }) {
      const providerParentThreadId = input.root.providerThreadId;
      if (!providerParentThreadId) {
        return;
      }
      const metadataKey = childThreadStartedMetadataKey({
        providerThreadId: input.providerThreadId,
        providerParentThreadId,
        parentThreadId: input.root.threadId,
        subagentNickname: input.subagentNickname,
        subagentRole: input.subagentRole,
        subagentPath: input.subagentPath,
      });
      const metadataScore = childThreadStartedMetadataScore(input);
      const previousMetadata = input.root.childThreadStartedMetadataByProviderThreadId.get(
        input.providerThreadId,
      );
      if (
        previousMetadata?.key === metadataKey ||
        (previousMetadata?.score ?? -1) > metadataScore
      ) {
        return;
      }
      input.root.childThreadStartedMetadataByProviderThreadId.set(input.providerThreadId, {
        key: metadataKey,
        score: metadataScore,
      });

      yield* Queue.offer(runtimeEventQueue, {
        eventId: childThreadStartedEventId({
          providerParentThreadId,
          providerThreadId: input.providerThreadId,
          metadataKey,
        }),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        createdAt: input.createdAt,
        type: "thread.started",
        payload: {
          providerThreadId: input.providerThreadId,
          providerParentThreadId,
          parentThreadId: input.root.threadId,
          subagentKind: "thread_spawn",
          hiddenFromThreadList: false,
          ...(input.subagentNickname ? { subagentNickname: input.subagentNickname } : {}),
          ...(input.subagentRole ? { subagentRole: input.subagentRole } : {}),
          ...(input.subagentPath ? { subagentPath: input.subagentPath } : {}),
        },
        ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
        ...(input.raw ? { raw: input.raw } : {}),
      });
    },
  );

  const ensureMaterializedCandidateChildSessions = Effect.fn(
    "ensureMaterializedCandidateChildSessions",
  )(function* (
    root: CodexAdapterRootSessionContext,
    event: ProviderEvent,
    hydration: CodexChildHydrationWork,
  ) {
    if (!root.providerThreadId || !hydration.candidateProviderThreadIds) {
      return;
    }

    yield* Effect.forEach(
      hydration.candidateProviderThreadIds,
      (providerThreadId) =>
        Effect.gen(function* () {
          if (root.stoppedChildProviderThreadIds.has(providerThreadId)) {
            return;
          }

          const threadId = codexChildThreadId(boundInstanceId, providerThreadId);
          if (root.stoppedChildThreadIds.has(threadId)) {
            return;
          }

          const existing = sessions.get(threadId);
          if (
            !existing ||
            existing.stopped ||
            existing.kind !== "child" ||
            existing.providerThreadId !== providerThreadId
          ) {
            yield* registerVirtualChildSession({
              root,
              threadId,
              parentThreadId: root.threadId,
              providerThreadId,
            });
          }

          const metadata = childThreadSpawnMetadataFromEvent(event, providerThreadId);
          yield* emitMaterializedChildThreadStarted({
            root,
            threadId,
            providerThreadId,
            createdAt: event.createdAt,
            ...metadata,
            providerRefs: providerRefsFromEvent(event),
            raw: {
              source: eventRawSource(event),
              method: event.method,
              payload: event.payload ?? {},
            },
          });
          yield* enqueueChildBackfillRecovery(root, { threadId, providerThreadId });
        }),
      { concurrency: 1, discard: true },
    );
  });

  const enqueueChildThreadSnapshotBackfill = Effect.fn("enqueueChildThreadSnapshotBackfill")(
    function* (input: {
      readonly root: CodexAdapterRootSessionContext;
      readonly threadId: ThreadId;
      readonly providerThreadId: string;
    }) {
      const rootSession = yield* input.root.runtime.getSession;
      const snapshot = yield* input.root.runtime.readProviderThread(input.providerThreadId);
      const runtimeEvents = codexThreadSnapshotBackfillEvents({
        threadId: input.threadId,
        providerInstanceId: boundInstanceId,
        snapshot,
        fallbackCreatedAt: rootSession.updatedAt,
      });
      if (runtimeEvents.length > 0) {
        yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
      }
    },
  );

  const registerVirtualChildFromThreadStartedEvent = Effect.fn(
    "registerVirtualChildFromThreadStartedEvent",
  )(function* (root: CodexAdapterRootSessionContext, event: ProviderEvent) {
    if (event.method !== "thread/started" || event.threadId === root.threadId) {
      return;
    }
    if (root.stoppedChildThreadIds.has(event.threadId)) {
      return;
    }
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return;
    }
    if (root.stoppedChildProviderThreadIds.has(payload.thread.id)) {
      return;
    }
    const metadata = extractCodexThreadSpawnMetadata(payload.thread);
    if (!metadata) {
      return;
    }
    yield* registerVirtualChildSession({
      root,
      threadId: event.threadId,
      parentThreadId: readSalchiParentThreadId(event.payload) ?? root.threadId,
      providerThreadId: payload.thread.id,
    });
  });

  const hydrateSpawnedChildSessions = Effect.fn("hydrateSpawnedChildSessions")(function* (
    root: CodexAdapterRootSessionContext,
    options?: CodexSpawnedChildThreadListOptions & {
      readonly reason?: string;
    },
  ) {
    if (!root.providerThreadId) {
      return;
    }
    const children = yield* root.runtime.listSpawnedChildThreads(root.providerThreadId, options);
    const rootSession = yield* root.runtime.getSession;
    yield* Effect.forEach(
      children,
      (thread) =>
        Effect.gen(function* () {
          const metadata = extractCodexThreadSpawnMetadata(thread);
          if (!metadata) {
            return;
          }
          if (
            options?.candidateProviderThreadIds &&
            !options.candidateProviderThreadIds.has(thread.id)
          ) {
            return;
          }
          if (root.stoppedChildProviderThreadIds.has(thread.id)) {
            return;
          }
          const threadId = codexChildThreadId(boundInstanceId, thread.id);
          if (root.stoppedChildThreadIds.has(threadId)) {
            return;
          }
          const existing = sessions.get(threadId);
          if (
            !existing ||
            existing.stopped ||
            existing.kind !== "child" ||
            existing.providerThreadId !== thread.id
          ) {
            yield* registerVirtualChildSession({
              root,
              threadId,
              parentThreadId: root.threadId,
              providerThreadId: thread.id,
            });
          }
          yield* emitMaterializedChildThreadStarted({
            root,
            threadId,
            providerThreadId: thread.id,
            createdAt: rootSession.updatedAt,
            subagentNickname: metadata.subagentNickname,
            subagentRole: metadata.subagentRole,
            subagentPath: metadata.subagentPath,
            raw: {
              source: "codex.app-server.notification",
              method: "thread/started",
              payload: {
                thread,
                salchiParentThreadId: root.threadId,
              },
            },
          });
          yield* enqueueChildBackfillRecovery(root, {
            threadId,
            providerThreadId: thread.id,
          });
        }),
      { concurrency: 1, discard: true },
    );
  });

  const emptyRecoveryWork = (root: CodexAdapterRootSessionContext): CodexChildRecoveryWork => ({
    root,
    backfills: new Map(),
    hydrations: [],
  });

  const mergeRecoveryWork = (
    current: CodexChildRecoveryWork,
    next: CodexChildRecoveryWork,
  ): CodexChildRecoveryWork => {
    const backfills = new Map(current.backfills);
    for (const [providerThreadId, backfill] of next.backfills) {
      backfills.set(providerThreadId, backfill);
    }
    return {
      root: next.root,
      backfills,
      hydrations: [...current.hydrations, ...next.hydrations],
    };
  };

  const processChildRecoveryWork = (work: CodexChildRecoveryWork) =>
    Effect.gen(function* () {
      if (work.root.stopped) {
        return;
      }
      yield* Effect.forEach(
        Array.from(work.backfills.values()),
        (backfill) =>
          enqueueChildThreadSnapshotBackfill({
            root: work.root,
            threadId: backfill.threadId,
            providerThreadId: backfill.providerThreadId,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to backfill Codex spawned child thread", {
                threadId: backfill.threadId,
                providerThreadId: backfill.providerThreadId,
                cause,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        work.hydrations,
        (hydration) =>
          hydrateSpawnedChildSessions(work.root, hydration).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to hydrate Codex spawned child threads", {
                threadId: work.root.threadId,
                reason: hydration.reason,
                candidateProviderThreadIds: hydration.candidateProviderThreadIds
                  ? [...hydration.candidateProviderThreadIds]
                  : undefined,
                cause,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

  const enqueueChildBackfillRecovery = (
    root: CodexAdapterRootSessionContext,
    backfill: CodexChildBackfillWork,
  ) =>
    root.recoveryWorker.enqueue(root.threadId, {
      ...emptyRecoveryWork(root),
      backfills: new Map([[backfill.providerThreadId, backfill]]),
    });

  const enqueueChildHydrationRecovery = (
    root: CodexAdapterRootSessionContext,
    hydration: CodexChildHydrationWork = {},
  ) =>
    root.recoveryWorker.enqueue(root.threadId, {
      ...emptyRecoveryWork(root),
      hydrations: [hydration],
    });

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* Effect.suspend(() => stopSessionInternal(existing));
        }

        const approvalsReviewer = resolveCodexApprovalsReviewer(
          input.modelSelection,
          boundInstanceId,
        );
        const serviceTier =
          input.modelSelection?.instanceId === boundInstanceId
            ? getCodexServiceTierOptionValue(input.modelSelection)
            : undefined;
        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          cwd: input.cwd ?? process.cwd(),
          binaryPath: codexConfig.binaryPath,
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(isCodexResumeCursorSchema(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          runtimeMode: input.runtimeMode,
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(approvalsReviewer
            ? {
                approvalsReviewer:
                  approvalsReviewer as EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer,
              }
            : {}),
        };
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const recoveryWorker = yield* makeKeyedCoalescingWorker({
          merge: mergeRecoveryWork,
          process: (_rootThreadId: ThreadId, work: CodexChildRecoveryWork) =>
            processChildRecoveryWork(work),
        }).pipe(Effect.provideService(Scope.Scope, sessionScope));

        let rootSession: CodexAdapterRootSessionContext | undefined;
        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const root = rootSession;
            if (root?.stoppedChildThreadIds.has(event.threadId)) {
              return;
            }
            if (root) {
              yield* registerVirtualChildFromThreadStartedEvent(root, event);
            }
            const hydrationInput = root ? codexChildHydrationInputFromEvent(event) : null;
            if (root && hydrationInput) {
              yield* ensureMaterializedCandidateChildSessions(root, event, hydrationInput);
            }
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
            } else {
              yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            }
            if (runtimeEvents.length > 0 && event.method === "thread/started" && root) {
              const childSession = sessions.get(event.threadId);
              if (childSession?.kind === "child") {
                yield* enqueueChildBackfillRecovery(root, {
                  threadId: childSession.threadId,
                  providerThreadId: childSession.providerThreadId,
                });
              }
            }
            if (root && hydrationInput) {
              yield* enqueueChildHydrationRecovery(root, {
                ...hydrationInput,
                allowScanRepair: true,
              });
            }
          }),
        ).pipe(Effect.forkChild);
        rootSession = {
          kind: "root",
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          childThreadIds: new Set(),
          stoppedChildThreadIds: new Set(),
          stoppedChildProviderThreadIds: new Set(),
          childThreadStartedMetadataByProviderThreadId: new Map(),
          recoveryWorker,
          stopped: false,
        };

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );

        const startedProviderThreadId = isCodexResumeCursorSchema(started.resumeCursor)
          ? started.resumeCursor.threadId
          : undefined;
        if (startedProviderThreadId) {
          rootSession.providerThreadId = startedProviderThreadId;
        }
        sessions.set(input.threadId, rootSession);
        if (startedProviderThreadId && String(input.threadId).startsWith("codex-child-")) {
          yield* enqueueChildBackfillRecovery(rootSession, {
            threadId: input.threadId,
            providerThreadId: startedProviderThreadId,
          });
        }
        yield* enqueueChildHydrationRecovery(rootSession, {
          allowScanRepair: true,
          reason: "root-start",
        });
        sessionScopeTransferred = true;

        return started;
      }),
    );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    method: "turn/start" | "turn/steer",
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    if (attachment.type === "pdf") {
      const reference = toProviderAttachmentReference(attachment, attachmentPath);
      return {
        input: {
          type: "mention" as const,
          name: attachment.name,
          path: attachmentPath,
        },
        reference,
      };
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      input: {
        type: "image" as const,
        url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      },
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const resolvedAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment("turn/start", attachment),
      { concurrency: 1 },
    );
    const codexAttachments = resolvedAttachments.map((attachment) => attachment.input);
    const attachmentReferenceText = formatPdfAttachmentReferenceText(
      resolvedAttachments.flatMap((attachment) =>
        attachment.reference ? [attachment.reference] : [],
      ),
    );
    const runtimeInputText = [input.input, attachmentReferenceText]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");

    const session = yield* requireSession(input.threadId);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? getCodexServiceTierOptionValue(input.modelSelection)
        : undefined;
    const approvalsReviewer = resolveCodexApprovalsReviewer(input.modelSelection, boundInstanceId);
    const runtimeTurnInput = {
      ...(runtimeInputText.length > 0 ? { input: runtimeInputText } : {}),
      ...(input.modelSelection?.instanceId === boundInstanceId
        ? { model: input.modelSelection.model }
        : {}),
      ...(reasoningEffort
        ? {
            effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
          }
        : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(approvalsReviewer ? { approvalsReviewer } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
    };
    const turn =
      session.kind === "child"
        ? session.runtime.sendTurnToProviderThread(session.providerThreadId, runtimeTurnInput)
        : session.runtime.sendTurn(runtimeTurnInput);
    return yield* turn.pipe(
      Effect.map((result) => ({ ...result, threadId: input.threadId })),
      Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)),
    );
  });

  const steerTurn: CodexAdapterShape["steerTurn"] = Effect.fn("steerTurn")(function* (input) {
    const resolvedAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment("turn/steer", attachment),
      { concurrency: 1 },
    );
    const codexAttachments = resolvedAttachments.map((attachment) => attachment.input);
    const attachmentReferenceText = formatPdfAttachmentReferenceText(
      resolvedAttachments.flatMap((attachment) =>
        attachment.reference ? [attachment.reference] : [],
      ),
    );
    const runtimeInputText = [input.input, attachmentReferenceText]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");
    const runtimeSteerInput = {
      expectedTurnId: input.expectedTurnId,
      messageId: input.messageId,
      ...(runtimeInputText.length > 0 ? { input: runtimeInputText } : {}),
      ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
    } satisfies Parameters<CodexSessionRuntimeShape["steerTurn"]>[0];

    const session = yield* requireSession(input.threadId);
    const turn =
      session.kind === "child"
        ? session.runtime.steerTurnToProviderThread(session.providerThreadId, runtimeSteerInput)
        : session.runtime.steerTurn(runtimeSteerInput);
    return yield* turn.pipe(
      Effect.map((result) => ({ ...result, threadId: input.threadId })),
      Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/steer", cause)),
    );
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        session.kind === "child"
          ? session.runtime.interruptProviderThreadTurn(session.providerThreadId, turnId)
          : session.runtime.interruptTurn(turnId),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        session.kind === "child"
          ? session.runtime.readProviderThread(session.providerThreadId)
          : session.runtime.readThread,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        session.kind === "child"
          ? session.runtime.rollbackProviderThread(session.providerThreadId, numTurns)
          : session.runtime.rollbackThread(numTurns),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
  ) {
    if (session.stopped) {
      return;
    }
    if (session.kind === "child") {
      session.stopped = true;
      sessions.delete(session.threadId);
      const root = sessions.get(session.rootThreadId);
      if (root?.kind === "root") {
        root.childThreadIds.delete(session.threadId);
        root.stoppedChildThreadIds.add(session.threadId);
        root.stoppedChildProviderThreadIds.add(session.providerThreadId);
      }
      return;
    }

    session.stopped = true;
    sessions.delete(session.threadId);
    for (const childThreadId of session.childThreadIds) {
      const child = sessions.get(childThreadId);
      if (child?.kind === "child") {
        child.stopped = true;
        session.stoppedChildThreadIds.add(child.threadId);
        session.stoppedChildProviderThreadIds.add(child.providerThreadId);
        sessions.delete(childThreadId);
      }
    }
    session.childThreadIds.clear();
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped),
      (session) =>
        session.kind === "child"
          ? session.runtime.getSession.pipe(
              Effect.map((rootSession) => ({
                ...rootSession,
                threadId: session.threadId,
                resumeCursor: { threadId: session.providerThreadId },
                status: session.stopped ? "closed" : rootSession.status,
              })),
            )
          : session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const refreshUsage: NonNullable<CodexAdapterShape["refreshUsage"]> = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter(
        (session): session is CodexAdapterRootSessionContext =>
          session.kind === "root" && !session.stopped,
      ),
      (session) =>
        session.runtime.refreshUsage.pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("codex.adapter.usage.refresh-failed", {
              threadId: session.threadId,
              cause,
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.asVoid);

  const getAccountRateLimits: NonNullable<CodexAdapterShape["getAccountRateLimits"]> = () =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return undefined;
      }

      if (!accountClient) {
        const accountScope = yield* Scope.make("sequential");
        const createAccountClient = options?.makeCodexAppServerClient ?? makeCodexAppServerClient;
        const handle = yield* createAccountClient({
          binaryPath: codexConfig.binaryPath,
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          cwd: process.cwd(),
          ...(options?.environment ? { environment: options.environment } : {}),
        }).pipe(
          Effect.provideService(Scope.Scope, accountScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        );
        accountClient = {
          scope: accountScope,
          client: handle.client,
        };
      }

      return yield* accountClient.client.request("account/rateLimits/read", undefined).pipe(
        Effect.timeoutOption(CODEX_USAGE_REFRESH_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("codex.account-rate-limits.failed", { cause }).pipe(Effect.as(undefined)),
      ),
    );

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter(
        (session): session is CodexAdapterRootSessionContext => session.kind === "root",
      ),
      stopSessionInternal,
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.asVoid);

  const closeAccountClient = Effect.gen(function* () {
    if (!accountClient) {
      return;
    }
    const current = accountClient;
    accountClient = undefined;
    yield* Scope.close(current.scope, Exit.void);
  });

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(closeAccountClient),
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      childThreadMode: "materialized",
      activeTurnSteering: "native",
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    refreshUsage,
    getAccountRateLimits,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CodexAdapterShape;
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
