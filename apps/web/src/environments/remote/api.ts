import type {
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
} from "@salchi/contracts";

class RemoteEnvironmentAuthHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteEnvironmentAuthHttpError";
    this.status = status;
  }
}

export function isRemoteEnvironmentAuthHttpError(
  error: unknown,
): error is RemoteEnvironmentAuthHttpError {
  return error instanceof RemoteEnvironmentAuthHttpError;
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readRemoteAuthErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall back to raw text below.
  }

  return text;
}

async function fetchRemoteJson<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown | URLSearchParams;
}): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  const isUrlParamsBody = input.body instanceof URLSearchParams;
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: input.method ?? "GET",
      headers: {
        ...(input.body !== undefined
          ? {
              "content-type": isUrlParamsBody
                ? "application/x-www-form-urlencoded"
                : "application/json",
            }
          : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined
        ? { body: isUrlParamsBody ? input.body.toString() : JSON.stringify(input.body) }
        : {}),
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch remote auth endpoint ${requestUrl} (${(error as Error).message}).`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new RemoteEnvironmentAuthHttpError(
      await readRemoteAuthErrorMessage(
        response,
        `Remote auth request failed (${response.status}).`,
      ),
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function bootstrapRemoteBearerSession(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
}): Promise<AuthAccessTokenResult> {
  return fetchRemoteJson<AuthAccessTokenResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/oauth/token",
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: input.credential,
      subject_token_type: "urn:salchi:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
}

export async function fetchRemoteSessionState(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthSessionState> {
  return fetchRemoteJson<AuthSessionState>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    bearerToken: input.bearerToken,
  });
}

export async function fetchRemoteEnvironmentDescriptor(input: {
  readonly httpBaseUrl: string;
}): Promise<ExecutionEnvironmentDescriptor> {
  return fetchRemoteJson<ExecutionEnvironmentDescriptor>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/.well-known/salchi/environment",
  });
}

export async function issueRemoteWebSocketTicket(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthWebSocketTicketResult> {
  return fetchRemoteJson<AuthWebSocketTicketResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/websocket-ticket",
    method: "POST",
    bearerToken: input.bearerToken,
  });
}

export const issueRemoteWebSocketToken = issueRemoteWebSocketTicket;

export async function resolveRemoteWebSocketConnectionUrl(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<string> {
  const issued = await issueRemoteWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  });
  const url = new URL(input.wsBaseUrl, window.location.origin);
  url.searchParams.set("ticket", issued.ticket);
  return url.toString();
}
