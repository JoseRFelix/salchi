import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("created_by_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN created_by_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_created_by
    ON projection_threads(project_id, created_by_thread_id, created_at, thread_id)
  `;
});
