import "../index.css";

import { ThreadId, type VcsStatusResult } from "@salchi/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const SHARED_THREAD_ID = ThreadId.make("thread-source-control-real-list");
const ENVIRONMENT_A = "environment-local" as never;
const GIT_CWD = "/repo/project";
const BRANCH_NAME = "feature/real-list-actions";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

const {
  currentGitStatusRef,
  generateCommitMessageMutateAsyncSpy,
  refreshGitStatusSpy,
  recordSourceControlDiagnosticEventSpy,
  recordSourceControlDisabledSnapshotSpy,
  revertUnstagedFilesMutateAsyncSpy,
  runStackedActionMutateAsyncSpy,
  setThreadBranchSpy,
  stageFilesMutateAsyncSpy,
  toastAddSpy,
  toastCloseSpy,
  toastPromiseSpy,
  toastUpdateSpy,
  unstageFilesMutateAsyncSpy,
} = vi.hoisted(() => ({
  currentGitStatusRef: {
    current: null as VcsStatusResult | null,
  },
  generateCommitMessageMutateAsyncSpy: vi.fn(() =>
    Promise.resolve({ commitMessage: "Update changed files" }),
  ),
  refreshGitStatusSpy: vi.fn(() => Promise.resolve(null)),
  recordSourceControlDiagnosticEventSpy: vi.fn(),
  recordSourceControlDisabledSnapshotSpy: vi.fn(),
  revertUnstagedFilesMutateAsyncSpy: vi.fn(() => Promise.resolve(null)),
  runStackedActionMutateAsyncSpy: vi.fn(() =>
    Promise.resolve({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_no_changes" },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
      toast: { title: "No changes", cta: { kind: "none" } },
    }),
  ),
  setThreadBranchSpy: vi.fn(),
  stageFilesMutateAsyncSpy: vi.fn(() => Promise.resolve(null)),
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastPromiseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
  unstageFilesMutateAsyncSpy: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: vi.fn(),
  useParams: vi.fn((input?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId: ENVIRONMENT_A, threadId: SHARED_THREAD_ID };
    return input?.select ? input.select(params) : params;
  }),
}));

vi.mock("@tanstack/react-query", async () => {
  const React = await import("react");
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  function useMockAsyncMutation<TInput, TResult>(
    mutateAsyncSpy: (input: TInput) => Promise<TResult>,
  ) {
    const [isPending, setIsPending] = React.useState(false);
    const mutateAsync = React.useCallback(
      async (input: TInput) => {
        setIsPending(true);
        try {
          return await mutateAsyncSpy(input);
        } finally {
          setIsPending(false);
        }
      },
      [mutateAsyncSpy],
    );
    return { mutateAsync, isPending };
  }

  return {
    ...actual,
    useIsMutating: vi.fn(() => 0),
    useMutation: vi.fn((options: { __kind?: string }) => {
      if (options.__kind === "generate-commit-message") {
        return useMockAsyncMutation(generateCommitMessageMutateAsyncSpy);
      }
      if (options.__kind === "run-stacked-action") {
        return useMockAsyncMutation(runStackedActionMutateAsyncSpy);
      }
      if (options.__kind === "stage-files") {
        return useMockAsyncMutation(stageFilesMutateAsyncSpy);
      }
      if (options.__kind === "unstage-files") {
        return useMockAsyncMutation(unstageFilesMutateAsyncSpy);
      }
      if (options.__kind === "revert-unstaged-files") {
        return useMockAsyncMutation(revertUnstagedFilesMutateAsyncSpy);
      }
      if (options.__kind === "pull") {
        return useMockAsyncMutation(vi.fn(() => Promise.resolve(null)));
      }
      return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
    }),
    useQuery: vi.fn(() => ({ data: null, error: null })),
    useQueryClient: vi.fn(() => ({})),
  };
});

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
    close: toastCloseSpy,
    promise: toastPromiseSpy,
    update: toastUpdateSpy,
  },
  stackedThreadToast: vi.fn((options: unknown) => options),
}));

vi.mock("./SourceControlPublishDialog", () => ({
  SourceControlPublishDialog: () => null,
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitGenerateCommitMessageMutationOptions: vi.fn(() => ({ __kind: "generate-commit-message" })),
  gitInitMutationOptions: vi.fn(() => ({ __kind: "init" })),
  gitMutationKeys: {
    generateCommitMessage: vi.fn(() => ["generate-commit-message"]),
    publishRepository: vi.fn(() => ["publish-repository"]),
    pull: vi.fn(() => ["pull"]),
    runStackedAction: vi.fn(() => ["run-stacked-action"]),
  },
  gitPullMutationOptions: vi.fn(() => ({ __kind: "pull" })),
  gitRunStackedActionMutationOptions: vi.fn(() => ({ __kind: "run-stacked-action" })),
  vcsRevertUnstagedFilesMutationOptions: vi.fn(() => ({ __kind: "revert-unstaged-files" })),
  vcsStageFilesMutationOptions: vi.fn(() => ({ __kind: "stage-files" })),
  vcsUnstageFilesMutationOptions: vi.fn(() => ({ __kind: "unstage-files" })),
}));

vi.mock("~/lib/gitStatusState", () => ({
  refreshGitStatus: refreshGitStatusSpy,
  resetGitStatusStateForTests: () => undefined,
  useGitStatus: vi.fn(() => ({
    data: currentGitStatusRef.current,
    error: null,
    isPending: false,
  })),
}));

vi.mock("~/lib/sourceControlDiagnostics", () => ({
  recordSourceControlDiagnosticEvent: recordSourceControlDiagnosticEventSpy,
  recordSourceControlDisabledSnapshot: recordSourceControlDisabledSnapshotSpy,
  sourceControlActionDisabledReasons: vi.fn(
    (input: {
      isGitActionRunningRaw: boolean;
      isFinalizingAction: boolean;
      isPushing: boolean;
      stageFilesPending: boolean;
      unstageFilesPending: boolean;
      revertUnstagedFilesPending: boolean;
    }) => {
      const reasons: string[] = [];
      if (input.isGitActionRunningRaw) reasons.push("git-action-running");
      if (input.isFinalizingAction) reasons.push("finalizing-action");
      if (input.isPushing) reasons.push("pushing");
      if (input.stageFilesPending) reasons.push("stage-files-pending");
      if (input.unstageFilesPending) reasons.push("unstage-files-pending");
      if (input.revertUnstagedFilesPending) reasons.push("revert-unstaged-files-pending");
      return reasons;
    },
  ),
}));

vi.mock("~/localApi", () => ({
  readLocalApi: vi.fn(() => null),
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => null),
}));

vi.mock("~/composerDraftStore", async () => {
  const draftStoreState = {
    getDraftThreadByRef: () => null,
    getDraftSession: () => null,
    getDraftSessionByRef: () => null,
    setDraftThreadContext: vi.fn(),
  };

  return {
    DraftId: {
      makeUnsafe: (value: string) => value,
    },
    useComposerDraftStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(draftStoreState),
      { getState: () => draftStoreState },
    ),
  };
});

vi.mock("~/store", () => {
  function createEnvironmentState() {
    return {
      projectIds: [],
      projectById: {},
      threadIds: [SHARED_THREAD_ID],
      threadIdsByProjectId: {},
      threadShellById: {
        [SHARED_THREAD_ID]: {
          id: SHARED_THREAD_ID,
          environmentId: ENVIRONMENT_A,
          projectId: "project-source-control",
          branch: BRANCH_NAME,
          worktreePath: GIT_CWD,
        },
      },
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      queuedTurnIdsByThreadId: {},
      queuedTurnByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailPageInfoByThreadId: {},
      sidebarThreadSummaryById: {},
      bootstrapComplete: true,
    };
  }

  function createStoreState() {
    const environmentStateById: Record<string, ReturnType<typeof createEnvironmentState>> = {
      [ENVIRONMENT_A]: createEnvironmentState(),
    };

    return {
      activeEnvironmentId: ENVIRONMENT_A,
      setThreadBranch: setThreadBranchSpy,
      environmentStateById,
    };
  }

  return {
    selectProjectByRef: () => ({ cwd: GIT_CWD }),
    selectEnvironmentState: (state: ReturnType<typeof createStoreState>, environmentId: string) =>
      state.environmentStateById[environmentId] ?? createEnvironmentState(),
    useStore: (selector: (state: ReturnType<typeof createStoreState>) => unknown) =>
      selector(createStoreState()),
  };
});

import SourceControlPanel from "./SourceControlPanel";
import { __resetSourceControlPanelStateForTests } from "../sourceControlPanelState";

function createPanelStatus(input: {
  stagedFiles?: VcsStatusResult["workingTree"]["files"];
  unstagedFiles?: VcsStatusResult["workingTree"]["files"];
}): VcsStatusResult {
  const stagedFiles = input.stagedFiles ?? [];
  const unstagedFiles = input.unstagedFiles ?? [];
  const files = [...stagedFiles, ...unstagedFiles].toSorted((a, b) => a.path.localeCompare(b.path));
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    isRepo: true,
    sourceControlProvider: {
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: BRANCH_NAME,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files,
      insertions,
      deletions,
      staged: {
        files: stagedFiles,
        insertions: stagedFiles.reduce((sum, file) => sum + file.insertions, 0),
        deletions: stagedFiles.reduce((sum, file) => sum + file.deletions, 0),
      },
      unstaged: {
        files: unstagedFiles,
        insertions: unstagedFiles.reduce((sum, file) => sum + file.insertions, 0),
        deletions: unstagedFiles.reduce((sum, file) => sum + file.deletions, 0),
      },
    },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    pr: null,
  };
}

function createLargeUnstagedFileList(): VcsStatusResult["workingTree"]["files"] {
  return Array.from({ length: 120 }, (_, index) => ({
    path: `docs/file-${String(index).padStart(3, "0")}.ts`,
    status: "modified",
    insertions: 1,
    deletions: 0,
  }));
}

async function waitForLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function queryButtonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return button;
}

function expectButtonCenterHitTarget(button: HTMLButtonElement): void {
  const rect = button.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const hitButton = document.elementFromPoint(centerX, centerY)?.closest("button");
  expect(hitButton).toBe(button);
}

async function clickButtonCenter(host: HTMLElement, button: HTMLButtonElement): Promise<void> {
  const hostRect = host.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  await userEvent.click(host, {
    position: {
      x: buttonRect.left - hostRect.left + buttonRect.width / 2,
      y: buttonRect.top - hostRect.top + buttonRect.height / 2,
    },
  });
}

async function renderPanel(input?: { width?: number; height?: number }) {
  const host = document.createElement("div");
  host.style.height = `${input?.height ?? 420}px`;
  host.style.width = `${input?.width ?? 720}px`;
  document.body.append(host);
  const screen = await render(<SourceControlPanel onClose={() => undefined} />, {
    container: host,
  });
  return { host, screen };
}

describe("SourceControlPanel real virtualized list actions", () => {
  afterEach(() => {
    vi.clearAllMocks();
    currentGitStatusRef.current = null;
    __resetSourceControlPanelStateForTests();
    document.body.innerHTML = "";
  });

  it("dispatches row action clicks through real LegendList hit testing", async () => {
    await page.viewport(900, 520);
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: createLargeUnstagedFileList(),
    });
    const { host, screen } = await renderPanel();

    try {
      await vi.waitFor(() => {
        expect(queryButtonByLabel("Stage docs/file-000.ts")).not.toBeNull();
        expect(queryButtonByLabel("Revert docs/file-000.ts")).not.toBeNull();
      });
      await waitForLayout();

      const stageButton = queryButtonByLabel("Stage docs/file-000.ts");
      expectButtonCenterHitTarget(stageButton);
      await clickButtonCenter(host, stageButton);
      await vi.waitFor(() => {
        expect(stageFilesMutateAsyncSpy).toHaveBeenCalledWith({
          filePaths: ["docs/file-000.ts"],
        });
      });

      const revertButton = queryButtonByLabel("Revert docs/file-000.ts");
      expectButtonCenterHitTarget(revertButton);
      await clickButtonCenter(host, revertButton);
      await vi.waitFor(() => {
        expect(revertUnstagedFilesMutateAsyncSpy).toHaveBeenCalledWith({
          filePaths: ["docs/file-000.ts"],
        });
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the next row action hit target aligned after a reverted row is removed", async () => {
    await page.viewport(393, 852);
    const unstagedFiles = createLargeUnstagedFileList();
    currentGitStatusRef.current = createPanelStatus({ unstagedFiles });
    const firstRevertDeferred = createDeferredPromise<null>();
    revertUnstagedFilesMutateAsyncSpy.mockImplementationOnce(() => {
      currentGitStatusRef.current = createPanelStatus({
        unstagedFiles: unstagedFiles.filter((file) => file.path !== "docs/file-000.ts"),
      });
      return firstRevertDeferred.promise;
    });
    const { host, screen } = await renderPanel({ width: 393, height: 852 });

    try {
      await vi.waitFor(() => {
        expect(queryButtonByLabel("Revert docs/file-000.ts")).not.toBeNull();
      });
      await waitForLayout();

      const firstRevertButton = queryButtonByLabel("Revert docs/file-000.ts");
      expectButtonCenterHitTarget(firstRevertButton);
      await clickButtonCenter(host, firstRevertButton);
      await vi.waitFor(() => {
        expect(revertUnstagedFilesMutateAsyncSpy).toHaveBeenCalledWith({
          filePaths: ["docs/file-000.ts"],
        });
      });
      firstRevertDeferred.resolve(null);
      await firstRevertDeferred.promise;
      await waitForLayout();

      await vi.waitFor(() => {
        expect(document.querySelector('button[aria-label="Revert docs/file-000.ts"]')).toBeNull();
        expect(queryButtonByLabel("Revert docs/file-001.ts")).not.toBeNull();
      });
      await vi.waitFor(() => {
        expect(queryButtonByLabel("Revert docs/file-001.ts").disabled).toBe(false);
      });
      await waitForLayout();

      const nextRevertButton = queryButtonByLabel("Revert docs/file-001.ts");
      expectButtonCenterHitTarget(nextRevertButton);
      await clickButtonCenter(host, nextRevertButton);

      await vi.waitFor(() => {
        expect(revertUnstagedFilesMutateAsyncSpy).toHaveBeenCalledTimes(2);
      });
      expect(revertUnstagedFilesMutateAsyncSpy).toHaveBeenNthCalledWith(1, {
        filePaths: ["docs/file-000.ts"],
      });
      expect(revertUnstagedFilesMutateAsyncSpy).toHaveBeenNthCalledWith(2, {
        filePaths: ["docs/file-001.ts"],
      });
    } finally {
      firstRevertDeferred.resolve(null);
      await screen.unmount();
      host.remove();
    }
  });

  it("records pointer hit-test diagnostics for coordinate-clicked row actions", async () => {
    await page.viewport(393, 852);
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: createLargeUnstagedFileList(),
    });
    const { host, screen } = await renderPanel({ width: 393, height: 852 });

    try {
      await vi.waitFor(() => {
        expect(queryButtonByLabel("Revert docs/file-000.ts")).not.toBeNull();
      });
      await waitForLayout();

      const revertButton = queryButtonByLabel("Revert docs/file-000.ts");
      expectButtonCenterHitTarget(revertButton);
      await clickButtonCenter(host, revertButton);

      await vi.waitFor(() => {
        expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "pointer-hit-test",
            buttonAriaLabel: "Revert docs/file-000.ts",
            buttonDisabled: false,
            sourceControlAction: "revert",
            sourceControlPath: "docs/file-000.ts",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("records disabled diagnostics while a coordinate-clicked revert is pending", async () => {
    await page.viewport(900, 520);
    currentGitStatusRef.current = createPanelStatus({
      unstagedFiles: createLargeUnstagedFileList(),
    });
    const revertDeferred = createDeferredPromise<null>();
    revertUnstagedFilesMutateAsyncSpy.mockImplementationOnce(() => revertDeferred.promise);
    const { host, screen } = await renderPanel();

    try {
      await vi.waitFor(() => {
        expect(queryButtonByLabel("Revert docs/file-000.ts")).not.toBeNull();
      });
      await waitForLayout();

      const revertButton = queryButtonByLabel("Revert docs/file-000.ts");
      expectButtonCenterHitTarget(revertButton);
      expect(revertButton.disabled).toBe(false);
      await clickButtonCenter(host, revertButton);

      await vi.waitFor(() => {
        expect(revertUnstagedFilesMutateAsyncSpy).toHaveBeenCalledWith({
          filePaths: ["docs/file-000.ts"],
        });
      });
      expect(queryButtonByLabel("Revert docs/file-000.ts")).not.toBeNull();
      expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "row-action-requested",
          action: "revert",
          filePaths: ["docs/file-000.ts"],
        }),
      );
      await vi.waitFor(() => {
        expect(recordSourceControlDisabledSnapshotSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            actionDisabled: true,
            actionDisabledReasons: ["revert-unstaged-files-pending"],
            revertUnstagedFilesPending: true,
          }),
        );
      });

      revertDeferred.resolve(null);
      await revertDeferred.promise;

      await vi.waitFor(() => {
        expect(queryButtonByLabel("Revert docs/file-000.ts").disabled).toBe(false);
      });
      await vi.waitFor(() => {
        expect(recordSourceControlDiagnosticEventSpy).toHaveBeenCalledWith({
          kind: "row-action-settled",
          action: "revert",
          filePaths: ["docs/file-000.ts"],
        });
      });
    } finally {
      revertDeferred.resolve(null);
      await screen.unmount();
      host.remove();
    }
  });
});
