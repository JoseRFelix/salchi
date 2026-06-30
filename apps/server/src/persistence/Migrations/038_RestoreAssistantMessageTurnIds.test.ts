import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0038 from "./038_RestoreAssistantMessageTurnIds.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_RestoreAssistantMessageTurnIds", (it) => {
  it.effect("restores detached assistant message turn ids and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'assistant-detached',
            'thread-repair',
            NULL,
            'assistant',
            'answer tail',
            '[]',
            0,
            '2026-06-01T00:00:00.000Z',
            '2026-06-01T00:00:10.000Z'
          ),
          (
            'assistant-existing',
            'thread-repair',
            'turn-existing',
            'assistant',
            'already linked',
            '[]',
            0,
            '2026-06-01T00:01:00.000Z',
            '2026-06-01T00:01:10.000Z'
          ),
          (
            'assistant-rebound',
            'thread-repair',
            NULL,
            'assistant',
            'rebound answer',
            '[]',
            0,
            '2026-06-01T00:02:00.000Z',
            '2026-06-01T00:02:10.000Z'
          ),
          (
            'user-detached',
            'thread-repair',
            NULL,
            'user',
            'user message',
            '[]',
            0,
            '2026-06-01T00:02:00.000Z',
            '2026-06-01T00:02:10.000Z'
          )
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
          (
            'event-assistant-detached-linked',
            'thread',
            'thread-repair',
            1,
            'thread.message-sent',
            '2026-06-01T00:00:00.000Z',
            'cmd-assistant-detached-linked',
            NULL,
            'corr-assistant-detached-linked',
            'system',
            '{"threadId":"thread-repair","messageId":"assistant-detached","role":"assistant","text":"answer","turnId":"turn-restored","streaming":true,"createdAt":"2026-06-01T00:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}',
            '{}'
          ),
          (
            'event-assistant-detached-null',
            'thread',
            'thread-repair',
            2,
            'thread.message-sent',
            '2026-06-01T00:00:10.000Z',
            'cmd-assistant-detached-null',
            NULL,
            'corr-assistant-detached-null',
            'system',
            '{"threadId":"thread-repair","messageId":"assistant-detached","role":"assistant","text":"","turnId":null,"streaming":false,"createdAt":"2026-06-01T00:00:10.000Z","updatedAt":"2026-06-01T00:00:10.000Z"}',
            '{}'
          ),
          (
            'event-assistant-existing-linked',
            'thread',
            'thread-repair',
            3,
            'thread.message-sent',
            '2026-06-01T00:01:00.000Z',
            'cmd-assistant-existing-linked',
            NULL,
            'corr-assistant-existing-linked',
            'system',
            '{"threadId":"thread-repair","messageId":"assistant-existing","role":"assistant","text":"already linked","turnId":"turn-should-not-overwrite","streaming":false,"createdAt":"2026-06-01T00:01:00.000Z","updatedAt":"2026-06-01T00:01:00.000Z"}',
            '{}'
          ),
          (
            'event-user-linked',
            'thread',
            'thread-repair',
            4,
            'thread.message-sent',
            '2026-06-01T00:02:00.000Z',
            'cmd-user-linked',
            NULL,
            'corr-user-linked',
            'system',
            '{"threadId":"thread-repair","messageId":"user-detached","role":"user","text":"user message","turnId":"turn-user","streaming":false,"createdAt":"2026-06-01T00:02:00.000Z","updatedAt":"2026-06-01T00:02:00.000Z"}',
            '{}'
          ),
          (
            'event-assistant-rebound-old',
            'thread',
            'thread-repair',
            5,
            'thread.message-sent',
            '2026-06-01T00:03:00.000Z',
            'cmd-assistant-rebound-old',
            NULL,
            'corr-assistant-rebound-old',
            'system',
            '{"threadId":"thread-repair","messageId":"assistant-rebound","role":"assistant","text":"old","turnId":"turn-z-old","streaming":true,"createdAt":"2026-06-01T00:03:00.000Z","updatedAt":"2026-06-01T00:03:00.000Z"}',
            '{}'
          ),
          (
            'event-assistant-rebound-new',
            'thread',
            'thread-repair',
            6,
            'thread.message-sent',
            '2026-06-01T00:03:10.000Z',
            'cmd-assistant-rebound-new',
            NULL,
            'corr-assistant-rebound-new',
            'system',
            '{"threadId":"thread-repair","messageId":"assistant-rebound","role":"assistant","text":"new","turnId":"turn-a-new","streaming":false,"createdAt":"2026-06-01T00:03:10.000Z","updatedAt":"2026-06-01T00:03:10.000Z"}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* Migration0038;

      const rows = yield* sql<{ readonly messageId: string; readonly turnId: string | null }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId"
        FROM projection_thread_messages
        ORDER BY message_id
      `;

      assert.deepEqual(rows, [
        { messageId: "assistant-detached", turnId: "turn-restored" },
        { messageId: "assistant-existing", turnId: "turn-existing" },
        { messageId: "assistant-rebound", turnId: "turn-a-new" },
        { messageId: "user-detached", turnId: null },
      ]);
    }),
  );
});
