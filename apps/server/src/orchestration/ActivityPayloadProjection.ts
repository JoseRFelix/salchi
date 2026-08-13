import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@salchi/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth = 0): void {
  if (depth > 4 || target.length >= 12) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectChangedFiles(entry, target, seen, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const path = asTrimmedString(record[key]);
    if (path && !seen.has(path) && target.length < 12) {
      seen.add(path);
      target.push(path);
    }
  }
  for (const key of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (key in record) collectChangedFiles(record[key], target, seen, depth + 1);
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) return undefined;
  const projected: Record<string, unknown> = {};
  if ("command" in item) projected.command = item.command;
  const input = asRecord(item.input);
  if (input && "command" in input) projected.input = { command: input.command };
  const result = asRecord(item.result);
  if (result && "command" in result) projected.result = { command: result.command };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function summarizeText(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  return lines.length > 1 ? `${lines.length.toLocaleString()} lines` : null;
}

function extractMcpResultText(result: unknown): string | null {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  if (!record) return null;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return null;
  const texts = record.content.flatMap((entry) => {
    const text = asRecord(entry)?.text;
    return typeof text === "string" && text.trim().length > 0 ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) return undefined;
  const text = extractMcpResultText(result);
  const summary = text ? summarizeText(text) : null;
  return summary ? { content: summary } : undefined;
}

const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) projectedItem[key] = item[key];
    }
    const result = summarizeMcpResult(item.result);
    if (result) projectedItem.result = result;
    projected.item = projectedItem;
  }
  for (const key of ["toolName", "input", "toolCallId", "kind"] as const) {
    if (key in data) projected[key] = data[key];
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) projected.result = result;
  }
  const files: string[] = [];
  collectChangedFiles(data, files, new Set());
  if (files.length > 0) projected.files = files.map((path) => ({ path }));
  return projected;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const output = asRecord(value);
  if (!output) return undefined;
  if (typeof output.totalFiles === "number" && Number.isFinite(output.totalFiles)) {
    return {
      totalFiles: output.totalFiles,
      ...(output.truncated === true ? { truncated: true } : {}),
    };
  }
  for (const key of ["content", "stdout"] as const) {
    const text = asTrimmedString(output[key]);
    const summary = text ? summarizeText(text) : null;
    if (summary) return { content: summary };
  }
  return undefined;
}

/** Projects persisted activity into the compact representation sent to clients. */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) return activity;
  if (payload.itemType === "mcp_tool_call") {
    return { ...activity, payload: { ...payload, data: projectMcpToolCallData(data) } };
  }

  const projected: Record<string, unknown> = {};
  const item = projectCommandData(data);
  if (item) projected.item = item;
  for (const key of ["command", "toolCallId", "kind"] as const) {
    if (key in data) projected[key] = data[key];
  }
  const files: string[] = [];
  collectChangedFiles(data, files, new Set());
  if (files.length > 0) projected.files = files.map((path) => ({ path }));
  const rawOutput = projectRawOutput(data.rawOutput);
  if (rawOutput) projected.rawOutput = rawOutput;
  return { ...activity, payload: { ...payload, data: projected } };
}

function isResolvableContextWindow(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") return false;
  const usedTokens = asRecord(activity.payload)?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  activities.forEach((activity, index) => {
    if (isResolvableContextWindow(activity)) latestIndexByTurn.set(activity.turnId, index);
  });
  return latestIndexByTurn.size === 0
    ? activities
    : activities.filter(
        (activity, index) =>
          !isResolvableContextWindow(activity) || latestIndexByTurn.get(activity.turnId) === index,
      );
}

function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) return null;
  const toolCallId = asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) return `id:${toolCallId}`;
  const itemType = asTrimmedString(payload.itemType) ?? "";
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  return itemType.length || label.length || detail.length
    ? [itemType, label, detail].join("\u001f")
    : null;
}

function dropSupersededToolUpdates(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndices = new Map<string, number[]>();
  activities.forEach((activity, index) => {
    if (activity.kind !== "tool.completed") return;
    const identity = toolLifecycleIdentity(activity);
    if (!identity) return;
    const key = `${activity.turnId ?? ""}\u0000${identity}`;
    completionIndices.set(key, [...(completionIndices.get(key) ?? []), index]);
  });
  if (completionIndices.size === 0) return activities;
  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") return true;
    const identity = toolLifecycleIdentity(activity);
    if (!identity) return true;
    return !completionIndices
      .get(`${activity.turnId ?? ""}\u0000${identity}`)
      ?.some((completionIndex) => completionIndex > index);
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdates(
        dropStaleContextWindowActivities(snapshot.thread.activities),
      ).map(projectActivityPayload),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  return event.type === "thread.activity-appended"
    ? {
        ...event,
        payload: { ...event.payload, activity: projectActivityPayload(event.payload.activity) },
      }
    : event;
}
