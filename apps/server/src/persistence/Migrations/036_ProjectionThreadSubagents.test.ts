import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadSubagents", (it) => {
  it.effect("adds child-thread columns, defaults, and parent index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const byName = new Map(columns.map((column) => [column.name, column] as const));

      assert.ok(byName.has("parent_thread_id"));
      assert.ok(byName.has("subagent_kind"));
      assert.ok(byName.has("subagent_nickname"));
      assert.ok(byName.has("subagent_role"));
      const hiddenFromThreadList = byName.get("hidden_from_thread_list");
      assert.ok(hiddenFromThreadList);
      assert.equal(hiddenFromThreadList.name, "hidden_from_thread_list");
      assert.equal(hiddenFromThreadList.notnull, 1);
      assert.equal(hiddenFromThreadList.dflt_value, "0");

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_threads_parent"));
    }),
  );
});
