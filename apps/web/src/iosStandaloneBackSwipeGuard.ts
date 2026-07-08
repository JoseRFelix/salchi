import { isStandalonePwa } from "./env";

export const IOS_HISTORY_SWIPE_EDGE_WIDTH_PX = 32;
export const IOS_EDGE_TAP_SLOP_PX = 10;
export const IOS_EDGE_TAP_MAX_DURATION_MS = 700;

export type IosStandaloneBackSwipeGuardEnvironment = {
  readonly isStandalonePwa: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string;
  readonly userAgent: string;
};

type InstallIosStandaloneBackSwipeGuardOptions = {
  readonly window?: Window;
  readonly isStandalonePwa?: () => boolean;
};

type TouchStartInput = {
  readonly cancelable: boolean;
  readonly clientX: number | null;
  readonly defaultPrevented: boolean;
  readonly edgeWidth?: number;
  readonly targetAllowsNativeTouch?: boolean;
  readonly touchCount: number;
  readonly viewportWidth: number;
};

type PendingEdgeTap = {
  readonly identifier: number;
  readonly startTime: number;
  readonly startX: number;
  readonly startY: number;
  readonly target: EventTarget | null;
  readonly moved: boolean;
};

type SyntheticEdgeTapCoordinates = {
  readonly clientX: number;
  readonly clientY: number;
};

type SyntheticTapWindowConstructors = Window & {
  readonly Element?: typeof Element;
  readonly HTMLElement?: typeof HTMLElement;
  readonly MouseEvent?: typeof MouseEvent;
};

const NATIVE_TOUCH_BEHAVIOR_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  ".xterm",
  "[data-ios-back-swipe-guard-allow='true']",
].join(",");

export function isNativeTouchBehaviorTarget(target: EventTarget | null): boolean {
  if (!target) {
    return false;
  }

  const ownerDocument =
    typeof target === "object" && "ownerDocument" in target
      ? (target.ownerDocument as Document | null | undefined)
      : undefined;
  const ElementConstructor =
    ownerDocument?.defaultView?.Element ?? (typeof Element === "undefined" ? undefined : Element);

  if (!ElementConstructor || !(target instanceof ElementConstructor)) {
    return false;
  }

  return target.closest(NATIVE_TOUCH_BEHAVIOR_SELECTOR) !== null;
}

export function isIosTouchDevice(
  input: Pick<IosStandaloneBackSwipeGuardEnvironment, "maxTouchPoints" | "platform" | "userAgent">,
): boolean {
  const platform = input.platform.toLowerCase();
  const userAgent = input.userAgent.toLowerCase();

  return (
    userAgent.includes("iphone") ||
    userAgent.includes("ipad") ||
    userAgent.includes("ipod") ||
    (platform === "macintel" && input.maxTouchPoints > 1)
  );
}

export function shouldInstallIosStandaloneBackSwipeGuard(
  environment: IosStandaloneBackSwipeGuardEnvironment,
): boolean {
  return environment.isStandalonePwa && isIosTouchDevice(environment);
}

export function isHistorySwipeEdgeTouch(input: {
  readonly clientX: number;
  readonly edgeWidth?: number;
  readonly viewportWidth: number;
}): boolean {
  if (input.viewportWidth <= 0) {
    return false;
  }

  const edgeWidth = Math.min(
    Math.max(input.edgeWidth ?? IOS_HISTORY_SWIPE_EDGE_WIDTH_PX, 0),
    input.viewportWidth / 2,
  );

  return input.clientX <= edgeWidth || input.clientX >= input.viewportWidth - edgeWidth;
}

export function shouldPreventIosHistorySwipeTouchStart(input: TouchStartInput): boolean {
  if (
    !input.cancelable ||
    input.defaultPrevented ||
    input.touchCount !== 1 ||
    input.clientX === null ||
    input.targetAllowsNativeTouch === true
  ) {
    return false;
  }

  return isHistorySwipeEdgeTouch({
    clientX: input.clientX,
    ...(input.edgeWidth === undefined ? {} : { edgeWidth: input.edgeWidth }),
    viewportWidth: input.viewportWidth,
  });
}

export function isSyntheticEdgeTap({
  deltaX,
  deltaY,
  durationMs,
  maxDurationMs = IOS_EDGE_TAP_MAX_DURATION_MS,
  slopPx = IOS_EDGE_TAP_SLOP_PX,
}: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly durationMs: number;
  readonly maxDurationMs?: number;
  readonly slopPx?: number;
}): boolean {
  return Math.hypot(deltaX, deltaY) <= slopPx && durationMs <= maxDurationMs;
}

export function installIosStandaloneBackSwipeGuard(
  options: InstallIosStandaloneBackSwipeGuardOptions = {},
): () => void {
  const targetWindow = options.window ?? (typeof window === "undefined" ? undefined : window);
  if (!targetWindow) {
    return () => {};
  }

  const environment = {
    isStandalonePwa: options.isStandalonePwa?.() ?? isStandalonePwa(),
    maxTouchPoints: targetWindow.navigator.maxTouchPoints ?? 0,
    platform: targetWindow.navigator.platform ?? "",
    userAgent: targetWindow.navigator.userAgent ?? "",
  };

  if (!shouldInstallIosStandaloneBackSwipeGuard(environment)) {
    return () => {};
  }

  let pendingTap: PendingEdgeTap | null = null;

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      pendingTap = null;
      return;
    }

    const touch = getFirstTouch(event.touches);
    if (!touch) {
      pendingTap = null;
      return;
    }

    if (
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: event.cancelable,
        clientX: touch.clientX,
        defaultPrevented: event.defaultPrevented,
        targetAllowsNativeTouch: isNativeTouchBehaviorTarget(event.target),
        touchCount: event.touches.length,
        viewportWidth: getViewportWidth(targetWindow),
      })
    ) {
      event.preventDefault();
      pendingTap = {
        identifier: touch.identifier,
        moved: false,
        startTime: getNow(targetWindow),
        startX: touch.clientX,
        startY: touch.clientY,
        target: event.target,
      };
      return;
    }

    pendingTap = null;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!pendingTap) {
      return;
    }

    if (event.touches.length !== 1) {
      pendingTap = null;
      return;
    }

    const touch = Array.from(event.touches).find(
      (currentTouch) => currentTouch.identifier === pendingTap?.identifier,
    );
    if (!touch) {
      pendingTap = null;
      return;
    }

    if (
      Math.hypot(touch.clientX - pendingTap.startX, touch.clientY - pendingTap.startY) >
      IOS_EDGE_TAP_SLOP_PX
    ) {
      pendingTap = { ...pendingTap, moved: true };
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (!pendingTap) {
      return;
    }

    const touch = Array.from(event.changedTouches).find(
      (changedTouch) => changedTouch.identifier === pendingTap?.identifier,
    );
    if (!touch) {
      return;
    }

    const tap = pendingTap;
    pendingTap = null;
    if (
      tap.moved ||
      event.defaultPrevented ||
      !isSyntheticEdgeTap({
        deltaX: touch.clientX - tap.startX,
        deltaY: touch.clientY - tap.startY,
        durationMs: getNow(targetWindow) - tap.startTime,
      })
    ) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    dispatchSyntheticEdgeTap(tap.target, targetWindow, {
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
  };

  const onTouchCancel = () => {
    pendingTap = null;
  };

  targetWindow.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: false,
  });
  targetWindow.addEventListener("touchmove", onTouchMove, { passive: true });
  targetWindow.addEventListener("touchend", onTouchEnd, { passive: false });
  targetWindow.addEventListener("touchcancel", onTouchCancel, { passive: true });

  return () => {
    targetWindow.removeEventListener("touchstart", onTouchStart, true);
    targetWindow.removeEventListener("touchmove", onTouchMove);
    targetWindow.removeEventListener("touchend", onTouchEnd);
    targetWindow.removeEventListener("touchcancel", onTouchCancel);
  };
}

function getFirstTouch(touches: TouchList): Touch | null {
  const firstTouch = touches.item(0);
  return typeof firstTouch?.clientX === "number" ? firstTouch : null;
}

function getViewportWidth(targetWindow: Window): number {
  return targetWindow.innerWidth || targetWindow.document.documentElement.clientWidth || 0;
}

function getNow(targetWindow: Window): number {
  return targetWindow.performance?.now() ?? Date.now();
}

function dispatchSyntheticEdgeTap(
  target: EventTarget | null,
  targetWindow: Window,
  coordinates: SyntheticEdgeTapCoordinates,
): void {
  const constructors = targetWindow as SyntheticTapWindowConstructors;
  const ElementConstructor =
    constructors.Element ?? (typeof Element === "undefined" ? undefined : Element);
  if (!ElementConstructor || !(target instanceof ElementConstructor) || !target.isConnected) {
    return;
  }

  const element = target;
  const HTMLElementConstructor =
    constructors.HTMLElement ?? (typeof HTMLElement === "undefined" ? undefined : HTMLElement);
  const MouseEventConstructor =
    constructors.MouseEvent ?? (typeof MouseEvent === "undefined" ? undefined : MouseEvent);
  if (!MouseEventConstructor) {
    return;
  }

  const eventInit: MouseEventInit = {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: coordinates.clientX,
    clientY: coordinates.clientY,
    detail: 1,
    view: targetWindow,
  };

  element.dispatchEvent(new MouseEventConstructor("mousedown", eventInit));

  if (HTMLElementConstructor && element instanceof HTMLElementConstructor) {
    // Edge-band touchstarts are always claimed so iOS cannot navigate history.
    // Long-press text selection is unavailable on non-exempt edge targets; use
    // data-ios-back-swipe-guard-allow for components that need native touch.
    element.focus({ preventScroll: true });
  }

  element.dispatchEvent(new MouseEventConstructor("mouseup", eventInit));
  element.dispatchEvent(new MouseEventConstructor("click", eventInit));
}
