import type { EnvironmentId, ScopedThreadRef } from "@salchi/contracts";

import type { Thread } from "./types";

import { readEnvironmentApi } from "./environmentApi";
import { readPrimaryEnvironmentDescriptor } from "./environments/primary";
import { getSavedEnvironmentRuntimeState } from "./environments/runtime/catalog";
import { newCommandId } from "./lib/utils";

export type ThreadLifecycleCapability =
  | "threadSettlement"
  | "threadSnooze"
  | "threadPinning"
  | "threadPinReorder"
  | "threadTitleRegeneration";

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export function supportsThreadLifecycleCapability(
  environmentId: EnvironmentId,
  capability: ThreadLifecycleCapability,
): boolean {
  const primaryDescriptor = readPrimaryEnvironmentDescriptor();
  if (primaryDescriptor?.environmentId === environmentId) {
    return primaryDescriptor.capabilities[capability] === true;
  }

  const remoteRuntime = getSavedEnvironmentRuntimeState(environmentId);
  const descriptor = remoteRuntime.descriptor ?? remoteRuntime.serverConfig?.environment;
  // Permit an attempt while a remote descriptor is still loading. Once a
  // legacy server identifies itself, unsupported controls disappear.
  return descriptor === undefined ? true : descriptor.capabilities[capability] === true;
}

async function dispatchLifecycleCommand(
  target: ScopedThreadRef,
  capability: ThreadLifecycleCapability,
  command:
    | { readonly type: "thread.settle" }
    | { readonly type: "thread.unsettle"; readonly reason: "user" }
    | { readonly type: "thread.snooze"; readonly snoozedUntil: string }
    | { readonly type: "thread.unsnooze"; readonly reason: "user" }
    | { readonly type: "thread.pin"; readonly orderKey?: string }
    | { readonly type: "thread.unpin" }
    | { readonly type: "thread.pin.reorder"; readonly orderKey: string },
): Promise<boolean> {
  if (!supportsThreadLifecycleCapability(target.environmentId, capability)) {
    return false;
  }
  const api = readEnvironmentApi(target.environmentId);
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    ...command,
    commandId: newCommandId(),
    threadId: target.threadId,
  });
  return true;
}

export function setThreadSettled(target: ScopedThreadRef, settled: boolean): Promise<boolean> {
  return dispatchLifecycleCommand(
    target,
    "threadSettlement",
    settled ? { type: "thread.settle" } : { type: "thread.unsettle", reason: "user" },
  );
}

export function snoozeThread(target: ScopedThreadRef, snoozedUntil: string): Promise<boolean> {
  return dispatchLifecycleCommand(target, "threadSnooze", {
    type: "thread.snooze",
    snoozedUntil,
  });
}

export function unsnoozeThread(target: ScopedThreadRef): Promise<boolean> {
  return dispatchLifecycleCommand(target, "threadSnooze", {
    type: "thread.unsnooze",
    reason: "user",
  });
}

export function setThreadPinned(
  target: ScopedThreadRef,
  pinned: boolean,
  orderKey?: string,
): Promise<boolean> {
  return dispatchLifecycleCommand(
    target,
    "threadPinning",
    pinned
      ? { type: "thread.pin", ...(orderKey === undefined ? {} : { orderKey }) }
      : { type: "thread.unpin" },
  );
}

export function reorderPinnedThread(target: ScopedThreadRef, orderKey: string): Promise<boolean> {
  return dispatchLifecycleCommand(target, "threadPinReorder", {
    type: "thread.pin.reorder",
    orderKey,
  });
}
