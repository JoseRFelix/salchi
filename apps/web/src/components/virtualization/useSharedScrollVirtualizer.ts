import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface FixedVirtualRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

interface ResolveFixedVirtualRangeInput {
  readonly itemCount: number;
  readonly itemStride: number;
  /** Top of the scroll viewport, expressed in list-local pixels. */
  readonly viewportStart: number;
  readonly viewportSize: number;
  readonly overscan: number;
}

interface UseFixedSharedScrollVirtualizerInput {
  readonly enabled: boolean;
  readonly itemCount: number;
  readonly itemStride: number;
  readonly overscan: number;
  readonly initialRenderCount: number;
  readonly listRef: RefObject<HTMLElement | null>;
  readonly scrollViewportRef: RefObject<HTMLElement | null>;
}

function clampIndex(value: number, itemCount: number): number {
  return Math.max(0, Math.min(itemCount, value));
}

export function getFixedVirtualItemStyle(
  index: number,
  itemStride: number,
  inlineInset: CSSProperties["insetInline"] = 0,
): CSSProperties {
  return {
    position: "absolute",
    top: index * itemStride,
    // Absolute percentage widths use the containing block's padding box.
    // Pin both edges and clear any class-provided width so padded lists align.
    insetInline: inlineInset,
    width: "auto",
  };
}

export function resolveFixedVirtualRange({
  itemCount,
  itemStride,
  viewportStart,
  viewportSize,
  overscan,
}: ResolveFixedVirtualRangeInput): FixedVirtualRange {
  const safeItemCount = Math.max(0, Math.floor(itemCount));
  if (safeItemCount === 0 || !Number.isFinite(itemStride) || itemStride <= 0) {
    return { startIndex: 0, endIndex: 0 };
  }

  const safeViewportStart = Number.isFinite(viewportStart) ? viewportStart : 0;
  const safeViewportSize = Number.isFinite(viewportSize) ? Math.max(0, viewportSize) : 0;
  const safeOverscan = Number.isFinite(overscan) ? Math.max(0, overscan) : 0;
  const startIndex = clampIndex(
    Math.floor((safeViewportStart - safeOverscan) / itemStride),
    safeItemCount,
  );
  const endIndex = clampIndex(
    Math.ceil((safeViewportStart + safeViewportSize + safeOverscan) / itemStride),
    safeItemCount,
  );

  return {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
  };
}

function rangesEqual(left: FixedVirtualRange, right: FixedVirtualRange): boolean {
  return left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

export function useFixedSharedScrollVirtualizer({
  enabled,
  itemCount,
  itemStride,
  overscan,
  initialRenderCount,
  listRef,
  scrollViewportRef,
}: UseFixedSharedScrollVirtualizerInput): FixedVirtualRange {
  const safeItemCount = Math.max(0, Math.floor(itemCount));
  const safeInitialRenderCount = Math.max(0, Math.floor(initialRenderCount));
  const [measuredRange, setMeasuredRange] = useState<FixedVirtualRange>(() => ({
    startIndex: 0,
    endIndex: Math.min(safeItemCount, safeInitialRenderCount),
  }));

  const measure = useCallback(() => {
    if (!enabled) {
      return;
    }
    const list = listRef.current;
    const scrollViewport = scrollViewportRef.current;
    if (!list || !scrollViewport) {
      return;
    }

    const listRect = list.getBoundingClientRect();
    const viewportRect = scrollViewport.getBoundingClientRect();
    const nextRange = resolveFixedVirtualRange({
      itemCount,
      itemStride,
      viewportStart: viewportRect.top - listRect.top,
      viewportSize: scrollViewport.clientHeight,
      overscan,
    });
    setMeasuredRange((current) => (rangesEqual(current, nextRange) ? current : nextRange));
  }, [enabled, itemCount, itemStride, listRef, overscan, scrollViewportRef]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    const scrollViewport = scrollViewportRef.current;
    if (!scrollViewport) {
      return;
    }

    let animationFrame: number | null = null;
    const scheduleMeasure = () => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        measure();
      });
    };

    measure();
    scrollViewport.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scrollViewport);
    const list = listRef.current;
    if (list) {
      resizeObserver.observe(list);
    }
    const scrollContent = scrollViewport.querySelector<HTMLElement>('[data-sidebar="content"]');
    if (scrollContent) {
      resizeObserver.observe(scrollContent);
    }
    const mutationObserver = scrollContent ? new MutationObserver(scheduleMeasure) : null;
    if (scrollContent) {
      mutationObserver?.observe(scrollContent, { childList: true, subtree: true });
    }

    return () => {
      scrollViewport.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [enabled, listRef, measure, scrollViewportRef]);

  if (!enabled) {
    return { startIndex: 0, endIndex: safeItemCount };
  }

  return {
    startIndex: clampIndex(measuredRange.startIndex, safeItemCount),
    endIndex: clampIndex(measuredRange.endIndex, safeItemCount),
  };
}
