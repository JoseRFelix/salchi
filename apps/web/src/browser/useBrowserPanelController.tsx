import type { EnvironmentId, ThreadId } from "@salchi/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { BrowserPanel } from "../components/BrowserPanel";
import { BrowserPictureInPicture } from "../components/BrowserPictureInPicture";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { useMobileEdgeSwipe } from "../hooks/useMobileEdgeSwipe";
import { markRightPanelUsed, openRightPanel, useRegisterRightPanel } from "../rightPanelGesture";
import { useRegisterBrowserRightPanelContent } from "../rightPanelContentRegistry";
import {
  browserErrorMessage,
  initialBrowserViewportState,
  isBrowserAuthorizationError,
  isBrowserAuthorizationErrorMessage,
  reduceBrowserViewportState,
  type BrowserViewportStateAction,
} from "./browserViewportState";
import {
  BROWSER_PIP_FADE_MILLIS,
  BROWSER_PIP_LINGER_MILLIS,
  initialBrowserPipState,
  reduceBrowserPipState,
} from "./browserPipState";
import {
  createBrowserSurfaceStreamLease,
  resolveBrowserViewportSurface,
} from "./browserSurfaceStreamLease";

const HIDDEN_BROWSER_STATE_REFRESH_INTERVAL_MS = 15_000;

export interface BrowserPanelController {
  readonly close: () => void;
  readonly open: boolean;
  readonly pictureInPicture: ReactNode;
  readonly running: boolean;
  readonly toggle: () => void;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

export function useBrowserPanelController(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly showAgentPreview: boolean;
  readonly threadId: ThreadId;
  readonly useSheet: boolean;
}): BrowserPanelController {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(
    reduceBrowserViewportState,
    input.threadId,
    initialBrowserViewportState,
  );
  const [pipState, dispatchPip] = useReducer(
    reduceBrowserPipState,
    { enabled: input.enabled && input.showAgentPreview, threadId: input.threadId },
    initialBrowserPipState,
  );
  const documentVisible = useDocumentVisible();
  const streamLease = useMemo(
    () =>
      createBrowserSurfaceStreamLease({
        environmentId: input.environmentId,
        threadId: input.threadId,
        debug: import.meta.env.DEV,
        onPipSocketDrop: () => dispatchPip({ type: "socketDrop" }),
      }),
    [input.environmentId, input.threadId],
  );
  const pipThreadMemoryRef = useRef(
    new Map<string, { readonly agentActive: boolean; readonly dismissed: boolean }>(),
  );

  const close = useCallback(() => setOpen(false), []);
  const openPanel = useCallback(() => {
    if (!input.enabled) return;
    markRightPanelUsed("browser");
    setOpen(true);
  }, [input.enabled]);
  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    openRightPanel("browser");
  }, [close, open]);
  const onStateAction = useCallback((action: BrowserViewportStateAction) => {
    dispatch(action);
  }, []);

  useEffect(() => {
    dispatch({ type: "reset", threadId: input.threadId });
    const memory = pipThreadMemoryRef.current.get(input.threadId);
    dispatchPip({
      type: "reset",
      ...(memory === undefined
        ? {}
        : {
            agentActive: memory.agentActive,
            dismissedForCurrentBurst: memory.dismissed,
          }),
      enabled: input.enabled && input.showAgentPreview,
      threadId: input.threadId,
    });
  }, [input.enabled, input.showAgentPreview, input.threadId]);

  useLayoutEffect(() => () => streamLease.dispose(), [streamLease]);

  useEffect(() => {
    pipThreadMemoryRef.current.set(pipState.threadId, {
      agentActive: pipState.agentActive,
      dismissed: pipState.dismissedForCurrentBurst,
    });
  }, [pipState.agentActive, pipState.dismissedForCurrentBurst, pipState.threadId]);

  useEffect(() => {
    if (input.enabled) return;
    setOpen(false);
  }, [input.enabled]);

  useEffect(() => {
    dispatchPip({ type: "panelVisibility", open: input.enabled && open });
  }, [input.enabled, open]);

  useEffect(() => {
    dispatchPip({ type: "status", status: state.status ?? "stopped" });
  }, [state.status]);

  useEffect(() => {
    if (!input.enabled || !input.showAgentPreview || state.authorization !== "granted") return;
    let currentClient = readEnvironmentConnection(input.environmentId)?.client.browser ?? null;
    let unsubscribeActivity: (() => void) | null = null;

    const stopActivity = () => {
      const unsubscribe = unsubscribeActivity;
      unsubscribeActivity = null;
      unsubscribe?.();
    };
    const subscribeActivity = () => {
      stopActivity();
      if (currentClient === null) return;
      unsubscribeActivity = currentClient.subscribeAgentActivity(
        { threadId: input.threadId },
        (agentActive) => {
          dispatchPip({ type: "activity", active: agentActive });
          if (!agentActive || currentClient === null) return;
          void currentClient.getState({ threadId: input.threadId }).then(
            (snapshot) => dispatch({ type: "snapshot", snapshot }),
            () => undefined,
          );
        },
        {
          onSubscriptionError: (info) => {
            if (isBrowserAuthorizationErrorMessage(info.error)) {
              stopActivity();
              dispatch({ type: "authorizationDenied" });
              dispatchPip({ type: "status", status: "stopped" });
              return;
            }
            dispatchPip({ type: "activity", active: false });
          },
        },
      );
    };
    const syncConnection = () => {
      const nextClient = readEnvironmentConnection(input.environmentId)?.client.browser ?? null;
      if (nextClient === currentClient) return;
      currentClient = nextClient;
      subscribeActivity();
    };

    subscribeActivity();
    const unsubscribeConnections = subscribeEnvironmentConnections(syncConnection);
    return () => {
      stopActivity();
      unsubscribeConnections();
    };
  }, [
    input.enabled,
    input.environmentId,
    input.showAgentPreview,
    input.threadId,
    state.authorization,
  ]);

  useEffect(() => {
    if (pipState.phase !== "lingering") return;
    const timer = window.setTimeout(
      () => dispatchPip({ type: "lingerElapsed" }),
      BROWSER_PIP_LINGER_MILLIS,
    );
    return () => window.clearTimeout(timer);
  }, [pipState.phase]);

  const viewportSurface = resolveBrowserViewportSurface({
    documentVisible,
    panelVisible: input.enabled && open && state.authorization !== "denied",
    pipPhase: pipState.phase,
  });
  useLayoutEffect(() => {
    streamLease.setSurface(viewportSurface);
  }, [streamLease, viewportSurface]);

  useEffect(() => {
    if (pipState.phase !== "fading") return;
    const timer = window.setTimeout(
      () => dispatchPip({ type: "fadeElapsed" }),
      BROWSER_PIP_FADE_MILLIS,
    );
    return () => window.clearTimeout(timer);
  }, [pipState.phase]);

  useEffect(() => {
    if (!input.enabled) return;

    let disposed = false;
    let currentClient = readEnvironmentConnection(input.environmentId)?.client.browser ?? null;
    let requestGeneration = 0;
    let authorizationDenied = false;

    const refresh = (client: NonNullable<typeof currentClient>) => {
      if (authorizationDenied) return;
      requestGeneration += 1;
      const generation = requestGeneration;
      void client.getState({ threadId: input.threadId }).then(
        (snapshot) => {
          if (disposed || generation !== requestGeneration) return;
          dispatch({ type: "snapshot", snapshot });
        },
        (error: unknown) => {
          if (disposed || generation !== requestGeneration) return;
          if (isBrowserAuthorizationError(error)) {
            authorizationDenied = true;
            dispatch({ type: "authorizationDenied" });
            return;
          }
          dispatch({
            type: "operationFailed",
            error: browserErrorMessage(error, "Unable to read browser status."),
          });
        },
      );
    };

    const syncConnection = () => {
      const nextClient = readEnvironmentConnection(input.environmentId)?.client.browser ?? null;
      if (nextClient === currentClient) return;
      currentClient = nextClient;
      authorizationDenied = false;
      requestGeneration += 1;
      if (currentClient) refresh(currentClient);
    };

    if (currentClient) refresh(currentClient);
    const unsubscribeConnections = subscribeEnvironmentConnections(syncConnection);
    const intervalId = window.setInterval(() => {
      if (open || document.visibilityState !== "visible") return;
      const latestClient = readEnvironmentConnection(input.environmentId)?.client.browser ?? null;
      if (latestClient !== currentClient) {
        syncConnection();
        return;
      }
      if (currentClient) refresh(currentClient);
    }, HIDDEN_BROWSER_STATE_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      requestGeneration += 1;
      unsubscribeConnections();
      window.clearInterval(intervalId);
    };
  }, [input.enabled, input.environmentId, input.threadId, open]);

  const registration = useMemo(
    () => ({
      open: input.enabled && open,
      onClose: close,
      render: (mode: "sheet" | "sidebar") => (
        <BrowserPanel
          environmentId={input.environmentId}
          mode={mode}
          onClose={close}
          onStateAction={onStateAction}
          state={state}
          streamLease={streamLease}
          threadId={input.threadId}
          visible={input.enabled && open}
        />
      ),
    }),
    [
      close,
      input.enabled,
      input.environmentId,
      input.threadId,
      onStateAction,
      open,
      state,
      streamLease,
    ],
  );
  useRegisterBrowserRightPanelContent(registration);
  useRegisterRightPanel({
    close,
    enabled: input.enabled,
    kind: "browser",
    open: openPanel,
  });

  useMobileEdgeSwipe({
    action: "close",
    enabled: input.useSheet && open,
    horizontalScrollOwnerScope: "all",
    onSwipe: close,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  useEffect(() => {
    if (open) markRightPanelUsed("browser");
  }, [open]);

  const pictureInPicture =
    pipState.threadId !== input.threadId || pipState.phase === "hidden" || open ? null : (
      <BrowserPictureInPicture
        onClose={() => dispatchPip({ type: "close" })}
        onOpenPanel={() => {
          dispatchPip({ type: "panelVisibility", open: true });
          openRightPanel("browser");
        }}
        phase={pipState.phase}
        streamLease={streamLease}
      />
    );

  return {
    close,
    open: input.enabled && open,
    pictureInPicture,
    running: input.enabled && state.status === "running",
    toggle,
  };
}
