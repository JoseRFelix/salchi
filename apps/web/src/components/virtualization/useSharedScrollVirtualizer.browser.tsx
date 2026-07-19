import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useRef } from "react";

import {
  getFixedVirtualItemStyle,
  useFixedSharedScrollVirtualizer,
} from "./useSharedScrollVirtualizer";

const ITEM_COUNT = 700;
const ITEM_STRIDE = 30;

function SharedScrollVirtualizerHarness() {
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const range = useFixedSharedScrollVirtualizer({
    enabled: true,
    itemCount: ITEM_COUNT,
    itemStride: ITEM_STRIDE,
    overscan: 60,
    initialRenderCount: 20,
    listRef,
    scrollViewportRef,
  });
  const visibleIndices = Array.from(
    { length: range.endIndex - range.startIndex },
    (_, offset) => range.startIndex + offset,
  );

  return (
    <div ref={scrollViewportRef} data-testid="viewport" style={{ height: 300, overflowY: "auto" }}>
      <div data-sidebar="content">
        <div style={{ height: 100 }}>Header</div>
        <div data-testid="normal-list" style={{ paddingInline: 6 }}>
          <div data-testid="normal-row" style={{ height: 28, position: "relative", width: "100%" }}>
            <button
              data-testid="normal-row-action"
              style={{ height: 24, position: "absolute", right: 2, width: 24 }}
            />
          </div>
        </div>
        <div
          ref={listRef}
          data-testid="virtual-list"
          style={{ height: ITEM_COUNT * ITEM_STRIDE, paddingInline: 6, position: "relative" }}
        >
          {visibleIndices.map((index) => (
            <div
              key={index}
              data-testid="virtual-row"
              data-index={index}
              style={{
                height: 28,
                ...getFixedVirtualItemStyle(index, ITEM_STRIDE, 6),
              }}
            >
              Row {index}
              <button
                data-testid="virtual-row-action"
                style={{ height: 24, position: "absolute", right: 2, width: 24 }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

describe("useFixedSharedScrollVirtualizer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a 700-row list bounded while following the shared scroll viewport", async () => {
    const screen = await render(<SharedScrollVirtualizerHarness />);

    try {
      await vi.waitFor(() => {
        const rows = document.querySelectorAll('[data-testid="virtual-row"]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(30);
        expect(document.querySelector('[data-index="0"]')).not.toBeNull();
        expect(document.querySelector('[data-index="699"]')).toBeNull();
      });

      const normalRow = document.querySelector<HTMLElement>('[data-testid="normal-row"]');
      const virtualRow = document.querySelector<HTMLElement>('[data-index="0"]');
      const normalAction = document.querySelector<HTMLElement>('[data-testid="normal-row-action"]');
      const virtualAction = virtualRow?.querySelector<HTMLElement>(
        '[data-testid="virtual-row-action"]',
      );
      expect(normalRow?.getBoundingClientRect().left).toBe(
        virtualRow?.getBoundingClientRect().left,
      );
      expect(normalRow?.getBoundingClientRect().right).toBe(
        virtualRow?.getBoundingClientRect().right,
      );
      expect(normalAction?.getBoundingClientRect().right).toBe(
        virtualAction?.getBoundingClientRect().right,
      );

      const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]');
      expect(viewport).not.toBeNull();
      viewport!.scrollTop = 15_000;
      viewport!.dispatchEvent(new Event("scroll"));

      await vi.waitFor(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="virtual-row"]')];
        const indices = rows.map((row) => Number(row.dataset.index));
        expect(rows.length).toBeLessThan(30);
        expect(Math.min(...indices)).toBeGreaterThan(490);
        expect(Math.max(...indices)).toBeLessThan(520);
        expect(document.querySelector('[data-index="0"]')).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });
});
