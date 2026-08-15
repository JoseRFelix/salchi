import type {
  EnvironmentId,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationQueuedTurn,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationSession,
  OrchestrationSessionStatus,
  OrchestrationThread,
  OrchestrationThreadDetailPageCursors,
  OrchestrationThreadDetailPageInfo,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  OrchestrationThreadActivity,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@salchi/contracts";
import {
  isTurnStillRunningForPacking,
  resolveEffectiveMessageTurnId,
  settledTurnStateForSessionStatus,
} from "@salchi/client-runtime";
import {
  EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@salchi/contracts";
import type { ThreadId, TurnId } from "@salchi/contracts";
import * as Schema from "effect/Schema";
import { resolveModelSlugForProvider } from "@salchi/shared/model";
import { create } from "zustand";
import {
  type ChatMessage,
  type ChatAttachment,
  type Project,
  type ProposedPlan,
  type QueuedTurn,
  type SidebarThreadSummary,
  type Thread,
  type ThreadSession,
  type ThreadShell,
  type ThreadTurnState,
  type TurnDiffFileChange,
  type TurnDiffSummary,
} from "./types";
import { resolveEnvironmentHttpUrl } from "./environments/runtime";
import { sanitizeThreadErrorMessage } from "./rpc/transportError";
import { getThreadFromEnvironmentState } from "./threadDerivation";
import { compareThreadActivitiesByOrder } from "./threadActivityOrdering";
const isProviderDriverKindValue = Schema.is(ProviderDriverKind);

export interface EnvironmentState {
  projectIds: ProjectId[];
  projectById: Record<ProjectId, Project>;

  // ---------------------------------------------------------------------------
  // Thread bookkeeping — written by BOTH shell stream and detail stream.
  // Both streams ensure the thread is registered here; the bookkeeping is
  // additive (append-only IDs) so concurrent writes are safe.
  // ---------------------------------------------------------------------------
  threadIds: ThreadId[];
  threadIdsByProjectId: Record<ProjectId, ThreadId[]>;

  // ---------------------------------------------------------------------------
  // Thread shell / session / turn — written by BOTH shell stream and detail
  // stream.  The shell stream is the *authoritative* source (server pre-
  // computes these from the projection pipeline), but the detail stream also
  // writes them so the active thread has up-to-date state even if the shell
  // event hasn't arrived yet.  Structural equality checks in both write
  // functions prevent unnecessary React re-renders when both streams deliver
  // equivalent data.
  // ---------------------------------------------------------------------------
  threadShellById: Record<ThreadId, ThreadShell>;
  threadSessionById: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById: Record<ThreadId, ThreadTurnState>;

  // ---------------------------------------------------------------------------
  // Thread detail content — written ONLY by detail sources
  // (subscription tail snapshots/events and explicit older-page merges).  The
  // shell stream never touches these.
  // ---------------------------------------------------------------------------
  messageIdsByThreadId: Record<ThreadId, MessageId[]>;
  messageByThreadId: Record<ThreadId, Record<MessageId, ChatMessage>>;
  queuedTurnIdsByThreadId: Record<ThreadId, MessageId[]>;
  queuedTurnByThreadId: Record<ThreadId, Record<MessageId, QueuedTurn>>;
  activityIdsByThreadId: Record<ThreadId, string[]>;
  activityByThreadId: Record<ThreadId, Record<string, OrchestrationThreadActivity>>;
  proposedPlanIdsByThreadId: Record<ThreadId, string[]>;
  proposedPlanByThreadId: Record<ThreadId, Record<string, ProposedPlan>>;
  turnDiffIdsByThreadId: Record<ThreadId, TurnId[]>;
  turnDiffSummaryByThreadId: Record<ThreadId, Record<TurnId, TurnDiffSummary>>;
  threadDetailPageInfoByThreadId: Record<ThreadId, OrchestrationThreadDetailPageInfo>;
  lastAppliedEventSequenceByThreadId?: Record<ThreadId, number>;
  lastAppliedEventIdByThreadId?: Record<ThreadId, string>;

  // ---------------------------------------------------------------------------
  // Sidebar summary — written ONLY by the shell stream
  // (writeThreadShellState / mapThreadShell).  Pre-computed server-side with
  // fields like latestUserMessageAt, hasPendingApprovals, etc.  The detail
  // stream must NOT write here; the shell stream is the single source of
  // truth for sidebar data.
  // ---------------------------------------------------------------------------
  sidebarThreadSummaryById: Record<ThreadId, SidebarThreadSummary>;

  bootstrapComplete: boolean;
}

export interface AppState {
  activeEnvironmentId: EnvironmentId | null;
  environmentStateById: Record<string, EnvironmentState>;
  accountRateLimitsByInstanceId: Record<
    string,
    {
      readonly rateLimits: unknown;
      readonly updatedAt: string;
    }
  >;
}

const initialEnvironmentState: EnvironmentState = {
  projectIds: [],
  projectById: {},
  threadIds: [],
  threadIdsByProjectId: {},
  threadShellById: {},
  threadSessionById: {},
  threadTurnStateById: {},
  messageIdsByThreadId: {},
  messageByThreadId: {},
  queuedTurnIdsByThreadId: {},
  queuedTurnByThreadId: {},
  activityIdsByThreadId: {},
  activityByThreadId: {},
  proposedPlanIdsByThreadId: {},
  proposedPlanByThreadId: {},
  turnDiffIdsByThreadId: {},
  turnDiffSummaryByThreadId: {},
  threadDetailPageInfoByThreadId: {},
  lastAppliedEventSequenceByThreadId: {},
  lastAppliedEventIdByThreadId: {},
  sidebarThreadSummaryById: {},
  bootstrapComplete: false,
};

const initialState: AppState = {
  activeEnvironmentId: null,
  environmentStateById: {},
  accountRateLimitsByInstanceId: {},
};

interface ThreadDetailWriteOptions {
  readonly preserveShellFields?: boolean;
  readonly pageInfo?: OrchestrationThreadDetailPageInfo;
  readonly syncSidebarSummaries?: boolean;
}

interface ThreadDetailPageMergeOptions {
  readonly requestedBefore?: OrchestrationThreadDetailPageCursors;
}

const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_PROPOSED_PLANS = 200;
const MAX_THREAD_ACTIVITIES = 500;
const EMPTY_THREAD_IDS: ThreadId[] = [];

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Accepts the open `instanceId` string carried on `ModelSelection`; malformed
// values pass through unchanged, while valid slugs use any registered alias
// table for model normalization.
function normalizeModelSelection<T extends { instanceId: string; model: string }>(selection: T): T {
  if (!isProviderDriverKind(selection.instanceId)) {
    return selection;
  }
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.instanceId, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): ThreadSession {
  return {
    provider: toLegacyProvider(session.providerName),
    providerInstanceId: session.providerInstanceId ?? undefined,
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function mapChatAttachment(
  environmentId: EnvironmentId,
  attachment: NonNullable<OrchestrationMessage["attachments"]>[number],
): ChatAttachment {
  const base = {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: resolveEnvironmentHttpUrl({
      environmentId,
      pathname: attachmentPreviewRoutePath(attachment.id),
    }),
  };
  return attachment.type === "pdf"
    ? {
        ...base,
        type: "pdf",
        mimeType: "application/pdf",
      }
    : {
        ...base,
        type: "image",
      };
}

function mapMessage(environmentId: EnvironmentId, message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map((attachment) =>
    mapChatAttachment(environmentId, attachment),
  );

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function mapThreadMessage(
  environmentId: EnvironmentId,
  message: OrchestrationMessage,
  thread: Pick<OrchestrationThread, "session" | "latestTurn">,
): ChatMessage {
  return mapMessage(environmentId, {
    ...message,
    turnId: resolveEffectiveMessageTurnId({
      role: message.role,
      payloadTurnId: message.turnId,
      existingTurnId: null,
      session: thread.session,
      latestTurn: thread.latestTurn,
    }),
  });
}

function mapQueuedTurn(
  environmentId: EnvironmentId,
  queuedTurn: OrchestrationQueuedTurn,
): QueuedTurn {
  return {
    threadId: queuedTurn.threadId,
    messageId: queuedTurn.messageId,
    role: queuedTurn.role,
    text: queuedTurn.text,
    attachments: queuedTurn.attachments.map((attachment) =>
      mapChatAttachment(environmentId, attachment),
    ),
    ...(queuedTurn.modelSelection !== undefined
      ? { modelSelection: normalizeModelSelection(queuedTurn.modelSelection) }
      : {}),
    ...(queuedTurn.titleSeed !== undefined ? { titleSeed: queuedTurn.titleSeed } : {}),
    runtimeMode: queuedTurn.runtimeMode,
    interactionMode: queuedTurn.interactionMode,
    ...(queuedTurn.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: queuedTurn.sourceProposedPlan }
      : {}),
    ...(queuedTurn.steering !== undefined ? { steering: queuedTurn.steering } : {}),
    recoveryConfirmationRequired: queuedTurn.recoveryConfirmationRequired,
    createdAt: queuedTurn.createdAt,
    updatedAt: queuedTurn.updatedAt,
  };
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): ProposedPlan {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapTurnDiffSummary(checkpoint: OrchestrationCheckpointSummary): TurnDiffSummary {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    attribution: checkpoint.attribution,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function mapProject(
  project:
    | OrchestrationReadModel["projects"][number]
    | OrchestrationShellSnapshot["projects"][number],
  environmentId: EnvironmentId,
): Project {
  return {
    id: project.id,
    environmentId,
    name: project.title,
    cwd: project.workspaceRoot,
    repositoryIdentity: project.repositoryIdentity ?? null,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function mapThread(
  thread: OrchestrationThread,
  environmentId: EnvironmentId,
  pageInfo: OrchestrationThreadDetailPageInfo = EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO,
): Thread {
  return {
    id: thread.id,
    environmentId,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    parentThreadId: thread.parentThreadId ?? null,
    createdByThreadId: thread.createdByThreadId ?? null,
    subagentKind: thread.subagentKind ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    hiddenFromThreadList: thread.hiddenFromThreadList ?? false,
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map((message) => mapThreadMessage(environmentId, message, thread)),
    queuedTurns: thread.queuedTurns.map((queuedTurn) => mapQueuedTurn(environmentId, queuedTurn)),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    error: sanitizeThreadErrorMessage(thread.session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
    detailPageInfo: pageInfo,
  };
}

function mapThreadShell(
  thread: OrchestrationThreadShell,
  environmentId: EnvironmentId,
): {
  shell: ThreadShell;
  session: ThreadSession | null;
  turnState: ThreadTurnState;
  summary: SidebarThreadSummary;
} {
  const shell: ThreadShell = {
    id: thread.id,
    environmentId,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    parentThreadId: thread.parentThreadId ?? null,
    createdByThreadId: thread.createdByThreadId ?? null,
    subagentKind: thread.subagentKind ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    hiddenFromThreadList: thread.hiddenFromThreadList ?? false,
    error: sanitizeThreadErrorMessage(thread.session?.lastError),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
  };
  const session = thread.session ? mapSession(thread.session) : null;
  const turnState: ThreadTurnState = {
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
  };
  const summary: SidebarThreadSummary = {
    id: thread.id,
    environmentId,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    parentThreadId: thread.parentThreadId ?? null,
    createdByThreadId: thread.createdByThreadId ?? null,
    subagentKind: thread.subagentKind ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    hiddenFromThreadList: thread.hiddenFromThreadList ?? false,
    session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestUserMessageAt: thread.latestUserMessageAt,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
  };
  return {
    shell,
    session,
    turnState,
    summary,
  };
}

function toThreadShell(thread: Thread): ThreadShell {
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    codexThreadId: thread.codexThreadId,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    parentThreadId: thread.parentThreadId ?? null,
    createdByThreadId: thread.createdByThreadId ?? null,
    subagentKind: thread.subagentKind ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    hiddenFromThreadList: thread.hiddenFromThreadList ?? false,
    error: thread.error,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
  };
}

function toThreadTurnState(thread: Thread): ThreadTurnState {
  return {
    latestTurn: thread.latestTurn,
    ...(thread.pendingSourceProposedPlan
      ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
      : {}),
  };
}

function sourceProposedPlansEqual(
  left: OrchestrationLatestTurn["sourceProposedPlan"] | undefined,
  right: OrchestrationLatestTurn["sourceProposedPlan"] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.threadId === right.threadId && left.planId === right.planId;
}

function latestTurnsEqual(
  left: OrchestrationLatestTurn | null | undefined,
  right: OrchestrationLatestTurn | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.requestedAt === right.requestedAt &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.assistantMessageId === right.assistantMessageId &&
    sourceProposedPlansEqual(left.sourceProposedPlan, right.sourceProposedPlan)
  );
}

function threadSessionsEqual(
  left: ThreadSession | null | undefined,
  right: ThreadSession | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.provider === right.provider &&
    left.status === right.status &&
    left.orchestrationStatus === right.orchestrationStatus &&
    left.activeTurnId === right.activeTurnId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastError === right.lastError
  );
}

function providerOptionSelectionsEqual(
  left: ModelSelection["options"] | undefined,
  right: ModelSelection["options"] | undefined,
): boolean {
  const leftOptions = left ?? [];
  const rightOptions = right ?? [];
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every((option, index) => {
      const other = rightOptions[index];
      return other !== undefined && option.id === other.id && option.value === other.value;
    })
  );
}

function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    providerOptionSelectionsEqual(left.options, right.options)
  );
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.createdByThreadId ?? null) === (right.createdByThreadId ?? null) &&
    (left.subagentKind ?? null) === (right.subagentKind ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    (left.hiddenFromThreadList ?? false) === (right.hiddenFromThreadList ?? false) &&
    threadSessionsEqual(left.session, right.session) &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function threadShellsEqual(left: ThreadShell | undefined, right: ThreadShell): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.environmentId === right.environmentId &&
    left.codexThreadId === right.codexThreadId &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    modelSelectionsEqual(left.modelSelection, right.modelSelection) &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.createdByThreadId ?? null) === (right.createdByThreadId ?? null) &&
    (left.subagentKind ?? null) === (right.subagentKind ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    (left.hiddenFromThreadList ?? false) === (right.hiddenFromThreadList ?? false) &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath
  );
}

function threadTurnStatesEqual(left: ThreadTurnState | undefined, right: ThreadTurnState): boolean {
  return (
    left !== undefined &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    sourceProposedPlansEqual(left.pendingSourceProposedPlan, right.pendingSourceProposedPlan)
  );
}

function isNewerIsoTimestamp(
  existingUpdatedAt: string | undefined,
  incomingUpdatedAt: string | undefined,
): boolean {
  return (
    existingUpdatedAt !== undefined &&
    incomingUpdatedAt !== undefined &&
    existingUpdatedAt > incomingUpdatedAt
  );
}

function threadDetailPageCursorsEqual(
  left: OrchestrationThreadDetailPageInfo["messages"]["startCursor"],
  right: OrchestrationThreadDetailPageInfo["messages"]["startCursor"],
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.sequence === right.sequence &&
    left.checkpointTurnCount === right.checkpointTurnCount
  );
}

function threadDetailCollectionPageInfosEqual(
  left: OrchestrationThreadDetailPageInfo["messages"],
  right: OrchestrationThreadDetailPageInfo["messages"],
): boolean {
  return (
    left.hasMoreBefore === right.hasMoreBefore &&
    threadDetailPageCursorsEqual(left.startCursor, right.startCursor)
  );
}

function threadDetailPageInfosEqual(
  left: OrchestrationThreadDetailPageInfo | undefined,
  right: OrchestrationThreadDetailPageInfo,
): boolean {
  return (
    left !== undefined &&
    threadDetailCollectionPageInfosEqual(left.messages, right.messages) &&
    threadDetailCollectionPageInfosEqual(left.proposedPlans, right.proposedPlans) &&
    threadDetailCollectionPageInfosEqual(left.activities, right.activities) &&
    threadDetailCollectionPageInfosEqual(left.checkpoints, right.checkpoints)
  );
}

function chatAttachmentsEqual(
  left: readonly ChatAttachment[] | undefined,
  right: readonly ChatAttachment[] | undefined,
): boolean {
  const leftAttachments = left ?? [];
  const rightAttachments = right ?? [];
  return (
    leftAttachments.length === rightAttachments.length &&
    leftAttachments.every((attachment, index) => {
      const other = rightAttachments[index];
      return (
        other !== undefined &&
        attachment.type === other.type &&
        attachment.id === other.id &&
        attachment.name === other.name &&
        attachment.mimeType === other.mimeType &&
        attachment.sizeBytes === other.sizeBytes &&
        attachment.previewUrl === other.previewUrl
      );
    })
  );
}

function chatMessagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.text === right.text &&
    left.turnId === right.turnId &&
    left.createdAt === right.createdAt &&
    left.completedAt === right.completedAt &&
    left.streaming === right.streaming &&
    chatAttachmentsEqual(left.attachments, right.attachments)
  );
}

function queuedTurnsEqual(left: QueuedTurn, right: QueuedTurn): boolean {
  return (
    left.threadId === right.threadId &&
    left.messageId === right.messageId &&
    left.role === right.role &&
    left.text === right.text &&
    left.titleSeed === right.titleSeed &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.steering?.expectedTurnId === right.steering?.expectedTurnId &&
    left.steering?.requestedAt === right.steering?.requestedAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    chatAttachmentsEqual(left.attachments, right.attachments) &&
    ((left.modelSelection === undefined && right.modelSelection === undefined) ||
      (left.modelSelection !== undefined &&
        right.modelSelection !== undefined &&
        modelSelectionsEqual(left.modelSelection, right.modelSelection))) &&
    sourceProposedPlansEqual(left.sourceProposedPlan, right.sourceProposedPlan)
  );
}

function proposedPlansEqual(left: ProposedPlan, right: ProposedPlan): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.planMarkdown === right.planMarkdown &&
    left.implementedAt === right.implementedAt &&
    left.implementationThreadId === right.implementationThreadId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function turnDiffFilesEqual(
  left: readonly TurnDiffFileChange[],
  right: readonly TurnDiffFileChange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        file.path === other.path &&
        file.kind === other.kind &&
        file.additions === other.additions &&
        file.deletions === other.deletions
      );
    })
  );
}

function turnDiffSummariesEqual(left: TurnDiffSummary, right: TurnDiffSummary): boolean {
  return (
    left.turnId === right.turnId &&
    left.completedAt === right.completedAt &&
    left.status === right.status &&
    left.checkpointRef === right.checkpointRef &&
    left.attribution === right.attribution &&
    left.checkpointTurnCount === right.checkpointTurnCount &&
    left.assistantMessageId === right.assistantMessageId &&
    turnDiffFilesEqual(left.files, right.files)
  );
}

function jsonLikeValuesEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const seenRights = seen.get(left);
  if (seenRights?.has(right)) {
    return true;
  }
  if (seenRights) {
    seenRights.add(right);
  } else {
    seen.set(left, new WeakSet([right]));
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonLikeValuesEqual(value, right[index], seen))
    );
  }

  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key)
        ? jsonLikeValuesEqual(left[key], right[key], seen)
        : false,
    )
  );
}

function threadActivitiesEqual(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): boolean {
  return (
    left.id === right.id &&
    left.tone === right.tone &&
    left.kind === right.kind &&
    left.summary === right.summary &&
    left.turnId === right.turnId &&
    left.sequence === right.sequence &&
    left.createdAt === right.createdAt &&
    jsonLikeValuesEqual(left.payload, right.payload)
  );
}

function appendId<T extends string>(ids: readonly T[], id: T): T[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

function removeId<T extends string>(ids: readonly T[], id: T): T[] {
  return ids.filter((value) => value !== id);
}

function reuseEqualOrderedItems<TItem, TId extends string>(
  previousItems: TItem[],
  nextItems: TItem[],
  getId: (item: TItem) => TId,
  itemsEqual: (left: TItem, right: TItem) => boolean,
): TItem[] {
  if (
    previousItems.length === nextItems.length &&
    previousItems.every((previousItem, index) => {
      const nextItem = nextItems[index];
      return (
        nextItem !== undefined &&
        getId(previousItem) === getId(nextItem) &&
        itemsEqual(previousItem, nextItem)
      );
    })
  ) {
    return previousItems;
  }

  if (previousItems.length === 0 || nextItems.length === 0) {
    return nextItems;
  }

  const previousById = new Map<TId, TItem>();
  for (const item of previousItems) {
    previousById.set(getId(item), item);
  }

  let reusedAnyItem = false;
  const sharedItems = nextItems.map((nextItem) => {
    const previousItem = previousById.get(getId(nextItem));
    if (previousItem === undefined || !itemsEqual(previousItem, nextItem)) {
      return nextItem;
    }
    if (previousItem !== nextItem) {
      reusedAnyItem = true;
    }
    return previousItem;
  });

  return reusedAnyItem ? sharedItems : nextItems;
}

function shareThreadDetailCollections(previousThread: Thread, nextThread: Thread): Thread {
  const messages = reuseEqualOrderedItems(
    previousThread.messages,
    nextThread.messages,
    (message) => message.id,
    chatMessagesEqual,
  );
  const queuedTurns = reuseEqualOrderedItems(
    previousThread.queuedTurns,
    nextThread.queuedTurns,
    (queuedTurn) => queuedTurn.messageId,
    queuedTurnsEqual,
  );
  const activities = reuseEqualOrderedItems(
    previousThread.activities,
    nextThread.activities,
    (activity) => activity.id,
    threadActivitiesEqual,
  );
  const proposedPlans = reuseEqualOrderedItems(
    previousThread.proposedPlans,
    nextThread.proposedPlans,
    (plan) => plan.id,
    proposedPlansEqual,
  );
  const turnDiffSummaries = reuseEqualOrderedItems(
    previousThread.turnDiffSummaries,
    nextThread.turnDiffSummaries,
    (summary) => summary.turnId,
    turnDiffSummariesEqual,
  );

  if (
    messages === nextThread.messages &&
    queuedTurns === nextThread.queuedTurns &&
    activities === nextThread.activities &&
    proposedPlans === nextThread.proposedPlans &&
    turnDiffSummaries === nextThread.turnDiffSummaries
  ) {
    return nextThread;
  }

  return {
    ...nextThread,
    messages,
    queuedTurns,
    activities,
    proposedPlans,
    turnDiffSummaries,
  };
}

function compareMessagesByOrder(left: ChatMessage, right: ChatMessage): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function mapDispatchedQueuedTurnMessage(queuedTurn: QueuedTurn, dispatchedAt: string): ChatMessage {
  return {
    id: queuedTurn.messageId,
    role: queuedTurn.role,
    text: queuedTurn.text,
    turnId: null,
    createdAt: dispatchedAt,
    completedAt: dispatchedAt,
    streaming: false,
    ...(queuedTurn.attachments.length > 0 ? { attachments: [...queuedTurn.attachments] } : {}),
  };
}

function mapSteeredQueuedTurnMessage(
  queuedTurn: QueuedTurn,
  turnId: TurnId,
  steeredAt: string,
): ChatMessage {
  return {
    id: queuedTurn.messageId,
    role: queuedTurn.role,
    text: queuedTurn.text,
    turnId,
    createdAt: steeredAt,
    completedAt: steeredAt,
    streaming: false,
    ...(queuedTurn.attachments.length > 0 ? { attachments: [...queuedTurn.attachments] } : {}),
  };
}

function compareQueuedTurnsByOrder(left: QueuedTurn, right: QueuedTurn): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId)
  );
}

function compareProposedPlansByOrder(left: ProposedPlan, right: ProposedPlan): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareTurnDiffSummariesByOrder(left: TurnDiffSummary, right: TurnDiffSummary): number {
  const leftCheckpointTurnCount = left.checkpointTurnCount;
  const rightCheckpointTurnCount = right.checkpointTurnCount;
  if (leftCheckpointTurnCount !== undefined && rightCheckpointTurnCount !== undefined) {
    if (leftCheckpointTurnCount !== rightCheckpointTurnCount) {
      return leftCheckpointTurnCount - rightCheckpointTurnCount;
    }
  } else if (leftCheckpointTurnCount !== undefined) {
    return -1;
  } else if (rightCheckpointTurnCount !== undefined) {
    return 1;
  }

  return (
    left.completedAt.localeCompare(right.completedAt) || left.turnId.localeCompare(right.turnId)
  );
}

function mergeItemsWithIncomingPrecedence<TItem, TId extends string>(
  currentItems: readonly TItem[],
  incomingItems: readonly TItem[],
  getId: (item: TItem) => TId,
  compare: (left: TItem, right: TItem) => number,
): TItem[] {
  const byId = new Map<TId, TItem>();
  for (const item of currentItems) {
    byId.set(getId(item), item);
  }
  for (const item of incomingItems) {
    byId.set(getId(item), item);
  }
  return [...byId.values()].toSorted(compare);
}

function mergeTailItems<TItem, TId extends string>(
  currentItems: readonly TItem[],
  incomingTailItems: readonly TItem[],
  getId: (item: TItem) => TId,
  compare: (left: TItem, right: TItem) => number,
): TItem[] {
  return mergeItemsWithIncomingPrecedence(currentItems, incomingTailItems, getId, compare);
}

function mergeOlderItems<TItem, TId extends string>(
  olderItems: readonly TItem[],
  currentItems: readonly TItem[],
  getId: (item: TItem) => TId,
  compare: (left: TItem, right: TItem) => number,
): TItem[] {
  return mergeItemsWithIncomingPrecedence(currentItems, olderItems, getId, compare);
}

function preserveTailCollectionPageInfo(
  previousPageInfo: OrchestrationThreadDetailPageInfo["messages"],
  incomingPageInfo: OrchestrationThreadDetailPageInfo["messages"],
): OrchestrationThreadDetailPageInfo["messages"] {
  return previousPageInfo.hasMoreBefore || previousPageInfo.startCursor !== null
    ? previousPageInfo
    : incomingPageInfo;
}

function resolveTailSnapshotPageInfo(
  previousPageInfo: OrchestrationThreadDetailPageInfo | undefined,
  incomingPageInfo: OrchestrationThreadDetailPageInfo,
): OrchestrationThreadDetailPageInfo {
  if (previousPageInfo === undefined) {
    return incomingPageInfo;
  }
  return {
    messages: preserveTailCollectionPageInfo(previousPageInfo.messages, incomingPageInfo.messages),
    proposedPlans: preserveTailCollectionPageInfo(
      previousPageInfo.proposedPlans,
      incomingPageInfo.proposedPlans,
    ),
    activities: preserveTailCollectionPageInfo(
      previousPageInfo.activities,
      incomingPageInfo.activities,
    ),
    checkpoints: preserveTailCollectionPageInfo(
      previousPageInfo.checkpoints,
      incomingPageInfo.checkpoints,
    ),
  };
}

function resolveOlderPageInfo(
  previousPageInfo: OrchestrationThreadDetailPageInfo | undefined,
  incomingPageInfo: OrchestrationThreadDetailPageInfo,
  requestedBefore: OrchestrationThreadDetailPageCursors | undefined,
): OrchestrationThreadDetailPageInfo {
  if (previousPageInfo === undefined || requestedBefore === undefined) {
    return incomingPageInfo;
  }
  return {
    messages:
      requestedBefore.messages !== undefined
        ? incomingPageInfo.messages
        : previousPageInfo.messages,
    proposedPlans:
      requestedBefore.proposedPlans !== undefined
        ? incomingPageInfo.proposedPlans
        : previousPageInfo.proposedPlans,
    activities:
      requestedBefore.activities !== undefined
        ? incomingPageInfo.activities
        : previousPageInfo.activities,
    checkpoints:
      requestedBefore.checkpoints !== undefined
        ? incomingPageInfo.checkpoints
        : previousPageInfo.checkpoints,
  };
}

function buildMessageSlice(thread: Thread): {
  ids: MessageId[];
  byId: Record<MessageId, ChatMessage>;
} {
  return {
    ids: thread.messages.map((message) => message.id),
    byId: Object.fromEntries(
      thread.messages.map((message) => [message.id, message] as const),
    ) as Record<MessageId, ChatMessage>,
  };
}

function buildQueuedTurnSlice(thread: Thread): {
  ids: MessageId[];
  byId: Record<MessageId, QueuedTurn>;
} {
  return {
    ids: thread.queuedTurns.map((queuedTurn) => queuedTurn.messageId),
    byId: Object.fromEntries(
      thread.queuedTurns.map((queuedTurn) => [queuedTurn.messageId, queuedTurn] as const),
    ) as Record<MessageId, QueuedTurn>,
  };
}

function buildActivitySlice(thread: Thread): {
  ids: string[];
  byId: Record<string, OrchestrationThreadActivity>;
} {
  return {
    ids: thread.activities.map((activity) => activity.id),
    byId: Object.fromEntries(
      thread.activities.map((activity) => [activity.id, activity] as const),
    ) as Record<string, OrchestrationThreadActivity>,
  };
}

function buildProposedPlanSlice(thread: Thread): {
  ids: string[];
  byId: Record<string, ProposedPlan>;
} {
  return {
    ids: thread.proposedPlans.map((plan) => plan.id),
    byId: Object.fromEntries(
      thread.proposedPlans.map((plan) => [plan.id, plan] as const),
    ) as Record<string, ProposedPlan>,
  };
}

function buildTurnDiffSlice(thread: Thread): {
  ids: TurnId[];
  byId: Record<TurnId, TurnDiffSummary>;
} {
  return {
    ids: thread.turnDiffSummaries.map((summary) => summary.turnId),
    byId: Object.fromEntries(
      thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
    ) as Record<TurnId, TurnDiffSummary>,
  };
}

function getProjects(state: EnvironmentState): Project[] {
  return state.projectIds.flatMap((projectId) => {
    const project = state.projectById[projectId];
    return project ? [project] : [];
  });
}

function getThreads(state: EnvironmentState): Thread[] {
  return state.threadIds.flatMap((threadId) => {
    const thread = getThreadFromEnvironmentState(state, threadId);
    return thread ? [thread] : [];
  });
}

/**
 * Ensure a thread is registered in the bookkeeping indices (threadIds,
 * threadIdsByProjectId).  Shared by both the shell stream and detail stream
 * write paths — the bookkeeping is additive (append-only IDs) so concurrent
 * writes from both streams are safe.
 */
function ensureThreadRegistered(
  state: EnvironmentState,
  threadId: ThreadId,
  nextProjectId: ProjectId,
  previousProjectId: ProjectId | undefined,
): EnvironmentState {
  let nextState = state;

  if (!state.threadIds.includes(threadId)) {
    nextState = {
      ...nextState,
      threadIds: [...nextState.threadIds, threadId],
    };
  }

  const projectThreadIds = nextState.threadIdsByProjectId[nextProjectId] ?? EMPTY_THREAD_IDS;

  if (previousProjectId !== nextProjectId || !projectThreadIds.includes(threadId)) {
    let threadIdsByProjectId = nextState.threadIdsByProjectId;
    if (previousProjectId && previousProjectId !== nextProjectId) {
      const previousIds = threadIdsByProjectId[previousProjectId] ?? EMPTY_THREAD_IDS;
      const nextIds = removeId(previousIds, threadId);
      if (nextIds.length === 0) {
        const { [previousProjectId]: _removed, ...rest } = threadIdsByProjectId;
        threadIdsByProjectId = rest as Record<ProjectId, ThreadId[]>;
      } else if (!arraysEqual(previousIds, nextIds)) {
        threadIdsByProjectId = {
          ...threadIdsByProjectId,
          [previousProjectId]: nextIds,
        };
      }
    }
    const currentProjectThreadIds = threadIdsByProjectId[nextProjectId] ?? EMPTY_THREAD_IDS;
    const nextProjectThreadIds = appendId(currentProjectThreadIds, threadId);
    if (!arraysEqual(currentProjectThreadIds, nextProjectThreadIds)) {
      threadIdsByProjectId = {
        ...threadIdsByProjectId,
        [nextProjectId]: nextProjectThreadIds,
      };
    }
    if (threadIdsByProjectId !== nextState.threadIdsByProjectId) {
      nextState = {
        ...nextState,
        threadIdsByProjectId,
      };
    }
  }

  return nextState;
}

/**
 * Write thread state from the **detail stream** (per-thread subscription).
 *
 * Owns: messages, activities, proposed plans, turn diff summaries.
 * Also writes threadShellById / threadSessionById / threadTurnStateById so
 * the active thread has up-to-date state even if the shell stream event
 * hasn't arrived yet (both streams use structural equality checks to avoid
 * unnecessary re-renders when delivering equivalent data).
 * Does NOT write sidebarThreadSummaryById — that is shell-stream-only.
 */
function writeThreadState(
  state: EnvironmentState,
  nextThread: Thread,
  previousThread?: Thread,
  options: ThreadDetailWriteOptions = {},
): EnvironmentState {
  const sharedNextThread = previousThread
    ? shareThreadDetailCollections(previousThread, nextThread)
    : nextThread;
  // Detail packets may arrive after a newer shell projection; keep shell-owned
  // fields monotonic while still accepting detail-only content below.
  const shellSourceThread =
    options.preserveShellFields && previousThread
      ? previousThread
      : previousThread?.updatedAt !== undefined &&
          sharedNextThread.updatedAt !== undefined &&
          sharedNextThread.updatedAt < previousThread.updatedAt
        ? previousThread
        : sharedNextThread;
  const nextShell = toThreadShell(shellSourceThread);
  const nextTurnState = toThreadTurnState(shellSourceThread);
  const previousShell = state.threadShellById[sharedNextThread.id];
  const previousTurnState = state.threadTurnStateById[sharedNextThread.id];

  let nextState = ensureThreadRegistered(
    state,
    sharedNextThread.id,
    sharedNextThread.projectId,
    previousThread?.projectId,
  );

  if (!threadShellsEqual(previousShell, nextShell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...nextState.threadShellById,
        [sharedNextThread.id]: nextShell,
      },
    };
  }

  if (!threadSessionsEqual(previousThread?.session ?? null, shellSourceThread.session)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...nextState.threadSessionById,
        [sharedNextThread.id]: shellSourceThread.session,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...nextState.threadTurnStateById,
        [sharedNextThread.id]: nextTurnState,
      },
    };
  }

  if (previousThread?.messages !== sharedNextThread.messages) {
    const nextMessageSlice = buildMessageSlice(sharedNextThread);
    nextState = {
      ...nextState,
      messageIdsByThreadId: {
        ...nextState.messageIdsByThreadId,
        [sharedNextThread.id]: nextMessageSlice.ids,
      },
      messageByThreadId: {
        ...nextState.messageByThreadId,
        [sharedNextThread.id]: nextMessageSlice.byId,
      },
    };
  }

  if (previousThread?.queuedTurns !== sharedNextThread.queuedTurns) {
    const nextQueuedTurnSlice = buildQueuedTurnSlice(sharedNextThread);
    nextState = {
      ...nextState,
      queuedTurnIdsByThreadId: {
        ...nextState.queuedTurnIdsByThreadId,
        [sharedNextThread.id]: nextQueuedTurnSlice.ids,
      },
      queuedTurnByThreadId: {
        ...nextState.queuedTurnByThreadId,
        [sharedNextThread.id]: nextQueuedTurnSlice.byId,
      },
    };
  }

  if (previousThread?.activities !== sharedNextThread.activities) {
    const nextActivitySlice = buildActivitySlice(sharedNextThread);
    nextState = {
      ...nextState,
      activityIdsByThreadId: {
        ...nextState.activityIdsByThreadId,
        [sharedNextThread.id]: nextActivitySlice.ids,
      },
      activityByThreadId: {
        ...nextState.activityByThreadId,
        [sharedNextThread.id]: nextActivitySlice.byId,
      },
    };
  }

  if (previousThread?.proposedPlans !== sharedNextThread.proposedPlans) {
    const nextProposedPlanSlice = buildProposedPlanSlice(sharedNextThread);
    nextState = {
      ...nextState,
      proposedPlanIdsByThreadId: {
        ...nextState.proposedPlanIdsByThreadId,
        [sharedNextThread.id]: nextProposedPlanSlice.ids,
      },
      proposedPlanByThreadId: {
        ...nextState.proposedPlanByThreadId,
        [sharedNextThread.id]: nextProposedPlanSlice.byId,
      },
    };
  }

  if (previousThread?.turnDiffSummaries !== sharedNextThread.turnDiffSummaries) {
    const nextTurnDiffSlice = buildTurnDiffSlice(sharedNextThread);
    nextState = {
      ...nextState,
      turnDiffIdsByThreadId: {
        ...nextState.turnDiffIdsByThreadId,
        [sharedNextThread.id]: nextTurnDiffSlice.ids,
      },
      turnDiffSummaryByThreadId: {
        ...nextState.turnDiffSummaryByThreadId,
        [sharedNextThread.id]: nextTurnDiffSlice.byId,
      },
    };
  }

  const nextPageInfo =
    options.pageInfo ??
    sharedNextThread.detailPageInfo ??
    EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO;
  if (
    !threadDetailPageInfosEqual(
      state.threadDetailPageInfoByThreadId[sharedNextThread.id],
      nextPageInfo,
    )
  ) {
    nextState = {
      ...nextState,
      threadDetailPageInfoByThreadId: {
        ...nextState.threadDetailPageInfoByThreadId,
        [sharedNextThread.id]: nextPageInfo,
      },
    };
  }

  return nextState;
}

/**
 * Write thread state from the **shell stream** (all-threads subscription).
 *
 * Owns: sidebarThreadSummaryById (pre-computed server-side sidebar data).
 * Also writes threadShellById / threadSessionById / threadTurnStateById as
 * the authoritative source for these fields.  The detail stream may also
 * write them for the focused thread (see writeThreadState); structural
 * equality checks prevent unnecessary re-renders.
 * Does NOT write message/activity/proposedPlan/turnDiff content — that is
 * detail-stream-only.
 */
function writeThreadShellState(
  state: EnvironmentState,
  nextThread: {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState;
    summary: SidebarThreadSummary;
  },
  options: { preserveNewerState?: boolean } = {},
): EnvironmentState {
  const previousShell = state.threadShellById[nextThread.shell.id];
  const previousSession = state.threadSessionById[nextThread.shell.id] ?? null;
  const previousTurnState = state.threadTurnStateById[nextThread.shell.id];
  const shouldPreserveSession =
    options.preserveNewerState === true &&
    previousSession !== null &&
    nextThread.session !== null &&
    isNewerIsoTimestamp(previousSession.updatedAt, nextThread.session.updatedAt);
  const shouldPreserveTurnState =
    options.preserveNewerState === true &&
    previousTurnState !== undefined &&
    isNewerIsoTimestamp(previousShell?.updatedAt, nextThread.shell.updatedAt);
  const nextSession = shouldPreserveSession ? previousSession : nextThread.session;
  const nextTurnState = shouldPreserveTurnState ? previousTurnState : nextThread.turnState;

  let nextState = ensureThreadRegistered(
    state,
    nextThread.shell.id,
    nextThread.shell.projectId,
    previousShell?.projectId,
  );

  if (!threadShellsEqual(previousShell, nextThread.shell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...nextState.threadShellById,
        [nextThread.shell.id]: nextThread.shell,
      },
    };
  }

  if (!threadSessionsEqual(previousSession, nextSession)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...nextState.threadSessionById,
        [nextThread.shell.id]: nextSession,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...nextState.threadTurnStateById,
        [nextThread.shell.id]: nextTurnState,
      },
    };
  }

  if (
    !sidebarThreadSummariesEqual(
      state.sidebarThreadSummaryById[nextThread.shell.id],
      nextThread.summary,
    )
  ) {
    nextState = {
      ...nextState,
      sidebarThreadSummaryById: {
        ...nextState.sidebarThreadSummaryById,
        [nextThread.shell.id]: nextThread.summary,
      },
    };
  }

  return nextState;
}

function deriveLatestUserMessageAtForSidebarSummary(
  state: EnvironmentState,
  threadId: ThreadId,
  existingSummary: SidebarThreadSummary | undefined,
): string | null {
  const messageIds = state.messageIdsByThreadId[threadId] ?? [];
  const messages = state.messageByThreadId[threadId] ?? {};
  const queuedTurnIds = state.queuedTurnIdsByThreadId[threadId] ?? [];
  const queuedTurns = state.queuedTurnByThreadId[threadId] ?? {};

  const latestQueuedTurn = queuedTurnIds
    .flatMap((queuedTurnId) => {
      const queuedTurn = queuedTurns[queuedTurnId];
      return queuedTurn ? [queuedTurn.createdAt] : [];
    })
    .toSorted()
    .at(-1);

  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const message = messages[messageIds[index]!];
    if (message?.role === "user") {
      return latestQueuedTurn && latestQueuedTurn > message.createdAt
        ? latestQueuedTurn
        : message.createdAt;
    }
  }

  return latestQueuedTurn ?? existingSummary?.latestUserMessageAt ?? null;
}

function syncSidebarThreadSummaryFromThreadState(
  state: EnvironmentState,
  threadId: ThreadId,
  environmentId: EnvironmentId,
): EnvironmentState {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return state;
  }

  const existingSummary = state.sidebarThreadSummaryById[threadId];
  const nextSummary: SidebarThreadSummary = {
    id: shell.id,
    environmentId,
    projectId: shell.projectId,
    title: shell.title,
    interactionMode: shell.interactionMode,
    parentThreadId: shell.parentThreadId ?? null,
    createdByThreadId: shell.createdByThreadId ?? null,
    subagentKind: shell.subagentKind ?? null,
    subagentNickname: shell.subagentNickname ?? null,
    subagentRole: shell.subagentRole ?? null,
    hiddenFromThreadList: shell.hiddenFromThreadList ?? false,
    session: state.threadSessionById[threadId] ?? null,
    createdAt: shell.createdAt,
    archivedAt: shell.archivedAt,
    updatedAt: shell.updatedAt,
    latestTurn: state.threadTurnStateById[threadId]?.latestTurn ?? null,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    latestUserMessageAt: deriveLatestUserMessageAtForSidebarSummary(
      state,
      threadId,
      existingSummary,
    ),
    hasPendingApprovals: existingSummary?.hasPendingApprovals ?? false,
    hasPendingUserInput: existingSummary?.hasPendingUserInput ?? false,
    hasActionableProposedPlan: existingSummary?.hasActionableProposedPlan ?? false,
  };

  if (sidebarThreadSummariesEqual(existingSummary, nextSummary)) {
    return state;
  }

  return {
    ...state,
    sidebarThreadSummaryById: {
      ...state.sidebarThreadSummaryById,
      [threadId]: nextSummary,
    },
  };
}

function syncSidebarThreadSummaryFromThreadStateIfMissing(
  previousState: EnvironmentState,
  nextState: EnvironmentState,
  threadId: ThreadId,
  environmentId: EnvironmentId,
): EnvironmentState {
  if (previousState.sidebarThreadSummaryById[threadId] !== undefined) {
    return nextState;
  }
  return syncSidebarThreadSummaryFromThreadState(nextState, threadId, environmentId);
}

function getOrchestrationEventThreadId(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

function isStaleThreadEvent(state: EnvironmentState, event: OrchestrationEvent): boolean {
  const threadId = getOrchestrationEventThreadId(event);
  if (threadId === null) {
    return false;
  }
  const lastAppliedSequence = state.lastAppliedEventSequenceByThreadId?.[threadId];
  if (lastAppliedSequence === undefined) {
    return false;
  }
  if (event.sequence < lastAppliedSequence) {
    return true;
  }
  return (
    event.sequence > 1 &&
    event.sequence === lastAppliedSequence &&
    state.lastAppliedEventIdByThreadId?.[threadId] === event.eventId
  );
}

function recordAppliedThreadEventSequence(
  state: EnvironmentState,
  event: OrchestrationEvent,
): EnvironmentState {
  const threadId = getOrchestrationEventThreadId(event);
  if (threadId === null) {
    return state;
  }
  const lastAppliedByThreadId = state.lastAppliedEventSequenceByThreadId ?? {};
  const current = lastAppliedByThreadId[threadId];
  const lastEventIdByThreadId = state.lastAppliedEventIdByThreadId ?? {};
  if (current !== undefined && current > event.sequence) {
    return state;
  }
  return {
    ...state,
    lastAppliedEventSequenceByThreadId: {
      ...lastAppliedByThreadId,
      [threadId]: event.sequence,
    },
    lastAppliedEventIdByThreadId: {
      ...lastEventIdByThreadId,
      [threadId]: event.eventId,
    },
  };
}

function syncSidebarThreadSummariesForThreadIds(
  state: EnvironmentState,
  threadIds: Iterable<ThreadId>,
  environmentId: EnvironmentId,
): EnvironmentState {
  let nextState = state;
  for (const threadId of threadIds) {
    nextState = syncSidebarThreadSummaryFromThreadState(nextState, threadId, environmentId);
  }
  return nextState;
}

function syncRecoveredSidebarThreadSummaries(
  state: EnvironmentState,
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
): EnvironmentState {
  const threadIds = new Set<ThreadId>();
  for (const event of events) {
    const threadId = getOrchestrationEventThreadId(event);
    if (threadId !== null) {
      threadIds.add(threadId);
    }
  }

  return syncSidebarThreadSummariesForThreadIds(state, threadIds, environmentId);
}

function retainThreadScopedRecord<T>(
  record: Record<ThreadId, T>,
  nextThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([threadId, value]) =>
      nextThreadIds.has(threadId as ThreadId) ? [[threadId, value] as const] : [],
    ),
  ) as Record<ThreadId, T>;
}

function removeThreadState(state: EnvironmentState, threadId: ThreadId): EnvironmentState {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return state;
  }

  const nextThreadIds = removeId(state.threadIds, threadId);
  const currentProjectThreadIds = state.threadIdsByProjectId[shell.projectId] ?? EMPTY_THREAD_IDS;
  const nextProjectThreadIds = removeId(currentProjectThreadIds, threadId);
  const nextThreadIdsByProjectId =
    nextProjectThreadIds.length === 0
      ? (() => {
          const { [shell.projectId]: _removed, ...rest } = state.threadIdsByProjectId;
          return rest as Record<ProjectId, ThreadId[]>;
        })()
      : {
          ...state.threadIdsByProjectId,
          [shell.projectId]: nextProjectThreadIds,
        };

  const { [threadId]: _removedShell, ...threadShellById } = state.threadShellById;
  const { [threadId]: _removedSession, ...threadSessionById } = state.threadSessionById;
  const { [threadId]: _removedTurnState, ...threadTurnStateById } = state.threadTurnStateById;
  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } = state.messageIdsByThreadId;
  const { [threadId]: _removedMessages, ...messageByThreadId } = state.messageByThreadId;
  const { [threadId]: _removedQueuedTurnIds, ...queuedTurnIdsByThreadId } =
    state.queuedTurnIdsByThreadId;
  const { [threadId]: _removedQueuedTurns, ...queuedTurnByThreadId } = state.queuedTurnByThreadId;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } = state.activityIdsByThreadId;
  const { [threadId]: _removedActivities, ...activityByThreadId } = state.activityByThreadId;
  const { [threadId]: _removedPlanIds, ...proposedPlanIdsByThreadId } =
    state.proposedPlanIdsByThreadId;
  const { [threadId]: _removedPlans, ...proposedPlanByThreadId } = state.proposedPlanByThreadId;
  const { [threadId]: _removedTurnDiffIds, ...turnDiffIdsByThreadId } = state.turnDiffIdsByThreadId;
  const { [threadId]: _removedTurnDiffs, ...turnDiffSummaryByThreadId } =
    state.turnDiffSummaryByThreadId;
  const { [threadId]: _removedPageInfo, ...threadDetailPageInfoByThreadId } =
    state.threadDetailPageInfoByThreadId;
  const { [threadId]: _removedSidebarSummary, ...sidebarThreadSummaryById } =
    state.sidebarThreadSummaryById;

  return {
    ...state,
    threadIds: nextThreadIds,
    threadIdsByProjectId: nextThreadIdsByProjectId,
    threadShellById,
    threadSessionById,
    threadTurnStateById,
    messageIdsByThreadId,
    messageByThreadId,
    queuedTurnIdsByThreadId,
    queuedTurnByThreadId,
    activityIdsByThreadId,
    activityByThreadId,
    proposedPlanIdsByThreadId,
    proposedPlanByThreadId,
    turnDiffIdsByThreadId,
    turnDiffSummaryByThreadId,
    threadDetailPageInfoByThreadId,
    lastAppliedEventSequenceByThreadId: state.lastAppliedEventSequenceByThreadId ?? {},
    lastAppliedEventIdByThreadId: state.lastAppliedEventIdByThreadId ?? {},
    sidebarThreadSummaryById,
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  turnId: TurnId,
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): TurnDiffSummary[] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationThreadActivity[] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  retainedTurnIds: ReadonlySet<string>,
): ProposedPlan[] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderDriverKind {
  if (isProviderDriverKindValue(providerName)) {
    return providerName;
  }
  return ProviderDriverKind.make("codex");
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateThreadState(
  state: EnvironmentState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
  options?: ThreadDetailWriteOptions,
): EnvironmentState {
  const currentThread = getThreadFromEnvironmentState(state, threadId);
  if (!currentThread) {
    return state;
  }
  const nextThread = updater(currentThread);
  if (nextThread === currentThread) {
    return state;
  }
  return writeThreadState(state, nextThread, currentThread, options);
}

function buildProjectState(
  projects: ReadonlyArray<Project>,
): Pick<EnvironmentState, "projectIds" | "projectById"> {
  return {
    projectIds: projects.map((project) => project.id),
    projectById: Object.fromEntries(
      projects.map((project) => [project.id, project] as const),
    ) as Record<ProjectId, Project>,
  };
}

function getStoredEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
): EnvironmentState {
  return state.environmentStateById[environmentId] ?? initialEnvironmentState;
}

function commitEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
  nextEnvironmentState: EnvironmentState,
): AppState {
  const currentEnvironmentState = state.environmentStateById[environmentId];
  const environmentStateById =
    currentEnvironmentState === nextEnvironmentState
      ? state.environmentStateById
      : {
          ...state.environmentStateById,
          [environmentId]: nextEnvironmentState,
        };

  if (environmentStateById === state.environmentStateById) {
    return state;
  }

  return {
    ...state,
    environmentStateById,
  };
}

function syncEnvironmentShellSnapshot(
  state: EnvironmentState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
): EnvironmentState {
  const nextProjects = snapshot.projects.map((project) => mapProject(project, environmentId));
  const nextThreadIds = new Set(snapshot.threads.map((thread) => thread.id));
  let nextState: EnvironmentState = {
    ...state,
    ...buildProjectState(nextProjects),
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: retainThreadScopedRecord(state.threadShellById, nextThreadIds),
    threadSessionById: retainThreadScopedRecord(state.threadSessionById, nextThreadIds),
    threadTurnStateById: retainThreadScopedRecord(state.threadTurnStateById, nextThreadIds),
    sidebarThreadSummaryById: {},
    messageIdsByThreadId: retainThreadScopedRecord(state.messageIdsByThreadId, nextThreadIds),
    messageByThreadId: retainThreadScopedRecord(state.messageByThreadId, nextThreadIds),
    queuedTurnIdsByThreadId: retainThreadScopedRecord(state.queuedTurnIdsByThreadId, nextThreadIds),
    queuedTurnByThreadId: retainThreadScopedRecord(state.queuedTurnByThreadId, nextThreadIds),
    activityIdsByThreadId: retainThreadScopedRecord(state.activityIdsByThreadId, nextThreadIds),
    activityByThreadId: retainThreadScopedRecord(state.activityByThreadId, nextThreadIds),
    proposedPlanIdsByThreadId: retainThreadScopedRecord(
      state.proposedPlanIdsByThreadId,
      nextThreadIds,
    ),
    proposedPlanByThreadId: retainThreadScopedRecord(state.proposedPlanByThreadId, nextThreadIds),
    turnDiffIdsByThreadId: retainThreadScopedRecord(state.turnDiffIdsByThreadId, nextThreadIds),
    turnDiffSummaryByThreadId: retainThreadScopedRecord(
      state.turnDiffSummaryByThreadId,
      nextThreadIds,
    ),
    threadDetailPageInfoByThreadId: retainThreadScopedRecord(
      state.threadDetailPageInfoByThreadId,
      nextThreadIds,
    ),
    lastAppliedEventSequenceByThreadId: retainThreadScopedRecord(
      state.lastAppliedEventSequenceByThreadId ?? {},
      nextThreadIds,
    ),
    lastAppliedEventIdByThreadId: retainThreadScopedRecord(
      state.lastAppliedEventIdByThreadId ?? {},
      nextThreadIds,
    ),
    bootstrapComplete: true,
  };

  for (const thread of snapshot.threads) {
    nextState = writeThreadShellState(nextState, mapThreadShell(thread, environmentId), {
      preserveNewerState: true,
    });
  }

  return nextState;
}

export function syncServerShellSnapshot(
  state: AppState,
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    syncEnvironmentShellSnapshot(
      getStoredEnvironmentState(state, environmentId),
      snapshot,
      environmentId,
    ),
  );
}

export function syncServerThreadDetail(
  state: AppState,
  thread: OrchestrationThread,
  environmentId: EnvironmentId,
  options?: ThreadDetailWriteOptions,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const previousThread = getThreadFromEnvironmentState(environmentState, thread.id);
  const nextEnvironmentState = writeThreadState(
    environmentState,
    mapThread(thread, environmentId, options?.pageInfo),
    previousThread,
    options,
  );
  return commitEnvironmentState(
    state,
    environmentId,
    syncSidebarThreadSummaryFromThreadStateIfMissing(
      environmentState,
      nextEnvironmentState,
      thread.id,
      environmentId,
    ),
  );
}

export function mergeServerThreadDetailTailSnapshot(
  state: AppState,
  thread: OrchestrationThread,
  environmentId: EnvironmentId,
  options?: ThreadDetailWriteOptions,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const previousThread = getThreadFromEnvironmentState(environmentState, thread.id);
  const incomingPageInfo = options?.pageInfo ?? EMPTY_ORCHESTRATION_THREAD_DETAIL_PAGE_INFO;
  const incomingThread = mapThread(thread, environmentId, incomingPageInfo);
  const nextPageInfo = resolveTailSnapshotPageInfo(
    environmentState.threadDetailPageInfoByThreadId[thread.id],
    incomingPageInfo,
  );
  const nextThread: Thread = previousThread
    ? {
        ...incomingThread,
        detailPageInfo: nextPageInfo,
        messages: mergeTailItems(
          previousThread.messages,
          incomingThread.messages,
          (message) => message.id,
          compareMessagesByOrder,
        ),
        proposedPlans: mergeTailItems(
          previousThread.proposedPlans,
          incomingThread.proposedPlans,
          (plan) => plan.id,
          compareProposedPlansByOrder,
        ),
        activities: mergeTailItems(
          previousThread.activities,
          incomingThread.activities,
          (activity) => activity.id,
          compareThreadActivitiesByOrder,
        ),
        turnDiffSummaries: mergeTailItems(
          previousThread.turnDiffSummaries,
          incomingThread.turnDiffSummaries,
          (summary) => summary.turnId,
          compareTurnDiffSummariesByOrder,
        ),
      }
    : incomingThread;

  const nextEnvironmentState = writeThreadState(environmentState, nextThread, previousThread, {
    ...options,
    pageInfo: nextPageInfo,
  });
  return commitEnvironmentState(
    state,
    environmentId,
    syncSidebarThreadSummaryFromThreadStateIfMissing(
      environmentState,
      nextEnvironmentState,
      thread.id,
      environmentId,
    ),
  );
}

export function mergeServerThreadDetailPage(
  state: AppState,
  snapshot: OrchestrationThreadDetailSnapshot,
  environmentId: EnvironmentId,
  options: ThreadDetailPageMergeOptions = {},
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const previousThread = getThreadFromEnvironmentState(environmentState, snapshot.thread.id);
  const nextPageInfo = resolveOlderPageInfo(
    environmentState.threadDetailPageInfoByThreadId[snapshot.thread.id],
    snapshot.pageInfo,
    options.requestedBefore,
  );
  const pageThread = mapThread(snapshot.thread, environmentId, nextPageInfo);
  const nextThread: Thread = previousThread
    ? {
        ...pageThread,
        detailPageInfo: nextPageInfo,
        messages: mergeOlderItems(
          pageThread.messages,
          previousThread.messages,
          (message) => message.id,
          compareMessagesByOrder,
        ),
        proposedPlans: mergeOlderItems(
          pageThread.proposedPlans,
          previousThread.proposedPlans,
          (plan) => plan.id,
          compareProposedPlansByOrder,
        ),
        activities: mergeOlderItems(
          pageThread.activities,
          previousThread.activities,
          (activity) => activity.id,
          compareThreadActivitiesByOrder,
        ),
        turnDiffSummaries: mergeOlderItems(
          pageThread.turnDiffSummaries,
          previousThread.turnDiffSummaries,
          (summary) => summary.turnId,
          compareTurnDiffSummariesByOrder,
        ),
      }
    : pageThread;

  const nextEnvironmentState = writeThreadState(environmentState, nextThread, previousThread, {
    pageInfo: nextPageInfo,
  });
  return commitEnvironmentState(
    state,
    environmentId,
    syncSidebarThreadSummaryFromThreadStateIfMissing(
      environmentState,
      nextEnvironmentState,
      snapshot.thread.id,
      environmentId,
    ),
  );
}

function applyEnvironmentOrchestrationEventUnchecked(
  state: EnvironmentState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
  options: ThreadDetailWriteOptions = {},
): EnvironmentState {
  switch (event.type) {
    case "project.created": {
      const nextProject = mapProject(
        {
          id: event.payload.projectId,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          repositoryIdentity: event.payload.repositoryIdentity ?? null,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletedAt: null,
        },
        environmentId,
      );
      const existingProjectId =
        state.projectIds.find(
          (projectId) =>
            projectId === event.payload.projectId ||
            state.projectById[projectId]?.cwd === event.payload.workspaceRoot,
        ) ?? null;
      let projectById = state.projectById;
      let projectIds = state.projectIds;

      if (existingProjectId !== null && existingProjectId !== nextProject.id) {
        const { [existingProjectId]: _removedProject, ...restProjectById } = state.projectById;
        projectById = {
          ...restProjectById,
          [nextProject.id]: nextProject,
        };
        projectIds = state.projectIds.map((projectId) =>
          projectId === existingProjectId ? nextProject.id : projectId,
        );
      } else {
        projectById = {
          ...state.projectById,
          [nextProject.id]: nextProject,
        };
        projectIds =
          existingProjectId === null && !state.projectIds.includes(nextProject.id)
            ? [...state.projectIds, nextProject.id]
            : state.projectIds;
      }

      return {
        ...state,
        projectById,
        projectIds,
      };
    }

    case "project.meta-updated": {
      const project = state.projectById[event.payload.projectId];
      if (!project) {
        return state;
      }
      const nextProject: Project = {
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.repositoryIdentity !== undefined
          ? { repositoryIdentity: event.payload.repositoryIdentity ?? null }
          : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      };
      return {
        ...state,
        projectById: {
          ...state.projectById,
          [event.payload.projectId]: nextProject,
        },
      };
    }

    case "project.deleted": {
      if (!state.projectById[event.payload.projectId]) {
        return state;
      }
      const { [event.payload.projectId]: _removedProject, ...projectById } = state.projectById;
      return {
        ...state,
        projectById,
        projectIds: removeId(state.projectIds, event.payload.projectId),
      };
    }

    case "thread.created": {
      const previousThread = getThreadFromEnvironmentState(state, event.payload.threadId);
      const nextThread = mapThread(
        {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          parentThreadId: event.payload.parentThreadId ?? null,
          createdByThreadId: event.payload.createdByThreadId ?? null,
          subagentKind: event.payload.subagentKind ?? null,
          subagentNickname: event.payload.subagentNickname ?? null,
          subagentRole: event.payload.subagentRole ?? null,
          hiddenFromThreadList: event.payload.hiddenFromThreadList ?? false,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          queuedTurns: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
        environmentId,
      );
      return writeThreadState(state, nextThread, previousThread, options);
    }

    case "thread.deleted":
      return removeThreadState(state, event.payload.threadId);

    case "thread.archived":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        }),
        options,
      );

    case "thread.unarchived":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: null,
          updatedAt: event.payload.updatedAt,
        }),
        options,
      );

    case "thread.meta-updated":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        }),
        options,
      );

    case "thread.runtime-mode-set":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        }),
        options,
      );

    case "thread.interaction-mode-set":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        }),
        options,
      );

    case "thread.turn-start-requested":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          pendingSourceProposedPlan: event.payload.sourceProposedPlan,
          updatedAt: event.occurredAt,
        }),
        options,
      );

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const latestTurn = thread.latestTurn;
          if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
            return thread;
          }
          return {
            ...thread,
            latestTurn: buildLatestTurn({
              previous: latestTurn,
              turnId: event.payload.turnId,
              state: "interrupted",
              requestedAt: latestTurn.requestedAt,
              startedAt: latestTurn.startedAt ?? event.payload.createdAt,
              completedAt: latestTurn.completedAt ?? event.payload.createdAt,
              assistantMessageId: latestTurn.assistantMessageId,
            }),
            updatedAt: event.occurredAt,
          };
        },
        options,
      );
    }

    case "thread.message-sent":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const message = mapMessage(thread.environmentId, {
            id: event.payload.messageId,
            role: event.payload.role,
            text: event.payload.text,
            ...(event.payload.attachments !== undefined
              ? { attachments: event.payload.attachments }
              : {}),
            turnId: event.payload.turnId,
            streaming: event.payload.streaming,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          const existingMessage = thread.messages.find((entry) => entry.id === message.id);
          const effectiveTurnId = resolveEffectiveMessageTurnId({
            role: message.role,
            payloadTurnId: message.turnId,
            existingTurnId: existingMessage?.turnId,
            session: thread.session
              ? {
                  status: thread.session.orchestrationStatus,
                  activeTurnId: thread.session.activeTurnId ?? null,
                }
              : null,
            latestTurn: thread.latestTurn,
          });
          const messages = existingMessage
            ? thread.messages.map((entry) =>
                entry.id !== message.id
                  ? entry
                  : {
                      ...entry,
                      text: message.streaming
                        ? `${entry.text}${message.text}`
                        : message.text.length > 0
                          ? message.text
                          : entry.text,
                      streaming: message.streaming,
                      turnId: effectiveTurnId,
                      ...(message.streaming
                        ? entry.completedAt !== undefined
                          ? { completedAt: entry.completedAt }
                          : {}
                        : message.completedAt !== undefined
                          ? { completedAt: message.completedAt }
                          : {}),
                      ...(message.attachments !== undefined
                        ? { attachments: message.attachments }
                        : {}),
                    },
              )
            : [...thread.messages, { ...message, turnId: effectiveTurnId }];
          const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
          const turnDiffSummaries =
            event.payload.role === "assistant" && effectiveTurnId !== null
              ? rebindTurnDiffSummariesForAssistantMessage(
                  thread.turnDiffSummaries,
                  effectiveTurnId,
                  event.payload.messageId,
                )
              : thread.turnDiffSummaries;
          // A completed assistant message only settles the turn once there is
          // no session/latest-turn evidence that work is still in flight.
          // Providers may emit several assistant messages per turn, and the
          // turn must stay unsettled until the provider reports turn end.
          const turnStillRunning = isTurnStillRunningForPacking({
            turnId: effectiveTurnId,
            session: thread.session
              ? {
                  status: thread.session.orchestrationStatus,
                  activeTurnId: thread.session.activeTurnId ?? null,
                }
              : null,
            latestTurn: thread.latestTurn,
          });
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const latestTurn: Thread["latestTurn"] =
            event.payload.role === "assistant" &&
            effectiveTurnId !== null &&
            (thread.latestTurn === null || thread.latestTurn.turnId === effectiveTurnId)
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: effectiveTurnId,
                  state: settlesTurn
                    ? thread.latestTurn?.state === "interrupted"
                      ? "interrupted"
                      : thread.latestTurn?.state === "error"
                        ? "error"
                        : "completed"
                    : "running",
                  requestedAt:
                    thread.latestTurn?.turnId === effectiveTurnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.createdAt,
                  startedAt:
                    thread.latestTurn?.turnId === effectiveTurnId
                      ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                      : event.payload.createdAt,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                  completedAt: settlesTurn
                    ? event.payload.updatedAt
                    : thread.latestTurn?.turnId === effectiveTurnId
                      ? (thread.latestTurn.completedAt ?? null)
                      : null,
                  assistantMessageId: event.payload.messageId,
                })
              : thread.latestTurn;
          return {
            ...thread,
            messages: cappedMessages,
            turnDiffSummaries,
            latestTurn,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.turn-queued":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const queuedTurn = mapQueuedTurn(thread.environmentId, event.payload);
          const queuedTurns = [
            ...thread.queuedTurns.filter((entry) => entry.messageId !== queuedTurn.messageId),
            queuedTurn,
          ].toSorted(compareQueuedTurnsByOrder);
          return {
            ...thread,
            queuedTurns,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.queued-turn-updated":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const queuedTurns = thread.queuedTurns.map((queuedTurn) => {
            if (queuedTurn.messageId !== event.payload.messageId) {
              return queuedTurn;
            }
            changed = true;
            return {
              ...queuedTurn,
              text: event.payload.text,
              updatedAt: event.payload.updatedAt,
            };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            queuedTurns,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.queued-turn-cancelled":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const queuedTurns = thread.queuedTurns.filter(
            (entry) => entry.messageId !== event.payload.messageId,
          );
          if (queuedTurns.length === thread.queuedTurns.length) {
            return thread;
          }
          return {
            ...thread,
            queuedTurns,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.queued-turn-steer-requested":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const queuedTurns = thread.queuedTurns.map((entry) => {
            if (entry.messageId !== event.payload.messageId) {
              return entry;
            }
            changed = true;
            return {
              ...entry,
              steering: {
                expectedTurnId: event.payload.expectedTurnId,
                requestedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            queuedTurns,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.queued-turn-steer-failed":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          let changed = false;
          const queuedTurns = thread.queuedTurns.map((entry) => {
            if (entry.messageId !== event.payload.messageId || entry.steering === undefined) {
              return entry;
            }
            changed = true;
            const { steering: _steering, ...queuedTurn } = entry;
            return {
              ...queuedTurn,
              updatedAt: event.occurredAt,
            };
          });
          if (!changed) {
            return thread;
          }
          return {
            ...thread,
            queuedTurns,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.queued-turn-dispatched":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const queuedTurn = thread.queuedTurns.find(
            (entry) => entry.messageId === event.payload.messageId,
          );
          const queuedTurns = thread.queuedTurns.filter(
            (entry) => entry.messageId !== event.payload.messageId,
          );
          if (queuedTurns.length === thread.queuedTurns.length) {
            return thread;
          }

          const messages =
            queuedTurn !== undefined &&
            !thread.messages.some((message) => message.id === queuedTurn.messageId)
              ? [
                  ...thread.messages,
                  mapDispatchedQueuedTurnMessage(queuedTurn, event.payload.dispatchedAt),
                ]
                  .toSorted(compareMessagesByOrder)
                  .slice(-MAX_THREAD_MESSAGES)
              : thread.messages;

          return {
            ...thread,
            queuedTurns,
            messages,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.queued-turn-steered":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const queuedTurn = thread.queuedTurns.find(
            (entry) => entry.messageId === event.payload.messageId,
          );
          const queuedTurns = thread.queuedTurns.filter(
            (entry) => entry.messageId !== event.payload.messageId,
          );
          if (queuedTurns.length === thread.queuedTurns.length) {
            return thread;
          }

          const messages =
            queuedTurn !== undefined &&
            !thread.messages.some((message) => message.id === queuedTurn.messageId)
              ? [
                  ...thread.messages,
                  mapSteeredQueuedTurnMessage(
                    queuedTurn,
                    event.payload.turnId,
                    event.payload.steeredAt,
                  ),
                ]
                  .toSorted(compareMessagesByOrder)
                  .slice(-MAX_THREAD_MESSAGES)
              : thread.messages;

          return {
            ...thread,
            queuedTurns,
            messages,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.session-set":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          // Leaving the "running" session status is the turn-end signal:
          // settle a still-running latest turn so its duration reflects the
          // whole turn, not the last assistant message.
          const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
          const latestTurn: Thread["latestTurn"] =
            event.payload.session.status === "running" &&
            event.payload.session.activeTurnId !== null
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.session.activeTurnId,
                  state: "running",
                  requestedAt:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.session.updatedAt,
                  startedAt:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                      : event.payload.session.updatedAt,
                  completedAt: null,
                  assistantMessageId:
                    thread.latestTurn?.turnId === event.payload.session.activeTurnId
                      ? thread.latestTurn.assistantMessageId
                      : null,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                })
              : thread.latestTurn !== null &&
                  thread.latestTurn.state === "running" &&
                  settledTurnState !== null
                ? buildLatestTurn({
                    previous: thread.latestTurn,
                    turnId: thread.latestTurn.turnId,
                    state: settledTurnState,
                    requestedAt: thread.latestTurn.requestedAt,
                    startedAt: thread.latestTurn.startedAt,
                    // A running turn's completedAt can only hold a mid-turn
                    // placeholder checkpoint timestamp; the session leaving
                    // "running" is the authoritative turn end.
                    completedAt: event.payload.session.updatedAt,
                    assistantMessageId: thread.latestTurn.assistantMessageId,
                  })
                : thread.latestTurn;
          return {
            ...thread,
            session: mapSession(event.payload.session),
            error: sanitizeThreadErrorMessage(event.payload.session.lastError),
            latestTurn,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.session-stop-requested":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) =>
          thread.session === null
            ? thread
            : {
                ...thread,
                session: {
                  ...thread.session,
                  status: "closed",
                  orchestrationStatus: "stopped",
                  activeTurnId: undefined,
                  updatedAt: event.payload.createdAt,
                },
                updatedAt: event.occurredAt,
              },
        options,
      );

    case "thread.proposed-plan-upserted":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
          const proposedPlans = [
            ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
            proposedPlan,
          ]
            .toSorted(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            )
            .slice(-MAX_THREAD_PROPOSED_PLANS);
          return {
            ...thread,
            proposedPlans,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.turn-diff-completed":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const assistantMessageId =
            thread.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === event.payload.turnId,
            )?.id ?? event.payload.assistantMessageId;
          const checkpoint = mapTurnDiffSummary({
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            status: event.payload.status,
            files: event.payload.files,
            attribution: event.payload.attribution,
            assistantMessageId,
            completedAt: event.payload.completedAt,
          });
          const existing = thread.turnDiffSummaries.find(
            (entry) => entry.turnId === checkpoint.turnId,
          );
          if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
            return thread;
          }
          const turnDiffSummaries = [
            ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
            checkpoint,
          ]
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            )
            .slice(-MAX_THREAD_CHECKPOINTS);
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // diff summary, but don't settle a turn while its session is still running.
          const turnStillRunning =
            thread.session?.orchestrationStatus === "running" &&
            thread.session.activeTurnId === event.payload.turnId;
          const latestTurn =
            !turnStillRunning &&
            (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.turnId,
                  state: checkpointStatusToLatestTurnState(event.payload.status),
                  requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                  startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                  completedAt: event.payload.completedAt,
                  assistantMessageId,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                })
              : thread.latestTurn;
          return {
            ...thread,
            turnDiffSummaries,
            latestTurn,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.reverted":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const turnDiffSummaries = thread.turnDiffSummaries
            .filter(
              (entry) =>
                entry.checkpointTurnCount !== undefined &&
                entry.checkpointTurnCount <= event.payload.turnCount,
            )
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            )
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            event.payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-MAX_THREAD_PROPOSED_PLANS);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
          const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

          return {
            ...thread,
            turnDiffSummaries,
            messages,
            proposedPlans,
            activities,
            pendingSourceProposedPlan: undefined,
            latestTurn:
              latestCheckpoint === null
                ? null
                : {
                    turnId: latestCheckpoint.turnId,
                    state: checkpointStatusToLatestTurnState(
                      (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                    ),
                    requestedAt: latestCheckpoint.completedAt,
                    startedAt: latestCheckpoint.completedAt,
                    completedAt: latestCheckpoint.completedAt,
                    assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  },
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.activity-appended":
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const activities = [
            ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
            { ...event.payload.activity },
          ]
            .toSorted(compareActivities)
            .slice(-MAX_THREAD_ACTIVITIES);
          return {
            ...thread,
            activities,
            updatedAt: event.occurredAt,
          };
        },
        options,
      );

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;
  }

  return state;
}

function applyEnvironmentOrchestrationEvent(
  state: EnvironmentState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
  options: ThreadDetailWriteOptions = {},
): EnvironmentState {
  if (isStaleThreadEvent(state, event)) {
    return state;
  }

  const nextState = applyEnvironmentOrchestrationEventUnchecked(
    state,
    event,
    environmentId,
    options,
  );
  const threadId = getOrchestrationEventThreadId(event);
  if (
    threadId === null ||
    (state.threadShellById[threadId] === undefined &&
      nextState.threadShellById[threadId] === undefined)
  ) {
    return nextState;
  }
  return recordAppliedThreadEventSequence(nextState, event);
}

function applyEnvironmentShellEvent(
  state: EnvironmentState,
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
): EnvironmentState {
  switch (event.kind) {
    case "project-upserted": {
      const nextProject = mapProject(event.project, environmentId);
      const existingProjectId =
        state.projectIds.find(
          (projectId) =>
            projectId === event.project.id ||
            state.projectById[projectId]?.cwd === event.project.workspaceRoot,
        ) ?? null;
      let projectById = state.projectById;
      let projectIds = state.projectIds;

      if (existingProjectId !== null && existingProjectId !== nextProject.id) {
        const { [existingProjectId]: _removedProject, ...restProjectById } = state.projectById;
        projectById = {
          ...restProjectById,
          [nextProject.id]: nextProject,
        };
        projectIds = state.projectIds.map((projectId) =>
          projectId === existingProjectId ? nextProject.id : projectId,
        );
      } else {
        projectById = {
          ...state.projectById,
          [nextProject.id]: nextProject,
        };
        projectIds =
          existingProjectId === null && !state.projectIds.includes(nextProject.id)
            ? [...state.projectIds, nextProject.id]
            : state.projectIds;
      }

      return {
        ...state,
        projectById,
        projectIds,
      };
    }
    case "project-removed": {
      if (!state.projectById[event.projectId]) {
        return state;
      }
      const { [event.projectId]: _removedProject, ...projectById } = state.projectById;
      return {
        ...state,
        projectById,
        projectIds: removeId(state.projectIds, event.projectId),
      };
    }
    case "thread-upserted":
      return writeThreadShellState(state, mapThreadShell(event.thread, environmentId), {
        preserveNewerState: true,
      });
    case "thread-removed":
      return removeThreadState(state, event.threadId);
  }
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
  options?: ThreadDetailWriteOptions,
): AppState {
  if (events.length === 0) {
    return state;
  }
  const currentEnvironmentState = getStoredEnvironmentState(state, environmentId);
  const nextEnvironmentState = events.reduce(
    (nextState, event) =>
      applyEnvironmentOrchestrationEvent(nextState, event, environmentId, options),
    currentEnvironmentState,
  );
  return commitEnvironmentState(
    state,
    environmentId,
    options?.syncSidebarSummaries
      ? syncRecoveredSidebarThreadSummaries(nextEnvironmentState, events, environmentId)
      : nextEnvironmentState,
  );
}

export function syncSidebarThreadSummariesForEnvironment(
  state: AppState,
  environmentId: EnvironmentId,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  return commitEnvironmentState(
    state,
    environmentId,
    syncSidebarThreadSummariesForThreadIds(
      environmentState,
      environmentState.threadIds,
      environmentId,
    ),
  );
}

function getEnvironmentEntries(
  state: AppState,
): ReadonlyArray<readonly [EnvironmentId, EnvironmentState]> {
  return Object.entries(state.environmentStateById) as unknown as ReadonlyArray<
    readonly [EnvironmentId, EnvironmentState]
  >;
}

export function selectEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): EnvironmentState {
  return environmentId ? getStoredEnvironmentState(state, environmentId) : initialEnvironmentState;
}

export function selectProjectsForEnvironment(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): Project[] {
  return getProjects(selectEnvironmentState(state, environmentId));
}

export function selectThreadsForEnvironment(
  state: AppState,
  environmentId: EnvironmentId | null | undefined,
): Thread[] {
  return getThreads(selectEnvironmentState(state, environmentId));
}

export function selectProjectsAcrossEnvironments(state: AppState): Project[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    getProjects(environmentState),
  );
}

export function selectThreadsAcrossEnvironments(state: AppState): Thread[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    getThreads(environmentState),
  );
}

/** Like `selectThreadsAcrossEnvironments` but returns stable `ThreadShell` references from the store (no derived data). */
export function selectThreadShellsAcrossEnvironments(state: AppState): ThreadShell[] {
  return getEnvironmentEntries(state).flatMap(([, environmentState]) =>
    environmentState.threadIds.flatMap((threadId) => {
      const shell = environmentState.threadShellById[threadId];
      return shell ? [shell] : [];
    }),
  );
}

export function selectSidebarThreadsAcrossEnvironments(state: AppState): SidebarThreadSummary[] {
  return getEnvironmentEntries(state).flatMap(([environmentId, environmentState]) =>
    environmentState.threadIds.flatMap((threadId) => {
      const thread = environmentState.sidebarThreadSummaryById[threadId];
      return thread && thread.environmentId === environmentId ? [thread] : [];
    }),
  );
}

export function selectSidebarThreadsForProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): SidebarThreadSummary[] {
  if (!ref) {
    return [];
  }

  const environmentState = selectEnvironmentState(state, ref.environmentId);
  const threadIds = environmentState.threadIdsByProjectId[ref.projectId] ?? EMPTY_THREAD_IDS;
  return threadIds.flatMap((threadId) => {
    const thread = environmentState.sidebarThreadSummaryById[threadId];
    return thread ? [thread] : [];
  });
}

export function selectSidebarThreadsForProjectRefs(
  state: AppState,
  refs: readonly ScopedProjectRef[],
): SidebarThreadSummary[] {
  if (refs.length === 0) return [];
  if (refs.length === 1) return selectSidebarThreadsForProjectRef(state, refs[0]);
  return refs.flatMap((ref) => selectSidebarThreadsForProjectRef(state, ref));
}

export function selectBootstrapCompleteForActiveEnvironment(state: AppState): boolean {
  return selectEnvironmentState(state, state.activeEnvironmentId).bootstrapComplete;
}

export function selectProjectByRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): Project | undefined {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId]
    : undefined;
}

export function selectThreadByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): Thread | undefined {
  return ref
    ? getThreadFromEnvironmentState(selectEnvironmentState(state, ref.environmentId), ref.threadId)
    : undefined;
}

export function selectThreadExistsByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).threadShellById[ref.threadId] !== undefined
    : false;
}

export function selectSidebarThreadSummaryByRef(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): SidebarThreadSummary | undefined {
  return ref
    ? selectEnvironmentState(state, ref.environmentId).sidebarThreadSummaryById[ref.threadId]
    : undefined;
}

export function selectThreadIdsByProjectRef(
  state: AppState,
  ref: ScopedProjectRef | null | undefined,
): ThreadId[] {
  return ref
    ? (selectEnvironmentState(state, ref.environmentId).threadIdsByProjectId[ref.projectId] ??
        EMPTY_THREAD_IDS)
    : EMPTY_THREAD_IDS;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  if (state.activeEnvironmentId === null) {
    return state;
  }

  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, state.activeEnvironmentId),
    threadId,
    (thread) => {
      if (thread.error === error) return thread;
      return { ...thread, error };
    },
  );
  return commitEnvironmentState(state, state.activeEnvironmentId, nextEnvironmentState);
}

export function applyOrchestrationEvent(
  state: AppState,
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    applyEnvironmentOrchestrationEvent(
      getStoredEnvironmentState(state, environmentId),
      event,
      environmentId,
    ),
  );
}

export function applyShellEvent(
  state: AppState,
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
): AppState {
  return commitEnvironmentState(
    state,
    environmentId,
    applyEnvironmentShellEvent(
      getStoredEnvironmentState(state, environmentId),
      event,
      environmentId,
    ),
  );
}

export function setActiveEnvironmentId(state: AppState, environmentId: EnvironmentId): AppState {
  if (state.activeEnvironmentId === environmentId) {
    return state;
  }

  return {
    ...state,
    activeEnvironmentId: environmentId,
  };
}

export function removeEnvironmentState(state: AppState, environmentId: EnvironmentId): AppState {
  if (!state.environmentStateById[environmentId] && state.activeEnvironmentId !== environmentId) {
    return state;
  }

  const { [environmentId]: _removed, ...environmentStateById } = state.environmentStateById;
  return {
    ...state,
    activeEnvironmentId:
      state.activeEnvironmentId === environmentId ? null : state.activeEnvironmentId,
    environmentStateById,
  };
}

export function hydrateCachedEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId,
  cachedState: EnvironmentState,
): AppState {
  const currentEnvironmentState = getStoredEnvironmentState(state, environmentId);
  if (
    currentEnvironmentState.bootstrapComplete ||
    currentEnvironmentState.projectIds.length > 0 ||
    currentEnvironmentState.threadIds.length > 0
  ) {
    return state;
  }

  return commitEnvironmentState(state, environmentId, {
    ...cachedState,
    queuedTurnIdsByThreadId: cachedState.queuedTurnIdsByThreadId ?? {},
    queuedTurnByThreadId: cachedState.queuedTurnByThreadId ?? {},
    lastAppliedEventSequenceByThreadId: cachedState.lastAppliedEventSequenceByThreadId ?? {},
    lastAppliedEventIdByThreadId: cachedState.lastAppliedEventIdByThreadId ?? {},
    bootstrapComplete: false,
  });
}

function mergeCachedShellRecord<T>(
  current: Record<ThreadId, T>,
  cached: Record<ThreadId, T>,
  threadIds: readonly ThreadId[],
): Record<ThreadId, T> {
  const merged: Record<string, T> = {};
  for (const threadId of threadIds) {
    if (Object.prototype.hasOwnProperty.call(current, threadId)) {
      merged[threadId] = current[threadId] as T;
    } else if (Object.prototype.hasOwnProperty.call(cached, threadId)) {
      merged[threadId] = cached[threadId] as T;
    }
  }
  return merged as Record<ThreadId, T>;
}

/**
 * Restores a complete IndexedDB sidebar shell over a compact synchronous shell. The caller must
 * verify that both records share the same shell revision before invoking this merge.
 */
export function hydrateCachedEnvironmentShellState(
  state: AppState,
  environmentId: EnvironmentId,
  cachedState: EnvironmentState,
): AppState {
  const current = getStoredEnvironmentState(state, environmentId);
  if (
    current.bootstrapComplete ||
    (current.projectIds.length === 0 && current.threadIds.length === 0)
  ) {
    return state;
  }

  const projectIds = appendMissingCacheIds(
    cachedState.projectIds.filter((projectId) => cachedState.projectById[projectId] !== undefined),
    current.projectIds.filter((projectId) => current.projectById[projectId] !== undefined),
  );
  const projectById = Object.fromEntries(
    projectIds.map((projectId) => [
      projectId,
      current.projectById[projectId] ?? cachedState.projectById[projectId],
    ]),
  ) as EnvironmentState["projectById"];
  const threadIds = appendMissingCacheIds(
    cachedState.threadIds.filter((threadId) => cachedState.threadShellById[threadId] !== undefined),
    current.threadIds.filter((threadId) => current.threadShellById[threadId] !== undefined),
  );
  const retainedProjectIds = new Set(projectIds);
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const threadId of threadIds) {
    const projectId =
      current.threadShellById[threadId]?.projectId ??
      cachedState.threadShellById[threadId]?.projectId;
    if (!projectId || !retainedProjectIds.has(projectId)) {
      continue;
    }
    threadIdsByProjectId[projectId] = [...(threadIdsByProjectId[projectId] ?? []), threadId];
  }

  return commitEnvironmentState(state, environmentId, {
    ...current,
    projectIds,
    projectById,
    threadIds,
    threadIdsByProjectId: threadIdsByProjectId as EnvironmentState["threadIdsByProjectId"],
    threadShellById: mergeCachedShellRecord(
      current.threadShellById,
      cachedState.threadShellById,
      threadIds,
    ),
    threadSessionById: mergeCachedShellRecord(
      current.threadSessionById,
      cachedState.threadSessionById,
      threadIds,
    ),
    threadTurnStateById: mergeCachedShellRecord(
      current.threadTurnStateById,
      cachedState.threadTurnStateById,
      threadIds,
    ),
    sidebarThreadSummaryById: mergeCachedShellRecord(
      current.sidebarThreadSummaryById,
      cachedState.sidebarThreadSummaryById,
      threadIds,
    ),
    bootstrapComplete: false,
  });
}

function appendMissingCacheIds<Id extends string>(
  existingIds: readonly Id[],
  incomingIds: readonly Id[],
): Id[] {
  const mergedIds = [...existingIds];
  const seen = new Set<Id>(existingIds);
  for (const id of incomingIds) {
    if (!seen.has(id)) {
      seen.add(id);
      mergedIds.push(id);
    }
  }
  return mergedIds;
}

function hasCachedThreadDetail(state: EnvironmentState, threadId: ThreadId): boolean {
  return (
    (state.messageIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.queuedTurnIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.activityIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.proposedPlanIdsByThreadId[threadId]?.length ?? 0) > 0 ||
    (state.turnDiffIdsByThreadId[threadId]?.length ?? 0) > 0
  );
}

function mergeCachedThreadRecord<T>(
  current: Record<ThreadId, T>,
  cached: Record<ThreadId, T>,
  hydratedThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  const merged = { ...current };
  for (const threadId of hydratedThreadIds) {
    if (Object.prototype.hasOwnProperty.call(cached, threadId)) {
      merged[threadId] = cached[threadId] as T;
    }
  }
  return merged;
}

function mergeCachedThreadIdRecord<Id extends string>(
  current: Record<ThreadId, Id[]>,
  cached: Record<ThreadId, Id[]>,
  hydratedThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, Id[]> {
  const merged = { ...current };
  for (const threadId of hydratedThreadIds) {
    merged[threadId] = appendMissingCacheIds(cached[threadId] ?? [], current[threadId] ?? []);
  }
  return merged;
}

function mergeCachedThreadEntityRecord<Id extends string, Entity>(
  current: Record<ThreadId, Record<Id, Entity>>,
  cached: Record<ThreadId, Record<Id, Entity>>,
  hydratedThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, Record<Id, Entity>> {
  const merged = { ...current };
  for (const threadId of hydratedThreadIds) {
    merged[threadId] = {
      ...cached[threadId],
      ...current[threadId],
    } as Record<Id, Entity>;
  }
  return merged;
}

/**
 * IndexedDB detail arrives asynchronously after the synchronous local startup projection. Only
 * fill detail that is still absent, and never race an authoritative live bootstrap.
 */
export function hydrateCachedEnvironmentDetailState(
  state: AppState,
  environmentId: EnvironmentId,
  cachedState: EnvironmentState,
): AppState {
  const current = getStoredEnvironmentState(state, environmentId);
  if (current.bootstrapComplete) {
    return state;
  }
  if (current.projectIds.length === 0 && current.threadIds.length === 0) {
    return state;
  }

  const currentThreadIds = new Set(current.threadIds);
  const hydratedThreadIds = new Set(
    cachedState.threadIds.filter((threadId) => {
      if (!currentThreadIds.has(threadId) || !hasCachedThreadDetail(cachedState, threadId)) {
        return false;
      }
      if (!hasCachedThreadDetail(current, threadId)) {
        return true;
      }
      const currentSequence = current.lastAppliedEventSequenceByThreadId?.[threadId];
      const cachedSequence = cachedState.lastAppliedEventSequenceByThreadId?.[threadId];
      return (
        currentSequence !== undefined &&
        cachedSequence !== undefined &&
        cachedSequence >= currentSequence
      );
    }),
  );
  const nextEnvironmentState: EnvironmentState = {
    ...current,
    messageIdsByThreadId: mergeCachedThreadIdRecord(
      current.messageIdsByThreadId,
      cachedState.messageIdsByThreadId,
      hydratedThreadIds,
    ),
    messageByThreadId: mergeCachedThreadEntityRecord(
      current.messageByThreadId,
      cachedState.messageByThreadId,
      hydratedThreadIds,
    ),
    queuedTurnIdsByThreadId: mergeCachedThreadIdRecord(
      current.queuedTurnIdsByThreadId,
      cachedState.queuedTurnIdsByThreadId,
      hydratedThreadIds,
    ),
    queuedTurnByThreadId: mergeCachedThreadEntityRecord(
      current.queuedTurnByThreadId,
      cachedState.queuedTurnByThreadId,
      hydratedThreadIds,
    ),
    activityIdsByThreadId: mergeCachedThreadIdRecord(
      current.activityIdsByThreadId,
      cachedState.activityIdsByThreadId,
      hydratedThreadIds,
    ),
    activityByThreadId: mergeCachedThreadEntityRecord(
      current.activityByThreadId,
      cachedState.activityByThreadId,
      hydratedThreadIds,
    ),
    proposedPlanIdsByThreadId: mergeCachedThreadIdRecord(
      current.proposedPlanIdsByThreadId,
      cachedState.proposedPlanIdsByThreadId,
      hydratedThreadIds,
    ),
    proposedPlanByThreadId: mergeCachedThreadEntityRecord(
      current.proposedPlanByThreadId,
      cachedState.proposedPlanByThreadId,
      hydratedThreadIds,
    ),
    turnDiffIdsByThreadId: mergeCachedThreadIdRecord(
      current.turnDiffIdsByThreadId,
      cachedState.turnDiffIdsByThreadId,
      hydratedThreadIds,
    ),
    turnDiffSummaryByThreadId: mergeCachedThreadEntityRecord(
      current.turnDiffSummaryByThreadId,
      cachedState.turnDiffSummaryByThreadId,
      hydratedThreadIds,
    ),
    threadDetailPageInfoByThreadId: mergeCachedThreadRecord(
      current.threadDetailPageInfoByThreadId,
      cachedState.threadDetailPageInfoByThreadId,
      hydratedThreadIds,
    ),
    lastAppliedEventSequenceByThreadId: mergeCachedThreadRecord(
      current.lastAppliedEventSequenceByThreadId ?? {},
      cachedState.lastAppliedEventSequenceByThreadId ?? {},
      hydratedThreadIds,
    ),
    lastAppliedEventIdByThreadId: mergeCachedThreadRecord(
      current.lastAppliedEventIdByThreadId ?? {},
      cachedState.lastAppliedEventIdByThreadId ?? {},
      hydratedThreadIds,
    ),
    bootstrapComplete: false,
  };

  return commitEnvironmentState(state, environmentId, nextEnvironmentState);
}

export function setThreadBranch(
  state: AppState,
  threadRef: ScopedThreadRef,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const nextEnvironmentState = updateThreadState(
    getStoredEnvironmentState(state, threadRef.environmentId),
    threadRef.threadId,
    (thread) => {
      if (thread.branch === branch && thread.worktreePath === worktreePath) return thread;
      const cwdChanged = thread.worktreePath !== worktreePath;
      return {
        ...thread,
        branch,
        worktreePath,
        ...(cwdChanged ? { session: null } : {}),
      };
    },
  );
  return commitEnvironmentState(state, threadRef.environmentId, nextEnvironmentState);
}

interface AppStore extends AppState {
  setAccountRateLimitsByInstanceId: (limits: AppState["accountRateLimitsByInstanceId"]) => void;
  setActiveEnvironmentId: (environmentId: EnvironmentId) => void;
  removeEnvironmentState: (environmentId: EnvironmentId) => void;
  hydrateCachedEnvironmentState: (
    environmentId: EnvironmentId,
    cachedState: EnvironmentState,
  ) => void;
  hydrateCachedEnvironmentShellState: (
    environmentId: EnvironmentId,
    cachedState: EnvironmentState,
  ) => void;
  hydrateCachedEnvironmentDetailState: (
    environmentId: EnvironmentId,
    cachedState: EnvironmentState,
  ) => void;
  syncServerShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  syncServerThreadDetail: (
    thread: OrchestrationThread,
    environmentId: EnvironmentId,
    options?: ThreadDetailWriteOptions,
  ) => void;
  mergeServerThreadDetailTailSnapshot: (
    thread: OrchestrationThread,
    environmentId: EnvironmentId,
    options?: ThreadDetailWriteOptions,
  ) => void;
  mergeServerThreadDetailPage: (
    snapshot: OrchestrationThreadDetailSnapshot,
    environmentId: EnvironmentId,
    options?: ThreadDetailPageMergeOptions,
  ) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent, environmentId: EnvironmentId) => void;
  applyOrchestrationEvents: (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
    options?: ThreadDetailWriteOptions,
  ) => void;
  syncSidebarThreadSummariesForEnvironment: (environmentId: EnvironmentId) => void;
  applyShellEvent: (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (
    threadRef: ScopedThreadRef,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  setAccountRateLimitsByInstanceId: (limits) => set({ accountRateLimitsByInstanceId: limits }),
  setActiveEnvironmentId: (environmentId) =>
    set((state) => setActiveEnvironmentId(state, environmentId)),
  removeEnvironmentState: (environmentId) =>
    set((state) => removeEnvironmentState(state, environmentId)),
  hydrateCachedEnvironmentState: (environmentId, cachedState) =>
    set((state) => hydrateCachedEnvironmentState(state, environmentId, cachedState)),
  hydrateCachedEnvironmentShellState: (environmentId, cachedState) =>
    set((state) => hydrateCachedEnvironmentShellState(state, environmentId, cachedState)),
  hydrateCachedEnvironmentDetailState: (environmentId, cachedState) =>
    set((state) => hydrateCachedEnvironmentDetailState(state, environmentId, cachedState)),
  syncServerShellSnapshot: (snapshot, environmentId) =>
    set((state) => syncServerShellSnapshot(state, snapshot, environmentId)),
  syncServerThreadDetail: (thread, environmentId, options) =>
    set((state) => syncServerThreadDetail(state, thread, environmentId, options)),
  mergeServerThreadDetailTailSnapshot: (thread, environmentId, options) =>
    set((state) => mergeServerThreadDetailTailSnapshot(state, thread, environmentId, options)),
  mergeServerThreadDetailPage: (snapshot, environmentId, options) =>
    set((state) => mergeServerThreadDetailPage(state, snapshot, environmentId, options)),
  applyOrchestrationEvent: (event, environmentId) =>
    set((state) => applyOrchestrationEvent(state, event, environmentId)),
  applyOrchestrationEvents: (events, environmentId, options) =>
    set((state) => applyOrchestrationEvents(state, events, environmentId, options)),
  syncSidebarThreadSummariesForEnvironment: (environmentId) =>
    set((state) => syncSidebarThreadSummariesForEnvironment(state, environmentId)),
  applyShellEvent: (event, environmentId) =>
    set((state) => applyShellEvent(state, event, environmentId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadRef, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadRef, branch, worktreePath)),
}));
