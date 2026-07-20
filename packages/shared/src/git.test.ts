import type { VcsStatusRemoteResult, VcsStatusResult } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  applyGitStatusStreamEvent,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

const emptyWorkingTree = {
  files: [],
  insertions: 0,
  deletions: 0,
  staged: { files: [], insertions: 0, deletions: 0 },
  unstaged: { files: [], insertions: 0, deletions: 0 },
} satisfies VcsStatusResult["workingTree"];

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:Salchi/Salchi.git")).toBe(
      "github.com/salchi/salchi",
    );
    expect(normalizeGitRemoteUrl("https://github.com/Salchi/Salchi.git")).toBe(
      "github.com/salchi/salchi",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/Salchi/Salchi")).toBe(
      "github.com/salchi/salchi",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:Salchi/platform/Salchi.git")).toBe(
      "gitlab.com/salchi/platform/salchi",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/Salchi/platform/Salchi.git")).toBe(
      "gitlab.com/salchi/platform/salchi",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:Salchi/Salchi.git"),
    ).toBe("Salchi/Salchi");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/Salchi/Salchi.git"),
    ).toBe("Salchi/Salchi");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("matches legacy temporary worktree refs so they can be renamed away", () => {
    expect(isTemporaryWorktreeBranch("salchi/deadbeef")).toBe(true);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: emptyWorkingTree,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", status: "modified", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
        staged: {
          files: [{ path: "src/demo.ts", status: "modified", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
        unstaged: { files: [], insertions: 0, deletions: 0 },
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});
