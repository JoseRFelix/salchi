import * as Schema from "effect/Schema";

export const TRANSCRIPTION_STATUS_ROUTE_PATH = "/api/transcription/status";
export const TRANSCRIPTION_ROUTE_PATH = "/api/transcription";

export const TRANSCRIPTION_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPTION_MAX_RECORDING_MS = 2 * 60 * 1000;

export const TranscriptionModel = Schema.Literals(["tiny.en", "base.en", "small.en"]);
export type TranscriptionModel = typeof TranscriptionModel.Type;
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = "base.en";

export const TranscriptionStatusState = Schema.Literals([
  "unavailable",
  "checking",
  "downloading-runtime",
  "downloading-model",
  "starting",
  "ready",
  "error",
]);
export type TranscriptionStatusState = typeof TranscriptionStatusState.Type;

export const TranscriptionStatus = Schema.Struct({
  configured: Schema.Boolean,
  state: TranscriptionStatusState,
  downloadedBytes: Schema.NullOr(Schema.Number),
  totalBytes: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
});
export type TranscriptionStatus = typeof TranscriptionStatus.Type;

export const TranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type TranscriptionResult = typeof TranscriptionResult.Type;

export const TranscriptionErrorCode = Schema.Literals([
  "not_configured",
  "invalid_audio",
  "audio_too_large",
  "transcription_failed",
]);
export type TranscriptionErrorCode = typeof TranscriptionErrorCode.Type;

export const TranscriptionErrorResponse = Schema.Struct({
  code: TranscriptionErrorCode,
  error: Schema.String,
});
export type TranscriptionErrorResponse = typeof TranscriptionErrorResponse.Type;
