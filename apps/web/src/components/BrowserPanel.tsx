import type {
  BrowserInputEvent,
  BrowserSessionState,
  BrowserViewportFrame,
  EnvironmentId,
  ThreadId,
} from "@salchi/contracts";
import {
  AppWindowIcon,
  ArrowRightIcon,
  CircleStopIcon,
  KeyboardIcon,
  LockKeyholeIcon,
  MousePointer2Icon,
  PanelRightCloseIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  browserErrorMessage,
  browserTabLabel,
  isBrowserAuthorizationError,
  isBrowserAuthorizationErrorMessage,
  type BrowserViewportState,
  type BrowserViewportStateAction,
} from "../browser/browserViewportState";
import { browserAddressValue, resolveBrowserAddress } from "../browser/browserAddress";
import {
  browserKeyboardModifiers,
  mapCanvasPointToBrowserFrame,
  type BrowserFramePoint,
} from "../browser/browserInput";
import {
  createBrowserFrameRenderer,
  type LatestFrameRenderer,
} from "../browser/latestFrameRenderer";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { isTransportConnectionErrorMessage } from "../rpc/transportError";
import type { WsRpcClient } from "../rpc/wsRpcClient";
import { cn } from "../lib/utils";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { useRightPanelSheetOpen } from "./RightPanelSheet";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const NOOP = () => undefined;
const DOUBLE_TAP_DISTANCE_PX = 24;
const DOUBLE_TAP_WINDOW_MS = 350;
const TOUCH_CLICK_DRAG_HOLD_MS = 450;
const TOUCH_SCROLL_THRESHOLD_PX = 8;

type BrowserClient = WsRpcClient["browser"];
type PendingOperation = "close-tab" | "navigate" | "open-tab" | "set-active-tab" | "start" | "stop";
type BrowserPointerButton = Extract<BrowserInputEvent, { readonly _tag: "PointerDown" }>["button"];

interface ActivePointerGesture {
  readonly button: BrowserPointerButton;
  readonly clickCount: number;
  holdTimer: number | null;
  lastPoint: BrowserFramePoint;
  mode: "mouse-drag" | "touch-drag" | "touch-pending" | "touch-scroll";
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startPoint: BrowserFramePoint;
  readonly targetId: string;
}

interface PendingPointerMove {
  readonly event: Extract<BrowserInputEvent, { readonly _tag: "PointerMove" }>;
  readonly targetId: string;
}

function pointerButtonFromEvent(button: number): BrowserPointerButton {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
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

function BrowserEmptyState(props: {
  readonly actionLabel?: string;
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly loading?: boolean;
  readonly onAction?: () => void;
  readonly title: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.actionLabel && props.onAction ? (
        <EmptyContent>
          <Button disabled={props.loading} onClick={props.onAction}>
            {props.loading ? <Spinner className="size-4" /> : null}
            {props.actionLabel}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

export function BrowserPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly mode: Extract<DiffPanelMode, "sheet" | "sidebar">;
  readonly onClose: () => void;
  readonly onStateAction: (action: BrowserViewportStateAction) => void;
  readonly state: BrowserViewportState;
  readonly threadId: ThreadId;
  readonly visible: boolean;
}) {
  const sheetOpen = useRightPanelSheetOpen();
  const documentVisible = useDocumentVisible();
  const actuallyVisible = props.visible && sheetOpen && documentVisible;
  const shouldSubscribe =
    actuallyVisible &&
    props.state.threadId === props.threadId &&
    props.state.authorization !== "denied";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const mobileKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  const frameRendererRef = useRef<LatestFrameRenderer<BrowserViewportFrame> | null>(null);
  const pendingFrameRef = useRef<BrowserViewportFrame | null>(null);
  const currentFrameRef = useRef<BrowserViewportFrame | null>(null);
  const inputDispatchTailRef = useRef<Promise<void>>(Promise.resolve());
  const activePointerGestureRef = useRef<ActivePointerGesture | null>(null);
  const pendingPointerMoveRef = useRef<PendingPointerMove | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const lastTouchTapRef = useRef<{
    readonly at: number;
    readonly clientX: number;
    readonly clientY: number;
  } | null>(null);
  const operationGenerationRef = useRef(0);
  const autoOpenCheckedRef = useRef(false);
  const displayedActiveTargetId =
    props.state.optimisticActiveTargetId ??
    props.state.tabs.find((tab) => tab.active)?.targetId ??
    null;
  const displayedActiveTab =
    props.state.tabs.find((tab) => tab.targetId === displayedActiveTargetId) ?? null;
  const displayedActiveUrl = browserAddressValue(displayedActiveTab?.url ?? "");
  const hasWebsiteUrl = displayedActiveUrl.length > 0;
  const [hasFrame, setHasFrame] = useState(false);
  const [interactEnabled, setInteractEnabled] = useState(false);
  const [live, setLive] = useState(false);
  const [addressValue, setAddressValue] = useState(() => displayedActiveUrl);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);

  const pauseFrame = useCallback(() => {
    setLive(false);
  }, []);
  const acceptFrame = useCallback((frame: BrowserViewportFrame) => {
    currentFrameRef.current = frame;
    setHasFrame(true);
    setLive(true);

    const renderer = frameRendererRef.current;
    if (renderer) {
      renderer.push(frame);
    } else {
      pendingFrameRef.current = frame;
    }
  }, []);

  useEffect(() => {
    pendingFrameRef.current = null;
    currentFrameRef.current = null;
    setHasFrame(false);
    setInteractEnabled(false);
    pauseFrame();
  }, [pauseFrame, props.threadId]);

  useEffect(() => {
    setAddressValue(browserAddressValue(displayedActiveTab?.url ?? ""));
  }, [displayedActiveTab?.targetId, displayedActiveTab?.url, props.threadId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || props.state.status !== "running") return;

    const renderer = createBrowserFrameRenderer(canvas);
    frameRendererRef.current = renderer;
    if (pendingFrameRef.current) {
      renderer.push(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }

    const redraw = () => renderer.redraw();
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(redraw) : null;
    if (resizeObserver) {
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener("resize", redraw);
    }

    return () => {
      if (frameRendererRef.current === renderer) frameRendererRef.current = null;
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", redraw);
      renderer.dispose();
    };
  }, [hasWebsiteUrl, props.state.status, props.threadId]);

  useEffect(() => {
    if (!shouldSubscribe) {
      pauseFrame();
      return;
    }

    let disposed = false;
    let currentClient: BrowserClient | null = null;
    let currentUnsubscribe: () => void = NOOP;
    let connectionGeneration = 0;

    const connect = (client: BrowserClient) => {
      connectionGeneration += 1;
      const generation = connectionGeneration;
      let streamUnsubscribe: () => void = NOOP;

      const startStream = () => {
        if (disposed || generation !== connectionGeneration) return;
        streamUnsubscribe = client.subscribeViewport(
          { threadId: props.threadId },
          (event) => {
            if (disposed || generation !== connectionGeneration) return;
            if (event._tag === "Frame") {
              acceptFrame(event);
              return;
            }
            props.onStateAction({ type: "event", event });
          },
          {
            onResubscribe: pauseFrame,
            onSubscriptionError: (info) => {
              if (
                disposed ||
                generation !== connectionGeneration ||
                !isBrowserAuthorizationErrorMessage(info.error)
              ) {
                return;
              }
              props.onStateAction({ type: "authorizationDenied" });
              streamUnsubscribe();
              if (currentUnsubscribe === streamUnsubscribe) currentUnsubscribe = NOOP;
            },
          },
        );
        if (disposed || generation !== connectionGeneration) {
          streamUnsubscribe();
          return;
        }
        currentUnsubscribe = streamUnsubscribe;
      };

      void client.getState({ threadId: props.threadId }).then(
        (snapshot) => {
          if (disposed || generation !== connectionGeneration) return;
          props.onStateAction({ type: "snapshot", snapshot });
          startStream();
        },
        (error: unknown) => {
          if (disposed || generation !== connectionGeneration) return;
          if (isBrowserAuthorizationError(error)) {
            props.onStateAction({ type: "authorizationDenied" });
            return;
          }
          const message = browserErrorMessage(error, "Unable to subscribe to the browser.");
          props.onStateAction({ type: "operationFailed", error: message });
          if (isTransportConnectionErrorMessage(message)) startStream();
        },
      );
    };

    const syncConnection = () => {
      const nextClient = readEnvironmentConnection(props.environmentId)?.client.browser ?? null;
      if (nextClient === currentClient) return;
      connectionGeneration += 1;
      currentUnsubscribe();
      currentUnsubscribe = NOOP;
      currentClient = nextClient;
      pauseFrame();
      if (nextClient) {
        connect(nextClient);
      } else {
        props.onStateAction({
          type: "operationFailed",
          error: "The environment connection is unavailable.",
        });
      }
    };

    const unsubscribeConnections = subscribeEnvironmentConnections(syncConnection);
    syncConnection();
    return () => {
      disposed = true;
      connectionGeneration += 1;
      unsubscribeConnections();
      currentUnsubscribe();
      pauseFrame();
    };
  }, [
    acceptFrame,
    pauseFrame,
    props.environmentId,
    props.onStateAction,
    props.threadId,
    shouldSubscribe,
  ]);

  useEffect(
    () => () => {
      operationGenerationRef.current += 1;
    },
    [],
  );

  const runOperation = useCallback(
    async (
      operation: PendingOperation,
      execute: (client: BrowserClient) => Promise<BrowserSessionState>,
      failureStatus?: BrowserViewportState["status"],
    ) => {
      operationGenerationRef.current += 1;
      const generation = operationGenerationRef.current;
      setPendingOperation(operation);
      props.onStateAction({ type: "clearOperationError" });
      try {
        const client = readEnvironmentConnection(props.environmentId)?.client.browser;
        if (!client) throw new Error("The environment connection is unavailable.");
        const snapshot = await execute(client);
        if (generation !== operationGenerationRef.current) return;
        props.onStateAction({ type: "snapshot", snapshot });
        return snapshot;
      } catch (error: unknown) {
        if (generation !== operationGenerationRef.current) return;
        if (isBrowserAuthorizationError(error)) {
          props.onStateAction({ type: "authorizationDenied" });
        } else {
          props.onStateAction({
            type: "operationFailed",
            error: browserErrorMessage(error, "The browser operation failed."),
            ...(failureStatus === undefined ? {} : { status: failureStatus }),
          });
        }
      } finally {
        if (generation === operationGenerationRef.current) setPendingOperation(null);
      }
    },
    [props.environmentId, props.onStateAction],
  );

  const dispatchBrowserInput = useCallback(
    (targetId: string, event: BrowserInputEvent) => {
      const client = readEnvironmentConnection(props.environmentId)?.client.browser;
      if (!client) return;
      const execute = async () => {
        try {
          await client.dispatchInput({ threadId: props.threadId, targetId, event });
        } catch (error: unknown) {
          if (isBrowserAuthorizationError(error)) {
            props.onStateAction({ type: "authorizationDenied" });
            return;
          }
          props.onStateAction({
            type: "operationFailed",
            error: browserErrorMessage(error, "Unable to send browser input."),
          });
        }
      };
      inputDispatchTailRef.current = inputDispatchTailRef.current.then(execute, execute);
    },
    [props.environmentId, props.onStateAction, props.threadId],
  );

  const mapPointerCoordinates = useCallback(
    (clientX: number, clientY: number, clampToFrame = false) => {
      const canvas = canvasRef.current;
      const frame = currentFrameRef.current;
      if (
        canvas === null ||
        frame === null ||
        frame.targetId !== displayedActiveTargetId ||
        frame.width <= 0 ||
        frame.height <= 0
      ) {
        return null;
      }
      const bounds = canvas.getBoundingClientRect();
      const point = mapCanvasPointToBrowserFrame({
        bounds,
        clientX,
        clientY,
        devicePixelRatio: window.devicePixelRatio || 1,
        frameWidth: frame.width,
        frameHeight: frame.height,
        clampToFrame,
      });
      return point === null ? null : { point, targetId: frame.targetId };
    },
    [displayedActiveTargetId],
  );

  const flushPendingPointerMove = useCallback(() => {
    if (pointerMoveFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerMoveFrameRef.current);
      pointerMoveFrameRef.current = null;
    }
    const pending = pendingPointerMoveRef.current;
    pendingPointerMoveRef.current = null;
    if (pending !== null) dispatchBrowserInput(pending.targetId, pending.event);
  }, [dispatchBrowserInput]);

  const discardPendingPointerMove = useCallback(() => {
    if (pointerMoveFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerMoveFrameRef.current);
      pointerMoveFrameRef.current = null;
    }
    pendingPointerMoveRef.current = null;
  }, []);

  const queuePointerMove = useCallback(
    (pending: PendingPointerMove) => {
      pendingPointerMoveRef.current = pending;
      if (pointerMoveFrameRef.current !== null) return;
      pointerMoveFrameRef.current = window.requestAnimationFrame(() => {
        pointerMoveFrameRef.current = null;
        const latest = pendingPointerMoveRef.current;
        pendingPointerMoveRef.current = null;
        if (latest !== null) dispatchBrowserInput(latest.targetId, latest.event);
      });
    },
    [dispatchBrowserInput],
  );

  const releaseActiveGesture = useCallback(
    (sendPointerUp: boolean) => {
      const gesture = activePointerGestureRef.current;
      activePointerGestureRef.current = null;
      if (gesture !== null && gesture.holdTimer !== null) {
        window.clearTimeout(gesture.holdTimer);
      }
      if (
        sendPointerUp &&
        gesture !== null &&
        (gesture.mode === "mouse-drag" || gesture.mode === "touch-drag")
      ) {
        flushPendingPointerMove();
        dispatchBrowserInput(gesture.targetId, {
          _tag: "PointerUp",
          x: gesture.lastPoint.x,
          y: gesture.lastPoint.y,
          button: gesture.button,
          clickCount: gesture.clickCount,
        });
      } else {
        discardPendingPointerMove();
      }
    },
    [discardPendingPointerMove, dispatchBrowserInput, flushPendingPointerMove],
  );

  useEffect(() => {
    if (
      !actuallyVisible ||
      props.state.authorization === "denied" ||
      props.state.status !== "running"
    ) {
      setInteractEnabled(false);
    }
  }, [actuallyVisible, props.state.authorization, props.state.status]);

  useEffect(() => {
    if (interactEnabled) return;
    mobileKeyboardInputRef.current?.blur();
    releaseActiveGesture(true);
  }, [interactEnabled, releaseActiveGesture]);

  useEffect(() => () => releaseActiveGesture(true), [releaseActiveGesture]);

  const toggleInteract = useCallback(() => {
    setInteractEnabled((enabled) => {
      const next = !enabled;
      if (next) {
        window.requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
      }
      return next;
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactEnabled || !event.isPrimary) return;
      const mapped = mapPointerCoordinates(event.clientX, event.clientY);
      if (mapped === null) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some browser-test DOM implementations do not expose pointer capture.
      }

      const touch = event.pointerType === "touch";
      const button = touch ? "left" : pointerButtonFromEvent(event.button);
      const clickCount = touch ? 1 : Math.min(2, Math.max(1, event.detail || 1));
      const gesture: ActivePointerGesture = {
        pointerId: event.pointerId,
        mode: touch ? "touch-pending" : "mouse-drag",
        button,
        clickCount,
        targetId: mapped.targetId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPoint: mapped.point,
        lastPoint: mapped.point,
        holdTimer: null,
      };
      activePointerGestureRef.current = gesture;

      if (!touch) {
        dispatchBrowserInput(mapped.targetId, {
          _tag: "PointerDown",
          x: mapped.point.x,
          y: mapped.point.y,
          button,
          clickCount,
        });
        return;
      }

      gesture.holdTimer = window.setTimeout(() => {
        const current = activePointerGestureRef.current;
        if (current !== gesture || current.mode !== "touch-pending") return;
        current.holdTimer = null;
        current.mode = "touch-drag";
        dispatchBrowserInput(current.targetId, {
          _tag: "PointerDown",
          x: current.startPoint.x,
          y: current.startPoint.y,
          button: current.button,
          clickCount: current.clickCount,
        });
      }, TOUCH_CLICK_DRAG_HOLD_MS);
    },
    [dispatchBrowserInput, interactEnabled, mapPointerCoordinates],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactEnabled || !event.isPrimary) return;
      const gesture = activePointerGestureRef.current;
      const mapped = mapPointerCoordinates(
        event.clientX,
        event.clientY,
        gesture?.pointerId === event.pointerId,
      );
      if (mapped === null) return;
      event.preventDefault();
      event.stopPropagation();

      if (gesture === null || gesture.pointerId !== event.pointerId) {
        if (event.pointerType !== "touch") {
          queuePointerMove({
            targetId: mapped.targetId,
            event: {
              _tag: "PointerMove",
              x: mapped.point.x,
              y: mapped.point.y,
              button: "none",
              clickCount: 0,
            },
          });
        }
        return;
      }

      const previousPoint = gesture.lastPoint;
      gesture.lastPoint = mapped.point;

      if (gesture.mode === "touch-pending") {
        const moved = Math.hypot(
          event.clientX - gesture.startClientX,
          event.clientY - gesture.startClientY,
        );
        if (moved < TOUCH_SCROLL_THRESHOLD_PX) return;
        if (gesture.holdTimer !== null) window.clearTimeout(gesture.holdTimer);
        gesture.holdTimer = null;
        gesture.mode = "touch-scroll";
      }

      if (gesture.mode === "touch-scroll") {
        dispatchBrowserInput(gesture.targetId, {
          _tag: "Wheel",
          x: mapped.point.x,
          y: mapped.point.y,
          deltaX: previousPoint.x - mapped.point.x,
          deltaY: previousPoint.y - mapped.point.y,
        });
        return;
      }

      queuePointerMove({
        targetId: gesture.targetId,
        event: {
          _tag: "PointerMove",
          x: mapped.point.x,
          y: mapped.point.y,
          button: gesture.button,
          clickCount: gesture.clickCount,
        },
      });
    },
    [dispatchBrowserInput, interactEnabled, mapPointerCoordinates, queuePointerMove],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const gesture = activePointerGestureRef.current;
      if (!interactEnabled || gesture === null || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const mapped = mapPointerCoordinates(event.clientX, event.clientY, true);
      if (mapped !== null) gesture.lastPoint = mapped.point;
      if (gesture.holdTimer !== null) window.clearTimeout(gesture.holdTimer);
      gesture.holdTimer = null;
      activePointerGestureRef.current = null;

      if (gesture.mode === "touch-pending") {
        const now = Date.now();
        const previousTap = lastTouchTapRef.current;
        const doubleTap =
          previousTap !== null &&
          now - previousTap.at <= DOUBLE_TAP_WINDOW_MS &&
          Math.hypot(event.clientX - previousTap.clientX, event.clientY - previousTap.clientY) <=
            DOUBLE_TAP_DISTANCE_PX;
        const clickCount = doubleTap ? 2 : 1;
        lastTouchTapRef.current = doubleTap
          ? null
          : { at: now, clientX: event.clientX, clientY: event.clientY };
        dispatchBrowserInput(gesture.targetId, {
          _tag: "PointerDown",
          x: gesture.lastPoint.x,
          y: gesture.lastPoint.y,
          button: "left",
          clickCount,
        });
        dispatchBrowserInput(gesture.targetId, {
          _tag: "PointerUp",
          x: gesture.lastPoint.x,
          y: gesture.lastPoint.y,
          button: "left",
          clickCount,
        });
      } else if (gesture.mode === "mouse-drag" || gesture.mode === "touch-drag") {
        flushPendingPointerMove();
        dispatchBrowserInput(gesture.targetId, {
          _tag: "PointerUp",
          x: gesture.lastPoint.x,
          y: gesture.lastPoint.y,
          button: gesture.button,
          clickCount: gesture.clickCount,
        });
      } else {
        discardPendingPointerMove();
      }

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    },
    [
      discardPendingPointerMove,
      dispatchBrowserInput,
      flushPendingPointerMove,
      interactEnabled,
      mapPointerCoordinates,
    ],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointerGestureRef.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      releaseActiveGesture(true);
    },
    [releaseActiveGesture],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      if (!interactEnabled) return;
      const mapped = mapPointerCoordinates(event.clientX, event.clientY);
      if (mapped === null) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchBrowserInput(mapped.targetId, {
        _tag: "Wheel",
        x: mapped.point.x,
        y: mapped.point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    [dispatchBrowserInput, interactEnabled, mapPointerCoordinates],
  );

  const handleCanvasKey = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>, tag: "KeyDown" | "KeyUp") => {
      if (!interactEnabled || event.nativeEvent.isComposing) return;
      const frame = currentFrameRef.current;
      if (frame === null || frame.targetId !== displayedActiveTargetId) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchBrowserInput(frame.targetId, {
        _tag: tag,
        key: event.key,
        code: event.code,
        modifiers: browserKeyboardModifiers(event),
      });
    },
    [dispatchBrowserInput, displayedActiveTargetId, interactEnabled],
  );

  const handleMobileKeyboardKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!interactEnabled || (event.key !== "Enter" && event.key !== "Backspace")) return;
      const frame = currentFrameRef.current;
      if (frame === null || frame.targetId !== displayedActiveTargetId) return;
      event.preventDefault();
      const code = event.key === "Enter" ? "Enter" : "Backspace";
      const modifiers = browserKeyboardModifiers(event);
      dispatchBrowserInput(frame.targetId, {
        _tag: "KeyDown",
        key: event.key,
        code,
        modifiers,
      });
      dispatchBrowserInput(frame.targetId, {
        _tag: "KeyUp",
        key: event.key,
        code,
        modifiers,
      });
    },
    [dispatchBrowserInput, displayedActiveTargetId, interactEnabled],
  );

  const handleMobileTextInput = useCallback(
    (event: React.FormEvent<HTMLInputElement>) => {
      if (!interactEnabled) return;
      const frame = currentFrameRef.current;
      const text = event.currentTarget.value;
      event.currentTarget.value = "";
      if (frame === null || frame.targetId !== displayedActiveTargetId || text.length === 0) return;
      dispatchBrowserInput(frame.targetId, { _tag: "InsertText", text });
    },
    [dispatchBrowserInput, displayedActiveTargetId, interactEnabled],
  );

  const focusMobileKeyboard = useCallback(() => {
    mobileKeyboardInputRef.current?.focus({ preventScroll: true });
  }, []);

  const startBrowser = useCallback(() => {
    props.onStateAction({ type: "startRequested" });
    void runOperation(
      "start",
      (client) => client.start({ threadId: props.threadId }),
      props.state.status === "crashed" ? "crashed" : "stopped",
    );
  }, [props.onStateAction, props.state.status, props.threadId, runOperation]);
  const stopBrowser = useCallback(() => {
    void runOperation("stop", (client) => client.stop({ threadId: props.threadId }));
  }, [props.threadId, runOperation]);
  const setActiveTab = useCallback(
    (targetId: string) => {
      props.onStateAction({ type: "activeTabRequested", targetId });
      void runOperation("set-active-tab", (client) =>
        client.setActiveTab({ threadId: props.threadId, targetId }),
      );
    },
    [props.onStateAction, props.threadId, runOperation],
  );
  const focusAddressBar = useCallback(() => {
    window.requestAnimationFrame(() => {
      addressInputRef.current?.focus();
    });
  }, []);
  const openTab = useCallback(() => {
    void runOperation("open-tab", (client) =>
      client.openTab({ threadId: props.threadId, url: "about:blank" }),
    ).then((snapshot) => {
      if (!snapshot) return;
      setAddressValue("");
      focusAddressBar();
    });
  }, [focusAddressBar, props.threadId, runOperation]);
  useEffect(() => {
    const actuallyVisible = props.visible && sheetOpen && documentVisible;
    if (!actuallyVisible) {
      autoOpenCheckedRef.current = false;
      return;
    }
    if (
      autoOpenCheckedRef.current ||
      pendingOperation !== null ||
      props.state.authorization !== "granted" ||
      props.state.status === null ||
      props.state.status === "starting"
    ) {
      return;
    }

    autoOpenCheckedRef.current = true;
    if (props.state.status === "running" && props.state.tabs.length === 0) openTab();
  }, [
    documentVisible,
    openTab,
    pendingOperation,
    props.state.authorization,
    props.state.status,
    props.state.tabs.length,
    props.visible,
    sheetOpen,
  ]);
  const navigate = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (displayedActiveTargetId === null) return;
      const url = resolveBrowserAddress(addressValue);
      if (url === null) return;
      setAddressValue(browserAddressValue(url));
      void runOperation("navigate", (client) =>
        client.navigate({
          threadId: props.threadId,
          targetId: displayedActiveTargetId,
          url,
        }),
      );
    },
    [addressValue, displayedActiveTargetId, props.threadId, runOperation],
  );
  const closeTab = useCallback(
    (targetId: string) => {
      void runOperation("close-tab", (client) =>
        client.closeTab({ threadId: props.threadId, targetId }),
      ).then((snapshot) => {
        if (snapshot?.tabs.length === 0) props.onClose();
      });
    },
    [props.onClose, props.threadId, runOperation],
  );

  const running = props.state.status === "running";

  let content: React.ReactNode;
  if (props.state.authorization === "denied") {
    content = (
      <BrowserEmptyState
        description="Browser control requires owner access to this Salchi environment."
        icon={<LockKeyholeIcon />}
        title="Owner access required"
      />
    );
  } else if (props.state.status === "stopped") {
    content = (
      <BrowserEmptyState
        actionLabel="Start"
        description={
          props.state.operationError ?? "Start a private Chromium session for this thread."
        }
        icon={<AppWindowIcon />}
        loading={pendingOperation === "start"}
        onAction={startBrowser}
        title="Browser is stopped"
      />
    );
  } else if (props.state.status === "starting") {
    content = (
      <BrowserEmptyState
        description={props.state.operationError ?? "Launching Chromium and restoring its profile…"}
        icon={<Spinner className="size-5" />}
        title="Starting browser"
      />
    );
  } else if (props.state.status === "crashed") {
    content = (
      <BrowserEmptyState
        actionLabel="Restart"
        description={
          props.state.operationError ?? props.state.sessionError ?? "Chromium exited unexpectedly."
        }
        icon={<RotateCcwIcon />}
        loading={pendingOperation === "start"}
        onAction={startBrowser}
        title="Browser crashed"
      />
    );
  } else if (running) {
    content = (
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <form
          className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted/10 px-2 py-1.5"
          onSubmit={navigate}
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Browser address"
            autoCapitalize="none"
            autoComplete="off"
            className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            disabled={pendingOperation !== null || displayedActiveTargetId === null}
            onChange={(event) => setAddressValue(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="Search or enter address"
            ref={addressInputRef}
            spellCheck={false}
            value={addressValue}
          />
          <Button
            aria-label="Navigate"
            disabled={
              pendingOperation !== null ||
              displayedActiveTargetId === null ||
              addressValue.trim().length === 0
            }
            size="icon-xs"
            type="submit"
            variant="ghost"
          >
            {pendingOperation === "navigate" ? (
              <Spinner className="size-3.5" />
            ) : (
              <ArrowRightIcon className="size-3.5" />
            )}
          </Button>
        </form>
        {props.state.operationError ? (
          <div
            className="shrink-0 border-b border-destructive/20 bg-destructive/6 px-3 py-1.5 text-xs text-destructive-foreground"
            role="alert"
          >
            {props.state.operationError}
          </div>
        ) : null}
        {displayedActiveTab === null ? (
          <BrowserEmptyState
            actionLabel="Open tab"
            description="Open a new tab to start browsing."
            icon={<AppWindowIcon />}
            loading={pendingOperation === "open-tab"}
            onAction={openTab}
            title="No open tabs"
          />
        ) : !hasWebsiteUrl ? (
          <BrowserEmptyState
            actionLabel="Enter address"
            description="Search or enter a website address above."
            icon={<SearchIcon />}
            onAction={focusAddressBar}
            title="Browse the web"
          />
        ) : (
          <div
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden bg-zinc-950",
              interactEnabled && "ring-1 ring-inset ring-primary",
            )}
            data-browser-interact={interactEnabled ? "true" : "false"}
          >
            <canvas
              aria-label={
                interactEnabled ? "Interactive browser viewport" : "Live browser viewport"
              }
              className={cn(
                "block h-full w-full transition-opacity duration-200",
                hasFrame && !live && "opacity-55",
                interactEnabled && "touch-none cursor-crosshair select-none outline-none",
              )}
              onContextMenu={(event) => {
                if (interactEnabled) event.preventDefault();
              }}
              onKeyDown={(event) => handleCanvasKey(event, "KeyDown")}
              onKeyUp={(event) => handleCanvasKey(event, "KeyUp")}
              onPointerCancel={handlePointerCancel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onWheel={handleWheel}
              ref={canvasRef}
              role={interactEnabled ? "application" : "img"}
              tabIndex={interactEnabled ? 0 : -1}
            />
            <input
              aria-label="Browser mobile keyboard input"
              autoCapitalize="none"
              autoComplete="off"
              className="fixed bottom-0 left-0 h-px w-px opacity-0"
              inputMode="text"
              onInput={handleMobileTextInput}
              onKeyDown={handleMobileKeyboardKeyDown}
              ref={mobileKeyboardInputRef}
              spellCheck={false}
              tabIndex={-1}
            />
            {!hasFrame ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
                Waiting for a viewport frame…
              </div>
            ) : !live ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-xs text-zinc-300 backdrop-blur-sm">
                  Paused
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  } else {
    content = (
      <BrowserEmptyState
        description={props.state.operationError ?? "Reading this thread's browser state…"}
        icon={<Spinner className="size-5" />}
        title="Checking browser"
      />
    );
  }

  return (
    <DiffPanelShell mode={props.mode}>
      <div
        className="flex shrink-0 items-center border-b border-border/60 px-2 py-1"
        data-browser-tabs-toolbar="true"
      >
        <div className="browser-tab-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {running
            ? props.state.tabs.map((tab) => {
                const label = browserTabLabel(tab);
                const active = tab.targetId === displayedActiveTargetId;
                return (
                  <div
                    className={cn(
                      "group/tab flex h-6 min-w-0 shrink-0 items-center rounded-md border text-xs transition-colors",
                      active
                        ? "border-primary/30 bg-primary/10 text-foreground"
                        : "border-border/60 bg-muted/25 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                    key={tab.targetId}
                  >
                    <button
                      aria-pressed={active}
                      className="max-w-40 truncate py-0.5 pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={pendingOperation !== null}
                      onClick={() => setActiveTab(tab.targetId)}
                      title={tab.title || (tab.url === "about:blank" ? "New tab" : tab.url)}
                      type="button"
                    >
                      {label}
                    </button>
                    <button
                      aria-label={`Close ${label}`}
                      className="mr-0.5 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground/60 outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={pendingOperation !== null}
                      onClick={() => closeTab(tab.targetId)}
                      type="button"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </div>
                );
              })
            : null}
          {running ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open new browser tab"
                    className="rounded-md"
                    disabled={pendingOperation !== null}
                    onClick={openTab}
                    size="icon-xs"
                    variant="ghost"
                  />
                }
              >
                {pendingOperation === "open-tab" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="bottom">Open new tab</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <div className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-border/60 pl-1">
          {running ? (
            <>
              <Button
                aria-label={interactEnabled ? "Disable browser interaction" : "Interact"}
                aria-pressed={interactEnabled}
                disabled={!hasFrame || !hasWebsiteUrl}
                onClick={toggleInteract}
                size="xs"
                variant={interactEnabled ? "secondary" : "ghost"}
              >
                <MousePointer2Icon className="size-3.5" />
                Interact
              </Button>
              {interactEnabled ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Open browser keyboard"
                        onClick={focusMobileKeyboard}
                        size="icon-xs"
                        variant="ghost"
                      />
                    }
                  >
                    <KeyboardIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Open keyboard</TooltipPopup>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Stop browser"
                      disabled={pendingOperation !== null}
                      onClick={stopBrowser}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  {pendingOperation === "stop" ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <CircleStopIcon className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="bottom">Stop browser</TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          <Button
            aria-label="Close browser panel"
            onClick={props.onClose}
            size="icon-xs"
            variant="ghost"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      {content}
    </DiffPanelShell>
  );
}
