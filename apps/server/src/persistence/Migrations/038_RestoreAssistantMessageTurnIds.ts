import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP TABLE IF EXISTS assistant_message_turn_repair_candidates
  `;

  yield* sql`
    CREATE TEMP TABLE assistant_message_turn_repair_candidates AS
    SELECT
      candidate.thread_id,
      candidate.message_id,
      MAX(candidate.turn_id) AS turn_id
    FROM (
      SELECT
        json_extract(payload_json, '$.threadId') AS thread_id,
        json_extract(payload_json, '$.messageId') AS message_id,
        json_extract(payload_json, '$.turnId') AS turn_id
      FROM orchestration_events
      WHERE event_type = 'thread.message-sent'
        AND json_extract(payload_json, '$.role') = 'assistant'
        AND json_extract(payload_json, '$.turnId') IS NOT NULL
        AND json_extract(payload_json, '$.threadId') IS NOT NULL
        AND json_extract(payload_json, '$.messageId') IS NOT NULL
    ) AS candidate
    GROUP BY candidate.thread_id, candidate.message_id
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_assistant_message_turn_repair_candidates
    ON assistant_message_turn_repair_candidates(thread_id, message_id)
  `;

  yield* sql`
    UPDATE projection_thread_messages
    SET turn_id = (
      SELECT candidate.turn_id
      FROM assistant_message_turn_repair_candidates AS candidate
      WHERE candidate.thread_id = projection_thread_messages.thread_id
        AND candidate.message_id = projection_thread_messages.message_id
      LIMIT 1
    )
    WHERE role = 'assistant'
      AND turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM assistant_message_turn_repair_candidates AS candidate
        WHERE candidate.thread_id = projection_thread_messages.thread_id
          AND candidate.message_id = projection_thread_messages.message_id
      )
  `;

  yield* sql`
    DROP TABLE IF EXISTS assistant_message_turn_repair_candidates
  `;
});
