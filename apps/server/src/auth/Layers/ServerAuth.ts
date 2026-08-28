import {
  AuthAccessTokenType,
  AuthAccessTokenResult,
  type AuthBearerBootstrapResult,
  AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthBootstrapResult,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  AuthWebSocketTicketResult,
  type AuthWebSocketTokenResult,
} from "@salchi/contracts";
import { encodeOAuthScope } from "@salchi/shared/oauthScope";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
} from "../Services/SessionCredentialService.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane.ts";
import { scopesForSessionRole } from "../scopes.ts";

type BootstrapExchangeResult = {
  readonly response: AuthBootstrapResult;
  readonly sessionToken: string;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TOKEN_QUERY_PARAM = "wsToken";
const WEBSOCKET_TICKET_QUERY_PARAM = "ticket";

function selectGrantedScopes(input: {
  readonly role: "owner" | "client";
  readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
}): ReadonlyArray<AuthEnvironmentScope> {
  const grantedScopes = scopesForSessionRole(input.role);
  if (!input.requestedScopes || input.requestedScopes.length === 0) {
    return grantedScopes;
  }
  const grantedSet = new Set(grantedScopes);
  return input.requestedScopes.filter((scope) => grantedSet.has(scope));
}

export function toBootstrapExchangeAuthError(cause: BootstrapCredentialError): AuthError {
  if (cause.status === 500) {
    return new AuthError({
      message: "Failed to validate bootstrap credential.",
      status: 500,
      cause,
    });
  }

  return new AuthError({
    message: "Invalid bootstrap credential.",
    status: 401,
    cause,
  });
}

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const authControlPlane = yield* AuthControlPlane;
  const sessions = yield* SessionCredentialService;
  const descriptor = yield* policy.getDescriptor();

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.tapError((cause: SessionCredentialError) =>
        Effect.logWarning("Rejected authenticated session credential.").pipe(
          Effect.annotateLogs({
            reason: cause.message,
          }),
        ),
      ),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        role: session.role,
        scopes: new Set(session.scopes ?? scopesForSessionRole(session.role)),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Unauthorized request.",
            status: 401,
            cause,
          }),
      ),
    );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    const bearerToken = parseBearerToken(request);
    const credential = cookieToken ?? bearerToken;
    if (!credential) {
      return Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      );
    }
    return authenticateToken(credential);
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            role: session.role,
            scopes: [...session.scopes],
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchTag("AuthError", () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
    );

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) =>
        sessions
          .issue({
            method: "browser-session-cookie",
            subject: grant.subject,
            role: grant.role,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          ),
      ),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              role: session.role,
              scopes: scopesForSessionRole(session.role),
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBootstrapResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
    );

  const exchangeBootstrapCredentialForBrowserSession: ServerAuthShape["exchangeBootstrapCredentialForBrowserSession"] =
    (credential, requestMetadata) =>
      exchangeBootstrapCredential(credential, requestMetadata).pipe(
        Effect.map(
          (result) =>
            ({
              response: {
                authenticated: true,
                role: result.response.role,
                scopes: result.response.scopes ?? scopesForSessionRole(result.response.role),
                sessionMethod: result.response.sessionMethod,
                expiresAt: result.response.expiresAt,
              } satisfies AuthBrowserSessionResult,
              sessionToken: result.sessionToken,
            }) satisfies {
              readonly response: AuthBrowserSessionResult;
              readonly sessionToken: string;
            },
        ),
      );

  const exchangeBootstrapCredentialForBearerSessionWithScopes = (
    credential: string,
    requestMetadata: AuthClientMetadata,
    requestedScopes?: ReadonlyArray<AuthEnvironmentScope>,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) => {
        const scopes = selectGrantedScopes({
          role: grant.role,
          ...(requestedScopes ? { requestedScopes } : {}),
        });
        return sessions
          .issue({
            method: "bearer-access-token",
            subject: grant.subject,
            role: grant.role,
            scopes,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          );
      }),
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            role: session.role,
            scopes: session.scopes ?? scopesForSessionRole(session.role),
            sessionMethod: "bearer-access-token",
            expiresAt: DateTime.toUtc(session.expiresAt),
            sessionToken: session.token,
          }) satisfies AuthBearerBootstrapResult,
      ),
    );

  const exchangeBootstrapCredentialForBearerSession: ServerAuthShape["exchangeBootstrapCredentialForBearerSession"] =
    (credential, requestMetadata) =>
      exchangeBootstrapCredentialForBearerSessionWithScopes(credential, requestMetadata);

  const exchangeBootstrapCredentialForAccessToken: ServerAuthShape["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestMetadata, requestedScopes) =>
      exchangeBootstrapCredentialForBearerSessionWithScopes(
        credential,
        requestMetadata,
        requestedScopes,
      ).pipe(
        Effect.flatMap((session) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            return {
              access_token: session.sessionToken,
              issued_token_type: AuthAccessTokenType,
              token_type: "Bearer",
              expires_in: Math.max(
                0,
                Math.floor((DateTime.toDate(session.expiresAt).getTime() - now) / 1000),
              ),
              scope: encodeOAuthScope(session.scopes ?? scopesForSessionRole(session.role)),
            } satisfies AuthAccessTokenResult;
          }),
        ),
      );

  const issuePairingCredential: ServerAuthShape["issuePairingCredential"] = (input) =>
    authControlPlane
      .createPairingLink({
        role: input?.role ?? "client",
        subject: input?.role === "owner" ? "owner-bootstrap" : "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue pairing credential.",
              cause,
            }),
        ),
        Effect.map(
          (issued) =>
            ({
              id: issued.id,
              credential: issued.credential,
              ...(issued.label ? { label: issued.label } : {}),
              expiresAt: issued.expiresAt,
            }) satisfies AuthPairingCredentialResult,
        ),
      );

  const listPairingLinks: ServerAuthShape["listPairingLinks"] = () =>
    authControlPlane
      .listPairingLinks({
        role: "client",
        excludeSubjects: ["owner-bootstrap"],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load pairing links.",
              cause,
            }),
        ),
        Effect.map((pairingLinks) =>
          pairingLinks.map((pairingLink) => ({
            ...pairingLink,
            scopes: pairingLink.scopes ?? scopesForSessionRole(pairingLink.role),
          })),
        ),
      );

  const revokePairingLink: ServerAuthShape["revokePairingLink"] = (id) =>
    authControlPlane.revokePairingLink(id).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke pairing link.",
            cause,
          }),
      ),
    );

  const listClientSessions: ServerAuthShape["listClientSessions"] = (currentSessionId) =>
    authControlPlane.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load paired clients.",
            cause,
          }),
      ),
      Effect.map((clientSessions) =>
        clientSessions.map((clientSession): AuthClientSession => ({
          ...clientSession,
          scopes: clientSession.scopes ?? scopesForSessionRole(clientSession.role),
          current: clientSession.sessionId === currentSessionId,
        })),
      ),
    );

  const revokeClientSession: ServerAuthShape["revokeClientSession"] = (
    currentSessionId,
    targetSessionId,
  ) =>
    Effect.gen(function* () {
      if (currentSessionId === targetSessionId) {
        return yield* new AuthError({
          message: "Use revoke other clients to keep the current owner session active.",
          status: 403,
        });
      }
      return yield* authControlPlane.revokeSession(targetSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to revoke client session.",
              cause,
            }),
        ),
      );
    });

  const revokeOtherClientSessions: ServerAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    authControlPlane.revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke other client sessions.",
            cause,
          }),
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issuePairingCredential({ role: "owner" }).pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
    );

  const issueWebSocketToken: ServerAuthShape["issueWebSocketToken"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId, { scopes: [...session.scopes] }).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to issue websocket token.",
            cause,
          }),
      ),
      Effect.map(
        (issued) =>
          ({
            token: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTokenResult,
      ),
    );

  const issueWebSocketTicket: ServerAuthShape["issueWebSocketTicket"] = (session) =>
    issueWebSocketToken(session).pipe(
      Effect.map(
        (issued) =>
          ({
            ticket: issued.token,
            expiresAt: issued.expiresAt,
          }) satisfies AuthWebSocketTicketResult,
      ),
    );

  const authenticateWebSocketUpgrade: ServerAuthShape["authenticateWebSocketUpgrade"] = (request) =>
    Effect.gen(function* () {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketToken =
          requestUrl.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM) ??
          requestUrl.value.searchParams.get(WEBSOCKET_TOKEN_QUERY_PARAM);
        if (websocketToken && websocketToken.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketToken).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              scopes: new Set(session.scopes ?? scopesForSessionRole(session.role)),
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Unauthorized request.",
                  status: 401,
                  cause,
                }),
            ),
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState,
    exchangeBootstrapCredential,
    exchangeBootstrapCredentialForBrowserSession,
    exchangeBootstrapCredentialForBearerSession,
    exchangeBootstrapCredentialForAccessToken,
    issuePairingCredential,
    listPairingLinks,
    revokePairingLink,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketToken,
    issueWebSocketTicket,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(AuthControlPlaneLive),
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(ServerAuthPolicyLive),
);
