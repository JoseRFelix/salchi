import type { EnvironmentId, ThreadId } from "@salchi/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
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
  reduceBrowserViewportState,
  type BrowserViewportStateAction,
} from "./browserViewportState";
import {
  BROWSER_PIP_FADE_MILLIS,
  BROWSER_PIP_LINGER_MILLIS,
  initialBrowserPipState,
  reduceBrowserPipState,
} from "./browserPipState";
import { acquireBrowserStream } from "./browserStreamPool";

const HIDDEN_BROWSER_STATE_REFRESH_INTERVAL_MS = 15_000;

export interface BrowserPanelController {
  readonly close: () => void;
  readonly open: boolean;
  readonly pictureInPicture: ReactNode;
  readonly running: boolean;
  readonly toggle: () => void;
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
    if (!input.enabled || !input.showAgentPreview || state.authorization === "denied") return;
    const subscription = acquireBrowserStream({
      environmentId: input.environmentId,
      threadId: input.threadId,
      onEvent: (event) => {
        if ("agentActive" in event) {
          dispatchPip({ type: "activity", active: event.agentActive });
        } else {
          dispatch({ type: "event", event });
          if (event._tag === "Status") {
            dispatchPip({ type: "status", status: event.status });
          }
        }
      },
      onConnectionState: (connectionState) => {
        if (connectionState === "closed") {
          dispatchPip({ type: "activity", active: false });
        }
      },
      onAuthorizationDenied: () => {
        dispatch({ type: "authorizationDenied" });
        dispatchPip({ type: "status", status: "stopped" });
      },
    });
    return subscription.dispose;
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
          threadId={input.threadId}
          visible={input.enabled && open}
        />
      ),
    }),
    [close, input.enabled, input.environmentId, input.threadId, onStateAction, open, state],
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
        environmentId={input.environmentId}
        onClose={() => dispatchPip({ type: "close" })}
        onOpenPanel={() => {
          dispatchPip({ type: "panelVisibility", open: true });
          openRightPanel("browser");
        }}
        phase={pipState.phase}
        threadId={input.threadId}
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
