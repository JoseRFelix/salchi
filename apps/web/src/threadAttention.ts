import type { EnvironmentId, ThreadId, TurnId } from "@salchi/contracts";

import { readEnvironmentApi } from "./environmentApi";
import { getSavedEnvironmentRuntimeState } from "./environments/runtime/catalog";
import { readPrimaryEnvironmentDescriptor } from "./environments/primary";
import { newCommandId } from "./lib/utils";

type ThreadCompletionAttentionOperation = "acknowledge" | "mark-unread";

const pendingOperations = new Map<string, Promise<boolean>>();

export function supportsThreadCompletionAttention(environmentId: EnvironmentId): boolean {
  const primaryDescriptor = readPrimaryEnvironmentDescriptor();
  if (primaryDescriptor?.environmentId === environmentId) {
    return primaryDescriptor.capabilities.completionAttention === true;
  }

  const remoteRuntime = getSavedEnvironmentRuntimeState(environmentId);
  const remoteDescriptor = remoteRuntime.descriptor ?? remoteRuntime.serverConfig?.environment;
  // Before the environment descriptor arrives, allow an attempt. Once a
  // legacy descriptor is known, the absent capability disables unsupported
  // commands and UI actions deterministically.
  return remoteDescriptor === undefined
    ? true
    : remoteDescriptor.capabilities.completionAttention === true;
}

export function threadCompletionAttentionTargetKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): string {
  return JSON.stringify([input.environmentId, input.threadId, input.turnId]);
}

function operationKey(input: {
  readonly operation: ThreadCompletionAttentionOperation;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): string {
  return `${input.operation}:${threadCompletionAttentionTargetKey(input)}`;
}

/** Dispatches one completion-attention transition and coalesces concurrent
 * callers in this page. Stale completions are rejected server-side and are
 * intentionally treated as a best-effort miss here.
 */
export function setThreadCompletionAttention(input: {
  readonly operation: ThreadCompletionAttentionOperation;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): Promise<boolean> {
  if (!supportsThreadCompletionAttention(input.environmentId)) {
    return Promise.resolve(false);
  }
  const key = operationKey(input);
  const pending = pendingOperations.get(key);
  if (pending) {
    return pending;
  }

  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    return Promise.resolve(false);
  }

  const request = api.orchestration
    .dispatchCommand({
      type:
        input.operation === "acknowledge"
          ? "thread.completion.acknowledge"
          : "thread.completion.mark-unread",
      commandId: newCommandId(),
      threadId: input.threadId,
      turnId: input.turnId,
    })
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      pendingOperations.delete(key);
    });
  pendingOperations.set(key, request);
  return request;
}
