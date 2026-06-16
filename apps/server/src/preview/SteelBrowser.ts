import { PreviewRemoteHostUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";

const MOBILE_WIDTH = 508;
const MOBILE_HEIGHT = 974;
const CDP_NAVIGATION_TIMEOUT = "8 seconds";

const SteelSessionDetails = Schema.Struct({
  id: TrimmedNonEmptyString,
  websocketUrl: TrimmedNonEmptyString,
  debugUrl: TrimmedNonEmptyString,
});

export interface SteelBrowserSession {
  readonly sessionId: string;
  readonly websocketUrl: string;
  readonly viewerUrl: string;
}

export interface SteelBrowserViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface SteelBrowserNavigationState {
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export type SteelBrowserKeyboardAction =
  | { readonly _tag: "InsertText"; readonly text: string }
  | { readonly _tag: "PressKey"; readonly key: "Backspace" | "Delete" | "Enter" | "Tab" };

export interface SteelBrowserShape {
  readonly enabled: boolean;
  readonly createMobileSession: (input?: {
    readonly viewportSize?: SteelBrowserViewportSize | undefined;
  }) => Effect.Effect<SteelBrowserSession, PreviewRemoteHostUnavailableError>;
  readonly navigate: (input: {
    readonly sessionId: string;
    readonly websocketUrl: string;
    readonly url: string;
    readonly viewportSize?: SteelBrowserViewportSize | undefined;
  }) => Effect.Effect<SteelBrowserNavigationState, PreviewRemoteHostUnavailableError>;
  readonly reload: (input: {
    readonly sessionId: string;
    readonly websocketUrl: string;
    readonly viewportSize?: SteelBrowserViewportSize | undefined;
  }) => Effect.Effect<SteelBrowserNavigationState, PreviewRemoteHostUnavailableError>;
  readonly goBack: (input: {
    readonly sessionId: string;
    readonly websocketUrl: string;
    readonly viewportSize?: SteelBrowserViewportSize | undefined;
  }) => Effect.Effect<SteelBrowserNavigationState, PreviewRemoteHostUnavailableError>;
  readonly goForward: (input: {
    readonly sessionId: string;
    readonly websocketUrl: string;
    readonly viewportSize?: SteelBrowserViewportSize | undefined;
  }) => Effect.Effect<SteelBrowserNavigationState, PreviewRemoteHostUnavailableError>;
  readonly keyboardInput: (input: {
    readonly sessionId: string;
    readonly websocketUrl: string;
    readonly action: SteelBrowserKeyboardAction;
  }) => Effect.Effect<void, PreviewRemoteHostUnavailableError>;
  readonly release: (input: { readonly sessionId: string }) => Effect.Effect<void>;
}

export class SteelBrowser extends Context.Service<SteelBrowser, SteelBrowserShape>()(
  "salchi/preview/SteelBrowser",
) {}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/u, "");

const steelError = (detail: string) =>
  new PreviewRemoteHostUnavailableError({ host: "steel", detail });

export const disabled: SteelBrowserShape = {
  enabled: false,
  createMobileSession: () =>
    Effect.fail(steelError("Set T3CODE_STEEL_BASE_URL to enable Steel preview sessions.")),
  navigate: () =>
    Effect.fail(steelError("Set T3CODE_STEEL_BASE_URL to enable Steel preview sessions.")),
  reload: () =>
    Effect.fail(steelError("Set T3CODE_STEEL_BASE_URL to enable Steel preview sessions.")),
  goBack: () =>
    Effect.fail(steelError("Set T3CODE_STEEL_BASE_URL to enable Steel preview sessions.")),
  goForward: () =>
    Effect.fail(steelError("Set T3CODE_STEEL_BASE_URL to enable Steel preview sessions.")),
  keyboardInput: () =>
    Effect.fail(steelError("Set T3CODE_STEEL_BASE_URL to enable Steel preview sessions.")),
  release: () => Effect.void,
};

const apiUrl = (baseUrl: string, path: string): string => `${trimTrailingSlash(baseUrl)}${path}`;
const fallbackViewportSize = (): SteelBrowserViewportSize => ({
  width: MOBILE_WIDTH,
  height: MOBILE_HEIGHT,
});
const resolveViewportSize = (
  viewportSize: SteelBrowserViewportSize | undefined,
): SteelBrowserViewportSize => viewportSize ?? fallbackViewportSize();

export function rewriteSteelUrlToBase(rawUrl: string, baseUrl: string): string {
  const raw = new URL(rawUrl);
  const base = new URL(baseUrl);
  const next = new URL(base.toString());
  next.pathname = raw.pathname;
  next.search = raw.search;
  next.hash = raw.hash;
  return next.toString();
}

export function rewriteSteelWebSocketUrl(rawUrl: string, baseUrl: string): string {
  const raw = new URL(rawUrl);
  const base = new URL(baseUrl);
  raw.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  raw.hostname = base.hostname;
  raw.port = base.port;
  return raw.toString();
}

export function buildSteelViewerUrl(rawDebugUrl: string, viewerBaseUrl: string): string {
  const viewerUrl = rewriteSteelUrlToBase(rawDebugUrl, viewerBaseUrl);
  const url = new URL(viewerUrl);
  url.searchParams.set("showControls", "false");
  url.searchParams.set("interactive", "true");
  url.searchParams.set("theme", "dark");
  return url.toString();
}

const responseError = (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, PreviewRemoteHostUnavailableError> =>
  response.text.pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.flatMap((body) =>
      Effect.fail(
        steelError(
          body.trim().length > 0
            ? `${operation} returned HTTP ${response.status}: ${body.trim()}`
            : `${operation} returned HTTP ${response.status}.`,
        ),
      ),
    ),
  );

const decodeResponse = <S extends Schema.Top>(
  operation: string,
  schema: S,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<S["Type"], PreviewRemoteHostUnavailableError, S["DecodingServices"]> =>
  HttpClientResponse.matchStatus({
    "2xx": (success) =>
      HttpClientResponse.schemaBodyJson(schema)(success).pipe(
        Effect.mapError(() => steelError(`${operation} returned invalid JSON.`)),
      ),
    orElse: (failed) => responseError(operation, failed),
  })(response);

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: string;
  };
}

interface CdpTargetInfo {
  readonly targetId: string;
  readonly type: string;
}

interface CdpGetTargetsResult {
  readonly targetInfos?: ReadonlyArray<CdpTargetInfo>;
}

interface CdpAttachToTargetResult {
  readonly sessionId: string;
}

interface CdpCreateTargetResult {
  readonly targetId: string;
}

interface CdpNavigationEntry {
  readonly id: number;
  readonly url: string;
  readonly title: string;
}

interface CdpGetNavigationHistoryResult {
  readonly currentIndex?: number;
  readonly entries?: ReadonlyArray<CdpNavigationEntry>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asGetTargetsResult = (value: unknown): CdpGetTargetsResult => {
  if (!isObject(value) || !Array.isArray(value.targetInfos)) return {};
  return {
    targetInfos: value.targetInfos
      .filter((entry): entry is CdpTargetInfo => {
        return (
          isObject(entry) && typeof entry.targetId === "string" && typeof entry.type === "string"
        );
      })
      .map((entry) => ({ targetId: entry.targetId, type: entry.type })),
  };
};

const asAttachResult = (value: unknown): CdpAttachToTargetResult => {
  if (isObject(value) && typeof value.sessionId === "string") {
    return { sessionId: value.sessionId };
  }
  throw new Error("Steel CDP returned an invalid attach response.");
};

const asCreateTargetResult = (value: unknown): CdpCreateTargetResult => {
  if (isObject(value) && typeof value.targetId === "string") {
    return { targetId: value.targetId };
  }
  throw new Error("Steel CDP returned an invalid create target response.");
};

const asNavigationHistoryResult = (value: unknown): CdpGetNavigationHistoryResult => {
  if (!isObject(value) || !Array.isArray(value.entries)) return {};
  const currentIndex = typeof value.currentIndex === "number" ? value.currentIndex : undefined;
  return {
    ...(currentIndex !== undefined ? { currentIndex } : {}),
    entries: value.entries
      .filter(
        (entry): entry is { readonly id: number; readonly url: string; readonly title?: unknown } =>
          isObject(entry) &&
          typeof entry.id === "number" &&
          typeof entry.url === "string" &&
          entry.url.length > 0,
      )
      .map((entry) => ({
        id: entry.id,
        url: entry.url,
        title: typeof entry.title === "string" ? entry.title : "",
      })),
  };
};

const eventDataToText = (data: unknown): string | null => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return null;
};

type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

interface CdpPageActionContext {
  readonly send: CdpSend;
  readonly sessionId: string;
}

const stateFromNavigationHistory = (
  history: CdpGetNavigationHistoryResult,
  fallback?: Partial<SteelBrowserNavigationState>,
): SteelBrowserNavigationState => {
  const entries = history.entries ?? [];
  const currentIndex =
    typeof history.currentIndex === "number" &&
    history.currentIndex >= 0 &&
    history.currentIndex < entries.length
      ? history.currentIndex
      : -1;
  const entry = currentIndex >= 0 ? entries[currentIndex] : null;
  return {
    url: entry?.url ?? fallback?.url ?? "",
    title: entry?.title ?? fallback?.title ?? "",
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex >= 0 && currentIndex < entries.length - 1,
  };
};

const readNavigationState = async (
  send: CdpSend,
  sessionId: string,
  fallback?: Partial<SteelBrowserNavigationState>,
): Promise<SteelBrowserNavigationState> =>
  send("Page.getNavigationHistory", undefined, sessionId).then(
    (result) => stateFromNavigationHistory(asNavigationHistoryResult(result), fallback),
    () => stateFromNavigationHistory({}, fallback),
  );

const keyDescriptor = (
  key: Extract<SteelBrowserKeyboardAction, { readonly _tag: "PressKey" }>,
): Record<string, unknown> => {
  switch (key.key) {
    case "Backspace":
      return {
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      };
    case "Delete":
      return {
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
        nativeVirtualKeyCode: 46,
      };
    case "Enter":
      return {
        key: "Enter",
        code: "Enter",
        text: "\r",
        unmodifiedText: "\r",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      };
    case "Tab":
      return {
        key: "Tab",
        code: "Tab",
        text: "\t",
        unmodifiedText: "\t",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      };
  }
};

const runCdpPageAction = <A>(input: {
  readonly websocketUrl: string;
  readonly viewportSize?: SteelBrowserViewportSize | undefined;
  readonly action: (context: CdpPageActionContext) => Promise<A>;
}): Promise<A> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(input.websocketUrl);
    const pending = new Map<
      number,
      {
        readonly resolve: (value: unknown) => void;
        readonly reject: (error: Error) => void;
      }
    >();
    let nextId = 1;
    let settled = false;

    const rejectAll = (error: Error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };

    const closeSocket = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectAll(error);
      try {
        socket.close();
      } catch {
        // Best-effort cleanup; the navigation result has already settled.
      }
    };

    const settleResolve = (value: A) => {
      if (settled) return;
      closeSocket(new Error("Steel CDP connection closed."));
      resolve(value);
    };

    const settleReject = (error?: Error) => {
      if (settled) return;
      const resolvedError = error ?? new Error("Steel CDP failed.");
      closeSocket(resolvedError);
      reject(resolvedError);
    };

    const send: CdpSend = (method, params, sessionId) =>
      new Promise((sendResolve, sendReject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          sendReject(new Error("Steel CDP socket is not open."));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: sendResolve, reject: sendReject });
        socket.send(
          JSON.stringify({
            id,
            method,
            ...(params !== undefined ? { params } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          }),
        );
      });

    socket.addEventListener("message", (event) => {
      const text = eventDataToText(event.data);
      if (text === null) return;
      let message: CdpResponse;
      try {
        message = JSON.parse(text) as CdpResponse;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? "Steel CDP command failed."));
        return;
      }
      request.resolve(message.result);
    });

    socket.addEventListener("error", () => {
      settleReject(new Error("Steel CDP websocket errored."));
    });
    socket.addEventListener("close", () => {
      if (!settled) settleReject(new Error("Steel CDP websocket closed."));
    });
    socket.addEventListener("open", () => {
      void (async () => {
        const targets = asGetTargetsResult(await send("Target.getTargets"));
        const target =
          targets.targetInfos?.find((entry) => entry.type === "page") ??
          asCreateTargetResult(
            await send("Target.createTarget", {
              url: "about:blank",
            }),
          );
        const attach = asAttachResult(
          await send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          }),
        );
        if (input.viewportSize !== undefined) {
          await send(
            "Emulation.setDeviceMetricsOverride",
            {
              width: input.viewportSize.width,
              height: input.viewportSize.height,
              deviceScaleFactor: 1,
              mobile: true,
            },
            attach.sessionId,
          );
        }
        await send("Page.enable", undefined, attach.sessionId);
        const result = await input.action({ send, sessionId: attach.sessionId });
        settleResolve(result);
      })().catch((error: unknown) => {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });

const navigateWithCdp = (input: {
  readonly websocketUrl: string;
  readonly url: string;
  readonly viewportSize?: SteelBrowserViewportSize | undefined;
}): Promise<SteelBrowserNavigationState> =>
  runCdpPageAction({
    websocketUrl: input.websocketUrl,
    viewportSize: input.viewportSize,
    action: async ({ send, sessionId }) => {
      await send("Page.navigate", { url: input.url }, sessionId);
      return readNavigationState(send, sessionId, { url: input.url });
    },
  });

const reloadWithCdp = (input: {
  readonly websocketUrl: string;
  readonly viewportSize?: SteelBrowserViewportSize | undefined;
}): Promise<SteelBrowserNavigationState> =>
  runCdpPageAction({
    websocketUrl: input.websocketUrl,
    viewportSize: input.viewportSize,
    action: async ({ send, sessionId }) => {
      const before = await readNavigationState(send, sessionId);
      await send("Page.reload", { ignoreCache: true }, sessionId).catch(async () => {
        if (before.url.length === 0) return;
        await send("Page.navigate", { url: before.url }, sessionId);
      });
      return readNavigationState(send, sessionId, before);
    },
  });

const navigateHistoryWithCdp = (input: {
  readonly websocketUrl: string;
  readonly viewportSize?: SteelBrowserViewportSize | undefined;
  readonly delta: -1 | 1;
}): Promise<SteelBrowserNavigationState> =>
  runCdpPageAction({
    websocketUrl: input.websocketUrl,
    viewportSize: input.viewportSize,
    action: async ({ send, sessionId }) => {
      const fallbackHistoryNavigation = async () => {
        await send(
          "Runtime.evaluate",
          {
            expression: input.delta < 0 ? "history.back()" : "history.forward()",
            userGesture: true,
          },
          sessionId,
        );
        return readNavigationState(send, sessionId);
      };
      const history = await send("Page.getNavigationHistory", undefined, sessionId).then(
        asNavigationHistoryResult,
        () => null,
      );
      if (history === null) return fallbackHistoryNavigation();
      const entries = history.entries ?? [];
      const currentIndex = typeof history.currentIndex === "number" ? history.currentIndex : -1;
      const targetIndex = currentIndex + input.delta;
      const target = entries[targetIndex];
      if (!target) return fallbackHistoryNavigation();
      try {
        await send("Page.navigateToHistoryEntry", { entryId: target.id }, sessionId);
      } catch {
        return fallbackHistoryNavigation();
      }
      return {
        url: target.url,
        title: target.title,
        canGoBack: targetIndex > 0,
        canGoForward: targetIndex < entries.length - 1,
      };
    },
  });

const keyboardInputWithCdp = (input: {
  readonly websocketUrl: string;
  readonly action: SteelBrowserKeyboardAction;
}): Promise<void> =>
  runCdpPageAction({
    websocketUrl: input.websocketUrl,
    action: async ({ send, sessionId }) => {
      if (input.action._tag === "InsertText") {
        if (input.action.text.length === 0) return;
        await send("Input.insertText", { text: input.action.text }, sessionId);
        return;
      }
      const descriptor = keyDescriptor(input.action);
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...descriptor }, sessionId);
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor }, sessionId);
    },
  });

export const make = Effect.fn("makeSteelBrowser")(function* () {
  const config = yield* ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const baseUrl = config.steelBrowserBaseUrl;

  if (baseUrl === undefined) {
    return disabled;
  }

  const viewerBaseUrl = config.steelBrowserPublicBaseUrl ?? baseUrl;

  const createMobileSession: SteelBrowserShape["createMobileSession"] = (input) =>
    Effect.gen(function* () {
      const viewportSize = resolveViewportSize(input?.viewportSize);
      const request = yield* HttpClientRequest.post(apiUrl(baseUrl, "/v1/sessions")).pipe(
        HttpClientRequest.bodyJson({
          deviceConfig: { device: "mobile" },
          dimensions: viewportSize,
          blockAds: true,
        }),
        Effect.mapError(() => steelError("Unable to encode Steel session request.")),
      );
      const rawSession = yield* httpClient.execute(request.pipe(HttpClientRequest.acceptJson)).pipe(
        Effect.mapError(() => steelError("Unable to connect to Steel.")),
        Effect.flatMap((response) =>
          decodeResponse("create Steel session", SteelSessionDetails, response),
        ),
      );

      return {
        sessionId: rawSession.id,
        websocketUrl: rewriteSteelWebSocketUrl(rawSession.websocketUrl, baseUrl),
        viewerUrl: buildSteelViewerUrl(rawSession.debugUrl, viewerBaseUrl),
      } satisfies SteelBrowserSession;
    });

  const runSteelCdpEffect = <A>(
    operation: string,
    sessionId: string,
    task: () => Promise<A>,
  ): Effect.Effect<A, PreviewRemoteHostUnavailableError> =>
    Effect.tryPromise({
      try: task,
      catch: (cause) => steelError(cause instanceof Error ? cause.message : `${operation} failed.`),
    }).pipe(
      Effect.timeoutOption(CDP_NAVIGATION_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(steelError(`${operation} timed out.`)),
          onSome: Effect.succeed,
        }),
      ),
      Effect.withSpan(operation, {
        attributes: {
          "preview.host": "steel",
          "preview.session_id": sessionId,
        },
      }),
    );

  const navigate: SteelBrowserShape["navigate"] = (input) =>
    runSteelCdpEffect("SteelBrowser.navigate", input.sessionId, () =>
      navigateWithCdp({
        websocketUrl: input.websocketUrl,
        url: input.url,
        viewportSize: input.viewportSize,
      }),
    );

  const reload: SteelBrowserShape["reload"] = (input) =>
    runSteelCdpEffect("SteelBrowser.reload", input.sessionId, () =>
      reloadWithCdp({
        websocketUrl: input.websocketUrl,
        viewportSize: input.viewportSize,
      }),
    );

  const goBack: SteelBrowserShape["goBack"] = (input) =>
    runSteelCdpEffect("SteelBrowser.goBack", input.sessionId, () =>
      navigateHistoryWithCdp({
        websocketUrl: input.websocketUrl,
        viewportSize: input.viewportSize,
        delta: -1,
      }),
    );

  const goForward: SteelBrowserShape["goForward"] = (input) =>
    runSteelCdpEffect("SteelBrowser.goForward", input.sessionId, () =>
      navigateHistoryWithCdp({
        websocketUrl: input.websocketUrl,
        viewportSize: input.viewportSize,
        delta: 1,
      }),
    );

  const keyboardInput: SteelBrowserShape["keyboardInput"] = (input) =>
    runSteelCdpEffect("SteelBrowser.keyboardInput", input.sessionId, () =>
      keyboardInputWithCdp({
        websocketUrl: input.websocketUrl,
        action: input.action,
      }),
    );

  const release: SteelBrowserShape["release"] = (input) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(
        apiUrl(baseUrl, `/v1/sessions/${input.sessionId}/release`),
      );
      yield* httpClient
        .execute(request.pipe(HttpClientRequest.acceptJson))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.withSpan("SteelBrowser.release", {
        attributes: {
          "preview.host": "steel",
          "preview.session_id": input.sessionId,
        },
      }),
    );

  return {
    enabled: true,
    createMobileSession,
    navigate,
    reload,
    goBack,
    goForward,
    keyboardInput,
    release,
  } satisfies SteelBrowserShape;
});

export const layer = Layer.effect(SteelBrowser, make());
export const layerDisabled = Layer.succeed(SteelBrowser, disabled);
