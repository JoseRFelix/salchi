import type {
  OrchestrationThread,
  OrchestrationThreadDetailFingerprint,
  OrchestrationThreadDetailPageInfo,
  OrchestrationThreadDetailSnapshot,
} from "@salchi/contracts";

const FINGERPRINT_VERSION = 1 as const;
const TEXT_HASH_SEED = 0x811c9dc5;

const THREAD_DETAIL_FINGERPRINT_TAIL_LIMITS = {
  messages: 100,
  proposedPlans: 20,
  activities: 200,
  checkpoints: 100,
} as const;

export function computeOrchestrationThreadDetailFingerprint(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailFingerprint {
  const parts: string[] = [];
  appendThreadParts(parts, snapshot.thread);
  appendPageInfoParts(parts, snapshot.pageInfo);
  return {
    version: FINGERPRINT_VERSION,
    value: hashStrings(parts),
  };
}

export function orchestrationThreadDetailFingerprintsEqual(
  left: OrchestrationThreadDetailFingerprint | null | undefined,
  right: OrchestrationThreadDetailFingerprint | null | undefined,
): boolean {
  return left?.version === right?.version && left?.value === right?.value;
}

function appendThreadParts(parts: string[], thread: OrchestrationThread): void {
  parts.push("thread", thread.id, thread.updatedAt);

  const latestTurn = thread.latestTurn;
  parts.push(
    "latestTurn",
    latestTurn?.turnId ?? "",
    latestTurn?.state ?? "",
    latestTurn?.startedAt ?? "",
    latestTurn?.completedAt ?? "",
    latestTurn?.assistantMessageId ?? "",
  );

  const session = thread.session;
  parts.push(
    "session",
    session?.status ?? "",
    session?.activeTurnId ?? "",
    session?.updatedAt ?? "",
    session?.lastError ?? "",
  );

  for (const message of tail(thread.messages, THREAD_DETAIL_FINGERPRINT_TAIL_LIMITS.messages)) {
    parts.push(
      "message",
      message.id,
      message.role,
      message.turnId ?? "",
      message.streaming ? "1" : "0",
      message.createdAt,
      message.updatedAt,
      String(message.text.length),
      hashString(message.text),
    );
    for (const attachment of message.attachments ?? []) {
      parts.push(
        "attachment",
        attachment.type,
        attachment.id,
        attachment.name,
        attachment.mimeType,
        String(attachment.sizeBytes),
      );
    }
  }

  for (const queuedTurn of thread.queuedTurns) {
    parts.push(
      "queuedTurn",
      queuedTurn.messageId,
      queuedTurn.role,
      queuedTurn.runtimeMode,
      queuedTurn.interactionMode,
      queuedTurn.createdAt,
      queuedTurn.updatedAt,
      String(queuedTurn.text.length),
      hashString(queuedTurn.text),
    );
    for (const attachment of queuedTurn.attachments) {
      parts.push(
        "queued-attachment",
        attachment.type,
        attachment.id,
        attachment.name,
        attachment.mimeType,
        String(attachment.sizeBytes),
      );
    }
  }

  for (const activity of tail(
    thread.activities,
    THREAD_DETAIL_FINGERPRINT_TAIL_LIMITS.activities,
  )) {
    parts.push(
      "activity",
      activity.id,
      activity.tone,
      activity.kind,
      activity.summary,
      activity.turnId ?? "",
      String(activity.sequence ?? ""),
      activity.createdAt,
      hashStableJsonLike(activity.payload),
    );
  }

  for (const plan of tail(
    thread.proposedPlans,
    THREAD_DETAIL_FINGERPRINT_TAIL_LIMITS.proposedPlans,
  )) {
    parts.push(
      "plan",
      plan.id,
      plan.turnId ?? "",
      plan.implementedAt ?? "",
      plan.implementationThreadId ?? "",
      plan.createdAt,
      plan.updatedAt,
      String(plan.planMarkdown.length),
      hashString(plan.planMarkdown),
    );
  }

  for (const checkpoint of tail(
    thread.checkpoints,
    THREAD_DETAIL_FINGERPRINT_TAIL_LIMITS.checkpoints,
  )) {
    parts.push(
      "checkpoint",
      checkpoint.turnId,
      String(checkpoint.checkpointTurnCount),
      checkpoint.checkpointRef,
      checkpoint.status,
      checkpoint.assistantMessageId ?? "",
      checkpoint.completedAt,
    );
    for (const file of checkpoint.files) {
      parts.push(
        "checkpoint-file",
        file.path,
        file.kind,
        String(file.additions),
        String(file.deletions),
      );
    }
  }
}

function appendPageInfoParts(parts: string[], pageInfo: OrchestrationThreadDetailPageInfo): void {
  for (const key of ["messages", "proposedPlans", "activities", "checkpoints"] as const) {
    const collection = pageInfo[key];
    const cursor = collection.startCursor;
    parts.push(
      "pageInfo",
      key,
      collection.hasMoreBefore ? "1" : "0",
      cursor?.id ?? "",
      cursor?.createdAt ?? "",
      String(cursor?.sequence ?? ""),
      String(cursor?.checkpointTurnCount ?? ""),
    );
  }
}

function tail<T>(items: ReadonlyArray<T>, limit: number): ReadonlyArray<T> {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

function hashStableJsonLike(value: unknown): string {
  const parts: string[] = [];
  appendStableJsonLikeParts(parts, value, new Set());
  return hashStrings(parts);
}

function appendStableJsonLikeParts(parts: string[], value: unknown, seen: Set<object>): void {
  if (value === null) {
    parts.push("null");
    return;
  }
  switch (typeof value) {
    case "undefined":
      parts.push("undefined");
      return;
    case "boolean":
    case "number":
    case "bigint":
    case "string":
      parts.push(typeof value, String(value));
      return;
    case "object":
      break;
    default:
      parts.push(typeof value);
      return;
  }

  if (seen.has(value)) {
    parts.push("cycle");
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    parts.push("array", String(value.length));
    for (const item of value) {
      appendStableJsonLikeParts(parts, item, seen);
    }
    seen.delete(value);
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    parts.push("object", "non-plain");
    seen.delete(value);
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  parts.push("object", String(keys.length));
  for (const key of keys) {
    parts.push("key", key);
    appendStableJsonLikeParts(parts, record[key], seen);
  }
  seen.delete(value);
}

function hashStrings(values: ReadonlyArray<string>): string {
  let hash = TEXT_HASH_SEED;
  for (const value of values) {
    hash = hashStringInto(hash, value);
    hash = hashStringInto(hash, "\u0000");
  }
  return hash.toString(16).padStart(8, "0");
}

function hashString(value: string): string {
  return hashStringInto(TEXT_HASH_SEED, value).toString(16).padStart(8, "0");
}

function hashStringInto(seed: number, value: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
