import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  activeThreadAnchorTimestampMs,
  buildInboxLifecycleThreadKeyByThreadKey,
  generateSpreadPinOrderKeys,
  getNextInboxWakeAtMs,
  partitionInboxThreads,
  pinOrderKeyBetween,
  planPinnedReorder,
  resolveInboxLifecycleSection,
  resolveInboxSnoozePresets,
  resolveInboxWokeAt,
  snoozeWakeLabel,
  sortPinnedThreadsByOrderKey,
} from "./inboxLifecycle";
import type { SidebarThreadSummary } from "./types";

const environmentId = EnvironmentId.make("environment-local");
const otherEnvironmentId = EnvironmentId.make("environment-remote");
const projectId = ProjectId.make("project-1");

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  const createdAt = overrides.createdAt ?? "2026-08-27T10:00:00.000Z";
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: id,
    interactionMode: "default",
    parentThreadId: null,
    session: null,
    createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    updatedAt: createdAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: createdAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function key(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

describe("inbox lifecycle partitioning", () => {
  it("uses drafts first and then snoozed, settled, pinned, and active precedence", () => {
    const lifecycleThread = makeThread("thread", {
      pinnedAt: "2026-08-27T08:00:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-08-27T09:00:00.000Z",
      snoozedUntil: "2026-08-27T14:00:00.000Z",
    });

    expect(
      resolveInboxLifecycleSection({
        thread: lifecycleThread,
        isDraft: true,
        now: "2026-08-27T11:00:00.000Z",
      }),
    ).toBe("drafts");
    expect(
      resolveInboxLifecycleSection({
        thread: lifecycleThread,
        isDraft: false,
        now: "2026-08-27T11:00:00.000Z",
      }),
    ).toBe("snoozed");
    expect(
      resolveInboxLifecycleSection({
        thread: { ...lifecycleThread, snoozedUntil: null },
        isDraft: false,
        now: "2026-08-27T11:00:00.000Z",
      }),
    ).toBe("settled");
    expect(
      resolveInboxLifecycleSection({
        thread: {
          ...lifecycleThread,
          snoozedUntil: null,
          settledOverride: "active",
          settledAt: null,
        },
        isDraft: false,
        now: "2026-08-27T11:00:00.000Z",
      }),
    ).toBe("pinned");
  });

  it("shares a root thread's lifecycle and draft state with its subagents", () => {
    const root = makeThread("root", { pinnedAt: "2026-08-27T09:00:00.000Z" });
    const child = makeThread("child", { parentThreadId: root.id });
    const lifecycleKeys = buildInboxLifecycleThreadKeyByThreadKey([root, child]);

    expect(lifecycleKeys.get(key(child))).toBe(key(root));
    const partitions = partitionInboxThreads({
      threads: [root, child],
      draftThreadKeys: new Set([key(root)]),
      now: "2026-08-27T11:00:00.000Z",
    });
    expect(partitions.drafts.map((thread) => thread.id)).toEqual([child.id, root.id]);
    expect(partitions.pinned).toEqual([]);
  });

  it("keeps active threads in creation order despite later activity", () => {
    const olderButRecentlyActive = makeThread("older", {
      createdAt: "2026-08-27T08:00:00.000Z",
      updatedAt: "2026-08-27T15:00:00.000Z",
    });
    const newer = makeThread("newer", {
      createdAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:00:00.000Z",
    });

    const partitions = partitionInboxThreads({
      threads: [olderButRecentlyActive, newer],
      draftThreadKeys: new Set(),
      now: "2026-08-27T16:00:00.000Z",
    });
    expect(partitions.active.map((thread) => thread.id)).toEqual([
      newer.id,
      olderButRecentlyActive.id,
    ]);
  });

  it("reanchors a manually un-settled thread without using ordinary activity", () => {
    const reactivated = makeThread("reactivated", {
      createdAt: "2026-08-27T08:00:00.000Z",
      updatedAt: "2026-08-27T09:00:00.000Z",
      unsettledAt: "2026-08-27T15:00:00.000Z",
    });
    const newer = makeThread("newer", { createdAt: "2026-08-27T10:00:00.000Z" });

    expect(activeThreadAnchorTimestampMs(reactivated)).toBe(Date.parse("2026-08-27T15:00:00.000Z"));
    expect(
      partitionInboxThreads({
        threads: [newer, reactivated],
        draftThreadKeys: new Set(),
        now: "2026-08-27T16:00:00.000Z",
      }).active.map((thread) => thread.id),
    ).toEqual([reactivated.id, newer.id]);
  });

  it("sorts snoozed by wake time and settled by settlement time", () => {
    const wakeLater = makeThread("wake-later", {
      snoozedUntil: "2026-08-28T12:00:00.000Z",
    });
    const wakeSooner = makeThread("wake-sooner", {
      snoozedUntil: "2026-08-28T09:00:00.000Z",
    });
    const settledOlder = makeThread("settled-older", {
      settledOverride: "settled",
      settledAt: "2026-08-26T09:00:00.000Z",
    });
    const settledNewer = makeThread("settled-newer", {
      settledOverride: "settled",
      settledAt: "2026-08-27T09:00:00.000Z",
    });

    const partitions = partitionInboxThreads({
      threads: [wakeLater, settledOlder, wakeSooner, settledNewer],
      draftThreadKeys: new Set(),
      now: "2026-08-27T16:00:00.000Z",
    });
    expect(partitions.snoozed.map((thread) => thread.id)).toEqual([wakeSooner.id, wakeLater.id]);
    expect(partitions.settled.map((thread) => thread.id)).toEqual([
      settledNewer.id,
      settledOlder.id,
    ]);
  });

  it("filters archived and hidden threads", () => {
    const archived = makeThread("archived", { archivedAt: "2026-08-27T12:00:00.000Z" });
    const hidden = makeThread("hidden", { hiddenFromThreadList: true });
    const visible = makeThread("visible");
    const partitions = partitionInboxThreads({
      threads: [archived, hidden, visible],
      draftThreadKeys: new Set(),
      now: "2026-08-27T13:00:00.000Z",
    });
    expect(partitions.active.map((thread) => thread.id)).toEqual([visible.id]);
  });
});

describe("pinned ordering", () => {
  it("places a new pin before the current first key", () => {
    const orderKey = pinOrderKeyBetween(null, "g");
    expect(orderKey).not.toBeNull();
    expect(orderKey! < "g").toBe(true);
  });

  it("sorts persisted order keys first and keyless legacy pins newest first", () => {
    const threads = [
      makeThread("legacy-old", {
        createdAt: "2026-08-27T08:00:00.000Z",
        pinnedAt: "2026-08-27T08:00:00.000Z",
      }),
      makeThread("second", { pinnedAt: "2026-08-27T10:00:00.000Z", pinOrderKey: "m" }),
      makeThread("first", { pinnedAt: "2026-08-27T10:00:00.000Z", pinOrderKey: "g" }),
      makeThread("legacy-new", {
        createdAt: "2026-08-27T09:00:00.000Z",
        pinnedAt: "2026-08-27T09:00:00.000Z",
      }),
    ];
    expect(sortPinnedThreadsByOrderKey(threads).map((thread) => thread.id)).toEqual([
      ThreadId.make("first"),
      ThreadId.make("second"),
      ThreadId.make("legacy-new"),
      ThreadId.make("legacy-old"),
    ]);
  });

  it("uses a fractional update when possible and rebalances invalid legacy keys", () => {
    expect(
      planPinnedReorder({
        orderedIds: ["second", "first", "third"],
        keysById: new Map([
          ["first", "g"],
          ["second", "m"],
          ["third", "t"],
        ]),
        movedId: "second",
      }),
    ).toEqual([{ id: "second", orderKey: expect.any(String) }]);

    const rebalanced = planPinnedReorder({
      orderedIds: ["legacy", "first", "third"],
      keysById: new Map([
        ["legacy", null],
        ["first", "g"],
        ["third", "t"],
      ]),
      movedId: "first",
    });
    expect(rebalanced).toHaveLength(3);
    expect(rebalanced.map(({ orderKey }) => orderKey)).toEqual(generateSpreadPinOrderKeys(3));
  });
});

describe("snooze presentation", () => {
  it("offers five contextual presets earlier in the day", () => {
    const now = new Date(2026, 7, 27, 10, 0, 0, 0);
    const presets = resolveInboxSnoozePresets(now);
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets.every((preset) => Date.parse(preset.snoozedUntil) > now.getTime())).toBe(true);
    expect(presets.every((preset) => preset.whenLabel.length > 0)).toBe(true);
  });

  it("reports wake countdowns and the next pending wake", () => {
    const now = "2026-08-27T10:00:00.000Z";
    expect(snoozeWakeLabel("2026-08-27T10:45:00.000Z", now)).toBe("45m");
    expect(snoozeWakeLabel("2026-08-27T13:00:00.000Z", now)).toBe("3h");
    expect(snoozeWakeLabel("2026-08-29T10:00:00.000Z", now)).toBe("2d");
    expect(
      getNextInboxWakeAtMs(
        [
          makeThread("past", { snoozedUntil: "2026-08-27T09:00:00.000Z" }),
          makeThread("later", { snoozedUntil: "2026-08-27T13:00:00.000Z" }),
          makeThread("next", { snoozedUntil: "2026-08-27T11:00:00.000Z" }),
        ],
        now,
      ),
    ).toBe(Date.parse("2026-08-27T11:00:00.000Z"));
  });

  it("returns expired snoozes to active and exposes a Woke timestamp", () => {
    const thread = makeThread("woke", { snoozedUntil: "2026-08-27T10:00:00.000Z" });
    expect(
      resolveInboxLifecycleSection({
        thread,
        isDraft: false,
        now: "2026-08-27T10:00:01.000Z",
      }),
    ).toBe("active");
    expect(resolveInboxWokeAt(thread, "2026-08-27T10:00:01.000Z")).toBe("2026-08-27T10:00:00.000Z");
  });
});

describe("multi-environment identity", () => {
  it("keeps identical thread ids in different environments distinct", () => {
    const local = makeThread("same");
    const remote = makeThread("same", { environmentId: otherEnvironmentId });
    expect(key(local)).not.toBe(key(remote));
    const lifecycleKeys = buildInboxLifecycleThreadKeyByThreadKey([local, remote]);
    expect(lifecycleKeys.get(key(local))).toBe(key(local));
    expect(lifecycleKeys.get(key(remote))).toBe(key(remote));
  });
});
