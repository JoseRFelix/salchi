import * as Schema from "effect/Schema";

import { AuthSessionId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WebPushSubscriptionKeys = Schema.Struct({
  p256dh: TrimmedNonEmptyString,
  auth: TrimmedNonEmptyString,
});
export type WebPushSubscriptionKeys = typeof WebPushSubscriptionKeys.Type;

export const WebPushSubscriptionJson = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  expirationTime: Schema.NullOr(NonNegativeInt),
  keys: WebPushSubscriptionKeys,
});
export type WebPushSubscriptionJson = typeof WebPushSubscriptionJson.Type;

export const ServerPushNotificationPayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  tag: Schema.optional(TrimmedNonEmptyString),
});
export type ServerPushNotificationPayload = typeof ServerPushNotificationPayload.Type;

export const ServerPushConfig = Schema.Struct({
  supported: Schema.Boolean,
  publicVapidKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerPushConfig = typeof ServerPushConfig.Type;

export const ServerPushSubscriptionStatus = Schema.Struct({
  subscribed: Schema.Boolean,
  endpoint: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerPushSubscriptionStatus = typeof ServerPushSubscriptionStatus.Type;

export const ServerRegisterPushSubscriptionInput = Schema.Struct({
  subscription: WebPushSubscriptionJson,
  userAgent: Schema.optional(TrimmedNonEmptyString),
});
export type ServerRegisterPushSubscriptionInput = typeof ServerRegisterPushSubscriptionInput.Type;

export const ServerUnregisterPushSubscriptionInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
});
export type ServerUnregisterPushSubscriptionInput =
  typeof ServerUnregisterPushSubscriptionInput.Type;

export const ServerSendTestPushNotificationInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
});
export type ServerSendTestPushNotificationInput = typeof ServerSendTestPushNotificationInput.Type;

export const ServerPushSendResult = Schema.Struct({
  sentCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  lastFailureDetail: Schema.optional(TrimmedNonEmptyString),
});
export type ServerPushSendResult = typeof ServerPushSendResult.Type;

export const ServerPushSubscriptionRecord = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  sessionId: AuthSessionId,
  p256dh: TrimmedNonEmptyString,
  auth: TrimmedNonEmptyString,
  expirationTime: Schema.NullOr(NonNegativeInt),
  userAgent: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  lastSuccessfulPushAt: Schema.NullOr(Schema.DateTimeUtc),
  lastFailedPushAt: Schema.NullOr(Schema.DateTimeUtc),
  failureCount: NonNegativeInt,
  disabledAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type ServerPushSubscriptionRecord = typeof ServerPushSubscriptionRecord.Type;

export class ServerPushNotificationError extends Schema.TaggedErrorClass<ServerPushNotificationError>()(
  "ServerPushNotificationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}
