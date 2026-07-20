/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef } from "@salchi/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface CaptureOverlayCheckpointInput {
  readonly cwd: string;
  readonly baseCheckpointRef: CheckpointRef;
  readonly checkpointRef: CheckpointRef;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly blobSha: string | null;
  }>;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly paths?: ReadonlyArray<string>;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface HashFileBlobInput {
  readonly cwd: string;
  readonly path: string;
}

export interface ReadCheckpointFileBlobInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly path: string;
}

export const CHECKPOINT_DIFF_PATHSPEC_LIMIT = 500;

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   *
   * Uses an isolated temporary Git index and writes a hidden ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Capture a synthetic checkpoint by overlaying specific blob entries on top of a base checkpoint.
   */
  readonly captureOverlayCheckpoint: (
    input: CaptureOverlayCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint refs.
   *
   * Can optionally treat missing "from" ref as `HEAD`.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Writes the current file content to the VCS object store and returns its blob SHA.
   *
   * Returns `null` when the file is missing from the working tree.
   */
  readonly hashFileBlob: (
    input: HashFileBlobInput,
  ) => Effect.Effect<string | null, CheckpointStoreError>;

  /**
   * Resolves a file's blob SHA from a checkpoint tree.
   *
   * Returns `null` when the path does not exist in that checkpoint.
   */
  readonly readCheckpointFileBlob: (
    input: ReadCheckpointFileBlobInput,
  ) => Effect.Effect<string | null, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Best-effort delete: missing refs are tolerated.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreShape>()(
  "salchi/checkpointing/Services/CheckpointStore",
) {}
