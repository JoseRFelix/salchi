import type { OrchestrationEvent } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  isOrchestrationThreadDetailEvent,
  ORCHESTRATION_THREAD_DETAIL_EVENT_TYPES,
} from "./orchestrationThreadDetailEvents.ts";

const QUEUED_TURN_EVENT_TYPES = [
  "thread.turn-queued",
  "thread.queued-turn-updated",
  "thread.queued-turn-cancelled",
  "thread.queued-turn-dispatched",
  "thread.queued-turn-steer-requested",
  "thread.queued-turn-steer-failed",
  "thread.queued-turn-steered",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

function eventWithType(type: OrchestrationEvent["type"]): OrchestrationEvent {
  return { type } as OrchestrationEvent;
}

describe("isOrchestrationThreadDetailEvent", () => {
  it("includes every queued-turn lifecycle event", () => {
    for (const type of QUEUED_TURN_EVENT_TYPES) {
      expect(ORCHESTRATION_THREAD_DETAIL_EVENT_TYPES).toContain(type);
      expect(isOrchestrationThreadDetailEvent(eventWithType(type))).toBe(true);
    }
  });

  it("excludes thread events that do not directly change detail state", () => {
    expect(isOrchestrationThreadDetailEvent(eventWithType("thread.meta-updated"))).toBe(false);
    expect(isOrchestrationThreadDetailEvent(eventWithType("thread.turn-start-requested"))).toBe(
      false,
    );
  });
});
