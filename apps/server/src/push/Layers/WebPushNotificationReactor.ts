import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProviderRuntimeEvent,
  ServerPushNotificationPayload,
  ServerPushUnreadCompletionState,
  ThreadId,
  TurnId,
} from "@salchi/contracts";
import { makeDrainableWorker } from "@salchi/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadQueuedTurnRepositoryLive } from "../../persistence/Layers/ProjectionThreadQueuedTurns.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ProjectionThreadQueuedTurnRepository } from "../../persistence/Services/ProjectionThreadQueuedTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  WebPushNotificationReactor,
  type WebPushNotificationReactorShape,
} from "../Services/WebPushNotificationReactor.ts";
import { WebPushService } from "../Services/WebPushService.ts";

type NotificationEvent =
  | Extract<OrchestrationEvent, { type: "thread.activity-appended" | "thread.turn-diff-completed" }>
  | Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;

export type RuntimeContentTrackingEvent = Pick<
  ProviderRuntimeEvent,
  "eventId" | "itemId" | "threadId" | "turnId"
>;

interface RuntimeTurnNotificationContent {
  readonly contentByMessageKey: Map<string, string>;
  readonly segmentIndexByBaseKey: Map<string, number>;
  latestMessageKey: string | null;
  activeBaseKey: string | null;
}

interface NotificationWorkItem {
  readonly event: NotificationEvent;
  readonly hasPendingQueuedWorkAtCompletion: boolean;
}

export interface QueuedTurnNotificationTracker {
  readonly trackQueued: (threadId: ThreadId, messageId: string) => void;
  readonly trackRemoved: (threadId: ThreadId, messageId: string) => void;
  readonly trackPromoted: (threadId: ThreadId, messageId: string) => void;
  readonly trackTurnStarted: (threadId: ThreadId) => void;
  readonly trackTurnStartFailed: (threadId: ThreadId) => void;
  readonly clearThread: (threadId: ThreadId) => void;
  readonly hasPendingQueuedWork: (threadId: ThreadId) => boolean;
}

export interface LatestProjectedThreadContent {
  readonly content: string | null;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
}

const TRACKED_RUNTIME_CONTENT_MAX_CHARS = 4_000;
const INTERRUPTED_ACTION_BODY = "Agent interrupted. Open Salchi to choose the next action.";
const EMPTY_ENGAGED_THREAD_IDS: ReadonlySet<ThreadId> = new Set();
const THREAD_NOTIFICATION_DETAIL_PAGE = {
  limits: {
    messages: 16,
    proposedPlans: 1,
    activities: 1,
    checkpoints: 1,
  },
} as const;
const CANONICAL_COMPLETION_RETRY_COUNT = 40;
const CANONICAL_COMPLETION_RETRY_DELAY_MS = 50;

export function createQueuedTurnNotificationTracker(): QueuedTurnNotificationTracker {
  const queuedMessageIdsByThreadId = new Map<ThreadId, Set<string>>();
  const promotedQueuedTurnThreadIds = new Set<ThreadId>();

  const trackQueued = (threadId: ThreadId, messageId: string): void => {
    const queuedMessageIds = queuedMessageIdsByThreadId.get(threadId) ?? new Set<string>();
    queuedMessageIds.add(messageId);
    queuedMessageIdsByThreadId.set(threadId, queuedMessageIds);
  };

  const trackRemoved = (threadId: ThreadId, messageId: string): void => {
    const queuedMessageIds = queuedMessageIdsByThreadId.get(threadId);
    if (queuedMessageIds === undefined) {
      return;
    }
    queuedMessageIds.delete(messageId);
    if (queuedMessageIds.size === 0) {
      queuedMessageIdsByThreadId.delete(threadId);
    }
  };

  const trackPromoted = (threadId: ThreadId, messageId: string): void => {
    trackRemoved(threadId, messageId);
    promotedQueuedTurnThreadIds.add(threadId);
  };

  const trackTurnStarted = (threadId: ThreadId): void => {
    promotedQueuedTurnThreadIds.delete(threadId);
  };

  const clearThread = (threadId: ThreadId): void => {
    queuedMessageIdsByThreadId.delete(threadId);
    promotedQueuedTurnThreadIds.delete(threadId);
  };

  return {
    trackQueued,
    trackRemoved,
    trackPromoted,
    trackTurnStarted,
    trackTurnStartFailed: trackTurnStarted,
    clearThread,
    hasPendingQueuedWork: (threadId) =>
      (queuedMessageIdsByThreadId.get(threadId)?.size ?? 0) > 0 ||
      promotedQueuedTurnThreadIds.has(threadId),
  };
}

function threadUrl(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function notificationThreadId(event: NotificationEvent): ThreadId {
  return event.type === "turn.completed" ? event.threadId : event.payload.threadId;
}

function normalizeNotificationText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeManualStopReason(value: string | null | undefined): string | null {
  const normalized =
    normalizeNotificationText(value)
      ?.toLowerCase()
      .replace(/[.!]+$/g, "") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function isManualStopReason(value: string | null | undefined): boolean {
  const normalized = normalizeManualStopReason(value);
  if (normalized === null) {
    return false;
  }
  return (
    normalized === "session stopped" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized.includes("user cancelled") ||
    normalized.includes("user canceled")
  );
}

function threadTurnKey(threadId: ThreadId, turnId: TurnId | undefined): string {
  return `${threadId}:${turnId ?? "unknown"}`;
}

function runtimeMessageBaseKey(
  event: Pick<ProviderRuntimeEvent, "eventId" | "itemId" | "turnId">,
): string {
  if (event.itemId !== undefined) {
    return `item:${event.itemId}`;
  }
  if (event.turnId !== undefined) {
    return `turn:${event.turnId}`;
  }
  return `event:${event.eventId}`;
}

function runtimeSegmentedMessageKey(
  content: RuntimeTurnNotificationContent,
  baseKey: string,
): string {
  const segmentIndex = content.segmentIndexByBaseKey.get(baseKey) ?? 0;
  return segmentIndex === 0 ? baseKey : `${baseKey}:segment:${segmentIndex}`;
}

function truncateTrackedRuntimeContent(value: string): string {
  return value.length > TRACKED_RUNTIME_CONTENT_MAX_CHARS
    ? value.slice(0, TRACKED_RUNTIME_CONTENT_MAX_CHARS)
    : value;
}

function getOrCreateRuntimeTurnNotificationContent(
  existing: RuntimeTurnNotificationContent | undefined,
): RuntimeTurnNotificationContent {
  return (
    existing ?? {
      contentByMessageKey: new Map<string, string>(),
      segmentIndexByBaseKey: new Map<string, number>(),
      latestMessageKey: null,
      activeBaseKey: null,
    }
  );
}

function appendTrackedRuntimeMessageContent(
  existing: RuntimeTurnNotificationContent | undefined,
  event: RuntimeContentTrackingEvent,
  delta: string,
): RuntimeTurnNotificationContent {
  const content = getOrCreateRuntimeTurnNotificationContent(existing);
  const baseKey = runtimeMessageBaseKey(event);
  const messageKey = runtimeSegmentedMessageKey(content, baseKey);
  content.contentByMessageKey.set(
    messageKey,
    truncateTrackedRuntimeContent(`${content.contentByMessageKey.get(messageKey) ?? ""}${delta}`),
  );
  content.latestMessageKey = messageKey;
  content.activeBaseKey = baseKey;
  return content;
}

function setTrackedRuntimeMessageContent(
  existing: RuntimeTurnNotificationContent | undefined,
  event: RuntimeContentTrackingEvent,
  text: string,
): RuntimeTurnNotificationContent {
  const content = getOrCreateRuntimeTurnNotificationContent(existing);
  const baseKey = runtimeMessageBaseKey(event);
  const messageKey = runtimeSegmentedMessageKey(content, baseKey);
  content.contentByMessageKey.set(messageKey, truncateTrackedRuntimeContent(text));
  content.latestMessageKey = messageKey;
  content.activeBaseKey = baseKey;
  return content;
}

function trackRuntimeContentDelta(
  runtimeContentByTurn: Map<string, RuntimeTurnNotificationContent>,
  event: RuntimeContentTrackingEvent,
  delta: string,
): void {
  const key = threadTurnKey(event.threadId, event.turnId);
  runtimeContentByTurn.set(
    key,
    appendTrackedRuntimeMessageContent(runtimeContentByTurn.get(key), event, delta),
  );
}

function trackRuntimeMessageContent(
  runtimeContentByTurn: Map<string, RuntimeTurnNotificationContent>,
  event: RuntimeContentTrackingEvent,
  text: string,
): void {
  const key = threadTurnKey(event.threadId, event.turnId);
  runtimeContentByTurn.set(
    key,
    setTrackedRuntimeMessageContent(runtimeContentByTurn.get(key), event, text),
  );
}

function markRuntimeAssistantBoundary(
  runtimeContentByTurn: Map<string, RuntimeTurnNotificationContent>,
  event: RuntimeContentTrackingEvent,
): void {
  const key = threadTurnKey(event.threadId, event.turnId);
  const content = runtimeContentByTurn.get(key);
  if (content?.activeBaseKey === null || content?.activeBaseKey === undefined) {
    return;
  }
  const nextSegmentIndex = (content.segmentIndexByBaseKey.get(content.activeBaseKey) ?? 0) + 1;
  content.segmentIndexByBaseKey.set(content.activeBaseKey, nextSegmentIndex);
  content.activeBaseKey = null;
}

function takeTrackedRuntimeThreadContent(
  runtimeContentByTurn: Map<string, RuntimeTurnNotificationContent>,
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
): string | null {
  const key = threadTurnKey(event.threadId, event.turnId);
  const content = runtimeContentByTurn.get(key) ?? null;
  runtimeContentByTurn.delete(key);
  if (content?.latestMessageKey === null || content?.latestMessageKey === undefined) {
    return null;
  }
  return normalizeNotificationText(content.contentByMessageKey.get(content.latestMessageKey));
}

export function createRuntimeNotificationContentTrackerForTest() {
  const runtimeContentByTurn = new Map<string, RuntimeTurnNotificationContent>();
  return {
    appendDelta: (event: RuntimeContentTrackingEvent, delta: string) => {
      trackRuntimeContentDelta(runtimeContentByTurn, event, delta);
    },
    setMessage: (event: RuntimeContentTrackingEvent, text: string) => {
      trackRuntimeMessageContent(runtimeContentByTurn, event, text);
    },
    markBoundary: (event: RuntimeContentTrackingEvent) => {
      markRuntimeAssistantBoundary(runtimeContentByTurn, event);
    },
    messageKeys: (event: RuntimeContentTrackingEvent) =>
      Array.from(
        runtimeContentByTurn
          .get(threadTurnKey(event.threadId, event.turnId))
          ?.contentByMessageKey.keys() ?? [],
      ),
    take: (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      takeTrackedRuntimeThreadContent(runtimeContentByTurn, event),
  };
}

function latestMessageNotificationContent(
  message: OrchestrationMessage | undefined,
): string | null {
  const text = normalizeNotificationText(message?.text);
  if (text !== null) {
    return text;
  }
  const attachmentCount = message?.attachments?.length ?? 0;
  if (attachmentCount === 1) {
    return "Attachment";
  }
  if (attachmentCount > 1) {
    return `${attachmentCount} attachments`;
  }
  return null;
}

function latestProjectedThreadContent(
  message: OrchestrationMessage | undefined,
): LatestProjectedThreadContent | null {
  if (message === undefined) {
    return null;
  }
  return {
    content: latestMessageNotificationContent(message),
    turnId: message.turnId,
    streaming: message.streaming,
  };
}

export function selectLatestThreadContentForTurnCompletion(input: {
  readonly event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
  readonly runtimeContent: string | null;
  readonly projectedContent: LatestProjectedThreadContent | null;
}): string | null {
  const runtimeBody = normalizeNotificationText(input.runtimeContent);
  if (runtimeBody !== null) {
    return runtimeBody;
  }
  const projectedBody = normalizeNotificationText(input.projectedContent?.content);
  return projectedBody;
}

export function selectProjectedThreadContentForTurnCompletion(input: {
  readonly event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
  readonly thread: Pick<OrchestrationThread, "latestTurn" | "messages">;
}): LatestProjectedThreadContent | null {
  const latestTurn = input.thread.latestTurn;
  const latestTurnAssistantMessage =
    latestTurn !== null && latestTurn.turnId === input.event.turnId
      ? latestTurn.assistantMessageId
      : null;
  const message =
    latestTurnAssistantMessage !== null
      ? input.thread.messages.find((entry) => entry.id === latestTurnAssistantMessage)
      : undefined;
  return latestProjectedThreadContent(message ?? input.thread.messages.at(-1));
}

function fallbackNotificationContent(event: NotificationEvent): string | null {
  switch (event.type) {
    case "thread.activity-appended":
      return normalizeNotificationText(event.payload.activity.summary);

    case "thread.turn-diff-completed":
      return null;

    case "turn.completed":
      return "Agent turn completed";
  }
}

function turnCompletionNotificationBody(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  latestThreadContent: string | null,
): string | null {
  switch (event.payload.state) {
    case "completed":
      return normalizeNotificationText(latestThreadContent) ?? "Agent turn completed";

    case "failed":
      return (
        normalizeNotificationText(event.payload.errorMessage) ??
        normalizeNotificationText(latestThreadContent) ??
        "Agent turn finished with errors"
      );

    case "cancelled":
      return null;

    case "interrupted":
      return isManualStopReason(event.payload.errorMessage) ||
        isManualStopReason(event.payload.stopReason)
        ? null
        : INTERRUPTED_ACTION_BODY;
  }
}

export function isManualStopTurnCompletion(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  thread: Option.Option<OrchestrationThreadShell>,
): boolean {
  if (event.payload.state === "cancelled") {
    return true;
  }
  if (Option.isSome(thread) && thread.value.session?.status === "stopped") {
    return true;
  }
  return (
    event.payload.state === "interrupted" &&
    (isManualStopReason(event.payload.errorMessage) || isManualStopReason(event.payload.stopReason))
  );
}

function isMaterializedSubagentChildThread(thread: OrchestrationThreadShell): boolean {
  return thread.parentThreadId !== null && thread.subagentKind === "thread_spawn";
}

function isThreadUserEngaged(
  thread: OrchestrationThreadShell,
  engagedThreadIds: ReadonlySet<ThreadId>,
): boolean {
  return thread.latestUserMessageAt !== null || engagedThreadIds.has(thread.id);
}

function shouldSuppressUnengagedSubagentCompletion(input: {
  readonly event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
  readonly thread: Option.Option<OrchestrationThreadShell>;
  readonly engagedThreadIds: ReadonlySet<ThreadId>;
}): boolean {
  if (input.event.payload.state !== "completed" || Option.isNone(input.thread)) {
    return false;
  }

  const thread = input.thread.value;
  return (
    isMaterializedSubagentChildThread(thread) &&
    !isThreadUserEngaged(thread, input.engagedThreadIds)
  );
}

export function shouldNotifyRuntimeTurnCompletion(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  thread: Option.Option<OrchestrationThreadShell>,
  options?: {
    readonly engagedThreadIds?: ReadonlySet<ThreadId>;
    readonly hasPendingQueuedWork?: boolean;
  },
): boolean {
  if (isManualStopTurnCompletion(event, thread)) {
    return false;
  }
  if (options?.hasPendingQueuedWork === true) {
    return false;
  }
  const engagedThreadIds = options?.engagedThreadIds ?? EMPTY_ENGAGED_THREAD_IDS;
  if (
    shouldSuppressUnengagedSubagentCompletion({
      event,
      thread,
      engagedThreadIds,
    })
  ) {
    return false;
  }
  if (Option.isNone(thread)) {
    return true;
  }
  const activeTurnId = thread.value.session?.activeTurnId ?? null;
  return activeTurnId === null || event.turnId === undefined || activeTurnId === event.turnId;
}

export function deriveWebPushPayloadForEvent(input: {
  readonly event: NotificationEvent;
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly latestThreadContent: string | null;
  readonly unreadCompletionState?: ServerPushUnreadCompletionState;
  readonly useCompletionAttentionProtocol?: boolean;
}): ServerPushNotificationPayload | null {
  const threadId = notificationThreadId(input.event);
  const url = threadUrl(input.environmentId, threadId);

  switch (input.event.type) {
    case "thread.activity-appended": {
      const activity = input.event.payload.activity;
      const body =
        normalizeNotificationText(input.latestThreadContent) ??
        fallbackNotificationContent(input.event);
      if (activity.kind === "approval.requested") {
        return {
          title: input.threadTitle,
          ...(body ? { body } : {}),
          url,
          tag: `thread:${input.event.payload.threadId}:approval:${activity.id}`,
        };
      }
      if (activity.kind === "user-input.requested") {
        return {
          title: input.threadTitle,
          ...(body ? { body } : {}),
          url,
          tag: `thread:${input.event.payload.threadId}:input:${activity.id}`,
        };
      }
      return null;
    }

    case "thread.turn-diff-completed":
      return null;

    case "turn.completed":
      const body = turnCompletionNotificationBody(input.event, input.latestThreadContent);
      if (body === null) {
        return null;
      }
      return {
        title: input.threadTitle,
        body,
        url,
        tag: `thread:${input.event.threadId}:turn:${input.event.turnId ?? input.event.eventId}`,
        ...(!input.useCompletionAttentionProtocol || input.unreadCompletionState
          ? {
              completion: {
                environmentId: input.environmentId,
                threadId: input.event.threadId,
                completionId: input.event.turnId ?? input.event.eventId,
              },
            }
          : {}),
        ...(input.unreadCompletionState
          ? { unreadCompletionState: input.unreadCompletionState }
          : {}),
        ...(input.useCompletionAttentionProtocol ? { completionAttentionVersion: 2 as const } : {}),
      };
  }
}

function isEligibleCompletionThread(thread: OrchestrationThreadShell): boolean {
  return (
    !thread.hiddenFromThreadList &&
    thread.archivedAt === null &&
    thread.latestTurn !== null &&
    thread.latestTurn.completedAt !== null &&
    (thread.latestTurn.state === "completed" || thread.latestTurn.state === "error")
  );
}

export function deriveUnreadCompletionState(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}): ServerPushUnreadCompletionState {
  let count = 0;
  for (const thread of input.snapshot.threads) {
    if (
      isEligibleCompletionThread(thread) &&
      thread.seenCompletionTurnId !== thread.latestTurn?.turnId
    ) {
      count += 1;
    }
  }
  return {
    environmentId: input.environmentId,
    sequence: input.snapshot.completionAttentionSequence ?? input.snapshot.snapshotSequence,
    count,
  };
}

export const makeWebPushNotificationReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const push = yield* WebPushService;
  const serverEnvironment = yield* ServerEnvironment;
  const queuedTurnRepository = yield* ProjectionThreadQueuedTurnRepository;
  const runtimeContentByTurn = new Map<string, RuntimeTurnNotificationContent>();
  const userEngagedThreadIds = new Set<ThreadId>();
  const queuedTurnNotificationTracker = createQueuedTurnNotificationTracker();

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.catch(() => Effect.succeed(Option.none<OrchestrationThreadShell>())));

  const resolveCanonicalUnreadCompletionState = (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
    environmentId: EnvironmentId,
    initialThread: Option.Option<OrchestrationThreadShell>,
  ): Effect.Effect<ServerPushUnreadCompletionState | null> => {
    const expectedTurnId =
      event.turnId ??
      Option.match(initialThread, {
        onNone: () => null,
        onSome: (thread) => thread.session?.activeTurnId ?? null,
      });
    if (expectedTurnId === null) {
      return Effect.succeed(null);
    }

    const attempt = (
      remainingAttempts: number,
    ): Effect.Effect<ServerPushUnreadCompletionState | null, ProjectionRepositoryError> =>
      Effect.gen(function* () {
        const projectedThread = yield* resolveThread(event.threadId);
        if (Option.isSome(projectedThread)) {
          const latestTurn = projectedThread.value.latestTurn;
          if (
            latestTurn?.turnId === expectedTurnId &&
            latestTurn.completedAt !== null &&
            (latestTurn.state === "completed" || latestTurn.state === "error")
          ) {
            const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
            const snapshotThread = snapshot.threads.find((thread) => thread.id === event.threadId);
            if (
              snapshotThread?.latestTurn?.turnId === expectedTurnId &&
              isEligibleCompletionThread(snapshotThread)
            ) {
              return deriveUnreadCompletionState({ environmentId, snapshot });
            }
          }
        }

        if (remainingAttempts <= 1) {
          return null;
        }
        yield* Effect.sleep(CANONICAL_COMPLETION_RETRY_DELAY_MS);
        return yield* attempt(remainingAttempts - 1);
      });

    return attempt(CANONICAL_COMPLETION_RETRY_COUNT).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to reconcile completion before web push", {
          threadId: event.threadId,
          turnId: expectedTurnId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
  };

  const resolveLatestProjectedThreadContent = (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) =>
    projectionSnapshotQuery
      .getThreadDetailSnapshotById(event.threadId, THREAD_NOTIFICATION_DETAIL_PAGE)
      .pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (snapshot) =>
              selectProjectedThreadContentForTurnCompletion({
                event,
                thread: snapshot.thread,
              }),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to resolve web push notification body", {
            threadId: event.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );

  const takeRuntimeThreadContent = (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) =>
    Effect.sync(() => {
      return takeTrackedRuntimeThreadContent(runtimeContentByTurn, event);
    });

  const resolveLatestThreadContent = (event: NotificationEvent): Effect.Effect<string | null> => {
    if (event.type === "thread.activity-appended") {
      return Effect.succeed(normalizeNotificationText(event.payload.activity.summary));
    }
    if (event.type !== "turn.completed") {
      return Effect.succeed(null);
    }
    return Effect.gen(function* () {
      const runtimeContent = yield* takeRuntimeThreadContent(event);
      const projectedContent = yield* resolveLatestProjectedThreadContent(event);
      return selectLatestThreadContentForTurnCompletion({
        event,
        runtimeContent,
        projectedContent,
      });
    });
  };

  const processEvent = Effect.fn("processWebPushNotificationEvent")(function* (
    workItem: NotificationWorkItem,
  ) {
    const { event } = workItem;
    const threadId = notificationThreadId(event);
    const [environment, thread] = yield* Effect.all([
      serverEnvironment.getDescriptor,
      resolveThread(threadId),
    ]);
    if (
      event.type === "turn.completed" &&
      !shouldNotifyRuntimeTurnCompletion(event, thread, {
        engagedThreadIds: userEngagedThreadIds,
        hasPendingQueuedWork: workItem.hasPendingQueuedWorkAtCompletion,
      })
    ) {
      yield* takeRuntimeThreadContent(event).pipe(Effect.asVoid);
      return;
    }
    const threadTitle = Option.match(thread, {
      onNone: () => "Salchi thread",
      onSome: (threadShell) => threadShell.title,
    });
    const latestThreadContent = yield* resolveLatestThreadContent(event);
    const shouldTrackCompletion =
      event.type === "turn.completed" &&
      (event.payload.state === "completed" || event.payload.state === "failed");
    const unreadCompletionState = shouldTrackCompletion
      ? yield* resolveCanonicalUnreadCompletionState(event, environment.environmentId, thread)
      : undefined;
    if (shouldTrackCompletion && unreadCompletionState === null) {
      yield* Effect.logWarning("sending completion web push without unread reconciliation", {
        threadId: event.threadId,
        turnId: event.turnId,
      });
    }
    const payload = deriveWebPushPayloadForEvent({
      event,
      environmentId: environment.environmentId,
      threadTitle,
      latestThreadContent,
      ...(unreadCompletionState ? { unreadCompletionState } : {}),
      ...(event.type === "turn.completed" ? { useCompletionAttentionProtocol: true } : {}),
    });
    if (payload === null) {
      return;
    }
    yield* push.sendToActiveSubscriptions({ payload }).pipe(
      Effect.tap((result) =>
        result.failedCount > 0
          ? Effect.logWarning("web push notification had delivery failures", {
              sentCount: result.sentCount,
              failedCount: result.failedCount,
              eventType: event.type,
              threadId,
            })
          : Effect.void,
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("web push notification reactor failed to send", {
          eventType: event.type,
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const worker = yield* makeDrainableWorker(processEvent);

  const trackQueuedTurnDomainEvent = (event: OrchestrationEvent): void => {
    switch (event.type) {
      case "thread.turn-queued":
        queuedTurnNotificationTracker.trackQueued(event.payload.threadId, event.payload.messageId);
        return;
      case "thread.queued-turn-cancelled":
      case "thread.queued-turn-steered":
        queuedTurnNotificationTracker.trackRemoved(event.payload.threadId, event.payload.messageId);
        return;
      case "thread.queued-turn-dispatched":
        queuedTurnNotificationTracker.trackPromoted(
          event.payload.threadId,
          event.payload.messageId,
        );
        return;
      case "thread.activity-appended":
        if (event.payload.activity.kind === "provider.turn.start.failed") {
          queuedTurnNotificationTracker.trackTurnStartFailed(event.payload.threadId);
        }
        return;
      case "thread.archived":
      case "thread.deleted":
        queuedTurnNotificationTracker.clearThread(event.payload.threadId);
        return;
      default:
        return;
    }
  };

  const hasPendingQueuedWork = (threadId: ThreadId): Effect.Effect<boolean> =>
    queuedTurnRepository.getOldestByThreadId({ threadId }).pipe(
      Effect.map(
        (queuedTurn) =>
          Option.isSome(queuedTurn) || queuedTurnNotificationTracker.hasPendingQueuedWork(threadId),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to resolve queued turns for web push notification", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(queuedTurnNotificationTracker.hasPendingQueuedWork(threadId))),
      ),
    );

  return {
    start: Effect.fn("startWebPushNotificationReactor")(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          const trackQueuedTurns = Effect.sync(() => {
            trackQueuedTurnDomainEvent(event);
          });
          if (event.type === "thread.message-sent" && event.payload.role === "user") {
            return trackQueuedTurns.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  userEngagedThreadIds.add(event.payload.threadId);
                }),
              ),
            );
          }
          if (event.type === "thread.turn-queued") {
            return trackQueuedTurns.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  userEngagedThreadIds.add(event.payload.threadId);
                }),
              ),
            );
          }
          if (event.type !== "thread.activity-appended") {
            return trackQueuedTurns;
          }
          return trackQueuedTurns.pipe(
            Effect.andThen(
              worker.enqueue({
                event,
                hasPendingQueuedWorkAtCompletion: false,
              }),
            ),
          );
        }),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => {
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
            return Effect.sync(() => {
              trackRuntimeContentDelta(runtimeContentByTurn, event, event.payload.delta);
            });
          }
          if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
            const detail = normalizeNotificationText(event.payload.detail);
            if (detail !== null) {
              return Effect.sync(() => {
                trackRuntimeMessageContent(runtimeContentByTurn, event, detail);
              });
            }
          }
          if (event.type === "request.opened" || event.type === "user-input.requested") {
            return Effect.sync(() => {
              markRuntimeAssistantBoundary(runtimeContentByTurn, event);
            });
          }
          if (event.type === "turn.started" || event.type === "turn.aborted") {
            return Effect.sync(() => {
              if (event.type === "turn.started") {
                queuedTurnNotificationTracker.trackTurnStarted(event.threadId);
              }
              runtimeContentByTurn.delete(threadTurnKey(event.threadId, event.turnId));
            });
          }
          if (event.type !== "turn.completed") {
            return Effect.void;
          }
          return hasPendingQueuedWork(event.threadId).pipe(
            Effect.flatMap((hasPendingQueuedWorkAtCompletion) =>
              worker.enqueue({ event, hasPendingQueuedWorkAtCompletion }),
            ),
          );
        }),
      );
    }),
    drain: worker.drain,
  };
});

export const WebPushNotificationReactorLive = Layer.effect(
  WebPushNotificationReactor,
  makeWebPushNotificationReactor,
).pipe(Layer.provideMerge(ProjectionThreadQueuedTurnRepositoryLive));

export const WebPushNotificationReactorNoop = Layer.succeed(WebPushNotificationReactor, {
  start: () => Effect.void,
  drain: Effect.void,
} satisfies WebPushNotificationReactorShape);
