import type { EnvironmentId, ThreadId } from "@salchi/contracts";
import * as Schema from "effect/Schema";
import { BotIcon, GripIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserPipPhase } from "../browser/browserPipState";
import type { BrowserStreamViewportFrame } from "../browser/browserStreamConnection";
import { acquireBrowserStream } from "../browser/browserStreamPool";
import {
  createBrowserBinaryFrameRenderer,
  type LatestFrameRenderer,
} from "../browser/latestFrameRenderer";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import { Spinner } from "./ui/spinner";

const DESKTOP_LAYOUT_KEY = "salchi.browserPip.desktopLayout";
const MOBILE_CORNER_KEY = "salchi.browserPip.mobileCorner";
const PIP_MARGIN = 12;
const MIN_PIP_WIDTH = 240;
const MIN_PIP_HEIGHT = 150;

const DesktopLayoutSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
type DesktopLayout = typeof DesktopLayoutSchema.Type;
const DEFAULT_DESKTOP_LAYOUT: DesktopLayout = { x: -1, y: -1, width: 360, height: 225 };

const MobileCornerSchema = Schema.Literals([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
type MobileCorner = typeof MobileCornerSchema.Type;

interface DragState {
  readonly kind: "move" | "resize";
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startLayout: DesktopLayout;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function resolvedDesktopLayout(layout: DesktopLayout, container: HTMLElement): DesktopLayout {
  const width = clamp(layout.width, MIN_PIP_WIDTH, Math.max(MIN_PIP_WIDTH, container.clientWidth));
  const height = clamp(
    layout.height,
    MIN_PIP_HEIGHT,
    Math.max(MIN_PIP_HEIGHT, container.clientHeight),
  );
  const defaultX = container.clientWidth - width - PIP_MARGIN;
  const defaultY = container.clientHeight - height - PIP_MARGIN;
  return {
    x: clamp(layout.x < 0 ? defaultX : layout.x, PIP_MARGIN, container.clientWidth - width),
    y: clamp(layout.y < 0 ? defaultY : layout.y, PIP_MARGIN, container.clientHeight - height),
    width,
    height,
  };
}

function mobileCornerClasses(corner: MobileCorner): string {
  switch (corner) {
    case "top-left":
      return "left-3 top-3";
    case "top-right":
      return "right-3 top-3";
    case "bottom-left":
      return "bottom-3 left-3";
    case "bottom-right":
      return "bottom-3 right-3";
  }
}

export function BrowserPictureInPicture(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onOpenPanel: () => void;
  readonly phase: Exclude<BrowserPipPhase, "hidden">;
  readonly threadId: ThreadId;
}) {
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<LatestFrameRenderer<BrowserStreamViewportFrame> | null>(null);
  const pendingFrameRef = useRef<BrowserStreamViewportFrame | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const transientDesktopLayoutRef = useRef<DesktopLayout | null>(null);
  const transientMobilePositionRef = useRef<{ readonly x: number; readonly y: number } | null>(
    null,
  );
  const [hasFrame, setHasFrame] = useState(false);
  const [desktopLayout, setDesktopLayout] = useLocalStorage(
    DESKTOP_LAYOUT_KEY,
    DEFAULT_DESKTOP_LAYOUT,
    DesktopLayoutSchema,
  );
  const [mobileCorner, setMobileCorner] = useLocalStorage<MobileCorner, MobileCorner>(
    MOBILE_CORNER_KEY,
    "bottom-right",
    MobileCornerSchema,
  );
  const [transientMobilePosition, setTransientMobilePosition] = useState<{
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [transientDesktopLayout, setTransientDesktopLayout] = useState<DesktopLayout | null>(null);

  useEffect(() => {
    const subscription = acquireBrowserStream({
      environmentId: props.environmentId,
      threadId: props.threadId,
      onFrame: (frame) => {
        setHasFrame(true);
        const renderer = rendererRef.current;
        if (renderer) renderer.push(frame);
        else pendingFrameRef.current = frame;
      },
    });
    return subscription.dispose;
  }, [props.environmentId, props.threadId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const renderer = createBrowserBinaryFrameRenderer(canvas);
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
  }, []);

  const beginDrag = useCallback(
    (event: React.PointerEvent, kind: DragState["kind"]) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const root = rootRef.current;
      const container = root?.parentElement;
      if (root === null || container == null) return;
      const layout = isMobile
        ? {
            x: root.offsetLeft,
            y: root.offsetTop,
            width: root.offsetWidth,
            height: root.offsetHeight,
          }
        : resolvedDesktopLayout(desktopLayout, container);
      dragRef.current = {
        kind,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLayout: layout,
      };
      transientDesktopLayoutRef.current = null;
      setTransientDesktopLayout(null);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [desktopLayout, isMobile],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      const container = rootRef.current?.parentElement;
      if (drag === null || drag.pointerId !== event.pointerId || container == null) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;
      if (isMobile) {
        const position = {
          x: clamp(
            drag.startLayout.x + deltaX,
            PIP_MARGIN,
            container.clientWidth - drag.startLayout.width - PIP_MARGIN,
          ),
          y: clamp(
            drag.startLayout.y + deltaY,
            PIP_MARGIN,
            container.clientHeight - drag.startLayout.height - PIP_MARGIN,
          ),
        };
        transientMobilePositionRef.current = position;
        setTransientMobilePosition(position);
        return;
      }
      if (drag.kind === "move") {
        const layout = {
          ...drag.startLayout,
          x: clamp(
            drag.startLayout.x + deltaX,
            PIP_MARGIN,
            container.clientWidth - drag.startLayout.width - PIP_MARGIN,
          ),
          y: clamp(
            drag.startLayout.y + deltaY,
            PIP_MARGIN,
            container.clientHeight - drag.startLayout.height - PIP_MARGIN,
          ),
        };
        transientDesktopLayoutRef.current = layout;
        setTransientDesktopLayout(layout);
        return;
      }
      const width = clamp(
        drag.startLayout.width - deltaX,
        MIN_PIP_WIDTH,
        drag.startLayout.x + drag.startLayout.width - PIP_MARGIN,
      );
      const height = clamp(
        drag.startLayout.height - deltaY,
        MIN_PIP_HEIGHT,
        drag.startLayout.y + drag.startLayout.height - PIP_MARGIN,
      );
      const layout = {
        x: drag.startLayout.x + drag.startLayout.width - width,
        y: drag.startLayout.y + drag.startLayout.height - height,
        width,
        height,
      };
      transientDesktopLayoutRef.current = layout;
      setTransientDesktopLayout(layout);
    },
    [isMobile],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      const container = rootRef.current?.parentElement;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const mobilePosition = transientMobilePositionRef.current;
      if (isMobile && container != null && mobilePosition !== null) {
        const centerX = mobilePosition.x + drag.startLayout.width / 2;
        const centerY = mobilePosition.y + drag.startLayout.height / 2;
        setMobileCorner(
          `${centerY < container.clientHeight / 2 ? "top" : "bottom"}-${
            centerX < container.clientWidth / 2 ? "left" : "right"
          }` as MobileCorner,
        );
        transientMobilePositionRef.current = null;
        setTransientMobilePosition(null);
        return;
      }
      const desktopPosition = transientDesktopLayoutRef.current;
      if (!isMobile && desktopPosition !== null) setDesktopLayout(desktopPosition);
      transientDesktopLayoutRef.current = null;
      setTransientDesktopLayout(null);
    },
    [isMobile, setDesktopLayout, setMobileCorner],
  );

  const parent = rootRef.current?.parentElement;
  const resolvedLayout =
    !isMobile && parent !== undefined && parent !== null
      ? resolvedDesktopLayout(desktopLayout, parent)
      : desktopLayout;
  const displayedDesktopLayout = transientDesktopLayout ?? resolvedLayout;

  return (
    <div
      aria-label="Agent browser preview"
      className={cn(
        "absolute z-40 overflow-hidden rounded-xl border border-border/80 bg-card shadow-xl transition-opacity duration-200",
        props.phase === "fading" ? "opacity-0" : "opacity-100",
        isMobile && transientMobilePosition === null && mobileCornerClasses(mobileCorner),
      )}
      data-testid="browser-picture-in-picture"
      ref={rootRef}
      style={
        isMobile
          ? transientMobilePosition === null
            ? { aspectRatio: "16 / 10", width: "clamp(9rem, 40vw, 14rem)" }
            : {
                aspectRatio: "16 / 10",
                left: transientMobilePosition.x,
                top: transientMobilePosition.y,
                width: "clamp(9rem, 40vw, 14rem)",
              }
          : {
              height: displayedDesktopLayout.height,
              left: displayedDesktopLayout.x < 0 ? undefined : displayedDesktopLayout.x,
              top: displayedDesktopLayout.y < 0 ? undefined : displayedDesktopLayout.y,
              width: displayedDesktopLayout.width,
              ...(displayedDesktopLayout.x < 0 ? { right: PIP_MARGIN } : {}),
              ...(displayedDesktopLayout.y < 0 ? { bottom: PIP_MARGIN } : {}),
            }
      }
    >
      {!isMobile ? (
        <button
          aria-label="Resize browser preview"
          className="absolute left-0 top-0 z-20 size-4 cursor-nwse-resize touch-none"
          onPointerDown={(event) => beginDrag(event, "resize")}
          onPointerMove={moveDrag}
          onPointerCancel={endDrag}
          onPointerUp={endDrag}
          type="button"
        />
      ) : null}
      <div
        className="flex h-8 touch-none items-center gap-1.5 border-b border-border/60 bg-card/95 px-2"
        onPointerDown={(event) => beginDrag(event, "move")}
        onPointerMove={moveDrag}
        onPointerCancel={endDrag}
        onPointerUp={endDrag}
      >
        <BotIcon className="size-3.5 text-primary" />
        <span className="min-w-0 flex-1 truncate font-medium text-[11px]">Agent browsing</span>
        <GripIcon className="size-3.5 text-muted-foreground/70" />
        <button
          aria-label="Close browser preview"
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <button
        aria-label="Open Browser panel"
        className="relative block h-[calc(100%-2rem)] w-full cursor-pointer overflow-hidden bg-black text-left"
        onClick={props.onOpenPanel}
        type="button"
      >
        <canvas className="pointer-events-none size-full" ref={canvasRef} />
        {!hasFrame ? (
          <span className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Spinner className="size-4" />
          </span>
        ) : null}
      </button>
    </div>
  );
}
