import type { BrowserInputEvent, EnvironmentId, ThreadId } from "@salchi/contracts";
import type { BrowserStreamMetaMessage } from "@salchi/shared/browserStreamProtocol";

import type {
  BrowserStreamConnectionState,
  BrowserStreamViewportFrame,
} from "./browserStreamConnection";
import {
  acquireBrowserStream,
  type BrowserStreamSubscriber,
  type BrowserStreamSubscription,
} from "./browserStreamPool";
import type { BrowserPipPhase } from "./browserPipState";

export const BROWSER_SURFACE_LEASE_INVARIANT_MILLIS = 30_000;

export type BrowserViewportSurface = "panel" | "pip";

export interface BrowserSurfaceStreamListener {
  readonly onAuthorizationDenied?: () => void;
  readonly onConnectionState?: (state: BrowserStreamConnectionState) => void;
  readonly onError?: (error: unknown) => void;
  readonly onEvent?: (event: BrowserStreamMetaMessage) => void;
  readonly onFrame?: (frame: BrowserStreamViewportFrame) => void;
}

export interface BrowserSurfaceStreamLeaseSnapshot {
  readonly connected: boolean;
  readonly surface: BrowserViewportSurface | null;
}

type AcquireBrowserStream = (subscriber: BrowserStreamSubscriber) => BrowserStreamSubscription;

export interface BrowserSurfaceStreamLease {
  readonly attach: (
    surface: BrowserViewportSurface,
    listener: BrowserSurfaceStreamListener,
  ) => () => void;
  readonly dispose: () => void;
  readonly sendInput: (targetId: string, event: BrowserInputEvent) => boolean;
  readonly setSurface: (surface: BrowserViewportSurface | null) => void;
  readonly snapshot: () => BrowserSurfaceStreamLeaseSnapshot;
}

export function resolveBrowserViewportSurface(input: {
  readonly documentVisible: boolean;
  readonly panelVisible: boolean;
  readonly pipPhase: BrowserPipPhase;
}): BrowserViewportSurface | null {
  if (!input.documentVisible) return null;
  if (input.panelVisible) return "panel";
  return input.pipPhase === "hidden" ? null : "pip";
}

/**
 * Owns the one raw viewport subscription shared by the Browser panel and PiP.
 * Switching between non-null surfaces only changes the recipient; the physical
 * socket remains acquired, so screencasting cannot flicker during handoff.
 */
export function createBrowserSurfaceStreamLease(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly acquire?: AcquireBrowserStream;
  readonly debug?: boolean;
  readonly onPipSocketDrop?: () => void;
}): BrowserSurfaceStreamLease {
  const acquire = input.acquire ?? acquireBrowserStream;
  const listeners = new Map<BrowserViewportSurface, BrowserSurfaceStreamListener>();
  let connection: BrowserStreamSubscription | null = null;
  let disposed = false;
  let latestActivity: BrowserStreamMetaMessage | null = null;
  let latestFrame: BrowserStreamViewportFrame | null = null;
  let latestStatus: BrowserStreamMetaMessage | null = null;
  let latestTabs: BrowserStreamMetaMessage | null = null;
  let surface: BrowserViewportSurface | null = null;
  let invariantViolationStartedAt: number | null = null;

  const listener = () => (surface === null ? undefined : listeners.get(surface));

  const releaseConnection = () => {
    const current = connection;
    connection = null;
    current?.dispose();
  };

  const replayLatest = (next: BrowserSurfaceStreamListener) => {
    if (latestStatus !== null) next.onEvent?.(latestStatus);
    if (latestTabs !== null) next.onEvent?.(latestTabs);
    if (latestActivity !== null) next.onEvent?.(latestActivity);
    if (latestFrame !== null) next.onFrame?.(latestFrame);
  };

  const handleSocketDrop = () => {
    if (surface !== "pip") return;
    surface = null;
    releaseConnection();
    input.onPipSocketDrop?.();
  };

  const acquireConnection = () => {
    if (connection !== null || surface === null || disposed) return;
    const acquired = acquire({
      environmentId: input.environmentId,
      threadId: input.threadId,
      onAuthorizationDenied: () => {
        listener()?.onAuthorizationDenied?.();
        surface = null;
        releaseConnection();
      },
      onConnectionState: (state) => {
        listener()?.onConnectionState?.(state);
        if (state === "closed") handleSocketDrop();
      },
      onError: (error) => listener()?.onError?.(error),
      onEvent: (event) => {
        if ("agentActive" in event) latestActivity = event;
        else if (event._tag === "Status") latestStatus = event;
        else latestTabs = event;
        listener()?.onEvent?.(event);
      },
      onFrame: (frame) => {
        latestFrame = frame;
        listener()?.onFrame?.(frame);
      },
    });
    if (disposed || surface === null) {
      acquired.dispose();
      return;
    }
    connection = acquired;
  };

  const invariantTimer = input.debug
    ? window.setInterval(() => {
        if (connection === null || surface !== null) {
          invariantViolationStartedAt = null;
          return;
        }
        invariantViolationStartedAt ??= Date.now();
        if (Date.now() - invariantViolationStartedAt < BROWSER_SURFACE_LEASE_INVARIANT_MILLIS) {
          return;
        }
        console.error(
          "[browser-stream] viewport subscriber exists without a visible surface for over 30s",
          { environmentId: input.environmentId, threadId: input.threadId },
        );
        invariantViolationStartedAt = Date.now();
      }, 5_000)
    : null;

  return {
    attach: (nextSurface, nextListener) => {
      listeners.set(nextSurface, nextListener);
      if (surface === nextSurface) replayLatest(nextListener);
      return () => {
        if (listeners.get(nextSurface) === nextListener) listeners.delete(nextSurface);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      surface = null;
      listeners.clear();
      releaseConnection();
      if (invariantTimer !== null) window.clearInterval(invariantTimer);
    },
    sendInput: (targetId, event) =>
      surface === "panel" ? (connection?.sendInput(targetId, event) ?? false) : false,
    setSurface: (nextSurface) => {
      if (disposed || surface === nextSurface) return;
      surface = nextSurface;
      if (nextSurface === null) {
        releaseConnection();
        return;
      }
      acquireConnection();
      const nextListener = listeners.get(nextSurface);
      if (nextListener !== undefined) replayLatest(nextListener);
    },
    snapshot: () => ({ connected: connection !== null, surface }),
  };
}
