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

function readSubagentSource(thread: Record<string, unknown>): unknown {
  const source = thread.source;
  if (!isRecord(source)) return null;
  return source.subAgent ?? null;
}

export function extractCodexThreadSpawnMetadata(value: unknown): CodexThreadSpawnMetadata | null {
  const thread = readThreadRecord(value);
  if (!thread) return null;

  const source = readSubagentSource(thread);
  if (!isRecord(source) || !isRecord(source.thread_spawn)) {
    return null;
  }

  const providerParentThreadId =
    readString(source.thread_spawn.parent_thread_id) ?? readString(thread.parentThreadId);
  if (!providerParentThreadId) {
    return null;
  }

  const subagentNickname =
    readString(source.thread_spawn.agent_nickname) ?? readString(thread.agentNickname);
  const subagentRole = readString(source.thread_spawn.agent_role) ?? readString(thread.agentRole);
  const subagentPath = readString(source.thread_spawn.agent_path) ?? readString(thread.path);

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
