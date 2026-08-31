import { describe, expect, it } from "vitest";

import {
  inboxChangeRequestSettleSource,
  inboxThreadHasBranchMismatch,
  nextInboxChangeRequestSnapshot,
} from "./inboxChangeRequest";

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
    state: "merged" as const,
    updatedAt: "2026-08-31T10:00:00.000Z",
  },
};

describe("inbox change-request snapshots", () => {
  it("records only branch-matched observations and keeps them through cache mismatches", () => {
    const snapshot = nextInboxChangeRequestSnapshot({
      threadBranch: "feature/inbox",
      gitStatus: status,
      previous: null,
      observedAt: "2026-08-31T10:01:00.000Z",
    });
    expect(snapshot?.pr?.number).toBe(42);
    expect(
      nextInboxChangeRequestSnapshot({
        threadBranch: "feature/inbox",
        gitStatus: { ...status, refName: "main" },
        previous: snapshot,
        observedAt: "2026-08-31T10:02:00.000Z",
      }),
    ).toEqual(snapshot);
    expect(inboxChangeRequestSettleSource(snapshot)).toEqual({
      state: "merged",
      updatedAt: "2026-08-31T10:00:00.000Z",
    });
  });

  it("distinguishes a known no-PR branch from an unobserved or mismatched branch", () => {
    expect(
      nextInboxChangeRequestSnapshot({
        threadBranch: "feature/inbox",
        gitStatus: { ...status, pr: null },
        previous: null,
        observedAt: "2026-08-31T10:01:00.000Z",
      }),
    ).toMatchObject({ branch: "feature/inbox", pr: null });
    expect(
      inboxThreadHasBranchMismatch({
        threadBranch: "feature/inbox",
        gitStatus: { ...status, refName: "main" },
      }),
    ).toBe(true);
  });
});
