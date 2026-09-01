import { EnvironmentId, type VcsStatusResult } from "@salchi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { InboxChangeRequestObserver } from "./InboxChangeRequestObservers";

const { useGitStatusMock } = vi.hoisted(() => ({
  useGitStatusMock: vi.fn(),
}));

vi.mock("../../lib/gitStatusState", () => ({
  useGitStatus: useGitStatusMock,
}));

const environmentId = EnvironmentId.make("environment-inbox-observer");
const status = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/mobile-inbox",
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
  pr: null,
} satisfies VcsStatusResult;

afterEach(() => {
  useGitStatusMock.mockReset();
});

describe("InboxChangeRequestObserver", () => {
  it("retains and reports only its mounted row target", async () => {
    useGitStatusMock.mockReturnValue({
      targetKey: `${environmentId}:/repo/worktree`,
      data: status,
      error: null,
      cause: null,
      isPending: false,
    });
    const onObservation = vi.fn();

    const screen = await render(
      <InboxChangeRequestObserver
        environmentId={environmentId}
        cwd="/repo/worktree"
        threadKey="environment-inbox-observer:thread-visible"
        branch="feature/mobile-inbox"
        onObservation={onObservation}
      />,
    );

    expect(useGitStatusMock).toHaveBeenCalledWith({
      environmentId,
      cwd: "/repo/worktree",
    });
    await vi.waitFor(() => {
      expect(onObservation).toHaveBeenCalledOnce();
    });
    expect(onObservation).toHaveBeenCalledWith(
      [
        {
          threadKey: "environment-inbox-observer:thread-visible",
          branch: "feature/mobile-inbox",
        },
      ],
      status,
    );

    await screen.rerender(
      <InboxChangeRequestObserver
        environmentId={environmentId}
        cwd="/repo/worktree"
        threadKey="environment-inbox-observer:thread-visible"
        branch={null}
        onObservation={onObservation}
      />,
    );
    expect(useGitStatusMock).toHaveBeenLastCalledWith({ environmentId, cwd: null });
    expect(onObservation).toHaveBeenCalledOnce();
  });
});
