import { createHash } from "node:crypto";

import { ThreadId, type ProviderInstanceId } from "@t3tools/contracts";

export interface CodexThreadSpawnMetadata {
  readonly providerParentThreadId: string;
  readonly subagentKind: string;
  readonly subagentNickname?: string;
  readonly subagentRole?: string;
  readonly subagentPath?: string;
  readonly hiddenFromThreadList: boolean;
}

export interface CodexSubagentMetadata {
  readonly providerParentThreadId?: string;
  readonly subagentKind: string;
  readonly subagentNickname?: string;
  readonly subagentRole?: string;
  readonly subagentPath?: string;
  readonly hiddenFromThreadList: boolean;
}

export function codexChildThreadId(
  providerInstanceId: ProviderInstanceId,
  providerThreadId: string,
): ThreadId {
  const digest = createHash("sha256")
    .update(`${providerInstanceId}\0${providerThreadId}`)
    .digest("hex")
    .slice(0, 32);
  return ThreadId.make(`codex-child-${digest}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readThreadRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const maybeThread = value.thread;
  if (isRecord(maybeThread)) return maybeThread;
  return value;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readSubagentSource(thread: Record<string, unknown>): unknown {
  const source = thread.source;
  const sourceRecord = isRecord(source)
    ? source
    : typeof source === "string"
      ? parseJsonRecord(source)
      : null;
  if (!sourceRecord) return null;
  return sourceRecord.subAgent ?? sourceRecord.subagent ?? null;
}

export function extractCodexThreadSpawnMetadata(value: unknown): CodexThreadSpawnMetadata | null {
  const thread = readThreadRecord(value);
  if (!thread) return null;

  const source = readSubagentSource(thread);
  const topLevelThreadSource =
    readString(thread.threadSource) ?? readString(thread.thread_source) ?? undefined;
  const topLevelSpawnRecord =
    topLevelThreadSource === "subagent" &&
    (readString(thread.parentThreadId) || readString(thread.parent_thread_id))
      ? thread
      : null;
  const spawnRecord =
    isRecord(source) && isRecord(source.thread_spawn) ? source.thread_spawn : topLevelSpawnRecord;
  if (!spawnRecord) {
    return null;
  }

  const providerParentThreadId =
    readString(spawnRecord.parent_thread_id) ??
    readString(spawnRecord.parentThreadId) ??
    readString(thread.parentThreadId) ??
    readString(thread.parent_thread_id);
  if (!providerParentThreadId) {
    return null;
  }

  const subagentNickname =
    readString(spawnRecord.agent_nickname) ??
    readString(spawnRecord.agentNickname) ??
    readString(thread.agentNickname) ??
    readString(thread.agent_nickname);
  const subagentRole =
    readString(spawnRecord.agent_role) ??
    readString(spawnRecord.agentRole) ??
    readString(thread.agentRole) ??
    readString(thread.agent_role);
  const subagentPath =
    readString(spawnRecord.agent_path) ??
    readString(spawnRecord.agentPath) ??
    readString(thread.agentPath) ??
    readString(thread.agent_path) ??
    readString(thread.path);

  return {
    providerParentThreadId,
    subagentKind: "thread_spawn",
    ...(subagentNickname ? { subagentNickname } : {}),
    ...(subagentRole ? { subagentRole } : {}),
    ...(subagentPath ? { subagentPath } : {}),
    hiddenFromThreadList: false,
  };
}

export function extractCodexSubagentMetadata(value: unknown): CodexSubagentMetadata | null {
  const thread = readThreadRecord(value);
  if (!thread) return null;

  const spawn = extractCodexThreadSpawnMetadata(thread);
  if (spawn) return spawn;

  const source = readSubagentSource(thread);
  if (source === "review" || source === "compact" || source === "memory_consolidation") {
    return {
      subagentKind: source,
      hiddenFromThreadList: true,
    };
  }

  if (isRecord(source)) {
    const other = readString(source.other);
    if (other) {
      return {
        subagentKind: other,
        hiddenFromThreadList: true,
      };
    }
  }

  return null;
}
