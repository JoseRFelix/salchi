import { useEffect, useEffectEvent, type RefObject } from "react";

export type HorizontalSwipeDirection = "left" | "right";

const TRACKPAD_SWIPE_CSS_VAR = "--toast-trackpad-swipe-x";
const TRACKPAD_SWIPE_DISMISS_THRESHOLD_PX = 80;
const TRACKPAD_SWIPE_GESTURE_IDLE_MS = 140;
const TRACKPAD_SWIPE_INTENT_THRESHOLD_PX = 4;
const TRACKPAD_SWIPE_HORIZONTAL_INTENT_RATIO = 1.2;
const TRACKPAD_SWIPE_LINE_HEIGHT_PX = 16;

function normalizeWheelDelta(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * TRACKPAD_SWIPE_LINE_HEIGHT_PX;
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * pageSize;
  }
  return delta;
}

function getTrackpadSwipeOffset(
  totalMovementX: number,
  direction: HorizontalSwipeDirection,
): number {
  const outwardSign = direction === "right" ? 1 : -1;
  const outwardMovement = totalMovementX * outwardSign;
  if (outwardMovement >= 0) {
    return totalMovementX;
  }

  // Match Base UI's pointer-swipe resistance when the toast is dragged inward.
  return -outwardSign * Math.sqrt(Math.abs(outwardMovement));
}

export function useTrackpadToastSwipe({
  direction,
  onDismiss,
  rootRef,
}: {
  direction: HorizontalSwipeDirection | null;
  onDismiss: () => void;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const dismiss = useEffectEvent(onDismiss);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !direction) return;

    let axis: "horizontal" | "vertical" | null = null;
    let totalMovementX = 0;
    let horizontalIntent = 0;
    let verticalIntent = 0;
    let lastEventAt = 0;
    let gestureEndTimer: number | null = null;
    let dismissed = false;

    const clearGestureEndTimer = () => {
      if (gestureEndTimer === null) return;
      window.clearTimeout(gestureEndTimer);
      gestureEndTimer = null;
    };

    const resetGesture = (restorePosition: boolean) => {
      clearGestureEndTimer();
      axis = null;
      totalMovementX = 0;
      horizontalIntent = 0;
      verticalIntent = 0;
      lastEventAt = 0;
      root.removeAttribute("data-trackpad-swiping");
      if (restorePosition) {
        root.style.setProperty(TRACKPAD_SWIPE_CSS_VAR, "0px");
      }
    };

    const scheduleGestureEnd = () => {
      clearGestureEndTimer();
      gestureEndTimer = window.setTimeout(() => {
        resetGesture(axis === "horizontal");
      }, TRACKPAD_SWIPE_GESTURE_IDLE_MS);
    };

    const handleWheel = (event: WheelEvent) => {
      if (dismissed) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-base-ui-swipe-ignore],[data-swipe-ignore]")
      ) {
        return;
      }

      const now = performance.now();
      if (lastEventAt > 0 && now - lastEventAt > TRACKPAD_SWIPE_GESTURE_IDLE_MS) {
        resetGesture(axis === "horizontal");
      }
      lastEventAt = now;

      const deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, root.clientWidth);
      const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, root.clientHeight);
      // Wheel deltas describe scroll position, which is opposite the content/finger movement of a
      // Mac trackpad with natural scrolling enabled.
      const movementX = -deltaX;
      totalMovementX += movementX;
      horizontalIntent += Math.abs(deltaX);
      verticalIntent += Math.abs(deltaY);

      if (axis === null) {
        const hasEnoughIntent =
          Math.max(horizontalIntent, verticalIntent) >= TRACKPAD_SWIPE_INTENT_THRESHOLD_PX;
        if (!hasEnoughIntent) {
          scheduleGestureEnd();
          return;
        }
        if (horizontalIntent > verticalIntent * TRACKPAD_SWIPE_HORIZONTAL_INTENT_RATIO) {
          axis = "horizontal";
        } else if (verticalIntent > horizontalIntent * TRACKPAD_SWIPE_HORIZONTAL_INTENT_RATIO) {
          axis = "vertical";
        } else {
          scheduleGestureEnd();
          return;
        }
      }

      scheduleGestureEnd();
      if (axis !== "horizontal") return;

      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      root.setAttribute("data-trackpad-swiping", "");

      const offsetX = getTrackpadSwipeOffset(totalMovementX, direction);
      root.style.setProperty(TRACKPAD_SWIPE_CSS_VAR, `${offsetX}px`);

      const outwardSign = direction === "right" ? 1 : -1;
      if (totalMovementX * outwardSign < TRACKPAD_SWIPE_DISMISS_THRESHOLD_PX) return;

      dismissed = true;
      clearGestureEndTimer();
      root.removeAttribute("data-trackpad-swiping");
      // Reuse Base UI's public swipe-direction state attribute so its existing directional exit
      // animation continues from the live trackpad offset.
      root.setAttribute("data-swipe-direction", direction);
      dismiss();
    };

    root.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      clearGestureEndTimer();
      root.removeEventListener("wheel", handleWheel);
    };
  }, [direction, rootRef]);
}
