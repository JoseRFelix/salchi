import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@salchi/ssh/errors";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  DesktopSshEnvironmentRequestError,
  fetchSshSessionState,
  issueSshWebSocketTicket,
} from "./sshEnvironment.ts";
import * as DesktopSshRemoteApi from "../../ssh/DesktopSshRemoteApi.ts";

function makeRemoteApiLayer(overrides: Partial<DesktopSshRemoteApi.DesktopSshRemoteApiShape>) {
  const notImplemented = (operation: DesktopSshRemoteApi.DesktopSshRemoteApiOperation) =>
    Effect.die(new Error(`${operation} not implemented in test`));

  return Layer.succeed(
    DesktopSshRemoteApi.DesktopSshRemoteApi,
    DesktopSshRemoteApi.DesktopSshRemoteApi.of({
      fetchEnvironmentDescriptor: () => notImplemented("fetch-environment-descriptor"),
      bootstrapBearerSession: () => notImplemented("bootstrap-bearer-session"),
      fetchSessionState: () => notImplemented("fetch-session-state"),
      issueWebSocketTicket: () => notImplemented("issue-websocket-ticket"),
      ...overrides,
    }),
  );
}

function makeRemoteApiError(input: {
  readonly operation: DesktopSshRemoteApi.DesktopSshRemoteApiOperation;
  readonly status: number | null;
}) {
  return new DesktopSshRemoteApi.DesktopSshRemoteApiError({
    operation: input.operation,
    sshHttpStatus: input.status,
    cause: new SshHttpBridgeError({
      ...(input.status === null ? {} : { status: input.status }),
      message:
        input.status === null
          ? "Forwarded endpoint returned invalid JSON."
          : `Forwarded request failed (${input.status}).`,
    }),
  });
}

function findRequestError(cause: Cause.Cause<unknown>) {
  const failure = Cause.findErrorOption(cause);
  assert(Option.isSome(failure));
  assert.instanceOf(failure.value, DesktopSshEnvironmentRequestError);
  return failure.value;
}

describe("SSH environment IPC", () => {
  it.effect("preserves ssh http status in request errors", () => {
    const layer = makeRemoteApiLayer({
      fetchSessionState: () =>
        Effect.fail(makeRemoteApiError({ operation: "fetch-session-state", status: 401 })),
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshSessionState.handler({
          httpBaseUrl: "http://127.0.0.1:41773/",
          bearerToken: "expired-token",
        }),
      );
      assert(Exit.isFailure(exit));
      const error = findRequestError(exit.cause);

      assert.equal(error.operation, "fetch-session-state");
      assert.equal(error.sshHttpStatus, 401);
      assert.match(error.message, /^\[ssh_http:401\]/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("preserves websocket ticket status in request errors", () => {
    const layer = makeRemoteApiLayer({
      issueWebSocketTicket: () =>
        Effect.fail(makeRemoteApiError({ operation: "issue-websocket-ticket", status: 403 })),
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        issueSshWebSocketTicket.handler({
          httpBaseUrl: "http://127.0.0.1:41773/",
          bearerToken: "missing-scope-token",
        }),
      );
      assert(Exit.isFailure(exit));
      const error = findRequestError(exit.cause);

      assert.equal(error.operation, "issue-websocket-ticket");
      assert.equal(error.sshHttpStatus, 403);
      assert.match(error.message, /^\[ssh_http:403\]/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not invent ssh http status for decode failures", () => {
    const layer = makeRemoteApiLayer({
      fetchSessionState: () =>
        Effect.fail(makeRemoteApiError({ operation: "fetch-session-state", status: null })),
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshSessionState.handler({
          httpBaseUrl: "http://127.0.0.1:41773/",
          bearerToken: "valid-token",
        }),
      );
      assert(Exit.isFailure(exit));
      const error = findRequestError(exit.cause);

      assert.equal(error.operation, "fetch-session-state");
      assert.equal(error.sshHttpStatus, null);
      assert.equal(error.message.includes("[ssh_http:"), false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes successful session state responses through the IPC schema", () => {
    const layer = makeRemoteApiLayer({
      fetchSessionState: () =>
        Effect.succeed({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-access-token"],
            sessionCookieName: "salchi_session",
          },
          role: "client",
          sessionMethod: "bearer-access-token",
          expiresAt: DateTime.makeUnsafe("2026-05-01T12:00:00.000Z"),
          scopes: ["orchestration:read", "relay:read"],
        }),
    });

    return Effect.gen(function* () {
      const result = yield* fetchSshSessionState.handler({
        httpBaseUrl: "http://127.0.0.1:41773/",
        bearerToken: "valid-token",
      });

      assert.equal((result as { readonly authenticated: boolean }).authenticated, true);
      assert.equal(
        (result as { readonly auth: { readonly sessionCookieName: string } }).auth
          .sessionCookieName,
        "salchi_session",
      );
    }).pipe(Effect.provide(layer));
  });
});
