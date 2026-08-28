import type { BrowserViewportFrame } from "@salchi/contracts";

import { computeBrowserFrameLayout } from "./browserInput";

export interface AnimationFrameScheduler {
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
}

export interface LatestFrameRenderer<TFrame> {
  readonly push: (frame: TFrame) => void;
  readonly redraw: () => void;
  readonly dispose: () => void;
}

interface DecodedBrowserFrame {
  readonly source: CanvasImageSource;
  readonly close: () => void;
}

const browserAnimationFrameScheduler: AnimationFrameScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
};

export function createLatestFrameRenderer<TFrame, TDecoded>(input: {
  readonly decode: (frame: TFrame) => Promise<TDecoded>;
  readonly render: (decoded: TDecoded, frame: TFrame) => void;
  readonly disposeDecoded: (decoded: TDecoded) => void;
  readonly scheduler: AnimationFrameScheduler;
  readonly onDecodeError?: (error: unknown) => void;
}): LatestFrameRenderer<TFrame> {
  let disposed = false;
  let pending: TFrame | null = null;
  let decoding = false;
  let candidate: { readonly decoded: TDecoded; readonly frame: TFrame } | null = null;
  let current: { readonly decoded: TDecoded; readonly frame: TFrame } | null = null;
  let renderFrameHandle: number | null = null;
  let redrawFrameHandle: number | null = null;

  const startDecode = () => {
    if (disposed || decoding || candidate !== null || pending === null) return;

    const frame = pending;
    pending = null;
    decoding = true;

    void input.decode(frame).then(
      (decoded) => {
        decoding = false;
        if (disposed) {
          input.disposeDecoded(decoded);
          return;
        }
        if (pending !== null) {
          input.disposeDecoded(decoded);
          startDecode();
          return;
        }

        candidate = { decoded, frame };
        renderFrameHandle = input.scheduler.requestAnimationFrame(() => {
          renderFrameHandle = null;
          const next = candidate;
          candidate = null;
          if (!next) return;
          if (disposed || pending !== null) {
            input.disposeDecoded(next.decoded);
            startDecode();
            return;
          }

          const previous = current;
          current = next;
          try {
            input.render(next.decoded, next.frame);
          } finally {
            if (previous) input.disposeDecoded(previous.decoded);
          }
          startDecode();
        });
      },
      (error: unknown) => {
        decoding = false;
        if (!disposed) input.onDecodeError?.(error);
        startDecode();
      },
    );
  };

  return {
    push: (frame) => {
      if (disposed) return;
      pending = frame;
      startDecode();
    },
    redraw: () => {
      if (disposed || current === null || redrawFrameHandle !== null) return;
      redrawFrameHandle = input.scheduler.requestAnimationFrame(() => {
        redrawFrameHandle = null;
        if (!disposed && current !== null) input.render(current.decoded, current.frame);
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pending = null;
      if (renderFrameHandle !== null) {
        input.scheduler.cancelAnimationFrame(renderFrameHandle);
        renderFrameHandle = null;
      }
      if (redrawFrameHandle !== null) {
        input.scheduler.cancelAnimationFrame(redrawFrameHandle);
        redrawFrameHandle = null;
      }
      if (candidate) {
        input.disposeDecoded(candidate.decoded);
        candidate = null;
      }
      if (current) {
        input.disposeDecoded(current.decoded);
        current = null;
      }
    },
  };
}

function jpegBlobFromBase64(dataBase64: string): Blob {
  const binary = globalThis.atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/jpeg" });
}

async function decodeBrowserFrame(frame: BrowserViewportFrame): Promise<DecodedBrowserFrame> {
  const blob = jpegBlobFromBase64(frame.dataBase64);
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(blob);
    return { source: bitmap, close: () => bitmap.close() };
  }

  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("Unable to decode browser frame.")), {
        once: true,
      });
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return { source: image, close: () => undefined };
}

export function drawBrowserFrameToCanvas(
  canvas: HTMLCanvasElement,
  decoded: CanvasImageSource,
  frame: Pick<BrowserViewportFrame, "width" | "height">,
): void {
  const cssWidth = Math.max(1, canvas.clientWidth);
  const cssHeight = Math.max(1, canvas.clientHeight);
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.round(cssWidth * pixelRatio);
  const backingHeight = Math.round(cssHeight * pixelRatio);

  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = "#09090b";
  context.fillRect(0, 0, cssWidth, cssHeight);
  if (frame.width <= 0 || frame.height <= 0) return;

  const layout = computeBrowserFrameLayout(cssWidth, cssHeight, frame.width, frame.height);
  if (layout === null) return;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(decoded, layout.drawX, layout.drawY, layout.drawWidth, layout.drawHeight);
}

export function createBrowserFrameRenderer(
  canvas: HTMLCanvasElement,
): LatestFrameRenderer<BrowserViewportFrame> {
  return createLatestFrameRenderer({
    decode: decodeBrowserFrame,
    render: (decoded, frame) => drawBrowserFrameToCanvas(canvas, decoded.source, frame),
    disposeDecoded: (decoded) => decoded.close(),
    scheduler: browserAnimationFrameScheduler,
  });
}
