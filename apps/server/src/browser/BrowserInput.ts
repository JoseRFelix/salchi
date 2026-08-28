import type { BrowserInputEvent, BrowserPointerButton } from "@salchi/contracts";

export const BROWSER_INPUT_RATE_LIMIT = 200;
export const BROWSER_INPUT_RATE_WINDOW_MS = 1_000;

export interface BrowserFrameDimensions {
  readonly width: number;
  readonly height: number;
}

interface BrowserCdpMouseCommand {
  readonly _tag: "Mouse";
  readonly params: {
    readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
    readonly x: number;
    readonly y: number;
    readonly button?: BrowserPointerButton;
    readonly buttons?: number;
    readonly clickCount?: number;
    readonly deltaX?: number;
    readonly deltaY?: number;
  };
}

interface BrowserCdpKeyCommand {
  readonly _tag: "Key";
  readonly params: {
    readonly type: "keyDown" | "keyUp";
    readonly key: string;
    readonly code: string;
    readonly modifiers: number;
    readonly text?: string;
    readonly unmodifiedText?: string;
    readonly windowsVirtualKeyCode?: number;
    readonly nativeVirtualKeyCode?: number;
  };
}

interface BrowserCdpInsertTextCommand {
  readonly _tag: "InsertText";
  readonly params: { readonly text: string };
}

export type BrowserCdpInputCommand =
  | BrowserCdpMouseCommand
  | BrowserCdpKeyCommand
  | BrowserCdpInsertTextCommand;

const POINTER_BUTTON_BITS: Readonly<Record<BrowserPointerButton, number>> = {
  none: 0,
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
};

const VIRTUAL_KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

export function clampBrowserInputCoordinate(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(0, maximum));
}

function keyCommand(event: Extract<BrowserInputEvent, { readonly _tag: "KeyDown" | "KeyUp" }>) {
  const virtualKeyCode = VIRTUAL_KEY_CODES[event.key];
  const printable =
    event._tag === "KeyDown" &&
    event.key.length === 1 &&
    // Ctrl, Meta, and Alt combinations represent shortcuts rather than text.
    (event.modifiers & 0b0111) === 0;
  return {
    _tag: "Key",
    params: {
      type: event._tag === "KeyDown" ? "keyDown" : "keyUp",
      key: event.key,
      code: event.code,
      modifiers: event.modifiers,
      ...(printable ? { text: event.key, unmodifiedText: event.key } : {}),
      ...(virtualKeyCode === undefined
        ? {}
        : {
            windowsVirtualKeyCode: virtualKeyCode,
            nativeVirtualKeyCode: virtualKeyCode,
          }),
    },
  } satisfies BrowserCdpKeyCommand;
}

export function toBrowserCdpInputCommand(
  event: BrowserInputEvent,
  frame: BrowserFrameDimensions,
): BrowserCdpInputCommand {
  switch (event._tag) {
    case "PointerDown":
    case "PointerUp":
    case "PointerMove": {
      const type =
        event._tag === "PointerDown"
          ? "mousePressed"
          : event._tag === "PointerUp"
            ? "mouseReleased"
            : "mouseMoved";
      return {
        _tag: "Mouse",
        params: {
          type,
          x: clampBrowserInputCoordinate(event.x, frame.width),
          y: clampBrowserInputCoordinate(event.y, frame.height),
          button: event.button,
          buttons: event._tag === "PointerUp" ? 0 : POINTER_BUTTON_BITS[event.button],
          clickCount: event.clickCount,
        },
      };
    }
    case "Wheel":
      return {
        _tag: "Mouse",
        params: {
          type: "mouseWheel",
          x: clampBrowserInputCoordinate(event.x, frame.width),
          y: clampBrowserInputCoordinate(event.y, frame.height),
          button: "none",
          buttons: 0,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        },
      };
    case "KeyDown":
    case "KeyUp":
      return keyCommand(event);
    case "InsertText":
      return { _tag: "InsertText", params: { text: event.text } };
  }
}

export interface BrowserInputRateLimiter {
  readonly tryAcquire: () => boolean;
}

export function makeBrowserInputRateLimiter(options?: {
  readonly limit?: number;
  readonly now?: () => number;
  readonly windowMs?: number;
}): BrowserInputRateLimiter {
  const limit = Math.max(1, Math.floor(options?.limit ?? BROWSER_INPUT_RATE_LIMIT));
  const now = options?.now ?? Date.now;
  const windowMs = Math.max(1, options?.windowMs ?? BROWSER_INPUT_RATE_WINDOW_MS);
  const acceptedAt: number[] = [];

  return {
    tryAcquire: () => {
      const currentTime = now();
      while (acceptedAt.length > 0 && (acceptedAt[0] ?? currentTime) <= currentTime - windowMs) {
        acceptedAt.shift();
      }
      if (acceptedAt.length >= limit) return false;
      acceptedAt.push(currentTime);
      return true;
    },
  };
}
