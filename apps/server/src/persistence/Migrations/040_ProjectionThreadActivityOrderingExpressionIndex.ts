import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const PROJECTION_THREAD_ACTIVITY_ORDERING_INDEX =
  "idx_projection_thread_activities_thread_ordering";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep this expression in lockstep with ProjectionSnapshotQuery's activity ordering. The
  // previous sequence index could filter by thread, but SQLite still had to sort every matching
  // activity into a temporary B-tree because NULL sequences are explicitly ordered last.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_ordering
    ON projection_thread_activities(
      thread_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END) DESC,
      sequence DESC,
      created_at DESC,
      activity_id DESC
    )
  `;
});
