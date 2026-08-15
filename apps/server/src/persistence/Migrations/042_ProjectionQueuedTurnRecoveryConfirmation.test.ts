import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionQueuedTurnRecoveryConfirmation", (it) => {
  it.effect("keeps pre-upgrade queued turns on the ordinary path", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
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
          'project-before-recovery-column',
          'Recovery migration',
          '/tmp/recovery-migration',
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
          'thread-before-recovery-column',
          'project-before-recovery-column',
          'Recovery migration',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}',
          NULL,
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
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
        INSERT INTO projection_thread_queued_turns (
          message_id,
          thread_id,
          role,
          text,
          attachments_json,
          model_selection_json,
          title_seed,
          runtime_mode,
          interaction_mode,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          steering_expected_turn_id,
          steering_requested_at,
          created_at,
          updated_at
        )
        VALUES (
          'message-before-recovery-column',
          'thread-before-recovery-column',
          'user',
          'ordinary queued message',
          '[]',
          NULL,
          NULL,
          'approval-required',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const rows = yield* sql<{ readonly recoveryConfirmationRequired: number }>`
        SELECT recovery_confirmation_required AS "recoveryConfirmationRequired"
        FROM projection_thread_queued_turns
        WHERE message_id = 'message-before-recovery-column'
      `;
      assert.deepStrictEqual(rows, [{ recoveryConfirmationRequired: 0 }]);
    }),
  );
});
