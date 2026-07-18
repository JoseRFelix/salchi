import {
  ChatAttachment,
  IsoDateTime,
  ModelSelection,
  OrchestrationProposedPlanId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadQueuedTurnsInput,
  GetProjectionThreadQueuedTurnByMessageIdInput,
  GetProjectionThreadQueuedTurnInput,
  ListProjectionThreadQueuedTurnsInput,
  ProjectionThreadQueuedTurn,
  ProjectionThreadQueuedTurnRepository,
  type ProjectionThreadQueuedTurnRepositoryShape,
} from "../Services/ProjectionThreadQueuedTurns.ts";

const ProjectionThreadQueuedTurnDbRow = Schema.Struct({
  threadId: ProjectionThreadQueuedTurn.fields.threadId,
  messageId: ProjectionThreadQueuedTurn.fields.messageId,
  role: ProjectionThreadQueuedTurn.fields.role,
  text: ProjectionThreadQueuedTurn.fields.text,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  titleSeed: Schema.NullOr(Schema.String),
  runtimeMode: ProjectionThreadQueuedTurn.fields.runtimeMode,
  interactionMode: ProjectionThreadQueuedTurn.fields.interactionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  steeringExpectedTurnId: Schema.NullOr(TurnId),
  steeringRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: ProjectionThreadQueuedTurn.fields.createdAt,
  updatedAt: ProjectionThreadQueuedTurn.fields.updatedAt,
});

const ProjectionThreadIdRow = Schema.Struct({
  threadId: ThreadId,
});

function toProjectionThreadQueuedTurn(
  row: Schema.Schema.Type<typeof ProjectionThreadQueuedTurnDbRow>,
): ProjectionThreadQueuedTurn {
  return {
    threadId: row.threadId,
    messageId: row.messageId,
    role: row.role,
    text: row.text,
    attachments: row.attachments,
    ...(row.modelSelection !== null ? { modelSelection: row.modelSelection } : {}),
    ...(row.titleSeed !== null ? { titleSeed: row.titleSeed } : {}),
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
    ...(row.steeringExpectedTurnId !== null && row.steeringRequestedAt !== null
      ? {
          steering: {
            expectedTurnId: row.steeringExpectedTurnId,
            requestedAt: row.steeringRequestedAt,
          },
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProjectionThreadQueuedTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadQueuedTurnRow = SqlSchema.void({
    Request: ProjectionThreadQueuedTurn,
    execute: (row) =>
      sql`
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
          ${row.messageId},
          ${row.threadId},
          ${row.role},
          ${row.text},
          ${JSON.stringify(row.attachments)},
          ${row.modelSelection !== undefined ? JSON.stringify(row.modelSelection) : null},
          ${row.titleSeed ?? null},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.sourceProposedPlan?.threadId ?? null},
          ${row.sourceProposedPlan?.planId ?? null},
          ${row.steering?.expectedTurnId ?? null},
          ${row.steering?.requestedAt ?? null},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = excluded.attachments_json,
          model_selection_json = excluded.model_selection_json,
          title_seed = excluded.title_seed,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          steering_expected_turn_id = excluded.steering_expected_turn_id,
          steering_requested_at = excluded.steering_requested_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadQueuedTurnByMessageId = SqlSchema.findOneOption({
    Request: GetProjectionThreadQueuedTurnByMessageIdInput,
    Result: ProjectionThreadQueuedTurnDbRow,
    execute: ({ messageId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          role,
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          steering_expected_turn_id AS "steeringExpectedTurnId",
          steering_requested_at AS "steeringRequestedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_turns
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const getProjectionThreadQueuedTurnByThreadAndMessageId = SqlSchema.findOneOption({
    Request: GetProjectionThreadQueuedTurnInput,
    Result: ProjectionThreadQueuedTurnDbRow,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          role,
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          steering_expected_turn_id AS "steeringExpectedTurnId",
          steering_requested_at AS "steeringRequestedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_turns
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        LIMIT 1
      `,
  });

  const getOldestProjectionThreadQueuedTurn = SqlSchema.findOneOption({
    Request: ListProjectionThreadQueuedTurnsInput,
    Result: ProjectionThreadQueuedTurnDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          role,
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          steering_expected_turn_id AS "steeringExpectedTurnId",
          steering_requested_at AS "steeringRequestedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_turns
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
        LIMIT 1
      `,
  });

  const listProjectionThreadQueuedTurns = SqlSchema.findAll({
    Request: ListProjectionThreadQueuedTurnsInput,
    Result: ProjectionThreadQueuedTurnDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          role,
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          steering_expected_turn_id AS "steeringExpectedTurnId",
          steering_requested_at AS "steeringRequestedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_turns
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listProjectionThreadIdsWithQueuedTurns = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadIdRow,
    execute: () =>
      sql`
        SELECT DISTINCT thread_id AS "threadId"
        FROM projection_thread_queued_turns
        ORDER BY thread_id ASC
      `,
  });

  const deleteProjectionThreadQueuedTurnByMessageId = SqlSchema.void({
    Request: GetProjectionThreadQueuedTurnByMessageIdInput,
    execute: ({ messageId }) =>
      sql`
        DELETE FROM projection_thread_queued_turns
        WHERE message_id = ${messageId}
      `,
  });

  const deleteProjectionThreadQueuedTurnsByThreadId = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedTurnsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_queued_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadQueuedTurnRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadQueuedTurnRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.upsert:query")),
    );

  const getByMessageId: ProjectionThreadQueuedTurnRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadQueuedTurnByMessageId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadQueuedTurn)),
    );

  const getByThreadAndMessageId: ProjectionThreadQueuedTurnRepositoryShape["getByThreadAndMessageId"] =
    (input) =>
      getProjectionThreadQueuedTurnByThreadAndMessageId(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadQueuedTurnRepository.getByThreadAndMessageId:query",
          ),
        ),
        Effect.map(Option.map(toProjectionThreadQueuedTurn)),
      );

  const getOldestByThreadId: ProjectionThreadQueuedTurnRepositoryShape["getOldestByThreadId"] = (
    input,
  ) =>
    getOldestProjectionThreadQueuedTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.getOldestByThreadId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadQueuedTurn)),
    );

  const listByThreadId: ProjectionThreadQueuedTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadQueuedTurns(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadQueuedTurn)),
    );

  const listThreadIdsWithQueuedTurns: ProjectionThreadQueuedTurnRepositoryShape["listThreadIdsWithQueuedTurns"] =
    () =>
      listProjectionThreadIdsWithQueuedTurns(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadQueuedTurnRepository.listThreadIdsWithQueuedTurns:query",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      );

  const deleteByMessageId: ProjectionThreadQueuedTurnRepositoryShape["deleteByMessageId"] = (
    input,
  ) =>
    deleteProjectionThreadQueuedTurnByMessageId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.deleteByMessageId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadQueuedTurnRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadQueuedTurnsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    getByThreadAndMessageId,
    getOldestByThreadId,
    listByThreadId,
    listThreadIdsWithQueuedTurns,
    deleteByMessageId,
    deleteByThreadId,
  } satisfies ProjectionThreadQueuedTurnRepositoryShape;
});

export const ProjectionThreadQueuedTurnRepositoryLive = Layer.effect(
  ProjectionThreadQueuedTurnRepository,
  makeProjectionThreadQueuedTurnRepository,
);
