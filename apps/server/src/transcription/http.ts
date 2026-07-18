import {
  TRANSCRIPTION_AUDIO_MAX_BYTES,
  TRANSCRIPTION_ROUTE_PATH,
  TRANSCRIPTION_STATUS_ROUTE_PATH,
  type TranscriptionErrorResponse,
  type TranscriptionResult,
  type TranscriptionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/unstable/http";

import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { LocalTranscription } from "./LocalTranscription.ts";

const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
]);

const multipartLimits = Multipart.limitsServices({
  maxParts: 1,
  maxFileSize: TRANSCRIPTION_AUDIO_MAX_BYTES,
  maxTotalSize: TRANSCRIPTION_AUDIO_MAX_BYTES + 64 * 1024,
});

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

function jsonError(status: number, code: TranscriptionErrorResponse["code"], error: string) {
  return HttpServerResponse.jsonUnsafe({ code, error } satisfies TranscriptionErrorResponse, {
    status,
  });
}

function normalizeAudioContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const transcriptionStatusRouteLayer = HttpRouter.add(
  "GET",
  TRANSCRIPTION_STATUS_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const transcription = yield* LocalTranscription;
    const status = yield* transcription.getStatus;
    return HttpServerResponse.jsonUnsafe(status satisfies TranscriptionStatus, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const transcriptionPostRouteLayer = HttpRouter.add(
  "POST",
  TRANSCRIPTION_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const transcription = yield* LocalTranscription;
    const status = yield* transcription.getStatus;

    if (!status.configured) {
      return jsonError(503, "not_configured", "Local transcription is not configured.");
    }

    const multipart = yield* request.multipart.pipe(Effect.provideContext(multipartLimits));
    const fileParts = multipart.file;
    if (!Array.isArray(fileParts) || fileParts.length !== 1) {
      return jsonError(400, "invalid_audio", "Expected exactly one audio file.");
    }

    const [file] = fileParts;
    if (!file || file._tag !== "PersistedFile") {
      return jsonError(400, "invalid_audio", "Expected exactly one audio file.");
    }

    const contentType = normalizeAudioContentType(file.contentType);
    if (!SUPPORTED_AUDIO_TYPES.has(contentType)) {
      return jsonError(415, "invalid_audio", "Unsupported audio format.");
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const audio = yield* fileSystem.readFile(file.path);
    if (audio.length === 0) {
      return jsonError(400, "invalid_audio", "The audio recording is empty.");
    }

    const result = yield* transcription.transcribe({
      audio,
      contentType,
    });
    return HttpServerResponse.jsonUnsafe(result satisfies TranscriptionResult, { status: 200 });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      MultipartError: (error) =>
        error.reason._tag === "FileTooLarge" || error.reason._tag === "BodyTooLarge"
          ? Effect.succeed(jsonError(413, "audio_too_large", "The audio recording is too large."))
          : Effect.succeed(jsonError(400, "invalid_audio", "Invalid audio upload.")),
      LocalTranscriptionError: (error) =>
        Effect.succeed(
          error.reason === "not_configured"
            ? jsonError(503, "not_configured", "Local transcription is not configured.")
            : jsonError(502, "transcription_failed", "Local transcription failed."),
        ),
    }),
    Effect.catch((cause) =>
      Effect.logError("Failed to process transcription upload", { cause }).pipe(
        Effect.as(jsonError(500, "transcription_failed", "Local transcription failed.")),
      ),
    ),
  ),
);

export const transcriptionHttpRouteLayer = Layer.merge(
  transcriptionStatusRouteLayer,
  transcriptionPostRouteLayer,
);
