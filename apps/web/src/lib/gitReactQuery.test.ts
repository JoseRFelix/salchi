import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { recordSourceControlDiagnosticEventSpy } = vi.hoisted(() => ({
  recordSourceControlDiagnosticEventSpy: vi.fn(),
}));

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
  getWsRpcClientForEnvironment: vi.fn(),
}));

vi.mock("./sourceControlDiagnostics", () => ({
  recordSourceControlDiagnosticEvent: recordSourceControlDiagnosticEventSpy,
}));

import type { InfiniteData, MutationFunctionContext } from "@tanstack/react-query";
import {
  EnvironmentId,
  type EnvironmentApi,
  type VcsListRefsResult,
  type VcsStatusLocalResult,
} from "@salchi/contracts";
import * as environmentApi from "../environmentApi";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitGenerateCommitMessageMutationOptions,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitQueryKeys,
  gitRunStackedActionMutationOptions,
  gitWorkingTreeDiffQueryOptions,
  invalidateGitQueries,
  vcsRevertUnstagedFilesMutationOptions,
  vcsStageFilesMutationOptions,
  vcsUnstageFilesMutationOptions,
} from "./gitReactQuery";

const BRANCH_QUERY_RESULT: VcsListRefsResult = {
  refs: [],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 0,
};

const BRANCH_SEARCH_RESULT: InfiniteData<VcsListRefsResult, number> = {
  pages: [BRANCH_QUERY_RESULT],
  pageParams: [0],
};
const LOCAL_STATUS_RESULT: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/test",
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
    staged: { files: [], insertions: 0, deletions: 0 },
    unstaged: { files: [], insertions: 0, deletions: 0 },
  },
};
const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

afterEach(() => {
  vi.clearAllMocks();
});

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction(ENVIRONMENT_A, "/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.pull(ENVIRONMENT_A, "/repo/b"),
    );
  });

  it("scopes generated commit message keys by cwd", () => {
    expect(gitMutationKeys.generateCommitMessage(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.generateCommitMessage(ENVIRONMENT_A, "/repo/b"),
    );
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread(ENVIRONMENT_A, "/repo/b"),
    );
  });

  it("scopes stage and unstage keys by cwd", () => {
    expect(gitMutationKeys.stageFiles(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.stageFiles(ENVIRONMENT_A, "/repo/b"),
    );
    expect(gitMutationKeys.unstageFiles(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.unstageFiles(ENVIRONMENT_A, "/repo/b"),
    );
    expect(gitMutationKeys.revertUnstagedFiles(ENVIRONMENT_A, "/repo/a")).not.toEqual(
      gitMutationKeys.revertUnstagedFiles(ENVIRONMENT_A, "/repo/b"),
    );
  });
});

describe("git working tree diff query options", () => {
  it("includes target, ignoreWhitespace, and filePaths in the query key", () => {
    expect(gitQueryKeys.workingTreeDiff(ENVIRONMENT_A, "/repo", "unstaged", false)).not.toEqual(
      gitQueryKeys.workingTreeDiff(ENVIRONMENT_A, "/repo", "staged", false),
    );
    expect(gitQueryKeys.workingTreeDiff(ENVIRONMENT_A, "/repo", "unstaged", false)).not.toEqual(
      gitQueryKeys.workingTreeDiff(ENVIRONMENT_A, "/repo", "unstaged", true),
    );
    expect(gitQueryKeys.workingTreeDiff(ENVIRONMENT_A, "/repo", "all", false)).not.toEqual(
      gitQueryKeys.workingTreeDiff(ENVIRONMENT_A, "/repo", "all", false, ["src/app.ts"]),
    );
  });

  it("forwards working tree diff requests to the environment API", async () => {
    const getWorkingTreeDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    vi.mocked(environmentApi.ensureEnvironmentApi).mockReturnValue({
      vcs: {
        getWorkingTreeDiff,
      },
    } as unknown as EnvironmentApi);

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(
      gitWorkingTreeDiffQueryOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo",
        target: "all",
        ignoreWhitespace: true,
        filePaths: ["src/app.ts"],
      }),
    );

    expect(getWorkingTreeDiff).toHaveBeenCalledWith({
      cwd: "/repo",
      target: "all",
      ignoreWhitespace: true,
      filePaths: ["src/app.ts"],
    });
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction(ENVIRONMENT_A, "/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull(ENVIRONMENT_A, "/repo/a"));
  });

  it("attaches cwd-scoped mutation key for generated commit messages", () => {
    const options = gitGenerateCommitMessageMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
    });
    expect(options.mutationKey).toEqual(
      gitMutationKeys.generateCommitMessage(ENVIRONMENT_A, "/repo/a"),
    );
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(
      gitMutationKeys.preparePullRequestThread(ENVIRONMENT_A, "/repo/a"),
    );
  });

  it("attaches cwd-scoped mutation keys for stage operations", () => {
    expect(
      vcsStageFilesMutationOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo/a",
        queryClient,
      }).mutationKey,
    ).toEqual(gitMutationKeys.stageFiles(ENVIRONMENT_A, "/repo/a"));
    expect(
      vcsUnstageFilesMutationOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo/a",
        queryClient,
      }).mutationKey,
    ).toEqual(gitMutationKeys.unstageFiles(ENVIRONMENT_A, "/repo/a"));
    expect(
      vcsRevertUnstagedFilesMutationOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo/a",
        queryClient,
      }).mutationKey,
    ).toEqual(gitMutationKeys.revertUnstagedFiles(ENVIRONMENT_A, "/repo/a"));
  });

  it("forwards file mutations to the environment API", async () => {
    const stageFiles = vi.fn().mockResolvedValue(null);
    const unstageFiles = vi.fn().mockResolvedValue(null);
    const revertUnstagedFiles = vi.fn().mockResolvedValue(null);
    vi.mocked(environmentApi.ensureEnvironmentApi).mockReturnValue({
      vcs: {
        stageFiles,
        unstageFiles,
        revertUnstagedFiles,
      },
    } as unknown as EnvironmentApi);

    await vcsStageFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    }).mutationFn?.({ filePaths: ["src/app.ts"] }, undefined as never);
    await vcsUnstageFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    }).mutationFn?.({ filePaths: ["src/app.ts"] }, undefined as never);
    await vcsRevertUnstagedFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    }).mutationFn?.({ filePaths: ["src/app.ts"] }, undefined as never);

    expect(stageFiles).toHaveBeenCalledWith({ cwd: "/repo/a", filePaths: ["src/app.ts"] });
    expect(unstageFiles).toHaveBeenCalledWith({ cwd: "/repo/a", filePaths: ["src/app.ts"] });
    expect(revertUnstagedFiles).toHaveBeenCalledWith({
      cwd: "/repo/a",
      filePaths: ["src/app.ts"],
    });
  });

  it("records diagnostics for file mutation start, success, and invalidation scheduling", async () => {
    const stageFiles = vi.fn().mockResolvedValue(null);
    const unstageFiles = vi.fn().mockResolvedValue(null);
    const revertUnstagedFiles = vi.fn().mockResolvedValue(null);
    vi.mocked(environmentApi.ensureEnvironmentApi).mockReturnValue({
      vcs: {
        stageFiles,
        unstageFiles,
        revertUnstagedFiles,
      },
    } as unknown as EnvironmentApi);
    const invalidateQueries = vi.fn(() => Promise.resolve());
    const diagnosticQueryClient = { invalidateQueries } as unknown as QueryClient;
    const mutationContext: MutationFunctionContext = {
      client: diagnosticQueryClient,
      meta: undefined,
    };

    const stageOptions = vcsStageFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient: diagnosticQueryClient,
    });
    const unstageOptions = vcsUnstageFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient: diagnosticQueryClient,
    });
    const revertOptions = vcsRevertUnstagedFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient: diagnosticQueryClient,
    });

    await stageOptions.mutationFn?.({ filePaths: ["src/app.ts"] }, mutationContext);
    stageOptions.onSuccess?.(
      LOCAL_STATUS_RESULT,
      { filePaths: ["src/app.ts"] },
      undefined as never,
      mutationContext,
    );
    await unstageOptions.mutationFn?.({ filePaths: ["src/app.ts"] }, mutationContext);
    unstageOptions.onSuccess?.(
      LOCAL_STATUS_RESULT,
      { filePaths: ["src/app.ts"] },
      undefined as never,
      mutationContext,
    );
    await revertOptions.mutationFn?.({ filePaths: ["src/app.ts"] }, mutationContext);
    revertOptions.onSuccess?.(
      LOCAL_STATUS_RESULT,
      { filePaths: ["src/app.ts"] },
      undefined as never,
      mutationContext,
    );

    for (const action of ["stage", "unstage", "revert"]) {
      expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "mutation-start",
          action,
          environmentId: ENVIRONMENT_A,
          cwd: "/repo/a",
          filePaths: ["src/app.ts"],
        }),
      );
      expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "mutation-success",
          action,
          environmentId: ENVIRONMENT_A,
          cwd: "/repo/a",
        }),
      );
      expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith({
        kind: "git-query-invalidation-scheduled",
        action,
        queryKey: gitQueryKeys.all,
      });
    }
  });

  it("records diagnostics for file mutation errors", () => {
    const mutationContext: MutationFunctionContext = {
      client: queryClient,
      meta: undefined,
    };
    const error = new Error("permission denied");

    vcsRevertUnstagedFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient,
    }).onError?.(error, { filePaths: ["src/app.ts"] }, undefined, mutationContext);

    expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith({
      kind: "mutation-error",
      action: "revert",
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      errorMessage: "permission denied",
    });
  });

  it("does not keep file mutations pending while git query invalidation refetches", () => {
    const invalidateQueries = vi.fn(() => new Promise(() => undefined));
    const hangingInvalidationClient = {
      invalidateQueries,
    } as unknown as QueryClient;
    const mutationContext: MutationFunctionContext = {
      client: hangingInvalidationClient,
      meta: undefined,
    };

    const stageResult = vcsStageFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient: hangingInvalidationClient,
    }).onSuccess?.(
      LOCAL_STATUS_RESULT,
      { filePaths: ["src/app.ts"] },
      undefined as never,
      mutationContext,
    );
    const unstageResult = vcsUnstageFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient: hangingInvalidationClient,
    }).onSuccess?.(
      LOCAL_STATUS_RESULT,
      { filePaths: ["src/app.ts"] },
      undefined as never,
      mutationContext,
    );
    const revertResult = vcsRevertUnstagedFilesMutationOptions({
      environmentId: ENVIRONMENT_A,
      cwd: "/repo/a",
      queryClient: hangingInvalidationClient,
    }).onSuccess?.(
      LOCAL_STATUS_RESULT,
      { filePaths: ["src/app.ts"] },
      undefined as never,
      mutationContext,
    );

    expect(stageResult).toBeUndefined();
    expect(unstageResult).toBeUndefined();
    expect(revertResult).toBeUndefined();
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: gitQueryKeys.all });
  });
});

describe("invalidateGitQueries", () => {
  it("can invalidate a single cwd without blasting other git query scopes", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        environmentId: ENVIRONMENT_A,
        cwd: "/repo/a",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        environmentId: ENVIRONMENT_B,
        cwd: "/repo/b",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );

    await invalidateGitQueries(queryClient, { environmentId: ENVIRONMENT_A, cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          environmentId: ENVIRONMENT_A,
          cwd: "/repo/a",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          environmentId: ENVIRONMENT_B,
          cwd: "/repo/b",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
  });
});
