import type { OrchestrationEvent } from "@salchi/contracts";

export const ORCHESTRATION_THREAD_DETAIL_EVENT_TYPES = [
  "thread.message-sent",
  "thread.turn-queued",
  "thread.queued-turn-updated",
  "thread.queued-turn-cancelled",
  "thread.queued-turn-dispatched",
  "thread.queued-turn-steer-requested",
  "thread.queued-turn-steer-failed",
  "thread.queued-turn-steered",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

export type OrchestrationThreadDetailEventType =
  (typeof ORCHESTRATION_THREAD_DETAIL_EVENT_TYPES)[number];

export type OrchestrationThreadDetailEvent = Extract<
  OrchestrationEvent,
  { type: OrchestrationThreadDetailEventType }
>;

const orchestrationThreadDetailEventTypeSet = new Set<OrchestrationEvent["type"]>(
  ORCHESTRATION_THREAD_DETAIL_EVENT_TYPES,
);

export function isOrchestrationThreadDetailEvent(
  event: OrchestrationEvent,
): event is OrchestrationThreadDetailEvent {
  return orchestrationThreadDetailEventTypeSet.has(event.type);
}
