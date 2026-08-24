import type { ServerPushSendResult, ServerPushSubscriptionRecord } from "@salchi/contracts";
import { ServerPushNotificationError, ServerPushNotificationPayload } from "@salchi/contracts";
import { resolveTailscaleHttpsBaseUrl } from "@salchi/tailscale";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import WebPush, { type PushSubscription } from "web-push";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { WebPushSubscriptionRepository } from "../../persistence/Services/WebPushSubscriptions.ts";
import { WebPushService, type WebPushServiceShape } from "../Services/WebPushService.ts";

const WEB_PUSH_VAPID_SECRET_NAME = "web-push-vapid";
const WEB_PUSH_FALLBACK_VAPID_SUBJECT = "mailto:web-push@example.com";
const WEB_PUSH_TTL_SECONDS = 60 * 60 * 24;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const VapidKeys = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});
type VapidKeys = typeof VapidKeys.Type;

interface PushSendAttempt {
  readonly sent: boolean;
  readonly failureDetail?: string;
}

const decodeVapidKeysJson = Schema.decodeUnknownEffect(Schema.fromJsonString(VapidKeys));
const encodeVapidKeysJson = Schema.encodeUnknownEffect(Schema.fromJsonString(VapidKeys));
const encodePushPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(ServerPushNotificationPayload),
);

function makePushError(input: {
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}): ServerPushNotificationError {
  return new ServerPushNotificationError({
    operation: input.operation,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function toWebPushSubscription(record: ServerPushSubscriptionRecord): PushSubscription {
  return {
    endpoint: record.endpoint,
    expirationTime: record.expirationTime,
    keys: {
      p256dh: record.p256dh,
      auth: record.auth,
    },
  };
}

function isGonePushError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return false;
  }
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return statusCode === 404 || statusCode === 410;
}

function readPushHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return null;
  }
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && Number.isFinite(statusCode) ? statusCode : null;
}

function readPushResponseBody(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("body" in error)) {
    return null;
  }
  const body = (error as { readonly body?: unknown }).body;
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return textDecoder.decode(body);
  }
  return null;
}

function formatPushFailure(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
  const statusCode = readPushHttpStatus(error);
  const body = readPushResponseBody(error);
  const statusDetail = statusCode === null ? "" : ` (${statusCode})`;
  const bodyDetail = body ? `: ${truncateNotificationText(body, 240)}` : "";
  return `${message}${statusDetail}${bodyDetail}`;
}

function truncateNotificationText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizePayload(payload: ServerPushNotificationPayload): ServerPushNotificationPayload {
  const body = payload.body ? truncateNotificationText(payload.body, 240) : undefined;
  return {
    title: truncateNotificationText(payload.title, 80),
    ...(body ? { body } : {}),
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.tag ? { tag: payload.tag } : {}),
    ...(payload.completion ? { completion: payload.completion } : {}),
    ...(payload.unreadCompletionState
      ? { unreadCompletionState: payload.unreadCompletionState }
      : {}),
    ...(payload.completionAttentionVersion === 2 ? { completionAttentionVersion: 2 as const } : {}),
  };
}

export const normalizeWebPushPayloadForTest = normalizePayload;

function urlOriginOrNull(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export const makeWebPushService = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore;
  const subscriptions = yield* WebPushSubscriptionRepository;

  const loadOrCreateVapidKeys = Effect.gen(function* () {
    const existing = yield* secrets.get(WEB_PUSH_VAPID_SECRET_NAME).pipe(
      Effect.mapError((cause) =>
        makePushError({
          operation: "push.loadVapidKeys",
          detail: "Stored VAPID keys could not be read.",
          cause,
        }),
      ),
    );
    if (existing !== null) {
      return yield* decodeVapidKeysJson(textDecoder.decode(existing)).pipe(
        Effect.mapError((cause) =>
          makePushError({
            operation: "push.loadVapidKeys",
            detail: "Stored VAPID keys are invalid.",
            cause,
          }),
        ),
      );
    }

    const generated = WebPush.generateVAPIDKeys();
    const json = yield* encodeVapidKeysJson(generated).pipe(
      Effect.mapError((cause) =>
        makePushError({
          operation: "push.createVapidKeys",
          detail: "Generated VAPID keys could not be encoded.",
          cause,
        }),
      ),
    );
    yield* secrets.set(WEB_PUSH_VAPID_SECRET_NAME, textEncoder.encode(json)).pipe(
      Effect.mapError((cause) =>
        makePushError({
          operation: "push.createVapidKeys",
          detail: "Generated VAPID keys could not be stored.",
          cause,
        }),
      ),
    );
    return generated;
  });
  const loadOrCreateVapidKeysCached = yield* Effect.cached(loadOrCreateVapidKeys);

  const getVapidKeys = loadOrCreateVapidKeysCached;

  const resolveVapidSubject = Effect.gen(function* () {
    if (serverConfig.tailscaleServeEnabled) {
      const tailscaleBaseUrl = yield* resolveTailscaleHttpsBaseUrl({
        servePort: serverConfig.tailscaleServePort,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.catch((cause) =>
          Effect.logWarning("failed to resolve Tailscale VAPID subject", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      const tailscaleOrigin = tailscaleBaseUrl ? urlOriginOrNull(tailscaleBaseUrl) : null;
      if (tailscaleOrigin) {
        return tailscaleOrigin;
      }
    }

    if (serverConfig.devUrl?.protocol === "https:") {
      return serverConfig.devUrl.origin;
    }

    return WEB_PUSH_FALLBACK_VAPID_SUBJECT;
  });

  const nowUtc = Effect.map(DateTime.now, DateTime.toUtc);

  const sendOne = (
    record: ServerPushSubscriptionRecord,
    payload: ServerPushNotificationPayload,
    vapidKeys: VapidKeys,
    vapidSubject: string,
  ): Effect.Effect<PushSendAttempt, never, never> =>
    Effect.gen(function* () {
      const normalizedPayload = normalizePayload(payload);
      const jsonPayload = yield* encodePushPayloadJson(normalizedPayload).pipe(
        Effect.mapError((cause) =>
          makePushError({
            operation: "push.encodePayload",
            detail: "Push notification payload could not be encoded.",
            cause,
          }),
        ),
      );

      return yield* Effect.tryPromise({
        try: () =>
          WebPush.sendNotification(toWebPushSubscription(record), jsonPayload, {
            TTL: WEB_PUSH_TTL_SECONDS,
            urgency: "normal",
            vapidDetails: {
              subject: vapidSubject,
              publicKey: vapidKeys.publicKey,
              privateKey: vapidKeys.privateKey,
            },
          }),
        catch: (cause) =>
          makePushError({
            operation: "push.sendNotification",
            detail: "Web push delivery failed.",
            cause,
          }),
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.gen(function* () {
              const now = yield* nowUtc;
              const cause = error.cause ?? error;
              const failureDetail = formatPushFailure(cause);
              if (isGonePushError(cause)) {
                yield* subscriptions
                  .disable({ endpoint: record.endpoint, now })
                  .pipe(Effect.ignoreCause({ log: true }));
              } else {
                yield* subscriptions
                  .markFailure({ endpoint: record.endpoint, now })
                  .pipe(Effect.ignoreCause({ log: true }));
              }
              yield* Effect.logWarning("web push delivery failed", {
                endpoint: record.endpoint,
                detail: failureDetail,
              });
              return { sent: false, failureDetail };
            }),
          onSuccess: () =>
            Effect.gen(function* () {
              const now = yield* nowUtc;
              yield* subscriptions
                .markSuccess({ endpoint: record.endpoint, now })
                .pipe(Effect.ignoreCause({ log: true }));
              return { sent: true };
            }),
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("web push delivery bookkeeping failed", {
          endpoint: record.endpoint,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.as({
            sent: false,
            failureDetail: "Push delivery bookkeeping failed.",
          }),
        );
      }),
    );

  const sendToRecords = (
    records: ReadonlyArray<ServerPushSubscriptionRecord>,
    payload: ServerPushNotificationPayload,
  ): Effect.Effect<ServerPushSendResult, ServerPushNotificationError> =>
    Effect.gen(function* () {
      if (records.length === 0) {
        return { sentCount: 0, failedCount: 0 };
      }
      const vapidKeys = yield* getVapidKeys;
      const vapidSubject = yield* resolveVapidSubject;
      yield* Effect.sync(() => {
        WebPush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);
      });
      const results = yield* Effect.forEach(
        records,
        (record) => sendOne(record, payload, vapidKeys, vapidSubject),
        {
          concurrency: 8,
        },
      );
      const sentCount = results.filter((result) => result.sent).length;
      const lastFailureDetail = results.findLast((result) => !result.sent)?.failureDetail;
      return {
        sentCount,
        failedCount: records.length - sentCount,
        ...(lastFailureDetail ? { lastFailureDetail } : {}),
      };
    });

  const getActiveSubscriptions = Effect.fn("getActiveSubscriptions")(function* () {
    const now = yield* nowUtc;
    return yield* subscriptions.listActive({ now }).pipe(
      Effect.mapError((cause) =>
        makePushError({
          operation: "push.listSubscriptions",
          detail: "Failed to load active push subscriptions.",
          cause,
        }),
      ),
    );
  });

  const getConfig: WebPushServiceShape["getConfig"] = getVapidKeys.pipe(
    Effect.map((keys) => ({
      supported: true,
      publicVapidKey: keys.publicKey,
    })),
  );

  const registerSubscription: WebPushServiceShape["registerSubscription"] = (sessionId, input) =>
    Effect.gen(function* () {
      const now = yield* nowUtc;
      yield* subscriptions
        .upsert({
          sessionId,
          subscription: input.subscription,
          userAgent: input.userAgent ?? null,
          now,
        })
        .pipe(
          Effect.mapError((cause) =>
            makePushError({
              operation: "push.registerSubscription",
              detail: "Failed to store push subscription.",
              cause,
            }),
          ),
        );
      return {
        subscribed: true,
        endpoint: input.subscription.endpoint,
      };
    });

  const unregisterSubscription: WebPushServiceShape["unregisterSubscription"] = (
    sessionId,
    input,
  ) =>
    subscriptions.removeByEndpointForSession({ sessionId, endpoint: input.endpoint }).pipe(
      Effect.mapError((cause) =>
        makePushError({
          operation: "push.unregisterSubscription",
          detail: "Failed to remove push subscription.",
          cause,
        }),
      ),
      Effect.map(() => ({
        subscribed: false,
        endpoint: null,
      })),
    );

  const sendTestNotification: WebPushServiceShape["sendTestNotification"] = (sessionId, input) =>
    Effect.gen(function* () {
      const activeSubscriptions = yield* getActiveSubscriptions();
      const matchingSubscription = activeSubscriptions.find(
        (entry) => entry.sessionId === sessionId && entry.endpoint === input.endpoint,
      );
      if (!matchingSubscription) {
        return yield* makePushError({
          operation: "push.sendTestNotification",
          detail: "Push subscription is not active for this session.",
        });
      }
      const result = yield* sendToRecords([matchingSubscription], {
        title: "Salchi notifications are enabled",
        body: "You will receive alerts when an agent needs attention or finishes a turn.",
        url: "/",
        tag: "salchi:test",
      });
      if (result.sentCount === 0) {
        return yield* makePushError({
          operation: "push.sendTestNotification",
          detail: result.lastFailureDetail
            ? `Push provider rejected the test notification: ${result.lastFailureDetail}`
            : "Push provider rejected the test notification.",
        });
      }
      return result;
    });

  const sendToActiveSubscriptions: WebPushServiceShape["sendToActiveSubscriptions"] = (input) =>
    Effect.gen(function* () {
      const activeSubscriptions = yield* getActiveSubscriptions();
      return yield* sendToRecords(activeSubscriptions, input.payload);
    });

  return {
    getConfig,
    registerSubscription,
    unregisterSubscription,
    sendTestNotification,
    sendToActiveSubscriptions,
  } satisfies WebPushServiceShape;
});

export const WebPushServiceLive = Layer.effect(WebPushService, makeWebPushService);

export const WebPushServiceNoop = Layer.succeed(WebPushService, {
  getConfig: Effect.succeed({
    supported: false,
    publicVapidKey: null,
  }),
  registerSubscription: (_sessionId, input) =>
    Effect.succeed({
      subscribed: true,
      endpoint: input.subscription.endpoint,
    }),
  unregisterSubscription: () =>
    Effect.succeed({
      subscribed: false,
      endpoint: null,
    }),
  sendTestNotification: () =>
    Effect.succeed({
      sentCount: 0,
      failedCount: 0,
    }),
  sendToActiveSubscriptions: () =>
    Effect.succeed({
      sentCount: 0,
      failedCount: 0,
    }),
} satisfies WebPushServiceShape);
