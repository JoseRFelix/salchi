import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";
import {
  INBOX_SETTLED_SHELF_DEFAULT_EXPANDED,
  INBOX_SETTLED_SHELF_EXPANDED_KEY,
  INBOX_SETTLED_INITIAL_COUNT,
  INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED,
  INBOX_SNOOZED_SHELF_EXPANDED_KEY,
  inboxShelfLabel,
  moveInboxSearchHighlightIndex,
  resolvePaginatedInboxShelfItems,
  resolveInboxRowVariant,
  resolveInboxSearchHighlight,
  resolveInboxShelfItems,
  shouldVirtualizeInboxActiveThreads,
} from "./inboxSidebarPresentation";

afterEach(() => {
  removeLocalStorageItem(INBOX_SNOOZED_SHELF_EXPANDED_KEY);
  removeLocalStorageItem(INBOX_SETTLED_SHELF_EXPANDED_KEY);
});

describe("resolveInboxRowVariant", () => {
  it("uses full cards for drafts, pinned, and active work", () => {
    expect(resolveInboxRowVariant("drafts")).toBe("card");
    expect(resolveInboxRowVariant("pinned")).toBe("card");
    expect(resolveInboxRowVariant("active")).toBe("card");
  });

  it("uses slim rows for snoozed and settled shelves", () => {
    expect(resolveInboxRowVariant("snoozed")).toBe("slim");
    expect(resolveInboxRowVariant("settled")).toBe("slim");
  });
});

describe("resolveInboxShelfItems", () => {
  const items = [{ key: "one" }, { key: "two" }];
  const getKey = (item: { readonly key: string }) => item.key;

  it("shows every row when expanded", () => {
    expect(resolveInboxShelfItems({ items, expanded: true, activeKey: null, getKey })).toEqual(
      items,
    );
  });

  it("hides collapsed rows except for the routed thread", () => {
    expect(resolveInboxShelfItems({ items, expanded: false, activeKey: null, getKey })).toEqual([]);
    expect(resolveInboxShelfItems({ items, expanded: false, activeKey: "two", getKey })).toEqual([
      { key: "two" },
    ]);
  });
});

describe("resolvePaginatedInboxShelfItems", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ key: `thread-${index}` }));
  const getKey = (item: { readonly key: string }) => item.key;

  it("renders only the first settled page and preserves a deep routed row", () => {
    const visible = resolvePaginatedInboxShelfItems({
      items,
      expanded: true,
      activeKey: "thread-35",
      visibleCount: INBOX_SETTLED_INITIAL_COUNT,
      getKey,
    });
    expect(visible).toHaveLength(INBOX_SETTLED_INITIAL_COUNT + 1);
    expect(visible.at(-1)).toEqual({ key: "thread-35" });
  });

  it("keeps a collapsed routed row visible without exposing the page", () => {
    expect(
      resolvePaginatedInboxShelfItems({
        items,
        expanded: false,
        activeKey: "thread-35",
        visibleCount: INBOX_SETTLED_INITIAL_COUNT,
        getKey,
      }),
    ).toEqual([{ key: "thread-35" }]);
  });
});

describe("shouldVirtualizeInboxActiveThreads", () => {
  it("bounds mounted card rows once the active list becomes large", () => {
    expect(shouldVirtualizeInboxActiveThreads(24)).toBe(false);
    expect(shouldVirtualizeInboxActiveThreads(25)).toBe(true);
  });
});

describe("inboxShelfLabel", () => {
  it("puts the count in collapsed shelf labels only", () => {
    expect(inboxShelfLabel("Snoozed", 3, false)).toBe("Snoozed (3)");
    expect(inboxShelfLabel("Snoozed", 3, true)).toBe("Snoozed");
  });
});

describe("inbox title search keyboard navigation", () => {
  it("wraps arrow navigation and remains safe when results shrink", () => {
    expect(moveInboxSearchHighlightIndex(0, 3, 1)).toBe(1);
    expect(moveInboxSearchHighlightIndex(2, 3, 1)).toBe(0);
    expect(moveInboxSearchHighlightIndex(0, 3, -1)).toBe(2);
    expect(moveInboxSearchHighlightIndex(9, 2, -1)).toBe(0);
    expect(moveInboxSearchHighlightIndex(0, 0, 1)).toBe(0);
  });

  it("resolves Enter's highlighted result and handles empty results", () => {
    expect(resolveInboxSearchHighlight(["first", "second"], 1)).toBe("second");
    expect(resolveInboxSearchHighlight(["first"], 4)).toBe("first");
    expect(resolveInboxSearchHighlight([], 0)).toBeNull();
  });
});

describe("inbox shelf persistence", () => {
  it("matches t3code's collapsed snoozed and expanded settled defaults", () => {
    expect(INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED).toBe(false);
    expect(INBOX_SETTLED_SHELF_DEFAULT_EXPANDED).toBe(true);
  });

  it("round-trips shelf expansion independently", () => {
    setLocalStorageItem(INBOX_SNOOZED_SHELF_EXPANDED_KEY, true, Schema.Boolean);
    setLocalStorageItem(INBOX_SETTLED_SHELF_EXPANDED_KEY, false, Schema.Boolean);

    expect(getLocalStorageItem(INBOX_SNOOZED_SHELF_EXPANDED_KEY, Schema.Boolean)).toBe(true);
    expect(getLocalStorageItem(INBOX_SETTLED_SHELF_EXPANDED_KEY, Schema.Boolean)).toBe(false);
  });
});
