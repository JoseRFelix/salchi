import { EnvironmentId, type VcsStatusResult } from "@salchi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { InboxChangeRequestSnapshots } from "./inboxChangeRequest";
import {
  INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY,
  compactInboxChangeRequestSnapshots,
  groupInboxChangeRequestObservationTargets,
  mergeInboxChangeRequestObservationBatches,
} from "./inboxChangeRequestState";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";

const status = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/inbox",
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
    staged: { files: [], insertions: 0, deletions: 0 },
    unstaged: { files: [], insertions: 0, deletions: 0 },
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 42,
    title: "Inbox",
    url: "https://example.com/pull/42",
    baseRef: "main",
    headRef: "feature/inbox",
    state: "open" as const,
    updatedAt: "2026-08-31T10:00:00.000Z",
  },
} satisfies VcsStatusResult;

afterEach(() => removeLocalStorageItem(INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY));

describe("inbox change-request observation state", () => {
  it("observes all threads sharing a Git target through one group", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const groups = groupInboxChangeRequestObservationTargets([
      ...Array.from({ length: 160 }, (_, index) => ({
        environmentId,
        cwd: "/repo",
        threadKey: `thread-${index}`,
        branch: "feature/inbox",
      })),
      {
        environmentId,
        cwd: "/repo/worktree",
        threadKey: "worktree-thread",
        branch: "feature/worktree",
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.threads).toHaveLength(160);
    expect(groups[1]?.threads).toEqual([
      { threadKey: "worktree-thread", branch: "feature/worktree" },
    ]);
  });

  it("merges a target-wide observation in one immutable update", () => {
    const threads = Array.from({ length: 160 }, (_, index) => ({
      threadKey: `thread-${index}`,
      branch: "feature/inbox",
    }));
    const merged = mergeInboxChangeRequestObservationBatches({}, [
      { threads, gitStatus: status, observedAt: "2026-08-31T10:01:00.000Z" },
    ]);

    expect(Object.keys(merged)).toHaveLength(160);
    expect(merged["thread-159"]?.pr?.number).toBe(42);
    expect(
      mergeInboxChangeRequestObservationBatches(merged, [
        { threads, gitStatus: status, observedAt: "2026-08-31T10:02:00.000Z" },
      ]),
    ).toBe(merged);
  });

  it("clears absent pull requests without writing known-empty snapshots", () => {
    const observed = mergeInboxChangeRequestObservationBatches({}, [
      {
        threads: [{ threadKey: "thread", branch: "feature/inbox" }],
        gitStatus: status,
        observedAt: "2026-08-31T10:01:00.000Z",
      },
    ]);
    const cleared = mergeInboxChangeRequestObservationBatches(observed, [
      {
        threads: [{ threadKey: "thread", branch: "feature/inbox" }],
        gitStatus: { ...status, pr: null },
        observedAt: "2026-08-31T10:02:00.000Z",
      },
    ]);

    expect(cleared).toEqual({});
  });

  it("compacts legacy empty entries and round-trips only useful snapshots", () => {
    const useful = mergeInboxChangeRequestObservationBatches({}, [
      {
        threads: [{ threadKey: "useful", branch: "feature/inbox" }],
        gitStatus: status,
        observedAt: "2026-08-31T10:01:00.000Z",
      },
    ]);
    const compacted = compactInboxChangeRequestSnapshots({
      ...useful,
      empty: {
        branch: "feature/empty",
        observedAt: "2026-08-31T10:01:00.000Z",
        pr: null,
      },
    });
    setLocalStorageItem(INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY, compacted, InboxChangeRequestSnapshots);

    expect(
      getLocalStorageItem(INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY, InboxChangeRequestSnapshots),
    ).toEqual(useful);
  });
});
