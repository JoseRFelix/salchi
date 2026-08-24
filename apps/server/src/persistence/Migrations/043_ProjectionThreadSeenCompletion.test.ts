import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionThreadSeenCompletion", (it) => {
  it.effect("starts existing terminal completions as read without hiding an active turn", () =>
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
          'project-seen-completion',
          'Seen completion migration',
          '/tmp/seen-completion-migration',
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
        VALUES
          (
            'thread-completed', 'project-seen-completion', 'Completed',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}', NULL, NULL, 'turn-completed',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', NULL, NULL,
            0, 0, 0, NULL, 'approval-required', 'default'
          ),
          (
            'thread-running', 'project-seen-completion', 'Running',
            '{"instanceId":"codex","model":"gpt-5.6-sol"}', NULL, NULL, 'turn-running',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', NULL, NULL,
            0, 0, 0, NULL, 'approval-required', 'default'
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
        VALUES
          (
            'thread-completed', 'turn-completed', NULL, NULL, NULL, NULL, 'completed',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:01.000Z', NULL, NULL, NULL, NULL, '[]'
          ),
          (
            'thread-running', 'turn-running', NULL, NULL, NULL, NULL, 'running',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            NULL, NULL, NULL, NULL, NULL, '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly seenCompletionTurnId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          seen_completion_turn_id AS "seenCompletionTurnId"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-completed", seenCompletionTurnId: "turn-completed" },
        { threadId: "thread-running", seenCompletionTurnId: null },
      ]);

      const baselines = yield* sql<{
        readonly threadId: string;
        readonly seenCompletionTurnId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          seen_completion_turn_id AS "seenCompletionTurnId"
        FROM orchestration_completion_attention_baselines
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(baselines, [
        { threadId: "thread-completed", seenCompletionTurnId: "turn-completed" },
      ]);
    }),
  );
});
