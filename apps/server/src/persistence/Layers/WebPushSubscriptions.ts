import { AuthSessionId, NonNegativeInt, ServerPushSubscriptionRecord } from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type WebPushSubscriptionRepositoryError,
} from "../Errors.ts";
import {
  DisableWebPushSubscriptionInput,
  ListActiveWebPushSubscriptionsInput,
  MarkWebPushSubscriptionFailureInput,
  MarkWebPushSubscriptionSuccessInput,
  RemoveWebPushSubscriptionInput,
  UpsertWebPushSubscriptionInput,
  WebPushSubscriptionRepository,
  type WebPushSubscriptionRepositoryShape,
} from "../Services/WebPushSubscriptions.ts";

const WebPushSubscriptionDbRow = Schema.Struct({
  endpoint: Schema.String,
  sessionId: AuthSessionId,
  p256dh: Schema.String,
  auth: Schema.String,
  expirationTime: Schema.NullOr(NonNegativeInt),
  userAgent: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  lastSuccessfulPushAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastFailedPushAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  failureCount: NonNegativeInt,
  disabledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

function toRecord(row: typeof WebPushSubscriptionDbRow.Type): ServerPushSubscriptionRecord {
  return row;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): WebPushSubscriptionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeWebPushSubscriptionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertSubscriptionRow = SqlSchema.void({
    Request: UpsertWebPushSubscriptionInput,
    execute: ({ sessionId, subscription, userAgent, now }) =>
      sql`
        INSERT INTO web_push_subscriptions (
          endpoint,
          session_id,
          p256dh,
          auth,
          expiration_time,
          user_agent,
          created_at,
          updated_at,
          failure_count,
          disabled_at
        )
        VALUES (
          ${subscription.endpoint},
          ${sessionId},
          ${subscription.keys.p256dh},
          ${subscription.keys.auth},
          ${subscription.expirationTime},
          ${userAgent},
          ${now},
          ${now},
          0,
          NULL
        )
        ON CONFLICT(endpoint) DO UPDATE SET
          session_id = excluded.session_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          expiration_time = excluded.expiration_time,
          user_agent = excluded.user_agent,
          updated_at = excluded.updated_at,
          failure_count = 0,
          disabled_at = NULL
      `,
  });

  const removeSubscriptionRow = SqlSchema.findAll({
    Request: RemoveWebPushSubscriptionInput,
    Result: Schema.Struct({ endpoint: Schema.String }),
    execute: ({ sessionId, endpoint }) =>
      sql`
        DELETE FROM web_push_subscriptions
        WHERE endpoint = ${endpoint}
          AND session_id = ${sessionId}
        RETURNING endpoint AS "endpoint"
      `,
  });

  const listActiveSubscriptionRows = SqlSchema.findAll({
    Request: ListActiveWebPushSubscriptionsInput,
    Result: WebPushSubscriptionDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          web_push_subscriptions.endpoint AS "endpoint",
          web_push_subscriptions.session_id AS "sessionId",
          web_push_subscriptions.p256dh AS "p256dh",
          web_push_subscriptions.auth AS "auth",
          web_push_subscriptions.expiration_time AS "expirationTime",
          web_push_subscriptions.user_agent AS "userAgent",
          web_push_subscriptions.created_at AS "createdAt",
          web_push_subscriptions.updated_at AS "updatedAt",
          web_push_subscriptions.last_successful_push_at AS "lastSuccessfulPushAt",
          web_push_subscriptions.last_failed_push_at AS "lastFailedPushAt",
          web_push_subscriptions.failure_count AS "failureCount",
          web_push_subscriptions.disabled_at AS "disabledAt"
        FROM web_push_subscriptions
        INNER JOIN auth_sessions
          ON auth_sessions.session_id = web_push_subscriptions.session_id
        WHERE web_push_subscriptions.disabled_at IS NULL
          AND auth_sessions.revoked_at IS NULL
          AND auth_sessions.expires_at > ${now}
        ORDER BY web_push_subscriptions.updated_at DESC
      `,
  });

  const markSuccessRow = SqlSchema.void({
    Request: MarkWebPushSubscriptionSuccessInput,
    execute: ({ endpoint, now }) =>
      sql`
        UPDATE web_push_subscriptions
        SET
          last_successful_push_at = ${now},
          updated_at = ${now},
          failure_count = 0
        WHERE endpoint = ${endpoint}
      `,
  });

  const markFailureRow = SqlSchema.void({
    Request: MarkWebPushSubscriptionFailureInput,
    execute: ({ endpoint, now }) =>
      sql`
        UPDATE web_push_subscriptions
        SET
          last_failed_push_at = ${now},
          updated_at = ${now},
          failure_count = failure_count + 1
        WHERE endpoint = ${endpoint}
      `,
  });

  const disableRow = SqlSchema.void({
    Request: DisableWebPushSubscriptionInput,
    execute: ({ endpoint, now }) =>
      sql`
        UPDATE web_push_subscriptions
        SET
          disabled_at = ${now},
          updated_at = ${now}
        WHERE endpoint = ${endpoint}
      `,
  });

  const upsert: WebPushSubscriptionRepositoryShape["upsert"] = (input) =>
    upsertSubscriptionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.upsert:query",
          "WebPushSubscriptionRepository.upsert:encodeRequest",
        ),
      ),
    );

  const removeByEndpointForSession: WebPushSubscriptionRepositoryShape["removeByEndpointForSession"] =
    (input) =>
      removeSubscriptionRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "WebPushSubscriptionRepository.removeByEndpointForSession:query",
            "WebPushSubscriptionRepository.removeByEndpointForSession:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );

  const listActive: WebPushSubscriptionRepositoryShape["listActive"] = (input) =>
    listActiveSubscriptionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.listActive:query",
          "WebPushSubscriptionRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toRecord)),
    );

  const markSuccess: WebPushSubscriptionRepositoryShape["markSuccess"] = (input) =>
    markSuccessRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.markSuccess:query",
          "WebPushSubscriptionRepository.markSuccess:encodeRequest",
        ),
      ),
    );

  const markFailure: WebPushSubscriptionRepositoryShape["markFailure"] = (input) =>
    markFailureRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.markFailure:query",
          "WebPushSubscriptionRepository.markFailure:encodeRequest",
        ),
      ),
    );

  const disable: WebPushSubscriptionRepositoryShape["disable"] = (input) =>
    disableRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.disable:query",
          "WebPushSubscriptionRepository.disable:encodeRequest",
        ),
      ),
    );

  return {
    upsert,
    removeByEndpointForSession,
    listActive,
    markSuccess,
    markFailure,
    disable,
  } satisfies WebPushSubscriptionRepositoryShape;
});

export const WebPushSubscriptionRepositoryLive = Layer.effect(
  WebPushSubscriptionRepository,
  makeWebPushSubscriptionRepository,
);
