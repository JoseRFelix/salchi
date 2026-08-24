import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_EnsureCompletionAttentionBaseline", (it) => {
  it.effect("recreates a missing baseline table after migration 43 was recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-baseline-repair',
          'Baseline repair',
          '/tmp/baseline-repair',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at,
          runtime_mode,
          interaction_mode
        )
        VALUES (
          'thread-baseline-repair',
          'project-baseline-repair',
          'Thread',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}',
          NULL,
          NULL,
          'turn-baseline-repair',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL,
          'approval-required',
          'default'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_attribution,
          checkpoint_files_json
        )
        VALUES (
          'thread-baseline-repair',
          'turn-baseline-repair',
          NULL,
          NULL,
          NULL,
          NULL,
          'completed',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`DROP TABLE orchestration_completion_attention_baselines`;
      yield* runMigrations({ toMigrationInclusive: 44 });

      const baselines = yield* sql<{
        readonly threadId: string;
        readonly seenCompletionTurnId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          seen_completion_turn_id AS "seenCompletionTurnId"
        FROM orchestration_completion_attention_baselines
      `;
      assert.deepStrictEqual(baselines, [
        {
          threadId: "thread-baseline-repair",
          seenCompletionTurnId: "turn-baseline-repair",
        },
      ]);
    }),
  );
});
