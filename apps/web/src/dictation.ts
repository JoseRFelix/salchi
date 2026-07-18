import {
  TRANSCRIPTION_ROUTE_PATH,
  TRANSCRIPTION_STATUS_ROUTE_PATH,
  TranscriptionResult,
  TranscriptionStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { fetchEnvironmentHttp } from "./environments/runtime";

export const DICTATION_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

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
  const normalizedTranscript = transcript.trim().replace(/\s+/g, " ");
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
