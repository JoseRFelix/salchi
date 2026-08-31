import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";

import type { InboxLifecycleSection } from "./inboxLifecycle";
import type { SidebarThreadSummary } from "./types";
import type { SidebarThreadTreeItem } from "./components/Sidebar.logic";

export const INBOX_CARD_ROW_SIZE = 82;
export const INBOX_DRAFT_ROW_SIZE = 62;
export const INBOX_SLIM_ROW_SIZE = 40;
export const INBOX_SEARCH_ROW_SIZE = 48;
export const INBOX_DIVIDER_ROW_SIZE = 13;
export const INBOX_SHELF_ROW_SIZE = 27;
export const INBOX_LOAD_MORE_ROW_SIZE = 36;
export const INBOX_DESKTOP_VIRTUALIZATION_THRESHOLD = 120;

type ThreadTreeItem = SidebarThreadTreeItem<SidebarThreadSummary>;

export type InboxSidebarListItem =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly section: InboxLifecycleSection;
      readonly item: ThreadTreeItem;
    }
  | {
      readonly kind: "search";
      readonly key: string;
      readonly index: number;
      readonly section: InboxLifecycleSection;
      readonly item: ThreadTreeItem;
    }
  | {
      readonly kind: "divider";
      readonly key: "divider:drafts" | "divider:pinned";
      readonly tone: "drafts" | "pinned";
    }
  | {
      readonly kind: "shelf";
      readonly key: "shelf:snoozed" | "shelf:settled";
      readonly section: "snoozed" | "settled";
      readonly count: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "load-more";
      readonly key: "load-more:settled";
      readonly count: number;
    };

function threadKey(item: ThreadTreeItem): string {
  return scopedThreadKey(scopeThreadRef(item.thread.environmentId, item.thread.id));
}

function appendThreads(
  target: InboxSidebarListItem[],
  items: readonly ThreadTreeItem[],
  section: InboxLifecycleSection,
): void {
  for (const item of items) {
    target.push({ kind: "thread", key: `thread:${threadKey(item)}`, section, item });
  }
}

export function buildInboxSidebarListItems(input: {
  readonly drafts: readonly ThreadTreeItem[];
  readonly pinned: readonly ThreadTreeItem[];
  readonly active: readonly ThreadTreeItem[];
  readonly visibleSnoozed: readonly ThreadTreeItem[];
  readonly snoozedCount: number;
  readonly snoozedExpanded: boolean;
  readonly visibleSettled: readonly ThreadTreeItem[];
  readonly settledCount: number;
  readonly settledExpanded: boolean;
  readonly hiddenSettledCount: number;
}): readonly InboxSidebarListItem[] {
  const result: InboxSidebarListItem[] = [];
  appendThreads(result, input.drafts, "drafts");
  if (input.drafts.length > 0) {
    result.push({ kind: "divider", key: "divider:drafts", tone: "drafts" });
  }
  appendThreads(result, input.pinned, "pinned");
  if (input.pinned.length > 0) {
    result.push({ kind: "divider", key: "divider:pinned", tone: "pinned" });
  }
  appendThreads(result, input.active, "active");
  if (input.snoozedCount > 0) {
    result.push({
      kind: "shelf",
      key: "shelf:snoozed",
      section: "snoozed",
      count: input.snoozedCount,
      expanded: input.snoozedExpanded,
    });
    appendThreads(result, input.visibleSnoozed, "snoozed");
  }
  if (input.settledCount > 0) {
    result.push({
      kind: "shelf",
      key: "shelf:settled",
      section: "settled",
      count: input.settledCount,
      expanded: input.settledExpanded,
    });
    appendThreads(result, input.visibleSettled, "settled");
    if (input.settledExpanded && input.hiddenSettledCount > 0) {
      result.push({
        kind: "load-more",
        key: "load-more:settled",
        count: input.hiddenSettledCount,
      });
    }
  }
  return result;
}

export function buildInboxSearchListItems(
  results: readonly {
    readonly section: InboxLifecycleSection;
    readonly item: ThreadTreeItem;
  }[],
): readonly InboxSidebarListItem[] {
  return results.map(({ section, item }, index) => ({
    kind: "search",
    key: `search:${threadKey(item)}`,
    index,
    section,
    item,
  }));
}

export function inboxSidebarListItemType(item: InboxSidebarListItem): string {
  if (item.kind === "thread") {
    if (item.section === "drafts") return "thread-draft";
    return item.section === "pinned" || item.section === "active" ? "thread-card" : "thread-slim";
  }
  return item.kind;
}

export function inboxSidebarListItemSize(item: InboxSidebarListItem): number {
  switch (inboxSidebarListItemType(item)) {
    case "thread-card":
      return INBOX_CARD_ROW_SIZE;
    case "thread-draft":
      return INBOX_DRAFT_ROW_SIZE;
    case "thread-slim":
      return INBOX_SLIM_ROW_SIZE;
    case "search":
      return INBOX_SEARCH_ROW_SIZE;
    case "divider":
      return INBOX_DIVIDER_ROW_SIZE;
    case "shelf":
      return INBOX_SHELF_ROW_SIZE;
    case "load-more":
      return INBOX_LOAD_MORE_ROW_SIZE;
    default:
      return INBOX_CARD_ROW_SIZE;
  }
}

export function shouldVirtualizeInboxList(input: {
  readonly isMobile: boolean;
  readonly itemCount: number;
}): boolean {
  if (input.itemCount === 0) return false;
  return input.isMobile || input.itemCount > INBOX_DESKTOP_VIRTUALIZATION_THRESHOLD;
}
