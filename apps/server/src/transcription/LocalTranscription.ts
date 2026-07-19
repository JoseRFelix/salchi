import {
  DEFAULT_TRANSCRIPTION_MODEL,
  type TranscriptionModel,
  type TranscriptionResult,
  type TranscriptionStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ManagedWhisperError,
  provisionManagedWhisper,
  resolveManagedWhisperRuntimeAsset,
} from "./ManagedWhisper.ts";

const WHISPER_REQUEST_TIMEOUT = "2 minutes";
const WHISPER_PROMPT =
  "Salchi, Codex, Claude, Effect, TypeScript, JavaScript, Bun, React, WebSocket, GitHub, worktree.";
const WHISPER_AUDIO_CONTEXT_MAX = 1_500;
const WHISPER_AUDIO_CONTEXT_MIN = 256;
const WHISPER_AUDIO_CONTEXT_STEP = 256;
const WHISPER_AUDIO_CONTEXT_PADDING_FRAMES = 50;
const WHISPER_SAMPLES_PER_AUDIO_CONTEXT_FRAME = 320;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export type LocalTranscriptionErrorReason =
  | "not_configured"
  | "provisioning_failed"
  | "upstream_failed"
  | "invalid_response";

export class LocalTranscriptionError extends Data.TaggedError("LocalTranscriptionError")<{
  readonly reason: LocalTranscriptionErrorReason;
  readonly cause?: unknown;
}> {}

export interface LocalTranscriptionInput {
  readonly audio: Uint8Array;
  readonly contentType: string;
}

export interface LocalTranscriptionShape {
  readonly getStatus: Effect.Effect<TranscriptionStatus>;
  readonly transcribe: (
    input: LocalTranscriptionInput,
  ) => Effect.Effect<TranscriptionResult, LocalTranscriptionError>;
}

export class LocalTranscription extends Context.Service<
  LocalTranscription,
  LocalTranscriptionShape
>()("salchi/transcription/LocalTranscription") {}

export function resolveWhisperInferenceUrl(serverUrl: URL | undefined): URL | undefined {
  if (!serverUrl) return undefined;

  const normalizedHostname = serverUrl.hostname.trim().toLowerCase();
  if (
    !LOOPBACK_HOSTNAMES.has(normalizedHostname) ||
    (serverUrl.protocol !== "http:" && serverUrl.protocol !== "https:")
  ) {
    return undefined;
  }

  const inferenceUrl = new URL(serverUrl.toString());
  if (inferenceUrl.pathname === "/" || inferenceUrl.pathname.length === 0) {
    inferenceUrl.pathname = "/inference";
  }
  inferenceUrl.hash = "";
  return inferenceUrl;
}

export function extractWhisperTranscriptionText(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    return null;
  }
  return value.text.trim();
}

function audioFileExtension(contentType: string): string {
  switch (contentType.split(";", 1)[0]?.trim().toLowerCase()) {
    case "audio/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

function bytesMatchAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

export function resolveWhisperAudioContext(input: LocalTranscriptionInput): number | null {
  const contentType = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "audio/wav" && contentType !== "audio/x-wav") return null;

  const bytes = input.audio;
  if (
    bytes.length < 44 ||
    !bytesMatchAscii(bytes, 0, "RIFF") ||
    !bytesMatchAscii(bytes, 8, "WAVE")
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let blockAlign: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const chunkBytes = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkBytes;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) return null;

    if (bytesMatchAscii(bytes, offset, "fmt ") && chunkBytes >= 16) {
      const audioFormat = view.getUint16(chunkStart, true);
      const channels = view.getUint16(chunkStart + 2, true);
      const sampleRate = view.getUint32(chunkStart + 4, true);
      const formatBlockAlign = view.getUint16(chunkStart + 12, true);
      const bitsPerSample = view.getUint16(chunkStart + 14, true);
      if (
        audioFormat !== 1 ||
        channels !== 1 ||
        sampleRate !== 16_000 ||
        formatBlockAlign !== 2 ||
        bitsPerSample !== 16
      ) {
        return null;
      }
      blockAlign = formatBlockAlign;
    } else if (bytesMatchAscii(bytes, offset, "data")) {
      dataBytes = chunkBytes;
    }

    offset = chunkEnd + (chunkBytes % 2);
  }

  if (
    blockAlign === null ||
    dataBytes === null ||
    dataBytes === 0 ||
    dataBytes % blockAlign !== 0
  ) {
    return null;
  }
  const sampleCount = Math.floor(dataBytes / blockAlign);
  const audioFrames = Math.ceil(sampleCount / WHISPER_SAMPLES_PER_AUDIO_CONTEXT_FRAME);
  const paddedFrames = audioFrames + WHISPER_AUDIO_CONTEXT_PADDING_FRAMES;
  const audioContext = Math.max(
    WHISPER_AUDIO_CONTEXT_MIN,
    Math.ceil(paddedFrames / WHISPER_AUDIO_CONTEXT_STEP) * WHISPER_AUDIO_CONTEXT_STEP,
  );
  return audioContext < WHISPER_AUDIO_CONTEXT_MAX ? audioContext : null;
}

export function makeWhisperInferenceFormData(input: LocalTranscriptionInput): FormData {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([input.audio], { type: input.contentType }),
    `recording.${audioFileExtension(input.contentType)}`,
  );
  formData.append("response_format", "json");
  formData.append("language", "en");
  formData.append("prompt", WHISPER_PROMPT);
  const audioContext = resolveWhisperAudioContext(input);
  if (audioContext !== null) {
    formData.append("audio_ctx", String(audioContext));
  }
  return formData;
}

export function makeLocalTranscription<R = never>(input: {
  readonly initialStatus: TranscriptionStatus;
  readonly initialInferenceUrl?: URL | undefined;
  readonly provision?:
    | ((
        onStatus: (status: TranscriptionStatus) => Effect.Effect<void>,
      ) => Effect.Effect<URL, ManagedWhisperError, R>)
    | undefined;
  readonly transcribeAt: (
    inferenceUrl: URL,
    request: LocalTranscriptionInput,
  ) => Effect.Effect<TranscriptionResult, LocalTranscriptionError>;
}) {
  return Effect.gen(function* () {
    const statusRef = yield* Ref.make(input.initialStatus);
    const readiness = yield* Deferred.make<URL, LocalTranscriptionError>();
    const semaphore = yield* Semaphore.make(1);

    if (input.initialInferenceUrl) {
      yield* Deferred.succeed(readiness, input.initialInferenceUrl);
    } else if (input.provision) {
      yield* input
        .provision((status) => Ref.set(statusRef, status))
        .pipe(
          Effect.tap((inferenceUrl) =>
            Ref.set(statusRef, {
              configured: true,
              state: "ready",
              downloadedBytes: null,
              totalBytes: null,
              message: null,
            }).pipe(Effect.andThen(Deferred.succeed(readiness, inferenceUrl))),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            const failure = cause.reasons.find(Cause.isFailReason)?.error;
            const error =
              failure instanceof ManagedWhisperError
                ? failure
                : new ManagedWhisperError({
                    detail: "Unexpected local dictation setup failure.",
                    cause,
                  });
            return Effect.logError("Local dictation provisioning failed", { cause }).pipe(
              Effect.andThen(
                Ref.set(statusRef, {
                  configured: true,
                  state: "error",
                  downloadedBytes: null,
                  totalBytes: null,
                  message: error.detail,
                }),
              ),
              Effect.andThen(
                Deferred.fail(
                  readiness,
                  new LocalTranscriptionError({
                    reason: "provisioning_failed",
                    cause: error,
                  }),
                ),
              ),
            );
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
    } else {
      yield* Deferred.fail(readiness, new LocalTranscriptionError({ reason: "not_configured" }));
    }

    return LocalTranscription.of({
      getStatus: Ref.get(statusRef),
      transcribe: (request) =>
        Deferred.await(readiness).pipe(
          Effect.flatMap((inferenceUrl) =>
            semaphore.withPermits(1)(input.transcribeAt(inferenceUrl, request)),
          ),
        ),
    });
  });
}

interface ActiveManagedWhisper {
  readonly model: TranscriptionModel;
  readonly scope: Scope.Closeable;
}

function managedWhisperErrorFromCause(
  cause: Cause.Cause<ManagedWhisperError>,
): ManagedWhisperError {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  return failure instanceof ManagedWhisperError
    ? failure
    : new ManagedWhisperError({
        detail: "Unexpected local dictation setup failure.",
        cause,
      });
}

export function makeManagedLocalTranscription<R>(input: {
  readonly initialModel: TranscriptionModel;
  readonly provision: (
    model: TranscriptionModel,
    onStatus: (status: TranscriptionStatus) => Effect.Effect<void>,
  ) => Effect.Effect<URL, ManagedWhisperError, R | Scope.Scope>;
  readonly transcribeAt: (
    inferenceUrl: URL,
    request: LocalTranscriptionInput,
  ) => Effect.Effect<TranscriptionResult, LocalTranscriptionError>;
}) {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope;
    const provisionContext = yield* Effect.context<R>();
    const initialReadiness = yield* Deferred.make<URL, LocalTranscriptionError>();
    const readinessRef = yield* Ref.make(initialReadiness);
    const statusRef = yield* Ref.make<TranscriptionStatus>({
      configured: true,
      state: "checking",
      downloadedBytes: null,
      totalBytes: null,
      message: null,
    });
    const activeRef = yield* Ref.make<ActiveManagedWhisper | null>(null);
    const selectedModelRef = yield* Ref.make<TranscriptionModel | null>(null);
    const switchSemaphore = yield* Semaphore.make(1);
    const transcriptionSemaphore = yield* Semaphore.make(1);

    const selectModel = (model: TranscriptionModel): Effect.Effect<void> =>
      switchSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(selectedModelRef)) === model) return;
          yield* Ref.set(selectedModelRef, model);

          const readiness = yield* Deferred.make<URL, LocalTranscriptionError>();
          yield* Ref.set(readinessRef, readiness);
          yield* Ref.set(statusRef, {
            configured: true,
            state: "checking",
            downloadedBytes: null,
            totalBytes: null,
            message: null,
          });

          const childScope = yield* Scope.make();
          yield* Scope.addFinalizer(
            parentScope,
            Scope.close(childScope, Exit.void).pipe(Effect.ignore),
          );
          const provisionExit = yield* input
            .provision(model, (status) => Ref.set(statusRef, status))
            .pipe(
              Effect.provideService(Scope.Scope, childScope),
              Effect.provideContext(provisionContext),
              Effect.exit,
            );

          if (Exit.isSuccess(provisionExit)) {
            yield* transcriptionSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const previous = yield* Ref.getAndSet(activeRef, {
                  model,
                  scope: childScope,
                });
                if (previous) {
                  yield* Scope.close(previous.scope, Exit.void).pipe(Effect.ignore);
                }
                yield* Ref.set(statusRef, {
                  configured: true,
                  state: "ready",
                  downloadedBytes: null,
                  totalBytes: null,
                  message: null,
                });
                yield* Deferred.succeed(readiness, provisionExit.value);
              }),
            );
            return;
          }

          const error = managedWhisperErrorFromCause(provisionExit.cause);
          yield* Effect.logError("Local dictation model provisioning failed", {
            model,
            cause: provisionExit.cause,
          });
          yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
          yield* transcriptionSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const previous = yield* Ref.getAndSet(activeRef, null);
              if (previous) {
                yield* Scope.close(previous.scope, Exit.void).pipe(Effect.ignore);
              }
              yield* Ref.set(selectedModelRef, null);
              yield* Ref.set(statusRef, {
                configured: true,
                state: "error",
                downloadedBytes: null,
                totalBytes: null,
                message: error.detail,
              });
              yield* Deferred.fail(
                readiness,
                new LocalTranscriptionError({
                  reason: "provisioning_failed",
                  cause: error,
                }),
              );
            }),
          );
        }),
      );

    const transcribe = (
      request: LocalTranscriptionInput,
    ): Effect.Effect<TranscriptionResult, LocalTranscriptionError> =>
      Effect.suspend(() =>
        Ref.get(readinessRef).pipe(
          Effect.flatMap((readiness) =>
            Deferred.await(readiness).pipe(
              Effect.flatMap((inferenceUrl) =>
                transcriptionSemaphore.withPermits(1)(
                  Ref.get(readinessRef).pipe(
                    Effect.flatMap(
                      (
                        currentReadiness,
                      ): Effect.Effect<
                        | { readonly retry: true }
                        | { readonly retry: false; readonly result: TranscriptionResult },
                        LocalTranscriptionError
                      > =>
                        currentReadiness === readiness
                          ? input
                              .transcribeAt(inferenceUrl, request)
                              .pipe(Effect.map((result) => ({ retry: false as const, result })))
                          : Effect.succeed({ retry: true as const }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Effect.flatMap((outcome) =>
            outcome.retry ? transcribe(request) : Effect.succeed(outcome.result),
          ),
        ),
      );

    yield* selectModel(input.initialModel).pipe(Effect.forkScoped({ startImmediately: true }));

    return {
      service: LocalTranscription.of({
        getStatus: Ref.get(statusRef),
        transcribe,
      }),
      selectModel,
    };
  });
}

export const LocalTranscriptionLive = Layer.effect(
  LocalTranscription,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const inferenceUrl = resolveWhisperInferenceUrl(config.whisperServerUrl);

    const transcribeAt = (
      targetUrl: URL,
      input: LocalTranscriptionInput,
    ): Effect.Effect<TranscriptionResult, LocalTranscriptionError> => {
      const formData = makeWhisperInferenceFormData(input);

      return httpClient
        .post(targetUrl, {
          body: HttpBody.formData(formData),
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.flatMap((response) => {
            const text = extractWhisperTranscriptionText(response);
            return text === null
              ? Effect.fail(
                  new LocalTranscriptionError({
                    reason: "invalid_response",
                  }),
                )
              : Effect.succeed({ text } satisfies TranscriptionResult);
          }),
          Effect.timeout(WHISPER_REQUEST_TIMEOUT),
          Effect.mapError((cause) =>
            cause instanceof LocalTranscriptionError
              ? cause
              : new LocalTranscriptionError({
                  reason: "upstream_failed",
                  cause,
                }),
          ),
        );
    };

    if (config.whisperServerUrl && !inferenceUrl) {
      yield* Effect.logWarning(
        "Ignoring T3CODE_WHISPER_SERVER_URL because it is not an HTTP(S) loopback URL.",
      );
      return yield* makeLocalTranscription({
        initialStatus: {
          configured: false,
          state: "error",
          downloadedBytes: null,
          totalBytes: null,
          message: "The configured dictation server must use an HTTP(S) loopback URL.",
        },
        transcribeAt,
      });
    }

    if (inferenceUrl) {
      return yield* makeLocalTranscription({
        initialStatus: {
          configured: true,
          state: "ready",
          downloadedBytes: null,
          totalBytes: null,
          message: null,
        },
        initialInferenceUrl: inferenceUrl,
        transcribeAt,
      });
    }

    if (config.whisperAutoProvision === false) {
      return yield* makeLocalTranscription({
        initialStatus: {
          configured: false,
          state: "unavailable",
          downloadedBytes: null,
          totalBytes: null,
          message: null,
        },
        transcribeAt,
      });
    }

    if (!resolveManagedWhisperRuntimeAsset(process.platform, process.arch)) {
      return yield* makeLocalTranscription({
        initialStatus: {
          configured: false,
          state: "unavailable",
          downloadedBytes: null,
          totalBytes: null,
          message: `Automatic dictation installation is unavailable for ${process.platform}/${process.arch}.`,
        },
        transcribeAt,
      });
    }

    const serverSettingsOption = yield* Effect.serviceOption(ServerSettingsService);
    const initialModel = Option.isSome(serverSettingsOption)
      ? yield* serverSettingsOption.value.getSettings.pipe(
          Effect.map((settings) => settings.transcriptionModel),
          Effect.orElseSucceed(() => DEFAULT_TRANSCRIPTION_MODEL),
        )
      : DEFAULT_TRANSCRIPTION_MODEL;
    const managed = yield* makeManagedLocalTranscription({
      initialModel,
      provision: (model, onStatus) => provisionManagedWhisper({ model, onStatus }),
      transcribeAt,
    });
    if (Option.isSome(serverSettingsOption)) {
      yield* serverSettingsOption.value.streamChanges.pipe(
        Stream.map((settings) => settings.transcriptionModel),
        Stream.changes,
        Stream.runForEach(managed.selectModel),
        Effect.forkScoped,
      );
    }
    return managed.service;
  }),
);
