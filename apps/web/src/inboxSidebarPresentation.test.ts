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
  INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED,
  INBOX_SNOOZED_SHELF_EXPANDED_KEY,
  inboxShelfLabel,
  resolveInboxRowVariant,
  resolveInboxShelfItems,
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

describe("inboxShelfLabel", () => {
  it("puts the count in collapsed shelf labels only", () => {
    expect(inboxShelfLabel("Snoozed", 3, false)).toBe("Snoozed (3)");
    expect(inboxShelfLabel("Snoozed", 3, true)).toBe("Snoozed");
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
