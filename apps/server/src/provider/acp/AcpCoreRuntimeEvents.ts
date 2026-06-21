import {
  type RuntimeEventRawSource,
  RuntimeItemId,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AcpPermissionRequest, AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
  makeIndependentThreadCreatedRuntimeEvent,
} from "../IndependentThreadTool.ts";

type AcpAdapterRawSource = Extract<
  RuntimeEventRawSource,
  "acp.jsonrpc" | `acp.${string}.extension`
>;

interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

type AcpCanonicalRequestType = Extract<
  CanonicalRequestType,
  "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown"
>;

function canonicalRequestTypeFromAcpKind(kind: string | "unknown"): AcpCanonicalRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function runtimeItemStatusFromAcpToolStatus(
  status: AcpToolCallState["status"],
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarkedJsonText(value: string): unknown | undefined {
  const markerIndex = value.indexOf(INDEPENDENT_THREAD_TOOL_RESULT_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const jsonStart = value.indexOf("{", markerIndex + INDEPENDENT_THREAD_TOOL_RESULT_MARKER.length);
  if (jsonStart < 0) {
    return undefined;
  }
  try {
    return JSON.parse(value.slice(jsonStart));
  } catch {
    return undefined;
  }
}

function extractIndependentThreadArguments(value: unknown, depth = 0): unknown | undefined {
  if (depth > 8) {
    return undefined;
  }

  if (typeof value === "string") {
    const markedJson = parseMarkedJsonText(value);
    if (markedJson !== undefined) {
      return extractIndependentThreadArguments(markedJson, depth + 1);
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractIndependentThreadArguments(JSON.parse(trimmed), depth + 1);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractIndependentThreadArguments(item, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === INDEPENDENT_THREAD_TOOL_RESULT_MARKER) {
    if (Object.hasOwn(value, "arguments")) {
      return value.arguments;
    }
    if (Object.hasOwn(value, "args")) {
      return value.args;
    }
    if (Object.hasOwn(value, "input")) {
      return value.input;
    }
    if (Object.hasOwn(value, "payload")) {
      return value.payload;
    }
  }

  const priorityFields = [
    "structuredContent",
    "rawOutput",
    "output",
    "content",
    "result",
    "data",
  ] as const;
  for (const field of priorityFields) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }
    const found = extractIndependentThreadArguments(value[field], depth + 1);
    if (found !== undefined) {
      return found;
    }
  }

  for (const nested of Object.values(value)) {
    const found = extractIndependentThreadArguments(nested, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

export function makeAcpRequestOpenedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly detail: string;
  readonly args: unknown;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      detail: input.detail,
      args: input.args,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpRequestResolvedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      decision: input.decision,
    },
  };
}

export function makeAcpPlanUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly payload: AcpPlanUpdate;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "turn.plan.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: input.payload,
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpToolCallEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const runtimeStatus = runtimeItemStatusFromAcpToolStatus(input.toolCall.status);
  return {
    type:
      input.toolCall.status === "completed" || input.toolCall.status === "failed"
        ? "item.completed"
        : "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.toolCall.toolCallId),
    payload: {
      itemType: canonicalItemTypeFromAcpToolKind(input.toolCall.kind),
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(input.toolCall.title ? { title: input.toolCall.title } : {}),
      ...(input.toolCall.detail ? { detail: input.toolCall.detail } : {}),
      ...(Object.keys(input.toolCall.data).length > 0 ? { data: input.toolCall.data } : {}),
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpIndependentThreadCreatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent | undefined {
  if (input.toolCall.status !== "completed") {
    return undefined;
  }
  const argumentsValue = extractIndependentThreadArguments(input.toolCall.data);
  if (argumentsValue === undefined) {
    return undefined;
  }
  return makeIndependentThreadCreatedRuntimeEvent({
    provider: input.provider,
    eventId: input.stamp.eventId,
    createdAt: input.stamp.createdAt,
    sourceThreadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    idPrefix: `acp-tool:${input.toolCall.toolCallId}`,
    argumentsValue,
    sourceItemId: RuntimeItemId.make(input.toolCall.toolCallId),
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  });
}

export function offerAcpIndependentThreadCreatedEvent<A, E, R>(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<A, E, R>;
}): Effect.Effect<void, E, R> {
  const event = makeAcpIndependentThreadCreatedEvent(input);
  return event ? input.offerRuntimeEvent(event).pipe(Effect.asVoid) : Effect.void;
}

export function makeAcpAssistantItemEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: string;
  readonly lifecycle: "item.started" | "item.completed";
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.itemId),
    payload: {
      itemType: "assistant_message",
      status: input.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
  };
}

export function makeAcpContentDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId?: string;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: "assistant_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}
