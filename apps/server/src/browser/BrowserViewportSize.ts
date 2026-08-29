import type { BrowserViewportSize } from "@salchi/contracts";

export const DEFAULT_BROWSER_VIEWPORT_SIZE = { width: 800, height: 600 } as const;
export const MIN_BROWSER_VIEWPORT_WIDTH = 320;
export const MAX_BROWSER_VIEWPORT_WIDTH = 1_280;
export const MIN_BROWSER_VIEWPORT_HEIGHT = 480;
export const MAX_BROWSER_VIEWPORT_HEIGHT = 1_024;

interface BrowserViewportRequest {
  readonly revision: number;
  readonly size: BrowserViewportSize;
}

export interface BrowserViewportPolicyState {
  readonly agentActive: boolean;
  readonly appliedSize: BrowserViewportSize;
  readonly enabled: boolean;
  readonly nextRevision: number;
  readonly pendingSize: BrowserViewportSize | null;
  readonly requests: ReadonlyMap<string, BrowserViewportRequest>;
}

export interface BrowserViewportPolicyTransition {
  readonly apply: BrowserViewportSize | null;
  readonly state: BrowserViewportPolicyState;
}

function clampAndSnapEven(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.round(finite / 2) * 2, minimum), maximum);
}

export function normalizeBrowserViewportSize(size: BrowserViewportSize): BrowserViewportSize {
  return {
    width: clampAndSnapEven(
      size.width,
      MIN_BROWSER_VIEWPORT_WIDTH,
      MAX_BROWSER_VIEWPORT_WIDTH,
      DEFAULT_BROWSER_VIEWPORT_SIZE.width,
    ),
    height: clampAndSnapEven(
      size.height,
      MIN_BROWSER_VIEWPORT_HEIGHT,
      MAX_BROWSER_VIEWPORT_HEIGHT,
      DEFAULT_BROWSER_VIEWPORT_SIZE.height,
    ),
  };
}

function sameSize(left: BrowserViewportSize, right: BrowserViewportSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function selectedRequestSize(state: BrowserViewportPolicyState): BrowserViewportSize {
  if (!state.enabled) return DEFAULT_BROWSER_VIEWPORT_SIZE;
  let selected: BrowserViewportRequest | undefined;
  for (const request of state.requests.values()) {
    const requestArea = request.size.width * request.size.height;
    const selectedArea = selected === undefined ? -1 : selected.size.width * selected.size.height;
    if (
      selected === undefined ||
      requestArea > selectedArea ||
      (requestArea === selectedArea && request.revision > selected.revision)
    ) {
      selected = request;
    }
  }
  return selected?.size ?? DEFAULT_BROWSER_VIEWPORT_SIZE;
}

function reconcileBrowserViewportPolicy(
  state: BrowserViewportPolicyState,
): BrowserViewportPolicyTransition {
  const desiredSize = selectedRequestSize(state);
  if (sameSize(desiredSize, state.appliedSize)) {
    return {
      apply: null,
      state: state.pendingSize === null ? state : { ...state, pendingSize: null },
    };
  }
  if (state.agentActive) {
    return {
      apply: null,
      state: { ...state, pendingSize: desiredSize },
    };
  }
  return {
    apply: desiredSize,
    state: { ...state, appliedSize: desiredSize, pendingSize: null },
  };
}

export function initialBrowserViewportPolicyState(enabled: boolean): BrowserViewportPolicyState {
  return {
    agentActive: false,
    appliedSize: DEFAULT_BROWSER_VIEWPORT_SIZE,
    enabled,
    nextRevision: 0,
    pendingSize: null,
    requests: new Map(),
  };
}

export function updateBrowserViewportRequest(
  state: BrowserViewportPolicyState,
  ownerId: string,
  size: BrowserViewportSize | null,
): BrowserViewportPolicyTransition {
  const requests = new Map(state.requests);
  const nextRevision = state.nextRevision + 1;
  if (size === null) requests.delete(ownerId);
  else requests.set(ownerId, { revision: nextRevision, size: normalizeBrowserViewportSize(size) });
  return reconcileBrowserViewportPolicy({ ...state, nextRevision, requests });
}

export function setBrowserViewportAgentActive(
  state: BrowserViewportPolicyState,
  agentActive: boolean,
): BrowserViewportPolicyTransition {
  if (state.agentActive === agentActive) return { apply: null, state };
  return reconcileBrowserViewportPolicy({ ...state, agentActive });
}

export function setBrowserViewportFollowingEnabled(
  state: BrowserViewportPolicyState,
  enabled: boolean,
): BrowserViewportPolicyTransition {
  if (state.enabled === enabled) return { apply: null, state };
  return reconcileBrowserViewportPolicy({ ...state, enabled });
}
