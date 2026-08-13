import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderItemId,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@salchi/contracts";
import { normalizeModelSlug } from "@salchi/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SchemaIssue from "effect/SchemaIssue";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { resolveSpawnCommand } from "@salchi/shared/shell";
import { terminateChildProcess } from "@salchi/shared/childProcess";
import { registerManagedChildProcess } from "../../process/ManagedChildProcessRegistry.ts";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexChildThreadId, extractCodexThreadSpawnMetadata } from "./CodexChildThreads.ts";
import {
  INDEPENDENT_THREAD_TOOL_METHOD,
  INDEPENDENT_THREAD_TOOL_SPEC,
  isIndependentThreadToolCall,
  parseIndependentThreadToolArguments,
} from "../IndependentThreadTool.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);
const decodeV2TurnSteerParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams);
const decodeV2TurnSteerResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerResponse);
const decodeV2ThreadStartResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ThreadStartResponse,
);

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
export const CODEX_USAGE_REFRESH_TIMEOUT = Duration.seconds(10);
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexDynamicToolSpec = EffectCodexSchema.V2ThreadStartParams__DynamicToolSpec;
type CodexThreadStartParamsWithDynamicTools = EffectCodexSchema.V2ThreadStartParams & {
  readonly dynamicTools?: ReadonlyArray<CodexDynamicToolSpec> | null;
};
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];
export type CodexSessionRuntimeAttachmentInput = Extract<
  EffectCodexSchema.V2TurnStartParams__UserInput,
  { readonly type: "image" } | { readonly type: "mention" }
>;

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly processRegistryDirectory?: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly approvalsReviewer?: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer | undefined;
  readonly resumeCursor?: CodexResumeCursor;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<CodexSessionRuntimeAttachmentInput>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly approvalsReviewer?: EffectCodexSchema.V2TurnStartParams__ApprovalsReviewer | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexSessionRuntimeSteerTurnInput {
  readonly expectedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<CodexSessionRuntimeAttachmentInput>;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly status: string;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly errorMessage?: string;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSpawnedChildThreadListOptions {
  readonly candidateProviderThreadIds?: ReadonlySet<string>;
  readonly allowScanRepair?: boolean;
  readonly maxPages?: number;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly registerProviderThreadBinding: (input: {
    readonly providerThreadId: string;
    readonly threadId: ThreadId;
    readonly parentThreadId?: ThreadId;
  }) => Effect.Effect<void>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly sendTurnToProviderThread: (
    providerThreadId: string,
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly steerTurn: (
    input: CodexSessionRuntimeSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly steerTurnToProviderThread: (
    providerThreadId: string,
    input: CodexSessionRuntimeSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly interruptProviderThreadTurn: (
    providerThreadId: string,
    turnId?: TurnId,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly readProviderThread: (
    providerThreadId: string,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackProviderThread: (
    providerThreadId: string,
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly listSpawnedChildThreads: (
    parentProviderThreadId: string,
    options?: CodexSpawnedChildThreadListOptions,
  ) => Effect.Effect<
    ReadonlyArray<EffectCodexSchema.V2ThreadListResponse["data"][number]>,
    CodexSessionRuntimeError
  >;
  readonly refreshUsage: Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer | undefined;
}): CodexThreadStartParamsWithDynamicTools {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    dynamicTools: [INDEPENDENT_THREAD_TOOL_SPEC],
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
  };
}

function buildThreadResumeParams(input: {
  readonly threadId: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadResumeParams__ApprovalsReviewer | undefined;
}): EffectCodexSchema.V2ThreadResumeParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    threadId: input.threadId,
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<CodexSessionRuntimeAttachmentInput>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly approvalsReviewer?: EffectCodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/start request payload", error)),
  );
}

export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<CodexSessionRuntimeAttachmentInput>;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnSteerParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  turnInput.push(...(input.attachments ?? []));

  return decodeV2TurnSteerParams({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    clientUserMessageId: input.messageId,
    input: turnInput,
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/steer request payload", error)),
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly raw: {
    readonly request: (
      method: string,
      payload?: unknown,
    ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  };
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

function startCodexThread(
  client: CodexThreadOpenClient,
  payload: CodexThreadStartParamsWithDynamicTools,
): Effect.Effect<
  CodexRpc.ClientRequestResponsesByMethod["thread/start"],
  CodexErrors.CodexAppServerError
> {
  return client.raw
    .request("thread/start", payload)
    .pipe(
      Effect.flatMap((raw) =>
        decodeV2ThreadStartResponse(raw).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/start response payload", error),
          ),
        ),
      ),
    );
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer | undefined;
  readonly resumeThreadId: string | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
    approvalsReviewer: input.approvalsReviewer,
  });

  if (resumeThreadId === undefined) {
    return startCodexThread(input.client, startParams);
  }

  return input.client
    .request(
      "thread/resume",
      buildThreadResumeParams({
        threadId: resumeThreadId,
        cwd: input.cwd,
        runtimeMode: input.runtimeMode,
        model: input.requestedModel,
        serviceTier: input.serviceTier,
        approvalsReviewer: input.approvalsReviewer,
      }),
    )
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error.message,
        }).pipe(Effect.andThen(startCodexThread(input.client, startParams))),
      ),
    );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readProviderThreadIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const raw = (payload as Record<string, unknown>).threadId;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "rawResponseItem/completed": {
      const rawItemId =
        "id" in notification.params.item && typeof notification.params.item.id === "string"
          ? notification.params.item.id
          : undefined;
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: rawItemId ? ProviderItemId.make(rawItemId) : undefined,
      };
    }
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function toProtocolParseError(
  detail: string,
  cause: Schema.SchemaError,
): CodexErrors.CodexAppServerProtocolParseError {
  return new CodexErrors.CodexAppServerProtocolParseError({
    detail: `${detail}: ${formatSchemaIssue(cause.issue)}`,
    cause,
  });
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...updates,
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      status: turn.status,
      ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
      ...(turn.completedAt !== undefined ? { completedAt: turn.completedAt } : {}),
      ...(turn.error?.message ? { errorMessage: turn.error.message } : {}),
      items: turn.items,
    })),
  };
}

export interface MakeCodexAppServerClientOptions {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly processRegistryDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexAppServerClientHandle {
  readonly client: CodexClient.CodexAppServerClientShape;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
}

export const makeCodexAppServerClient = (
  options: MakeCodexAppServerClientOptions,
): Effect.Effect<
  CodexAppServerClientHandle,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const clientScope = yield* Scope.Scope;

    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const spawnCommand = resolveSpawnCommand(options.binaryPath, ["app-server"], {
      env,
      extendEnv: true,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, clientScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const terminate = terminateChildProcess(child, {
      gracefulTimeout: CODEX_APP_SERVER_FORCE_KILL_AFTER,
      forceTimeout: CODEX_APP_SERVER_FORCE_KILL_AFTER,
    }).pipe(Effect.ignore);
    if (options.processRegistryDirectory) {
      yield* registerManagedChildProcess({
        registryDirectory: options.processRegistryDirectory,
        childPid: Number(child.pid),
        terminate,
      });
    } else {
      yield* Scope.addFinalizer(clientScope, terminate);
    }

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, clientScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);
    return { client, child } satisfies CodexAppServerClientHandle;
  });

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const runtimeScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const providerThreadToSalchiThreadRef = yield* Ref.make(new Map<string, ThreadId>());
    const providerThreadParentSalchiThreadRef = yield* Ref.make(new Map<string, ThreadId>());
    const activeProviderThreadTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const closedRef = yield* Ref.make(false);
    const providerInstanceId = options.providerInstanceId ?? ProviderInstanceId.make("codex");

    const { client, child } = yield* makeCodexAppServerClient({
      binaryPath: options.binaryPath,
      ...(options.homePath ? { homePath: options.homePath } : {}),
      cwd: options.cwd,
      ...(options.processRegistryDirectory
        ? { processRegistryDirectory: options.processRegistryDirectory }
        : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerTransportError({
            detail: "Failed to generate Codex runtime identifier.",
            cause,
          }),
      ),
    );

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4;
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const rememberProviderThreadBinding = (input: {
      readonly providerThreadId: string;
      readonly threadId: ThreadId;
      readonly parentThreadId?: ThreadId;
    }) => {
      const parentThreadId = input.parentThreadId;
      return Effect.all([
        Ref.update(providerThreadToSalchiThreadRef, (current) => {
          const next = new Map(current);
          next.set(input.providerThreadId, input.threadId);
          return next;
        }),
        parentThreadId
          ? Ref.update(providerThreadParentSalchiThreadRef, (current) => {
              const next = new Map(current);
              next.set(input.providerThreadId, parentThreadId);
              return next;
            })
          : Effect.void,
      ]).pipe(Effect.asVoid);
    };
    const resolveSalchiThreadIdForProviderThread = (providerThreadId: string | undefined) =>
      providerThreadId
        ? Ref.get(providerThreadToSalchiThreadRef).pipe(
            Effect.map((bindings) => bindings.get(providerThreadId) ?? options.threadId),
          )
        : Effect.succeed(options.threadId);
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const refreshAccountRateLimits = Effect.gen(function* () {
      const response = yield* client.request("account/rateLimits/read", undefined).pipe(
        Effect.timeoutOption(CODEX_USAGE_REFRESH_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                CodexErrors.CodexAppServerRequestError.internalError(
                  "Codex account rate-limit refresh timed out.",
                ),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      yield* emitEvent({
        kind: "notification",
        threadId: options.threadId,
        method: "account/rateLimits/updated",
        message: "Codex usage limits refreshed.",
        payload: response,
      });
    });

    const refreshAccountRateLimitsBestEffort = refreshAccountRateLimits.pipe(
      Effect.catch((error) =>
        Effect.logDebug("codex.usage.refresh.failed", {
          threadId: options.threadId,
          detail: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    // Ongoing usage polling is provider-scoped so opening more sessions cannot multiply account
    // requests. Keep one non-blocking initial read to populate the session immediately.
    const startInitialUsageRefresh = refreshAccountRateLimitsBestEffort.pipe(
      Effect.forkIn(runtimeScope),
    );

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const payload = notification.params;
        const route = readRouteFields(notification);
        const providerThreadId = readNotificationThreadId(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          return providerThreadId ? collabReceiverTurns.get(providerThreadId) : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        const mappedThreadId =
          providerThreadId !== undefined
            ? (yield* Ref.get(providerThreadToSalchiThreadRef)).get(providerThreadId)
            : undefined;

        if (
          childParentTurnId &&
          mappedThreadId === undefined &&
          shouldSuppressChildConversationNotification(notification.method)
        ) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId =
          mappedThreadId === undefined ? (childParentTurnId ?? route.turnId) : route.turnId;
        let itemId = route.itemId;
        let threadId =
          mappedThreadId ?? (yield* resolveSalchiThreadIdForProviderThread(providerThreadId));
        let eventPayload: unknown = payload;

        if (notification.method === "thread/started") {
          const spawnMetadata = extractCodexThreadSpawnMetadata(notification.params.thread);
          if (spawnMetadata) {
            const parentThreadId = (yield* Ref.get(providerThreadToSalchiThreadRef)).get(
              spawnMetadata.providerParentThreadId,
            );
            if (parentThreadId) {
              threadId = codexChildThreadId(providerInstanceId, notification.params.thread.id);
              yield* rememberProviderThreadBinding({
                providerThreadId: notification.params.thread.id,
                threadId,
                parentThreadId,
              });
              eventPayload = {
                ...payload,
                salchiParentThreadId: parentThreadId,
              };
            }
          }
        }

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            threadId = correlation.threadId;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        if (notification.method === "turn/started") {
          yield* Ref.update(activeProviderThreadTurnsRef, (current) => {
            const next = new Map(current);
            next.set(notification.params.threadId, TurnId.make(notification.params.turn.id));
            return next;
          });
        } else if (notification.method === "turn/completed") {
          yield* Ref.update(activeProviderThreadTurnsRef, (current) => {
            const next = new Map(current);
            next.delete(notification.params.threadId);
            return next;
          });
        }
        yield* emitEvent({
          kind: "notification",
          threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(eventPayload !== undefined ? { payload: eventPayload } : {}),
        });
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;
          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;
          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }
          const errorMessage = payload.error.message;
          const willRetry = payload.willRetry;
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        const threadId = yield* resolveSalchiThreadIdForProviderThread(
          readProviderThreadIdFromPayload(payload),
        );

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            threadId,
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            threadId,
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        const threadId = yield* resolveSalchiThreadIdForProviderThread(
          readProviderThreadIdFromPayload(payload),
        );

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            threadId,
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            threadId,
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();
        const threadId = yield* resolveSalchiThreadIdForProviderThread(
          readProviderThreadIdFromPayload(payload),
        );

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            threadId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/call", (payload) =>
      Effect.gen(function* () {
        if (!isIndependentThreadToolCall(payload)) {
          return {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: `Unsupported Salchi dynamic tool: ${
                  payload.namespace ? `${payload.namespace}/` : ""
                }${payload.tool}`,
              },
            ],
          } satisfies EffectCodexSchema.DynamicToolCallResponse;
        }

        const sourceThreadId = yield* resolveSalchiThreadIdForProviderThread(
          readProviderThreadIdFromPayload(payload),
        );
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.callId);
        const parsedArguments = parseIndependentThreadToolArguments(payload.arguments);
        if (
          parsedArguments.checkoutMode === "worktree" &&
          typeof parsedArguments.worktreePath !== "string"
        ) {
          return {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: "create_thread with checkoutMode 'worktree' requires worktreePath.",
              },
            ],
          } satisfies EffectCodexSchema.DynamicToolCallResponse;
        }
        const createdThreadId =
          parsedArguments.requestedThreadId ?? ThreadId.make(`codex-tool:${payload.callId}`);
        const initialMessageId = MessageId.make(`codex-tool:${payload.callId}:initial-message`);

        yield* emitEvent({
          kind: "notification",
          threadId: sourceThreadId,
          method: INDEPENDENT_THREAD_TOOL_METHOD,
          turnId,
          itemId,
          payload: {
            threadId: createdThreadId,
            title: parsedArguments.title,
            createdByThreadId: sourceThreadId,
            initialMessageId,
            sourceItemId: itemId,
            ...(parsedArguments.initialPrompt
              ? { initialPrompt: parsedArguments.initialPrompt }
              : {}),
            ...(parsedArguments.titleSeed ? { titleSeed: parsedArguments.titleSeed } : {}),
            ...(parsedArguments.branch !== undefined ? { branch: parsedArguments.branch } : {}),
            ...(parsedArguments.worktreePath !== undefined
              ? { worktreePath: parsedArguments.worktreePath }
              : {}),
            ...(parsedArguments.workspaceRoot !== undefined
              ? { workspaceRoot: parsedArguments.workspaceRoot }
              : {}),
          },
        });

        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: `Created independent thread '${createdThreadId}' (${parsedArguments.title}) from '${sourceThreadId}'.`,
            },
          ],
        } satisfies EffectCodexSchema.DynamicToolCallResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        approvalsReviewer: options.approvalsReviewer,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      const providerThreadId = opened.thread.id;
      yield* rememberProviderThreadBinding({
        providerThreadId,
        threadId: options.threadId,
      });
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      yield* startInitialUsageRefresh;
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped").pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Codex session closed event.", { cause }),
        ),
      );
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    const sendTurnToProviderThread = (
      providerThreadId: string,
      input: CodexSessionRuntimeSendTurnInput,
    ) =>
      Effect.gen(function* () {
        const normalizedModel = normalizeCodexModelSlug(
          input.model ?? (yield* Ref.get(sessionRef)).model,
        );
        const params = yield* buildTurnStartParams({
          threadId: providerThreadId,
          runtimeMode: options.runtimeMode,
          ...(input.input ? { prompt: input.input } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(normalizedModel ? { model: normalizedModel } : {}),
          ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
          ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        });
        const rawResponse = yield* client.raw.request("turn/start", params);
        const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid turn/start response payload", error),
          ),
        );
        const turnId = TurnId.make(response.turn.id);
        const rootProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
        yield* Ref.update(activeProviderThreadTurnsRef, (current) => {
          const next = new Map(current);
          next.set(providerThreadId, turnId);
          return next;
        });
        if (providerThreadId === rootProviderThreadId) {
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          });
        }
        const salchiThreadId = yield* resolveSalchiThreadIdForProviderThread(providerThreadId);
        return {
          threadId: salchiThreadId,
          turnId,
          resumeCursor: { threadId: providerThreadId },
        } satisfies ProviderTurnStartResult;
      });

    const steerTurnToProviderThread = (
      providerThreadId: string,
      input: CodexSessionRuntimeSteerTurnInput,
    ) =>
      Effect.gen(function* () {
        const params = yield* buildTurnSteerParams({
          threadId: providerThreadId,
          expectedTurnId: input.expectedTurnId,
          messageId: input.messageId,
          ...(input.input ? { prompt: input.input } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        });
        const rawResponse = yield* client.raw.request("turn/steer", params);
        const response = yield* decodeV2TurnSteerResponse(rawResponse).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid turn/steer response payload", error),
          ),
        );
        const turnId = TurnId.make(response.turnId);
        const salchiThreadId = yield* resolveSalchiThreadIdForProviderThread(providerThreadId);
        return {
          threadId: salchiThreadId,
          turnId,
          resumeCursor: { threadId: providerThreadId },
        } satisfies ProviderTurnStartResult;
      });

    const interruptProviderThreadTurn = (providerThreadId: string, turnId?: TurnId) =>
      Effect.gen(function* () {
        const session = yield* Ref.get(sessionRef);
        const activeProviderThreadTurns = yield* Ref.get(activeProviderThreadTurnsRef);
        const effectiveTurnId =
          turnId ??
          activeProviderThreadTurns.get(providerThreadId) ??
          (providerThreadId === currentProviderThreadId(session)
            ? session.activeTurnId
            : undefined);
        if (!effectiveTurnId) {
          return;
        }
        yield* client.request("turn/interrupt", {
          threadId: providerThreadId,
          turnId: effectiveTurnId,
        });
      });

    const readProviderThread = (providerThreadId: string) =>
      Effect.gen(function* () {
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      });

    const rollbackProviderThread = (providerThreadId: string, numTurns: number) =>
      Effect.gen(function* () {
        const response = yield* client.request("thread/rollback", {
          threadId: providerThreadId,
          numTurns,
        });
        const rootProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
        yield* Ref.update(activeProviderThreadTurnsRef, (current) => {
          const next = new Map(current);
          next.delete(providerThreadId);
          return next;
        });
        if (providerThreadId === rootProviderThreadId) {
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
        }
        return parseThreadSnapshot(response);
      });

    const listSpawnedChildThreads = (
      parentProviderThreadId: string,
      options: CodexSpawnedChildThreadListOptions = {},
    ) =>
      Effect.gen(function* () {
        const candidateProviderThreadIds = options.candidateProviderThreadIds;
        const hasAllCandidates = (
          threads: ReadonlyArray<EffectCodexSchema.V2ThreadListResponse["data"][number]>,
        ) => {
          if (!candidateProviderThreadIds || candidateProviderThreadIds.size === 0) {
            return false;
          }
          const found = new Set(threads.map((thread) => thread.id));
          for (const candidate of candidateProviderThreadIds) {
            if (!found.has(candidate)) {
              return false;
            }
          }
          return true;
        };
        const listWithStateDbMode = (useStateDbOnly: boolean) =>
          Effect.gen(function* () {
            const maxPages = Math.max(1, options.maxPages ?? 10);
            const threads: Array<EffectCodexSchema.V2ThreadListResponse["data"][number]> = [];
            let cursor: string | null | undefined;
            for (let page = 0; page < maxPages; page += 1) {
              const response = yield* client.request("thread/list", {
                sourceKinds: ["subAgentThreadSpawn"],
                useStateDbOnly,
                limit: 200,
                ...(cursor ? { cursor } : {}),
              });
              threads.push(
                ...response.data.filter(
                  (thread) =>
                    extractCodexThreadSpawnMetadata(thread)?.providerParentThreadId ===
                    parentProviderThreadId,
                ),
              );
              if (hasAllCandidates(threads)) {
                break;
              }
              cursor = response.nextCursor;
              if (!cursor) {
                break;
              }
            }
            return threads;
          });

        const stateDbThreads = yield* listWithStateDbMode(true);
        if (hasAllCandidates(stateDbThreads) || !options.allowScanRepair) {
          return stateDbThreads;
        }

        const repairedThreads = yield* listWithStateDbMode(false);
        const mergedThreadsById = new Map<string, (typeof stateDbThreads)[number]>();
        for (const thread of stateDbThreads) {
          mergedThreadsById.set(thread.id, thread);
        }
        for (const thread of repairedThreads) {
          mergedThreadsById.set(thread.id, thread);
        }
        const mergedThreads = [...mergedThreadsById.values()];
        if (candidateProviderThreadIds && !hasAllCandidates(mergedThreads)) {
          const found = new Set(mergedThreads.map((thread) => thread.id));
          const missing = [...candidateProviderThreadIds].filter(
            (candidate) => !found.has(candidate),
          );
          if (missing.length > 0) {
            yield* Effect.logWarning("Codex spawned child thread/list candidates missing", {
              parentProviderThreadId,
              missingProviderThreadIds: missing,
            });
          }
        }
        return mergedThreads;
      });

    return {
      start,
      getSession: Ref.get(sessionRef),
      registerProviderThreadBinding: rememberProviderThreadBinding,
      sendTurn: (input) =>
        readProviderThreadId.pipe(
          Effect.flatMap((providerThreadId) => sendTurnToProviderThread(providerThreadId, input)),
        ),
      sendTurnToProviderThread,
      steerTurn: (input) =>
        readProviderThreadId.pipe(
          Effect.flatMap((providerThreadId) => steerTurnToProviderThread(providerThreadId, input)),
        ),
      steerTurnToProviderThread,
      interruptTurn: (turnId) =>
        readProviderThreadId.pipe(
          Effect.flatMap((providerThreadId) =>
            interruptProviderThreadTurn(providerThreadId, turnId),
          ),
        ),
      interruptProviderThreadTurn,
      readThread: readProviderThreadId.pipe(Effect.flatMap(readProviderThread)),
      readProviderThread,
      rollbackThread: (numTurns) =>
        readProviderThreadId.pipe(
          Effect.flatMap((providerThreadId) => rollbackProviderThread(providerThreadId, numTurns)),
        ),
      rollbackProviderThread,
      listSpawnedChildThreads,
      refreshUsage: refreshAccountRateLimits,
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: pending.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: pending.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
