import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadTreeItem } from "./components/Sidebar.logic";
import {
  INBOX_CARD_ROW_SIZE,
  INBOX_DESKTOP_VIRTUALIZATION_THRESHOLD,
  INBOX_DIVIDER_ROW_SIZE,
  INBOX_DRAFT_ROW_SIZE,
  INBOX_LOAD_MORE_ROW_SIZE,
  INBOX_SEARCH_ROW_SIZE,
  INBOX_SHELF_ROW_SIZE,
  INBOX_SLIM_ROW_SIZE,
  buildInboxSearchListItems,
  buildInboxSidebarListItems,
  inboxSidebarListItemSize,
  inboxSidebarListItemType,
  shouldVirtualizeInboxList,
} from "./inboxSidebarList";
import type { SidebarThreadSummary } from "./types";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-local");

function item(id: string): SidebarThreadTreeItem<SidebarThreadSummary> {
  return {
    thread: {
      id: ThreadId.make(id),
      environmentId,
      projectId,
      title: id,
      interactionMode: "default",
      parentThreadId: null,
      session: null,
      createdAt: "2026-08-31T10:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      updatedAt: "2026-08-31T10:00:00.000Z",
      latestTurn: null,
      branch: null,
      worktreePath: null,
      latestUserMessageAt: "2026-08-31T10:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
    depth: 0,
    rootThreadId: id,
    childCount: 0,
  };
}

function threadItemKey(id: string): string {
  return `thread:${scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)))}`;
}

describe("inbox sidebar list model", () => {
  it("flattens every lifecycle section into one stable ordered list", () => {
    const list = buildInboxSidebarListItems({
      drafts: [item("draft")],
      pinned: [item("pinned")],
      active: [item("active-a"), item("active-b")],
      visibleSnoozed: [item("snoozed")],
      snoozedCount: 3,
      snoozedExpanded: true,
      visibleSettled: [item("settled")],
      settledCount: 12,
      settledExpanded: true,
      hiddenSettledCount: 2,
    });

    expect(list.map(({ key }) => key)).toEqual([
      threadItemKey("draft"),
      "divider:drafts",
      threadItemKey("pinned"),
      "divider:pinned",
      threadItemKey("active-a"),
      threadItemKey("active-b"),
      "shelf:snoozed",
      threadItemKey("snoozed"),
      "shelf:settled",
      threadItemKey("settled"),
      "load-more:settled",
    ]);
  });

  it("uses predictable item types and exact fixed row sizes", () => {
    const list = buildInboxSidebarListItems({
      drafts: [item("draft")],
      pinned: [item("pinned")],
      active: [],
      visibleSnoozed: [item("snoozed")],
      snoozedCount: 1,
      snoozedExpanded: true,
      visibleSettled: [],
      settledCount: 1,
      settledExpanded: true,
      hiddenSettledCount: 1,
    });
    expect(list.map(inboxSidebarListItemType)).toEqual([
      "thread-draft",
      "divider",
      "thread-card",
      "divider",
      "shelf",
      "thread-slim",
      "shelf",
      "load-more",
    ]);
    expect(list.map(inboxSidebarListItemSize)).toEqual([
      INBOX_DRAFT_ROW_SIZE,
      INBOX_DIVIDER_ROW_SIZE,
      INBOX_CARD_ROW_SIZE,
      INBOX_DIVIDER_ROW_SIZE,
      INBOX_SHELF_ROW_SIZE,
      INBOX_SLIM_ROW_SIZE,
      INBOX_SHELF_ROW_SIZE,
      INBOX_LOAD_MORE_ROW_SIZE,
    ]);

    const search = buildInboxSearchListItems([{ section: "active", item: item("match") }]);
    expect(search.map(inboxSidebarListItemType)).toEqual(["search"]);
    expect(search.map(inboxSidebarListItemSize)).toEqual([INBOX_SEARCH_ROW_SIZE]);
  });

  it("always bounds mobile mounts and keeps modest desktop lists native", () => {
    expect(shouldVirtualizeInboxList({ isMobile: true, itemCount: 0 })).toBe(false);
    expect(shouldVirtualizeInboxList({ isMobile: true, itemCount: 1 })).toBe(true);
    expect(
      shouldVirtualizeInboxList({
        isMobile: false,
        itemCount: INBOX_DESKTOP_VIRTUALIZATION_THRESHOLD,
      }),
    ).toBe(false);
    expect(
      shouldVirtualizeInboxList({
        isMobile: false,
        itemCount: INBOX_DESKTOP_VIRTUALIZATION_THRESHOLD + 1,
      }),
    ).toBe(true);
  });
});
