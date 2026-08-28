import type { BrowserSessionStatus, ThreadId } from "@salchi/contracts";

export const BROWSER_PIP_LINGER_MILLIS = 3_000;
export const BROWSER_PIP_FADE_MILLIS = 200;

export type BrowserPipPhase = "hidden" | "visible" | "lingering" | "fading";

export interface BrowserPipState {
  readonly agentActive: boolean;
  readonly dismissedForCurrentBurst: boolean;
  readonly enabled: boolean;
  readonly panelOpen: boolean;
  readonly phase: BrowserPipPhase;
  readonly status: BrowserSessionStatus;
  readonly threadId: ThreadId;
}

export type BrowserPipAction =
  | { readonly type: "activity"; readonly active: boolean }
  | { readonly type: "close" }
  | { readonly type: "enabled"; readonly enabled: boolean }
  | { readonly type: "fadeElapsed" }
  | { readonly type: "lingerElapsed" }
  | { readonly type: "panelVisibility"; readonly open: boolean }
  | {
      readonly type: "reset";
      readonly agentActive?: boolean;
      readonly dismissedForCurrentBurst?: boolean;
      readonly enabled: boolean;
      readonly threadId: ThreadId;
    }
  | { readonly type: "status"; readonly status: BrowserSessionStatus };

export function initialBrowserPipState(input: {
  readonly agentActive?: boolean;
  readonly dismissedForCurrentBurst?: boolean;
  readonly enabled: boolean;
  readonly threadId: ThreadId;
}): BrowserPipState {
  return {
    agentActive: input.agentActive ?? false,
    dismissedForCurrentBurst: input.dismissedForCurrentBurst ?? false,
    enabled: input.enabled,
    panelOpen: false,
    phase: "hidden",
    status: "stopped",
    threadId: input.threadId,
  };
}

function canShow(state: BrowserPipState): boolean {
  return (
    state.enabled &&
    state.status === "running" &&
    state.agentActive &&
    !state.dismissedForCurrentBurst &&
    !state.panelOpen
  );
}

export function reduceBrowserPipState(
  state: BrowserPipState,
  action: BrowserPipAction,
): BrowserPipState {
  switch (action.type) {
    case "reset":
      return initialBrowserPipState(action);
    case "enabled": {
      const next = { ...state, enabled: action.enabled };
      return { ...next, phase: canShow(next) ? "visible" : "hidden" };
    }
    case "panelVisibility": {
      const next = {
        ...state,
        panelOpen: action.open,
        dismissedForCurrentBurst:
          action.open && state.agentActive ? true : state.dismissedForCurrentBurst,
      };
      return { ...next, phase: canShow(next) ? "visible" : "hidden" };
    }
    case "status": {
      const agentActive = action.status === "running" ? state.agentActive : false;
      const next = { ...state, agentActive, status: action.status };
      return { ...next, phase: canShow(next) ? "visible" : "hidden" };
    }
    case "activity": {
      if (action.active) {
        const nextBurst = !state.agentActive;
        const next = {
          ...state,
          agentActive: true,
          dismissedForCurrentBurst: nextBurst ? state.panelOpen : state.dismissedForCurrentBurst,
        };
        return { ...next, phase: canShow(next) ? "visible" : "hidden" };
      }
      if (!state.agentActive) return state;
      return {
        ...state,
        agentActive: false,
        phase: state.phase === "visible" ? "lingering" : state.phase,
      };
    }
    case "close":
      return { ...state, dismissedForCurrentBurst: true, phase: "hidden" };
    case "lingerElapsed":
      return state.phase === "lingering" ? { ...state, phase: "fading" } : state;
    case "fadeElapsed":
      return state.phase === "fading" ? { ...state, phase: "hidden" } : state;
  }
}
