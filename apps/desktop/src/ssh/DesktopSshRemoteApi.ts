import {
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  type AuthAccessTokenResult as AuthAccessTokenResultType,
  type AuthSessionState as AuthSessionStateType,
  type AuthWebSocketTicketResult as AuthWebSocketTicketResultType,
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as ExecutionEnvironmentDescriptorType,
} from "@salchi/contracts";
import { SshHttpBridgeError } from "@salchi/ssh/errors";
import { fetchLoopbackSshJson } from "@salchi/ssh/tunnel";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

export type DesktopSshRemoteApiOperation =
  | "fetch-environment-descriptor"
  | "bootstrap-bearer-session"
  | "fetch-session-state"
  | "issue-websocket-ticket";

export class DesktopSshRemoteApiError extends Data.TaggedError("DesktopSshRemoteApiError")<{
  readonly operation: DesktopSshRemoteApiOperation;
  readonly cause: SshHttpBridgeError | Schema.SchemaError;
  readonly sshHttpStatus: number | null;
}> {
  override get message() {
    const statusPrefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${statusPrefix}SSH remote API request failed during ${this.operation}.`;
  }
}

export interface DesktopSshRemoteApiShape {
  readonly fetchEnvironmentDescriptor: (input: {
    readonly httpBaseUrl: string;
  }) => Effect.Effect<ExecutionEnvironmentDescriptorType, DesktopSshRemoteApiError>;
  readonly bootstrapBearerSession: (input: {
    readonly httpBaseUrl: string;
    readonly credential: string;
  }) => Effect.Effect<AuthAccessTokenResultType, DesktopSshRemoteApiError>;
  readonly fetchSessionState: (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
  }) => Effect.Effect<AuthSessionStateType, DesktopSshRemoteApiError>;
  readonly issueWebSocketTicket: (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
  }) => Effect.Effect<AuthWebSocketTicketResultType, DesktopSshRemoteApiError>;
}

export class DesktopSshRemoteApi extends Context.Service<
  DesktopSshRemoteApi,
  DesktopSshRemoteApiShape
>()("@salchi/desktop/ssh/DesktopSshRemoteApi") {}

const decodeExecutionEnvironmentDescriptor = Schema.decodeUnknownEffect(
  ExecutionEnvironmentDescriptor,
);
const decodeAuthAccessTokenResult = Schema.decodeUnknownEffect(AuthAccessTokenResult);
const decodeAuthSessionState = Schema.decodeUnknownEffect(AuthSessionState);
const decodeAuthWebSocketTicketResult = Schema.decodeUnknownEffect(AuthWebSocketTicketResult);

export function readSshHttpStatus(cause: SshHttpBridgeError | Schema.SchemaError): number | null {
  return cause instanceof SshHttpBridgeError ? (cause.status ?? null) : null;
}

const mapError =
  (operation: DesktopSshRemoteApiOperation) =>
  (cause: SshHttpBridgeError | Schema.SchemaError): DesktopSshRemoteApiError =>
    new DesktopSshRemoteApiError({ operation, cause, sshHttpStatus: readSshHttpStatus(cause) });

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const provideHttpClient = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  return DesktopSshRemoteApi.of({
    fetchEnvironmentDescriptor: ({ httpBaseUrl }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/.well-known/salchi/environment",
      }).pipe(
        Effect.flatMap(decodeExecutionEnvironmentDescriptor),
        Effect.mapError(mapError("fetch-environment-descriptor")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.fetchEnvironmentDescriptor"),
      ),
    bootstrapBearerSession: ({ httpBaseUrl, credential }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/oauth/token",
        method: "POST",
        body: { subject_token: credential },
      }).pipe(
        Effect.flatMap(decodeAuthAccessTokenResult),
        Effect.mapError(mapError("bootstrap-bearer-session")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.bootstrapBearerSession"),
      ),
    fetchSessionState: ({ httpBaseUrl, bearerToken }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/api/auth/session",
        bearerToken,
      }).pipe(
        Effect.flatMap(decodeAuthSessionState),
        Effect.mapError(mapError("fetch-session-state")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.fetchSessionState"),
      ),
    issueWebSocketTicket: ({ httpBaseUrl, bearerToken }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/api/auth/websocket-ticket",
        method: "POST",
        bearerToken,
      }).pipe(
        Effect.flatMap(decodeAuthWebSocketTicketResult),
        Effect.mapError(mapError("issue-websocket-ticket")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.issueWebSocketTicket"),
      ),
  });
});

export const layer = Layer.effect(DesktopSshRemoteApi, make);
