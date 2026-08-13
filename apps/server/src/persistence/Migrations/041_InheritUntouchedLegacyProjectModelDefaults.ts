import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Project creation used to materialize the then-current Codex default
 * (`gpt-5.4`) into every project. That made a system default indistinguishable
 * from a durable user preference and kept selecting 5.4 after Codex's default
 * moved on.
 *
 * A later project.meta-updated event containing `defaultModelSelection` is our
 * evidence that the value was explicitly edited, including an explicit edit
 * back to 5.4 or to null. Those projects are intentionally left untouched.
 * Thread selections are historical records and are never rewritten here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = NULL
    WHERE coalesce(
        json_extract(default_model_selection_json, '$.instanceId'),
        json_extract(default_model_selection_json, '$.provider')
      ) = 'codex'
      AND json_extract(default_model_selection_json, '$.model') = 'gpt-5.4'
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.aggregate_kind = 'project'
          AND created.stream_id = projection_projects.project_id
          AND created.event_type = 'project.created'
          AND coalesce(
              json_extract(created.payload_json, '$.defaultModelSelection.instanceId'),
              json_extract(created.payload_json, '$.defaultModelSelection.provider')
            ) = 'codex'
          AND json_extract(created.payload_json, '$.defaultModelSelection.model') = 'gpt-5.4'
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS later
            WHERE later.aggregate_kind = created.aggregate_kind
              AND later.stream_id = created.stream_id
              AND later.stream_version > created.stream_version
              AND later.event_type = 'project.meta-updated'
              AND json_type(later.payload_json, '$.defaultModelSelection') IS NOT NULL
          )
      )
  `;

  // Keep event history rebuild-safe: a projection replay must see inheritance
  // at project creation rather than restoring the legacy materialized default.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection',
      json('null')
    )
    WHERE aggregate_kind = 'project'
      AND event_type = 'project.created'
      AND coalesce(
          json_extract(payload_json, '$.defaultModelSelection.instanceId'),
          json_extract(payload_json, '$.defaultModelSelection.provider')
        ) = 'codex'
      AND json_extract(payload_json, '$.defaultModelSelection.model') = 'gpt-5.4'
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS later
        WHERE later.aggregate_kind = orchestration_events.aggregate_kind
          AND later.stream_id = orchestration_events.stream_id
          AND later.stream_version > orchestration_events.stream_version
          AND later.event_type = 'project.meta-updated'
          AND json_type(later.payload_json, '$.defaultModelSelection') IS NOT NULL
      )
  `;
});
