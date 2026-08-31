import type { InboxLifecycleSection } from "./inboxLifecycle";

export const INBOX_SNOOZED_SHELF_EXPANDED_KEY =
  "salchi:sidebar-inbox-prototype:snoozed-expanded:v1";
export const INBOX_SETTLED_SHELF_EXPANDED_KEY =
  "salchi:sidebar-inbox-prototype:settled-expanded:v1";
export const INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED = false;
export const INBOX_SETTLED_SHELF_DEFAULT_EXPANDED = true;
export const INBOX_SETTLED_INITIAL_COUNT = 10;
export const INBOX_SETTLED_PAGE_COUNT = 25;
export const INBOX_ACTIVE_VIRTUALIZATION_THRESHOLD = 24;

export type InboxRowVariant = "card" | "slim";

export function resolveInboxRowVariant(section: InboxLifecycleSection): InboxRowVariant {
  return section === "snoozed" || section === "settled" ? "slim" : "card";
}

export function resolveInboxShelfItems<T>(input: {
  readonly items: readonly T[];
  readonly expanded: boolean;
  readonly activeKey: string | null;
  readonly getKey: (item: T) => string;
}): readonly T[] {
  if (input.expanded) {
    return input.items;
  }
  if (input.activeKey === null) {
    return [];
  }
  const activeItem = input.items.find((item) => input.getKey(item) === input.activeKey);
  return activeItem ? [activeItem] : [];
}

export function resolvePaginatedInboxShelfItems<T>(input: {
  readonly items: readonly T[];
  readonly expanded: boolean;
  readonly activeKey: string | null;
  readonly visibleCount: number;
  readonly getKey: (item: T) => string;
}): readonly T[] {
  if (!input.expanded) {
    return resolveInboxShelfItems(input);
  }
  const visible = input.items.slice(0, Math.max(0, input.visibleCount));
  if (input.activeKey !== null && !visible.some((item) => input.getKey(item) === input.activeKey)) {
    const activeItem = input.items.find((item) => input.getKey(item) === input.activeKey);
    if (activeItem) {
      visible.push(activeItem);
    }
  }
  return visible;
}

export function shouldVirtualizeInboxActiveThreads(itemCount: number): boolean {
  return itemCount > INBOX_ACTIVE_VIRTUALIZATION_THRESHOLD;
}

export function inboxShelfLabel(title: string, count: number, expanded: boolean): string {
  return expanded ? title : `${title} (${count})`;
}

export function moveInboxSearchHighlightIndex(
  currentIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  const safeIndex = Math.min(Math.max(0, currentIndex), itemCount - 1);
  return (safeIndex + direction + itemCount) % itemCount;
}

export function resolveInboxSearchHighlight<T>(
  items: readonly T[],
  highlightIndex: number,
): T | null {
  if (items.length === 0) return null;
  return items[Math.min(Math.max(0, highlightIndex), items.length - 1)] ?? null;
}

export function resolveInboxParkForwardTarget(input: {
  readonly parkedLifecycleKey: string;
  readonly orderedThreadKeys: readonly string[];
  readonly lifecycleKeyByThreadKey: ReadonlyMap<string, string>;
}): string | null {
  return (
    input.orderedThreadKeys.find(
      (key) => (input.lifecycleKeyByThreadKey.get(key) ?? key) !== input.parkedLifecycleKey,
    ) ?? null
  );
}

export function reconcileInboxTitleRegeneration(
  pendingPreviousTitleByThreadKey: Readonly<Record<string, string>>,
  currentTitleByThreadKey: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pendingPreviousTitleByThreadKey).filter(
      ([key, previousTitle]) => currentTitleByThreadKey.get(key) === previousTitle,
    ),
  );
}
