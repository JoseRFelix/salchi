import type { InboxLifecycleSection } from "./inboxLifecycle";

export const INBOX_SNOOZED_SHELF_EXPANDED_KEY =
  "salchi:sidebar-inbox-prototype:snoozed-expanded:v1";
export const INBOX_SETTLED_SHELF_EXPANDED_KEY =
  "salchi:sidebar-inbox-prototype:settled-expanded:v1";
export const INBOX_SNOOZED_SHELF_DEFAULT_EXPANDED = false;
export const INBOX_SETTLED_SHELF_DEFAULT_EXPANDED = true;

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

export function inboxShelfLabel(title: string, count: number, expanded: boolean): string {
  return expanded ? title : `${title} (${count})`;
}
