import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("seen_completion_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN seen_completion_turn_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET seen_completion_turn_id = latest_turn_id
    WHERE seen_completion_turn_id IS NULL
      AND latest_turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_threads.thread_id
          AND projection_turns.turn_id = projection_threads.latest_turn_id
          AND projection_turns.completed_at IS NOT NULL
          AND projection_turns.state IN ('completed', 'error')
      )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_completion_attention_baselines (
      thread_id TEXT PRIMARY KEY NOT NULL,
      seen_completion_turn_id TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO orchestration_completion_attention_baselines (
      thread_id,
      seen_completion_turn_id
    )
    SELECT thread_id, seen_completion_turn_id
    FROM projection_threads
    WHERE seen_completion_turn_id IS NOT NULL
  `;
});
