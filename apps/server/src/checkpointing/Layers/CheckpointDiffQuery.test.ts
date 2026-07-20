import {
  CheckpointRef,
  type OrchestrationCheckpointAttribution,
  type OrchestrationCheckpointFile,
  ProjectId,
  ThreadId,
  TurnId,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  checkpointAttributedRefForThreadTurn,
  checkpointRefForThreadTurn,
  checkpointStartRefForThreadTurn,
} from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly files?: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly attribution?: OrchestrationCheckpointAttribution;
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: input.files ?? [],
        attribution: input.attribution ?? "unattributed",
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("CheckpointDiffQueryLive", () => {
  it("uses the narrow full-thread context lookup for all-turns diffs", async () => {
    const projectId = ProjectId.make("project-full-thread");
    const threadId = ThreadId.make("thread-full-thread");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 4);
    let getThreadCheckpointContextCalls = 0;
    let getFullThreadDiffContextCalls = 0;
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
          });
          return "full thread diff patch";
        }),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () =>
            Effect.sync(() => {
              getThreadCheckpointContextCalls += 1;
              return Option.none();
            }),
          getFullThreadDiffContext: () =>
            Effect.sync(() => {
              getFullThreadDiffContextCalls += 1;
              return Option.some({
                threadId,
                projectId,
                workspaceRoot: "/tmp/workspace",
                worktreePath: "/tmp/worktree",
                latestCheckpointTurnCount: 4,
                toCheckpointRef,
              });
            }),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(getThreadCheckpointContextCalls).toBe(0);
    expect(getFullThreadDiffContextCalls).toBe(1);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/worktree",
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 4,
      diff: "full thread diff patch",
    });
  });

  it("computes diffs using canonical turn-0 checkpoint refs", async () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
          });
          return "diff patch";
        }),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("prefers attributed start and synthetic refs for single-turn edit-snapshot diffs", async () => {
    const projectId = ProjectId.make("project-attributed");
    const threadId = ThreadId.make("thread-attributed");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const startRef = checkpointStartRefForThreadTurn(threadId, 1);
    const attributedRef = checkpointAttributedRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];
    const hasCheckpointRefCalls: CheckpointRef[] = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
      attribution: "edit-snapshots",
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.sync(() => {
          hasCheckpointRefCalls.push(checkpointRef);
          return checkpointRef === startRef || checkpointRef === attributedRef;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ignoreWhitespace,
          });
          return "attributed diff patch";
        }),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: false,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(hasCheckpointRefCalls).toEqual([startRef, attributedRef]);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: startRef,
        toCheckpointRef: attributedRef,
        ignoreWhitespace: false,
      },
    ]);
    expect(result.diff).toBe("attributed diff patch");
  });

  it("filters single-turn touched-path diffs to stored checkpoint files", async () => {
    const projectId = ProjectId.make("project-touched-paths");
    const threadId = ThreadId.make("thread-touched-paths");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly paths: ReadonlyArray<string> | undefined;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
      attribution: "touched-paths",
      files: [{ path: "src/a.ts", kind: "modified", additions: 1, deletions: 0 }],
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, paths }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            paths,
          });
          return "touched path diff patch";
        }),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([
      {
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
        toCheckpointRef,
        paths: ["src/a.ts"],
      },
    ]);
  });

  it("defaults to hide whitespace changes", async () => {
    const projectId = ProjectId.make("project-default-whitespace");
    const threadId = ThreadId.make("thread-default-whitespace");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ ignoreWhitespace });
          return "diff patch";
        }),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
  });

  it("does not preflight checkpoint refs before diffing", async () => {
    const projectId = ProjectId.make("project-no-preflight");
    const threadId = ThreadId.make("thread-no-preflight");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    let hasCheckpointRefCallCount = 0;

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: () =>
        Effect.sync(() => {
          hasCheckpointRefCallCount += 1;
          return true;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(hasCheckpointRefCallCount).toBe(0);
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.make("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      captureOverlayCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      hashFileBlob: () => Effect.succeed(null),
      readCheckpointFileBlob: () => Effect.succeed(null),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () =>
            Effect.die("CheckpointDiffQuery should not request the command read model"),
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getArchivedShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getMostRecentActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});
