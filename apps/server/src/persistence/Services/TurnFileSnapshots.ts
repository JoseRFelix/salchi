import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "@salchi/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const TurnFileSnapshot = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  path: TrimmedNonEmptyString,
  blobSha: Schema.NullOr(TrimmedNonEmptyString),
  deleted: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type TurnFileSnapshot = typeof TurnFileSnapshot.Type;

export const UpsertTurnFileSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  path: TrimmedNonEmptyString,
  blobSha: Schema.NullOr(TrimmedNonEmptyString),
  deleted: Schema.Boolean,
  preserveExistingSnapshot: Schema.optional(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export type UpsertTurnFileSnapshotInput = typeof UpsertTurnFileSnapshotInput.Type;

export const GetTurnFileSnapshotsByTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetTurnFileSnapshotsByTurnInput = typeof GetTurnFileSnapshotsByTurnInput.Type;

export const DeleteTurnFileSnapshotsByTurnInput = GetTurnFileSnapshotsByTurnInput;
export type DeleteTurnFileSnapshotsByTurnInput = typeof DeleteTurnFileSnapshotsByTurnInput.Type;

export const DeleteTurnFileSnapshotsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteTurnFileSnapshotsByThreadInput = typeof DeleteTurnFileSnapshotsByThreadInput.Type;

export interface TurnFileSnapshotsShape {
  readonly upsertSnapshot: (
    input: UpsertTurnFileSnapshotInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByTurn: (
    input: GetTurnFileSnapshotsByTurnInput,
  ) => Effect.Effect<ReadonlyArray<TurnFileSnapshot>, ProjectionRepositoryError>;
  readonly deleteByTurn: (
    input: DeleteTurnFileSnapshotsByTurnInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThread: (
    input: DeleteTurnFileSnapshotsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class TurnFileSnapshots extends Context.Service<TurnFileSnapshots, TurnFileSnapshotsShape>()(
  "salchi/persistence/Services/TurnFileSnapshots",
) {}
