import {
  EnvironmentId,
  ProviderDriverKind,
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
  resolveInboxThreadActivityAt,
  resolveInboxWokeAt,
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
      reactivatedAt: null,
      wokeAt: null,
    });
    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T11:06:00.000Z"),
    ).toBe("settled");

    state = applyInboxLifecycleAction(state, {
      type: "unsettle",
      threadKey,
      at: "2026-08-25T11:06:00.000Z",
    });
    expect(
      resolveInboxLifecycleSection(threadKey, state, new Set(), "2026-08-25T11:06:00.000Z"),
    ).toBe("pinned");
    state = applyInboxLifecycleAction(state, {
      type: "unpin",
      threadKey,
      at: "2026-08-25T11:07:00.000Z",
    });
    expect(state[threadKey]).toMatchObject({
      pinnedAt: null,
      reactivatedAt: "2026-08-25T11:07:00.000Z",
    });
  });

  it("lets an expired snooze return to the underlying lifecycle section", () => {
    const threadKey = "environment-local:thread-1";
    const state: InboxLifecycleByThreadKey = {
      [threadKey]: {
        pinnedAt: "2026-08-25T09:00:00.000Z",
        snoozedUntil: "2026-08-25T10:00:00.000Z",
        settledAt: null,
        reactivatedAt: null,
        wokeAt: null,
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

  it("promotes an early wake and clears its attention marker after acknowledgement", () => {
    const threadKey = "environment-local:thread-wake";
    let state = applyInboxLifecycleAction(
      {},
      {
        type: "snooze",
        threadKey,
        until: "2026-08-25T12:00:00.000Z",
      },
    );
    state = applyInboxLifecycleAction(state, {
      type: "unsnooze",
      threadKey,
      at: "2026-08-25T11:00:00.000Z",
    });
    expect(state[threadKey]).toMatchObject({
      snoozedUntil: null,
      reactivatedAt: "2026-08-25T11:00:00.000Z",
      wokeAt: "2026-08-25T11:00:00.000Z",
    });

    state = applyInboxLifecycleAction(state, {
      type: "acknowledge-wake",
      threadKey,
      at: "2026-08-25T11:00:00.000Z",
    });
    expect(resolveInboxWokeAt(state[threadKey], "2026-08-25T11:01:00.000Z")).toBeNull();
    expect(state[threadKey]?.reactivatedAt).toBe("2026-08-25T11:00:00.000Z");
  });

  it("keeps drafts ahead of any persisted lifecycle state", () => {
    const threadKey = "environment-local:thread-1";
    const state: InboxLifecycleByThreadKey = {
      [threadKey]: {
        pinnedAt: "2026-08-25T09:00:00.000Z",
        snoozedUntil: "2026-08-26T09:00:00.000Z",
        settledAt: "2026-08-25T10:00:00.000Z",
        reactivatedAt: null,
        wokeAt: null,
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
        reactivatedAt: null,
        wokeAt: null,
      },
      [key(pinned[1]!)]: {
        pinnedAt: "2026-08-25T10:00:00.000Z",
        snoozedUntil: null,
        settledAt: null,
        reactivatedAt: null,
        wokeAt: null,
      },
      [key(snoozed[0]!)]: {
        pinnedAt: null,
        snoozedUntil: "2026-08-25T13:00:00.000Z",
        settledAt: null,
        reactivatedAt: null,
        wokeAt: null,
      },
      [key(snoozed[1]!)]: {
        pinnedAt: null,
        snoozedUntil: "2026-08-25T12:00:00.000Z",
        settledAt: null,
        reactivatedAt: null,
        wokeAt: null,
      },
      [key(settled[0]!)]: {
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: "2026-08-25T09:00:00.000Z",
        reactivatedAt: null,
        wokeAt: null,
      },
      [key(settled[1]!)]: {
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: "2026-08-25T10:00:00.000Z",
        reactivatedAt: null,
        wokeAt: null,
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
        reactivatedAt: null,
        wokeAt: null,
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

  it("promotes newly active root groups without reordering on completion updates", () => {
    const newThread = makeThread({
      id: "new-thread",
      createdAt: "2026-08-25T10:00:00.000Z",
    });
    const oldRoot = {
      ...makeThread({ id: "old-root", createdAt: "2026-08-25T08:00:00.000Z" }),
      latestUserMessageAt: "2026-08-25T11:00:00.000Z",
    };
    const activeChild = {
      ...makeThread({
        id: "active-child",
        parentThreadId: "old-root",
        createdAt: "2026-08-25T08:30:00.000Z",
      }),
      latestUserMessageAt: "2026-08-25T12:00:00.000Z",
    };
    const completedChild = {
      ...activeChild,
      updatedAt: "2026-08-25T13:00:00.000Z",
    };

    const partition = (threads: readonly SidebarThreadSummary[]) =>
      partitionInboxThreads({
        threads,
        lifecycleByThreadKey: {},
        draftThreadKeys: new Set(),
        now: "2026-08-25T13:00:00.000Z",
      }).active;

    expect(partition([newThread, oldRoot, activeChild]).map(key)).toEqual([
      key(activeChild),
      key(oldRoot),
      key(newThread),
    ]);
    expect(partition([newThread, oldRoot, completedChild]).map(key)).toEqual([
      key(completedChild),
      key(oldRoot),
      key(newThread),
    ]);
  });

  it("uses an explicit reactivation timestamp ahead of older message activity", () => {
    const thread = makeThread({ id: "reactivated", createdAt: "2026-08-25T08:00:00.000Z" });
    expect(
      resolveInboxThreadActivityAt(thread, {
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: null,
        reactivatedAt: "2026-08-25T12:00:00.000Z",
        wokeAt: null,
      }),
    ).toBe("2026-08-25T12:00:00.000Z");
  });

  it("promotes a newly active session without using its later completion transition", () => {
    const thread = makeThread({ id: "session-activity", createdAt: "2026-08-25T08:00:00.000Z" });
    const runningSession = {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      orchestrationStatus: "running" as const,
      createdAt: "2026-08-25T08:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };

    expect(resolveInboxThreadActivityAt({ ...thread, session: runningSession }, undefined)).toBe(
      "2026-08-25T12:00:00.000Z",
    );
    expect(
      resolveInboxThreadActivityAt(
        {
          ...thread,
          session: {
            ...runningSession,
            status: "ready",
            orchestrationStatus: "ready",
            updatedAt: "2026-08-25T13:00:00.000Z",
          },
        },
        undefined,
      ),
    ).toBe("2026-08-25T08:00:00.000Z");
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
        reactivatedAt: null,
        wokeAt: null,
      },
    };
    persistInboxLifecycleState(storage, state);

    expect(readInboxLifecycleState(storage)).toEqual(state);
    expect(JSON.parse(storage.getItem(INBOX_LIFECYCLE_STORAGE_KEY) ?? "{}")).toMatchObject({
      version: 2,
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
        reactivatedAt: null,
        wokeAt: null,
      },
    });
  });

  it("migrates version-one entries with empty activity metadata", () => {
    expect(
      parseInboxLifecycleDocument(
        JSON.stringify({
          version: 1,
          threads: {
            "environment-local:thread-old": {
              pinnedAt: "2026-08-25T10:00:00.000Z",
              snoozedUntil: null,
              settledAt: null,
            },
          },
        }),
      ),
    ).toEqual({
      "environment-local:thread-old": {
        pinnedAt: "2026-08-25T10:00:00.000Z",
        snoozedUntil: null,
        settledAt: null,
        reactivatedAt: null,
        wokeAt: null,
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
            reactivatedAt: null,
            wokeAt: null,
          },
          first: {
            pinnedAt: null,
            snoozedUntil: "2026-08-25T11:00:00.000Z",
            settledAt: null,
            reactivatedAt: null,
            wokeAt: null,
          },
        },
        now,
      ),
    ).toBe(Date.parse("2026-08-25T11:00:00.000Z"));
  });

  it("surfaces an expired or explicitly early wake until it is acknowledged", () => {
    expect(
      resolveInboxWokeAt(
        {
          pinnedAt: null,
          snoozedUntil: "2026-08-25T11:00:00.000Z",
          settledAt: null,
          reactivatedAt: null,
          wokeAt: null,
        },
        "2026-08-25T11:01:00.000Z",
      ),
    ).toBe("2026-08-25T11:00:00.000Z");
    expect(
      resolveInboxWokeAt(
        {
          pinnedAt: null,
          snoozedUntil: null,
          settledAt: null,
          reactivatedAt: "2026-08-25T10:30:00.000Z",
          wokeAt: "2026-08-25T10:30:00.000Z",
        },
        "2026-08-25T10:31:00.000Z",
      ),
    ).toBe("2026-08-25T10:30:00.000Z");
  });
});
