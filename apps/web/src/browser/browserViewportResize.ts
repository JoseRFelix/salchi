export const BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MILLIS = 500;

export interface BrowserViewportContentSize {
  readonly height: number;
  readonly width: number;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface BrowserViewportResizeController {
  readonly activate: (size: BrowserViewportContentSize) => void;
  readonly deactivate: () => void;
  readonly dispose: () => void;
  readonly resize: (size: BrowserViewportContentSize) => void;
  readonly resend: () => void;
}

function normalizeContentSize(size: BrowserViewportContentSize): BrowserViewportContentSize | null {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function sameSize(
  left: BrowserViewportContentSize | null,
  right: BrowserViewportContentSize,
): boolean {
  return left?.width === right.width && left.height === right.height;
}

export function createBrowserViewportResizeController(options: {
  readonly cancelTimer?: (handle: TimerHandle) => void;
  readonly debounceMillis?: number;
  readonly onRelease: () => void;
  readonly onSet: (size: BrowserViewportContentSize) => void;
  readonly scheduleTimer?: (callback: () => void, delay: number) => TimerHandle;
}): BrowserViewportResizeController {
  const cancelTimer = options.cancelTimer ?? globalThis.clearTimeout;
  const scheduleTimer = options.scheduleTimer ?? globalThis.setTimeout;
  const debounceMillis = options.debounceMillis ?? BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MILLIS;
  let active = false;
  let disposed = false;
  let latestSize: BrowserViewportContentSize | null = null;
  let sentSize: BrowserViewportContentSize | null = null;
  let timer: TimerHandle | null = null;

  const cancelPending = () => {
    if (timer === null) return;
    cancelTimer(timer);
    timer = null;
  };
  const sendLatest = (force: boolean) => {
    timer = null;
    if (!active || latestSize === null || (!force && sameSize(sentSize, latestSize))) return;
    sentSize = latestSize;
    options.onSet(latestSize);
  };
  const deactivate = () => {
    if (!active) return;
    active = false;
    cancelPending();
    sentSize = null;
    options.onRelease();
  };

  return {
    activate: (size) => {
      if (disposed) return;
      const normalized = normalizeContentSize(size);
      if (normalized === null) return;
      latestSize = normalized;
      active = true;
      cancelPending();
      sendLatest(true);
    },
    deactivate,
    dispose: () => {
      if (disposed) return;
      deactivate();
      disposed = true;
    },
    resize: (size) => {
      if (disposed) return;
      const normalized = normalizeContentSize(size);
      if (normalized === null) return;
      latestSize = normalized;
      if (!active || sameSize(sentSize, normalized)) return;
      cancelPending();
      timer = scheduleTimer(() => sendLatest(false), debounceMillis);
    },
    resend: () => {
      if (disposed || !active || latestSize === null) return;
      cancelPending();
      sendLatest(true);
    },
  };
}
