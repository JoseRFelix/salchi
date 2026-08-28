import type {
  BrowserSessionState,
  BrowserSessionStatus,
  BrowserTab,
  BrowserViewportEvent,
  ThreadId,
} from "@salchi/contracts";

export type BrowserAuthorizationState = "unknown" | "granted" | "denied";

export interface BrowserViewportState {
  readonly threadId: ThreadId;
  readonly status: BrowserSessionStatus | null;
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly sessionError: string | null;
  readonly operationError: string | null;
  readonly authorization: BrowserAuthorizationState;
  readonly optimisticActiveTargetId: string | null;
}

export type BrowserViewportStateAction =
  | { readonly type: "reset"; readonly threadId: ThreadId }
  | { readonly type: "snapshot"; readonly snapshot: BrowserSessionState }
  | { readonly type: "event"; readonly event: BrowserViewportEvent }
  | { readonly type: "startRequested" }
  | { readonly type: "activeTabRequested"; readonly targetId: string }
  | {
      readonly type: "operationFailed";
      readonly error: string;
      readonly status?: BrowserSessionStatus | null;
    }
  | { readonly type: "authorizationDenied" }
  | { readonly type: "clearOperationError" };

export function initialBrowserViewportState(threadId: ThreadId): BrowserViewportState {
  return {
    threadId,
    status: null,
    tabs: [],
    sessionError: null,
    operationError: null,
    authorization: "unknown",
    optimisticActiveTargetId: null,
  };
}

export function reduceBrowserViewportState(
  state: BrowserViewportState,
  action: BrowserViewportStateAction,
): BrowserViewportState {
  switch (action.type) {
    case "reset":
      return initialBrowserViewportState(action.threadId);
    case "snapshot":
      if (action.snapshot.threadId !== state.threadId) return state;
      return {
        ...state,
        status: action.snapshot.status,
        tabs: action.snapshot.tabs,
        sessionError: action.snapshot.error ?? null,
        operationError: null,
        authorization: "granted",
        optimisticActiveTargetId: null,
      };
    case "event": {
      if (action.event.threadId !== state.threadId) return state;
      if (action.event._tag === "Frame") return state;
      if (action.event._tag === "Tabs") {
        return {
          ...state,
          tabs: action.event.tabs,
          authorization: "granted",
          optimisticActiveTargetId: null,
        };
      }
      return {
        ...state,
        status: action.event.status,
        sessionError: action.event.error ?? null,
        operationError: null,
        authorization: "granted",
      };
    }
    case "startRequested":
      return {
        ...state,
        status: "starting",
        sessionError: null,
        operationError: null,
      };
    case "activeTabRequested":
      return {
        ...state,
        optimisticActiveTargetId: action.targetId,
        operationError: null,
      };
    case "operationFailed":
      return {
        ...state,
        status: action.status === undefined ? state.status : action.status,
        operationError: action.error,
        optimisticActiveTargetId: null,
      };
    case "authorizationDenied":
      return {
        ...state,
        authorization: "denied",
        operationError: null,
        optimisticActiveTargetId: null,
      };
    case "clearOperationError":
      return { ...state, operationError: null };
  }
}

function hasBrowserAuthorizationTag(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError"
  );
}

export function isBrowserAuthorizationError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 4; depth += 1) {
    if (hasBrowserAuthorizationTag(current)) return true;
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  return isBrowserAuthorizationErrorMessage(message);
}

export function isBrowserAuthorizationErrorMessage(message: string): boolean {
  return message.includes("EnvironmentAuthorizationError") || message.includes("browser:operate");
}

export function browserErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function browserTabLabel(tab: BrowserTab): string {
  const title = tab.title.trim();
  if (title.length > 0) return title;

  if (tab.url.trim() === "about:blank") return "New tab";

  try {
    const hostname = new URL(tab.url).hostname;
    if (hostname.length > 0) return hostname;
  } catch {
    // Browser-internal and partially loaded URLs do not always parse as standard URLs.
  }

  return tab.url.trim() || "New tab";
}
