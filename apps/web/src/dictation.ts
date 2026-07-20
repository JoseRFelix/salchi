import {
  TRANSCRIPTION_ROUTE_PATH,
  TRANSCRIPTION_STATUS_ROUTE_PATH,
  TranscriptionResult,
  TranscriptionStatus,
  type EnvironmentId,
  type TranscriptionModel,
} from "@salchi/contracts";
import * as Schema from "effect/Schema";

import { fetchEnvironmentHttp } from "./environments/runtime";

export const DICTATION_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

export function localTranscriptionStatusQueryKey(
  environmentId: EnvironmentId,
  model: TranscriptionModel,
) {
  return ["local-transcription-status", environmentId, model] as const;
}

export function localTranscriptionStatusRefetchInterval(input: {
  readonly transcribing: boolean;
  readonly status: TranscriptionStatus | undefined;
}): 750 | false {
  if (input.transcribing) return 750;
  return input.status?.state === "ready" ||
    input.status?.state === "error" ||
    input.status?.state === "unavailable"
    ? false
    : 750;
}

const DICTATION_START_SOUND_DURATION_SECONDS = 0.1;
const DICTATION_START_SOUND_TIMEOUT_MS = 250;
const DICTATION_START_VIBRATION_MS = 50;
const DICTATION_BLANK_AUDIO_PATTERN = /^(?:\[BLANK_AUDIO\]\s*)+$/i;

export interface PreparedDictationStartSound {
  readonly play: () => Promise<void>;
  readonly dispose: () => void;
}

export interface DictationPcmRecorder {
  readonly stop: () => Promise<Blob>;
}

export type DictationCaptureInterruption =
  | "audio-context-closed"
  | "audio-context-interrupted"
  | "audio-context-suspended"
  | "stream-inactive"
  | "track-ended";

export interface DictationPcmRecorderStartOptions {
  readonly onInterrupted?: (reason: DictationCaptureInterruption) => void;
}

export interface PreparedDictationPcmRecorder {
  readonly start: (
    stream: MediaStream,
    options?: DictationPcmRecorderStartOptions,
  ) => Promise<DictationPcmRecorder>;
  readonly dispose: () => void;
}

export function triggerDictationStartVibration(
  navigatorLike: Pick<Navigator, "vibrate"> | null = typeof navigator !== "undefined" &&
  typeof navigator.vibrate === "function"
    ? navigator
    : null,
): boolean {
  try {
    return navigatorLike?.vibrate(DICTATION_START_VIBRATION_MS) ?? false;
  } catch {
    return false;
  }
}

/**
 * Prepare the recording-start cue while the microphone click still counts as
 * a user gesture. The cue is played after microphone access succeeds and
 * finishes before MediaRecorder starts, so it is not captured in the clip.
 */
export function prepareDictationStartSound(
  createAudioContext: () => AudioContext = () => new AudioContext(),
): PreparedDictationStartSound {
  let context: AudioContext;
  try {
    context = createAudioContext();
  } catch {
    return {
      play: () => Promise.resolve(),
      dispose: () => undefined,
    };
  }

  let disposed = false;
  let finishPlayback: (() => void) | null = null;
  const resumePromise =
    context.state === "running" ? Promise.resolve() : context.resume().catch(() => undefined);

  const closeContext = () => {
    if (disposed) return;
    disposed = true;
    finishPlayback?.();
    finishPlayback = null;
    void context.close().catch(() => undefined);
  };

  return {
    play: async () => {
      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
      try {
        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutId = globalThis.setTimeout(resolve, DICTATION_START_SOUND_TIMEOUT_MS);
        });
        const playbackPromise = (async () => {
          await resumePromise;
          if (disposed || context.state !== "running") return;

          await new Promise<void>((resolve) => {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const startedAt = context.currentTime;
            const endsAt = startedAt + DICTATION_START_SOUND_DURATION_SECONDS;
            let finished = false;

            const finish = () => {
              if (finished) return;
              finished = true;
              finishPlayback = null;
              oscillator.disconnect();
              gain.disconnect();
              resolve();
            };
            finishPlayback = finish;

            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(660, startedAt);
            oscillator.frequency.exponentialRampToValueAtTime(880, endsAt);
            gain.gain.setValueAtTime(0.0001, startedAt);
            gain.gain.exponentialRampToValueAtTime(0.08, startedAt + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.addEventListener("ended", finish, { once: true });
            oscillator.start(startedAt);
            oscillator.stop(endsAt);
          });
        })();

        await Promise.race([playbackPromise, timeoutPromise]);
      } catch {
        // Audio feedback is optional; recording should still start if it fails.
      } finally {
        if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
        closeContext();
      }
    },
    dispose: closeContext,
  };
}

export function selectDictationAudioMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | undefined {
  return DICTATION_AUDIO_MIME_TYPES.find((mimeType) => isTypeSupported(mimeType));
}

export function calculateDictationAudioLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;

  let sumOfSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumOfSquares += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(sumOfSquares / samples.length));
}

export function formatDictationRecordingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function normalizeDictationTranscript(transcript: string): string {
  const normalizedTranscript = transcript.trim().replace(/\s+/g, " ");
  return DICTATION_BLANK_AUDIO_PATTERN.test(normalizedTranscript) ? "" : normalizedTranscript;
}

export function resolveDictationInstallationState(status: TranscriptionStatus | undefined): {
  installing: boolean;
  progress: number | null;
} {
  const installing =
    status?.state === "downloading-runtime" || status?.state === "downloading-model";
  if (!installing || !status.totalBytes || status.downloadedBytes === null) {
    return { installing, progress: null };
  }
  return {
    installing: true,
    progress: Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100)),
  };
}

export function resolveDictationInsertion(
  text: string,
  cursor: number,
  transcript: string,
): { rangeStart: number; rangeEnd: number; replacement: string } | null {
  const normalizedTranscript = normalizeDictationTranscript(transcript);
  if (!normalizedTranscript) return null;

  const safeCursor = Math.max(0, Math.min(text.length, cursor));
  const characterBefore = text[safeCursor - 1];
  const characterAfter = text[safeCursor];
  const prefix = characterBefore && !/\s/.test(characterBefore) ? " " : "";
  const suffix = characterAfter && !/[\s.,!?;:)}\]]/.test(characterAfter) ? " " : "";

  return {
    rangeStart: safeCursor,
    rangeEnd: safeCursor,
    replacement: `${prefix}${normalizedTranscript}${suffix}`,
  };
}

export function resampleToMonoPcm(
  channels: ReadonlyArray<Float32Array>,
  sourceSampleRate: number,
  targetSampleRate = 16_000,
): Float32Array {
  const sourceLength = channels[0]?.length ?? 0;
  if (sourceLength === 0 || channels.length === 0) return new Float32Array();
  if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
    throw new Error("Invalid audio sample rate.");
  }

  const targetLength = Math.max(
    1,
    Math.round((sourceLength * targetSampleRate) / sourceSampleRate),
  );
  const output = new Float32Array(targetLength);
  const sourceSamplesPerTarget = sourceSampleRate / targetSampleRate;

  for (let targetIndex = 0; targetIndex < targetLength; targetIndex += 1) {
    if (sourceSamplesPerTarget >= 1) {
      const start = Math.floor(targetIndex * sourceSamplesPerTarget);
      const end = Math.max(start + 1, Math.floor((targetIndex + 1) * sourceSamplesPerTarget));
      let sum = 0;
      let count = 0;
      for (let sourceIndex = start; sourceIndex < Math.min(end, sourceLength); sourceIndex += 1) {
        for (const channel of channels) {
          sum += channel[sourceIndex] ?? 0;
          count += 1;
        }
      }
      output[targetIndex] = count > 0 ? sum / count : 0;
      continue;
    }

    const sourcePosition = targetIndex * sourceSamplesPerTarget;
    const lowerIndex = Math.min(sourceLength - 1, Math.floor(sourcePosition));
    const upperIndex = Math.min(sourceLength - 1, lowerIndex + 1);
    const fraction = sourcePosition - lowerIndex;
    let sample = 0;
    for (const channel of channels) {
      const lower = channel[lowerIndex] ?? 0;
      const upper = channel[upperIndex] ?? lower;
      sample += lower + (upper - lower) * fraction;
    }
    output[targetIndex] = sample / channels.length;
  }

  return output;
}

export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate = 16_000): Blob {
  const bytesPerSample = 2;
  const headerBytes = 44;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      headerBytes + index * bytesPerSample,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Capture microphone PCM without passing through MediaRecorder's container.
 * This is used on iOS because WebKit may fail to decode its own fragmented
 * MediaRecorder output through decodeAudioData().
 */
export function prepareDictationPcmRecorder(
  createAudioContext: () => AudioContext = () => new AudioContext(),
): PreparedDictationPcmRecorder | null {
  let context: AudioContext;
  try {
    context = createAudioContext();
  } catch {
    return null;
  }

  let handedOff = false;
  let disposed = false;
  const initialResume =
    context.state === "running" ? Promise.resolve() : context.resume().catch(() => undefined);

  const closePreparedContext = () => {
    if (disposed || handedOff) return;
    disposed = true;
    void context.close().catch(() => undefined);
  };

  return {
    start: async (stream, options) => {
      if (disposed || handedOff) throw new Error("Audio capture is no longer available.");
      await initialResume;
      if (disposed || handedOff) throw new Error("Audio capture is no longer available.");
      if (context.state !== "running") {
        await context.resume();
      }
      if (context.state !== "running") {
        throw new Error("Unable to start audio capture.");
      }

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4_096, 1, 1);
      const mutedOutput = context.createGain();
      const chunks: Float32Array[] = [];
      const sampleRate = context.sampleRate;
      const tracks = stream.getTracks();
      let stopPromise: Promise<Blob> | null = null;
      let stopping = false;
      let interruptionReported = false;

      const reportInterruption = (reason: DictationCaptureInterruption) => {
        if (stopping || interruptionReported) return;
        interruptionReported = true;
        queueMicrotask(() => {
          if (stopping) return;
          try {
            options?.onInterrupted?.(reason);
          } catch {
            // Capture cleanup must not depend on a consumer callback succeeding.
          }
        });
      };
      const handleStreamInactive = () => reportInterruption("stream-inactive");
      const handleTrackEnded = () => reportInterruption("track-ended");
      const handleContextStateChange = () => {
        const state = context.state as string;
        if (state === "closed") reportInterruption("audio-context-closed");
        if (state === "suspended") reportInterruption("audio-context-suspended");
        if (state === "interrupted") reportInterruption("audio-context-interrupted");
      };
      const removeInterruptionListeners = () => {
        stream.removeEventListener("inactive", handleStreamInactive);
        for (const track of tracks) track.removeEventListener("ended", handleTrackEnded);
        context.removeEventListener("statechange", handleContextStateChange);
      };

      mutedOutput.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        if (samples.length > 0) chunks.push(new Float32Array(samples));
      };
      source.connect(processor);
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
      stream.addEventListener("inactive", handleStreamInactive);
      for (const track of tracks) track.addEventListener("ended", handleTrackEnded);
      context.addEventListener("statechange", handleContextStateChange);
      handedOff = true;
      if (tracks.length > 0 && stream.active === false) reportInterruption("stream-inactive");
      for (const track of tracks) {
        if (track.readyState === "ended") reportInterruption("track-ended");
      }
      handleContextStateChange();

      return {
        stop: () => {
          stopping = true;
          stopPromise ??= (async () => {
            removeInterruptionListeners();
            processor.onaudioprocess = null;
            source.disconnect();
            processor.disconnect();
            mutedOutput.disconnect();
            await context.close().catch(() => undefined);

            const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
            if (sampleCount === 0) return new Blob([], { type: "audio/wav" });

            const samples = new Float32Array(sampleCount);
            let offset = 0;
            for (const chunk of chunks) {
              samples.set(chunk, offset);
              offset += chunk.length;
            }
            return encodeMonoPcm16Wav(resampleToMonoPcm([samples], sampleRate));
          })();
          return stopPromise;
        },
      };
    },
    dispose: closePreparedContext,
  };
}

export async function normalizeDictationAudioToWav(audio: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
      decoded.getChannelData(channel),
    );
    return encodeMonoPcm16Wav(resampleToMonoPcm(channels, decoded.sampleRate));
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function readResponseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

const decodeTranscriptionStatus = Schema.decodeUnknownSync(TranscriptionStatus);
const decodeTranscriptionResult = Schema.decodeUnknownSync(TranscriptionResult);

function decodeTranscriptionResponse<A>(
  decode: (input: unknown) => A,
  input: unknown,
  invalidResponseMessage: string,
): A {
  try {
    return decode(input);
  } catch {
    throw new Error(invalidResponseMessage);
  }
}

export async function getEnvironmentTranscriptionStatus(
  environmentId: EnvironmentId,
): Promise<TranscriptionStatus> {
  const response = await fetchEnvironmentHttp({
    environmentId,
    pathname: TRANSCRIPTION_STATUS_ROUTE_PATH,
  });
  if (!response.ok) {
    throw new Error(await readResponseError(response, "Could not check local transcription."));
  }
  const body: unknown = await response.json();
  return decodeTranscriptionResponse(
    decodeTranscriptionStatus,
    body,
    "The transcription status response was invalid.",
  );
}

export async function transcribeEnvironmentAudio(
  environmentId: EnvironmentId,
  audio: Blob,
  options?: { readonly signal?: AbortSignal },
): Promise<TranscriptionResult> {
  const formData = new FormData();
  formData.append("file", audio, "recording.wav");
  const response = await fetchEnvironmentHttp(
    {
      environmentId,
      pathname: TRANSCRIPTION_ROUTE_PATH,
    },
    {
      method: "POST",
      body: formData,
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(await readResponseError(response, "Local transcription failed."));
  }
  const body: unknown = await response.json();
  return decodeTranscriptionResponse(
    decodeTranscriptionResult,
    body,
    "The transcription response was invalid.",
  );
}
