import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { PROJECTION_THREAD_ACTIVITY_ORDERING_INDEX } from "./040_ProjectionThreadActivityOrderingExpressionIndex.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ProjectionThreadActivityOrderingExpressionIndex", (it) => {
  it.effect("satisfies the latest-activity ordering without a temporary sort", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.ok(indexes.some((index) => index.name === PROJECTION_THREAD_ACTIVITY_ORDERING_INDEX));

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-performance-regression'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT 201
      `;

      assert.ok(
        plan.some((row) => row.detail.includes(PROJECTION_THREAD_ACTIVITY_ORDERING_INDEX)),
        `expected query plan to use ${PROJECTION_THREAD_ACTIVITY_ORDERING_INDEX}: ${plan.map((row) => row.detail).join(" | ")}`,
      );
      assert.ok(
        plan.every((row) => !row.detail.includes("USE TEMP B-TREE")),
        `expected query plan to avoid a temporary sort: ${plan.map((row) => row.detail).join(" | ")}`,
      );
    }),
  );
});
