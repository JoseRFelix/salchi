import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { BrowserStreamViewportFrame } from "./browserStreamConnection";
import { createBrowserBinaryFrameRenderer, type LatestFrameRenderer } from "./latestFrameRenderer";

export interface BrowserCanvasRenderer<TFrame extends BrowserStreamViewportFrame> {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly currentFrameRef: RefObject<TFrame | null>;
  readonly hasFrame: boolean;
  readonly pushFrame: (frame: TFrame) => void;
  readonly reset: () => void;
}

/**
 * Shared panel/PiP canvas lifecycle: one latest-wins decoder, rAF paint,
 * high-DPI letterbox drawing, pending-frame handoff, and resize redraw.
 */
export function useBrowserCanvasRenderer<TFrame extends BrowserStreamViewportFrame>(input: {
  readonly enabled: boolean;
  readonly onRendered?: (frame: TFrame) => void;
  readonly resetKey: string;
}): BrowserCanvasRenderer<TFrame> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentFrameRef = useRef<TFrame | null>(null);
  const rendererRef = useRef<LatestFrameRenderer<TFrame> | null>(null);
  const pendingFrameRef = useRef<TFrame | null>(null);
  const hasFrameRef = useRef(false);
  const onRenderedRef = useRef(input.onRendered);
  onRenderedRef.current = input.onRendered;
  const [hasFrame, setHasFrame] = useState(false);

  const reset = useCallback(() => {
    currentFrameRef.current = null;
    pendingFrameRef.current = null;
    hasFrameRef.current = false;
    setHasFrame(false);
  }, []);

  const pushFrame = useCallback((frame: TFrame) => {
    currentFrameRef.current = frame;
    if (!hasFrameRef.current) {
      hasFrameRef.current = true;
      setHasFrame(true);
    }
    const renderer = rendererRef.current;
    if (renderer === null) pendingFrameRef.current = frame;
    else renderer.push(frame);
  }, []);

  useEffect(() => {
    reset();
  }, [input.resetKey, reset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!input.enabled || canvas === null) return;

    const renderer = createBrowserBinaryFrameRenderer<TFrame>(canvas, {
      onRendered: (frame) => onRenderedRef.current?.(frame),
    });
    rendererRef.current = renderer;
    if (pendingFrameRef.current !== null) {
      renderer.push(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }

    const redraw = () => renderer.redraw();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(redraw) : null;
    observer?.observe(canvas);
    if (observer === null) window.addEventListener("resize", redraw);

    return () => {
      if (rendererRef.current === renderer) rendererRef.current = null;
      observer?.disconnect();
      if (observer === null) window.removeEventListener("resize", redraw);
      renderer.dispose();
    };
  }, [input.enabled, input.resetKey]);

  return { canvasRef, currentFrameRef, hasFrame, pushFrame, reset };
}
