import { describe, expect, it } from "vitest";
import { ThreadId } from "@salchi/contracts";

import { initialBrowserPipState, reduceBrowserPipState } from "./browserPipState";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

function runningState() {
  return reduceBrowserPipState(initialBrowserPipState({ enabled: true, threadId: THREAD_A }), {
    type: "status",
    status: "running",
  });
}

describe("browser PiP visibility", () => {
  it("appears on activity, lingers, and fades after activity ends", () => {
    let state = reduceBrowserPipState(runningState(), { type: "activity", active: true });
    expect(state.phase).toBe("visible");
    state = reduceBrowserPipState(state, { type: "activity", active: false });
    expect(state.phase).toBe("lingering");
    state = reduceBrowserPipState(state, { type: "lingerElapsed" });
    expect(state.phase).toBe("fading");
    state = reduceBrowserPipState(state, { type: "fadeElapsed" });
    expect(state.phase).toBe("hidden");
  });

  it("suppresses a closed preview until the next false-to-true transition", () => {
    let state = reduceBrowserPipState(runningState(), { type: "activity", active: true });
    state = reduceBrowserPipState(state, { type: "close" });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    expect(state.phase).toBe("hidden");

    state = reduceBrowserPipState(state, { type: "activity", active: false });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    expect(state.phase).toBe("visible");
  });

  it("hides for an open panel and does not reappear when that panel closes mid-burst", () => {
    let state = reduceBrowserPipState(runningState(), { type: "activity", active: true });
    state = reduceBrowserPipState(state, { type: "panelVisibility", open: true });
    expect(state.phase).toBe("hidden");
    state = reduceBrowserPipState(state, { type: "panelVisibility", open: false });
    expect(state.phase).toBe("hidden");
  });

  it("does not appear when a new activity burst starts behind the full panel", () => {
    let state = reduceBrowserPipState(runningState(), {
      type: "panelVisibility",
      open: true,
    });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    state = reduceBrowserPipState(state, { type: "panelVisibility", open: false });
    expect(state.phase).toBe("hidden");
  });

  it("hides immediately on thread switch, stop, or crash", () => {
    let state = reduceBrowserPipState(runningState(), { type: "activity", active: true });
    state = reduceBrowserPipState(state, {
      type: "reset",
      enabled: true,
      threadId: THREAD_B,
    });
    expect(state).toMatchObject({ threadId: THREAD_B, phase: "hidden", agentActive: false });

    state = reduceBrowserPipState(state, { type: "status", status: "running" });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    expect(reduceBrowserPipState(state, { type: "status", status: "stopped" }).phase).toBe(
      "hidden",
    );
    expect(reduceBrowserPipState(state, { type: "status", status: "crashed" }).phase).toBe(
      "hidden",
    );
  });

  it("hides immediately when its viewport socket drops during linger", () => {
    let state = reduceBrowserPipState(runningState(), { type: "activity", active: true });
    state = reduceBrowserPipState(state, { type: "activity", active: false });
    expect(state.phase).toBe("lingering");
    expect(reduceBrowserPipState(state, { type: "socketDrop" }).phase).toBe("hidden");
  });

  it("restores per-thread suppression without treating a replayed active snapshot as a new burst", () => {
    let state = initialBrowserPipState({
      agentActive: true,
      dismissedForCurrentBurst: true,
      enabled: true,
      threadId: THREAD_A,
    });
    state = reduceBrowserPipState(state, { type: "status", status: "running" });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    expect(state.phase).toBe("hidden");

    state = reduceBrowserPipState(state, { type: "activity", active: false });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    expect(state.phase).toBe("visible");
  });

  it("is order tolerant when activity arrives before running status", () => {
    let state = initialBrowserPipState({ enabled: true, threadId: THREAD_A });
    state = reduceBrowserPipState(state, { type: "activity", active: true });
    expect(state.phase).toBe("hidden");
    state = reduceBrowserPipState(state, { type: "status", status: "running" });
    expect(state.phase).toBe("visible");
  });
});
