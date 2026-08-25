import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProviderInteractionMode,
} from "@salchi/contracts";
import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import { describe, expect, it } from "vitest";

import {
  applyInboxLifecycleAction,
  buildInboxLifecycleThreadKeyByThreadKey,
  getNextInboxWakeAtMs,
  INBOX_LIFECYCLE_STORAGE_KEY,
  parseInboxLifecycleDocument,
  partitionInboxThreads,
  persistInboxLifecycleState,
  readInboxLifecycleState,
  resolveInboxLifecycleSection,
  resolveInboxSnoozeUntil,
  type InboxLifecycleByThreadKey,
} from "./inboxLifecycle";
import { createMemoryStorage } from "./testUtils/memoryStorage";
import type { SidebarThreadSummary } from "./types";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

function makeThread(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly archivedAt?: string | null;
  readonly parentThreadId?: string | null;
}): SidebarThreadSummary {
  return {
    id: ThreadId.make(input.id),
    environmentId,
    projectId,
    title: input.id,
    interactionMode: "default" satisfies ProviderInteractionMode,
    parentThreadId: input.parentThreadId ? ThreadId.make(input.parentThreadId) : null,
    session: null,
    createdAt: input.createdAt,
    archivedAt: input.archivedAt ?? null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: input.createdAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function key(thread: SidebarThreadSummary): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

describe("inbox lifecycle interactions", () => {
  it("preserves pin state through snooze and settle transitions", () => {
    const threadKey = "environment-local:thread-1";
    let state: InboxLifecycleByThreadKey = {};
    state = applyInboxLifecycleAction(state, {
      type: "pin",
      threadKey,
      at: "2026-08-25T10:00:00.000Z",
    });
    state = applyInboxLifecycleAction(state, {
      type: "snooze",
      threadKey,
      until: "2026-08-25T12:00:00.000Z",
    });

    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T11:00:00.000Z"),
    ).toBe("snoozed");

    state = applyInboxLifecycleAction(state, {
      type: "settle",
      threadKey,
      at: "2026-08-25T11:05:00.000Z",
    });
    expect(state[threadKey]).toEqual({
      pinnedAt: "2026-08-25T10:00:00.000Z",
      snoozedUntil: null,
      settledAt: "2026-08-25T11:05:00.000Z",
    });
    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T11:06:00.000Z"),
    ).toBe("settled");

    state = applyInboxLifecycleAction(state, { type: "unsettle", threadKey });
    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T11:06:00.000Z"),
    ).toBe("pinned");
    state = applyInboxLifecycleAction(state, { type: "unpin", threadKey });
    expect(state).toEqual({});
  });

  it("lets an expired snooze return to the underlying lifecycle section", () => {
    const threadKey = "environment-local:thread-1";
    const state: InboxLifecycleByThreadKey = {
      [threadKey]: {
        pinnedAt: "2026-08-25T09:00:00.000Z",
        snoozedUntil: "2026-08-25T10:00:00.000Z",
        settledAt: null,
      },
    };
    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T10:00:01.000Z"),
    ).toBe("pinned");
  });

  it("returns a settled thread to history after its snooze expires", () => {
    const threadKey = "environment-local:thread-1";
    let state = applyInboxLifecycleAction(
      {},
      {
        type: "settle",
        threadKey,
        at: "2026-08-25T09:00:00.000Z",
      },
    );
    state = applyInboxLifecycleAction(state, {
      type: "snooze",
      threadKey,
      until: "2026-08-25T11:00:00.000Z",
    });

    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T10:00:00.000Z"),
    ).toBe("snoozed");
    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T11:00:00.000Z"),
    ).toBe("settled");
    expect(applyInboxLifecycleAction(state, { type: "remove", threadKey })).toEqual({});
  });

  it("keeps drafts ahead of any persisted lifecycle state", () => {
    const threadKey = "environment-local:thread-1";
    const state: InboxLifecycleByThreadKey = {
      [threadKey]: {
        pinnedAt: "2026-08-25T09:00:00.000Z",
        snoozedUntil: "2026-08-26T09:00:00.000Z",
        settledAt: "2026-08-25T10:00:00.000Z",
      },
    };

    expect(
      resolveInboxLifecycleSection(
        threadKey,
        state,
        new Set([threadKey]),
        "2026-08-25T11:00:00.000Z",
      ),
    ).toBe("drafts");
  });
});

describe("partitionInboxThreads", () => {
  it("partitions and deterministically sorts every lifecycle section", () => {
    const drafts = [
      makeThread({ id: "draft-old", createdAt: "2026-08-25T08:00:00.000Z" }),
      makeThread({ id: "draft-new", createdAt: "2026-08-25T09:00:00.000Z" }),
    ];
    const pinned = [
      makeThread({ id: "pin-second", createdAt: "2026-08-25T12:00:00.000Z" }),
      makeThread({ id: "pin-first", createdAt: "2026-08-25T07:00:00.000Z" }),
    ];
    const active = [
      makeThread({ id: "active-old", createdAt: "2026-08-25T06:00:00.000Z" }),
      makeThread({ id: "active-new", createdAt: "2026-08-25T13:00:00.000Z" }),
    ];
    const snoozed = [
      makeThread({ id: "wake-later", createdAt: "2026-08-25T15:00:00.000Z" }),
      makeThread({ id: "wake-first", createdAt: "2026-08-25T05:00:00.000Z" }),
    ];
    const settled = [
      makeThread({ id: "settled-old", createdAt: "2026-08-25T14:00:00.000Z" }),
      makeThread({ id: "settled-new", createdAt: "2026-08-25T04:00:00.000Z" }),
    ];
    const archived = makeThread({
      id: "archived",
      createdAt: "2026-08-25T16:00:00.000Z",
      archivedAt: "2026-08-25T16:01:00.000Z",
    });
    const hidden = {
      ...makeThread({ id: "hidden", createdAt: "2026-08-25T17:00:00.000Z" }),
      hiddenFromThreadList: true,
    };
    const lifecycleByThreadKey: InboxLifecycleByThreadKey = {
      [key(pinned[0]!)]: {
        pinnedAt: "2026-08-25T10:01:00.000Z",
        snoozedUntil: null,
        settledAt: null,
      },
      [key(pinned[1]!)]: {
        pinnedAt: "2026-08-25T10:00:00.000Z",
        snoozedUntil: null,
        settledAt: null,
      },
      [key(snoozed[0]!)]: {
        pinnedAt: null,
        snoozedUntil: "2026-08-25T13:00:00.000Z",
        settledAt: null,
      },
      [key(snoozed[1]!)]: {
        pinnedAt: null,
        snoozedUntil: "2026-08-25T12:00:00.000Z",
        settledAt: null,
      },
      [key(settled[0]!)]: {
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: "2026-08-25T09:00:00.000Z",
      },
      [key(settled[1]!)]: {
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: "2026-08-25T10:00:00.000Z",
      },
    };
    const partitioned = partitionInboxThreads({
      threads: [...active, ...settled, ...drafts, ...pinned, ...snoozed, archived, hidden],
      lifecycleByThreadKey,
      draftThreadKeys: new Set(drafts.map(key)),
      now: "2026-08-25T11:00:00.000Z",
    });

    expect(partitioned.drafts.map((thread) => thread.id)).toEqual([
      ThreadId.make("draft-new"),
      ThreadId.make("draft-old"),
    ]);
    expect(partitioned.pinned.map((thread) => thread.id)).toEqual([
      ThreadId.make("pin-first"),
      ThreadId.make("pin-second"),
    ]);
    expect(partitioned.active.map((thread) => thread.id)).toEqual([
      ThreadId.make("active-new"),
      ThreadId.make("active-old"),
    ]);
    expect(partitioned.snoozed.map((thread) => thread.id)).toEqual([
      ThreadId.make("wake-first"),
      ThreadId.make("wake-later"),
    ]);
    expect(partitioned.settled.map((thread) => thread.id)).toEqual([
      ThreadId.make("settled-new"),
      ThreadId.make("settled-old"),
    ]);
    expect(Object.values(partitioned).flat()).not.toContain(archived);
    expect(Object.values(partitioned).flat()).not.toContain(hidden);
  });

  it("keeps subagents in their root thread's lifecycle section", () => {
    const root = makeThread({ id: "root", createdAt: "2026-08-25T10:00:00.000Z" });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      createdAt: "2026-08-25T11:00:00.000Z",
    });
    const rootKey = key(root);
    const childKey = key(child);
    const lifecycleByThreadKey: InboxLifecycleByThreadKey = {
      [rootKey]: {
        pinnedAt: "2026-08-25T11:30:00.000Z",
        snoozedUntil: null,
        settledAt: null,
      },
    };

    expect(buildInboxLifecycleThreadKeyByThreadKey([child, root]).get(childKey)).toBe(rootKey);
    const partitioned = partitionInboxThreads({
      threads: [child, root],
      lifecycleByThreadKey,
      draftThreadKeys: new Set(),
      now: "2026-08-25T12:00:00.000Z",
    });
    expect(new Set(partitioned.pinned.map(key))).toEqual(new Set([rootKey, childKey]));
    expect(partitioned.active).toEqual([]);
  });

  it("uses scoped identity as a stable tie-breaker", () => {
    const alpha = makeThread({ id: "alpha", createdAt: "2026-08-25T10:00:00.000Z" });
    const beta = makeThread({ id: "beta", createdAt: "2026-08-25T10:00:00.000Z" });
    const partition = (threads: readonly SidebarThreadSummary[]) =>
      partitionInboxThreads({
        threads,
        lifecycleByThreadKey: {},
        draftThreadKeys: new Set(),
        now: "2026-08-25T11:00:00.000Z",
      }).active.map(key);

    expect(partition([beta, alpha])).toEqual(partition([alpha, beta]));
    expect(partition([beta, alpha])).toEqual([key(alpha), key(beta)]);
  });
});

describe("inbox lifecycle persistence", () => {
  it("round-trips the versioned prototype document", () => {
    const storage = createMemoryStorage();
    const state: InboxLifecycleByThreadKey = {
      "environment-local:thread-1": {
        pinnedAt: "2026-08-25T10:00:00.000Z",
        snoozedUntil: null,
        settledAt: null,
      },
    };
    persistInboxLifecycleState(storage, state);

    expect(readInboxLifecycleState(storage)).toEqual(state);
    expect(JSON.parse(storage.getItem(INBOX_LIFECYCLE_STORAGE_KEY) ?? "{}")).toMatchObject({
      version: 1,
    });
  });

  it("drops corrupt documents, keys, timestamps, and empty entries", () => {
    expect(parseInboxLifecycleDocument("{")).toEqual({});
    expect(
      parseInboxLifecycleDocument(
        JSON.stringify({
          version: 1,
          threads: {
            "": { pinnedAt: "2026-08-25T10:00:00.000Z" },
            invalid: { pinnedAt: "not-a-date" },
            "environment-local:thread-valid": {
              pinnedAt: "2026-08-25T10:00:00.000Z",
              snoozedUntil: 123,
              settledAt: null,
            },
          },
        }),
      ),
    ).toEqual({
      "environment-local:thread-valid": {
        pinnedAt: "2026-08-25T10:00:00.000Z",
        snoozedUntil: null,
        settledAt: null,
      },
    });
  });
});

describe("inbox snooze timing", () => {
  it("resolves predictable duration presets and the earliest wake boundary", () => {
    const now = "2026-08-25T10:00:00.000Z";
    expect(resolveInboxSnoozeUntil("one-hour", now)).toBe("2026-08-25T11:00:00.000Z");
    const tomorrow = new Date(resolveInboxSnoozeUntil("tomorrow", now));
    expect(tomorrow.getDate()).toBe(new Date(now).getDate() + 1);
    expect(tomorrow.getHours()).toBe(9);
    expect(resolveInboxSnoozeUntil("one-week", now)).toBe("2026-09-01T10:00:00.000Z");
    expect(
      getNextInboxWakeAtMs(
        {
          later: {
            pinnedAt: null,
            snoozedUntil: "2026-08-25T12:00:00.000Z",
            settledAt: null,
          },
          first: {
            pinnedAt: null,
            snoozedUntil: "2026-08-25T11:00:00.000Z",
            settledAt: null,
          },
        },
        now,
      ),
    ).toBe(Date.parse("2026-08-25T11:00:00.000Z"));
  });
});
