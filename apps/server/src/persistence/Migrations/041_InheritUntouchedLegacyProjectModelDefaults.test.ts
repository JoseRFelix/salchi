import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0041 from "./041_InheritUntouchedLegacyProjectModelDefaults.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_InheritUntouchedLegacyProjectModelDefaults", (it) => {
  it.effect("migrates only untouched auto-assigned 5.4 project defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

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
        VALUES
          ('project-untouched', 'Untouched', '/tmp/untouched', '{"instanceId":"codex","model":"gpt-5.4"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-legacy-wire', 'Legacy wire', '/tmp/legacy-wire', '{"provider":"codex","model":"gpt-5.4"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-title-only', 'Renamed', '/tmp/title-only', '{"instanceId":"codex","model":"gpt-5.4"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL),
          ('project-explicit-same', 'Explicit same', '/tmp/explicit-same', '{"instanceId":"codex","model":"gpt-5.4"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL),
          ('project-updated-sol', 'Updated Sol', '/tmp/updated-sol', '{"instanceId":"codex","model":"gpt-5.6-sol"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL),
          ('project-created-sol', 'Created Sol', '/tmp/created-sol', '{"instanceId":"codex","model":"gpt-5.6-sol"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-no-created-event', 'No event', '/tmp/no-created-event', '{"instanceId":"codex","model":"gpt-5.4"}', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          ('event-untouched-created', 'project', 'project-untouched', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'cmd-untouched', NULL, 'corr-untouched', 'client', '{"projectId":"project-untouched","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}', '{}'),
          ('event-legacy-created', 'project', 'project-legacy-wire', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'cmd-legacy', NULL, 'corr-legacy', 'client', '{"projectId":"project-legacy-wire","defaultModelSelection":{"provider":"codex","model":"gpt-5.4"}}', '{}'),
          ('event-title-created', 'project', 'project-title-only', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'cmd-title-created', NULL, 'corr-title', 'client', '{"projectId":"project-title-only","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}', '{}'),
          ('event-title-updated', 'project', 'project-title-only', 2, 'project.meta-updated', '2026-01-02T00:00:00.000Z', 'cmd-title-updated', NULL, 'corr-title', 'client', '{"projectId":"project-title-only","title":"Renamed"}', '{}'),
          ('event-explicit-created', 'project', 'project-explicit-same', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'cmd-explicit-created', NULL, 'corr-explicit', 'client', '{"projectId":"project-explicit-same","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}', '{}'),
          ('event-explicit-updated', 'project', 'project-explicit-same', 2, 'project.meta-updated', '2026-01-02T00:00:00.000Z', 'cmd-explicit-updated', NULL, 'corr-explicit', 'client', '{"projectId":"project-explicit-same","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}', '{}'),
          ('event-updated-sol-created', 'project', 'project-updated-sol', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'cmd-updated-sol-created', NULL, 'corr-updated-sol', 'client', '{"projectId":"project-updated-sol","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}', '{}'),
          ('event-updated-sol-updated', 'project', 'project-updated-sol', 2, 'project.meta-updated', '2026-01-02T00:00:00.000Z', 'cmd-updated-sol-updated', NULL, 'corr-updated-sol', 'client', '{"projectId":"project-updated-sol","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}', '{}'),
          ('event-created-sol', 'project', 'project-created-sol', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'cmd-created-sol', NULL, 'corr-created-sol', 'client', '{"projectId":"project-created-sol","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}', '{}'),
          ('event-thread-created', 'thread', 'thread-historical-5-4', 1, 'thread.created', '2026-01-01T00:00:00.000Z', 'cmd-thread-created', NULL, 'corr-thread-created', 'client', '{"threadId":"thread-historical-5-4","projectId":"project-untouched","modelSelection":{"instanceId":"codex","model":"gpt-5.4"}}', '{}')
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
          'thread-historical-5-4',
          'project-untouched',
          'Historical 5.4 thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
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
          'full-access',
          'default'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Migration0041;

      const projects = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(projects, [
        {
          projectId: "project-created-sol",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        },
        {
          projectId: "project-explicit-same",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.4"}',
        },
        { projectId: "project-legacy-wire", defaultModelSelection: null },
        {
          projectId: "project-no-created-event",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.4"}',
        },
        { projectId: "project-title-only", defaultModelSelection: null },
        { projectId: "project-untouched", defaultModelSelection: null },
        {
          projectId: "project-updated-sol",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        },
      ]);

      const createdEvents = yield* sql<{
        readonly streamId: string;
        readonly selectionType: string;
        readonly model: string | null;
      }>`
        SELECT
          stream_id AS "streamId",
          json_type(payload_json, '$.defaultModelSelection') AS "selectionType",
          json_extract(payload_json, '$.defaultModelSelection.model') AS "model"
        FROM orchestration_events
        WHERE event_type = 'project.created'
        ORDER BY stream_id
      `;
      assert.deepStrictEqual(createdEvents, [
        { streamId: "project-created-sol", selectionType: "object", model: "gpt-5.6-sol" },
        { streamId: "project-explicit-same", selectionType: "object", model: "gpt-5.4" },
        { streamId: "project-legacy-wire", selectionType: "null", model: null },
        { streamId: "project-title-only", selectionType: "null", model: null },
        { streamId: "project-untouched", selectionType: "null", model: null },
        { streamId: "project-updated-sol", selectionType: "object", model: "gpt-5.4" },
      ]);

      const [threadProjection] = yield* sql<{ readonly model: string }>`
        SELECT json_extract(model_selection_json, '$.model') AS "model"
        FROM projection_threads
        WHERE thread_id = 'thread-historical-5-4'
      `;
      const [threadEvent] = yield* sql<{ readonly model: string }>`
        SELECT json_extract(payload_json, '$.modelSelection.model') AS "model"
        FROM orchestration_events
        WHERE event_id = 'event-thread-created'
      `;
      assert.equal(threadProjection?.model, "gpt-5.4");
      assert.equal(threadEvent?.model, "gpt-5.4");
    }),
  );
});
