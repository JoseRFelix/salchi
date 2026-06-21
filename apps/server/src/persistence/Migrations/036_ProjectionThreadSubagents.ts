import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  if (!columnNames.has("subagent_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subagent_kind TEXT
    `;
  }

  if (!columnNames.has("subagent_nickname")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subagent_nickname TEXT
    `;
  }

  if (!columnNames.has("subagent_role")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subagent_role TEXT
    `;
  }

  if (!columnNames.has("hidden_from_thread_list")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN hidden_from_thread_list INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent
    ON projection_threads(project_id, parent_thread_id, created_at, thread_id)
  `;
});
