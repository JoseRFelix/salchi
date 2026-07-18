import { describe, expect, it } from "vitest";

import {
  calculateDictationAudioLevel,
  encodeMonoPcm16Wav,
  formatDictationRecordingDuration,
  resampleToMonoPcm,
  resolveDictationInstallationState,
  resolveDictationInsertion,
  selectDictationAudioMimeType,
} from "./dictation";

describe("dictation recording feedback", () => {
  it("calculates microphone amplitude from time-domain samples", () => {
    expect(calculateDictationAudioLevel(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(calculateDictationAudioLevel(new Uint8Array([0, 255]))).toBeGreaterThan(0.99);
  });

  it("formats elapsed recording time", () => {
    expect(formatDictationRecordingDuration(-1)).toBe("0:00");
    expect(formatDictationRecordingDuration(62_999)).toBe("1:02");
  });

  it("distinguishes installation progress from ordinary transcription", () => {
    expect(
      resolveDictationInstallationState({
        configured: true,
        state: "downloading-model",
        downloadedBytes: 25,
        totalBytes: 100,
        message: null,
      }),
    ).toEqual({ installing: true, progress: 25 });
    expect(
      resolveDictationInstallationState({
        configured: true,
        state: "downloading-runtime",
        downloadedBytes: null,
        totalBytes: null,
        message: null,
      }),
    ).toEqual({ installing: true, progress: null });
    expect(
      resolveDictationInstallationState({
        configured: true,
        state: "ready",
        downloadedBytes: null,
        totalBytes: null,
        message: null,
      }),
    ).toEqual({ installing: false, progress: null });
  });
});

describe("selectDictationAudioMimeType", () => {
  it("prefers Opus in WebM when the browser supports it", () => {
    expect(selectDictationAudioMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to MP4 for browsers without WebM recording", () => {
    expect(selectDictationAudioMimeType((mimeType) => mimeType === "audio/mp4")).toBe("audio/mp4");
  });

  it("allows the browser to choose when no preferred type is supported", () => {
    expect(selectDictationAudioMimeType(() => false)).toBeUndefined();
  });
});

describe("resolveDictationInsertion", () => {
  it("inserts normalized dictation at the cursor", () => {
    expect(resolveDictationInsertion("Fix  please", 4, "  the\nlogin bug  ")).toEqual({
      rangeStart: 4,
      rangeEnd: 4,
      replacement: "the login bug",
    });
  });

  it("adds word boundaries when inserting inside a word", () => {
    expect(resolveDictationInsertion("beforeafter", 6, "middle")).toEqual({
      rangeStart: 6,
      rangeEnd: 6,
      replacement: " middle ",
    });
  });

  it("does not add a space before punctuation", () => {
    expect(resolveDictationInsertion("Do this.", 7, "now")).toEqual({
      rangeStart: 7,
      rangeEnd: 7,
      replacement: " now",
    });
  });

  it("ignores an empty transcript", () => {
    expect(resolveDictationInsertion("Keep this", 4, " \n ")).toBeNull();
  });
});

describe("dictation WAV normalization", () => {
  it("mixes stereo audio down while resampling", () => {
    const samples = resampleToMonoPcm(
      [new Float32Array([1, 1, -1, -1]), new Float32Array([0, 0, 0, 0])],
      4,
      2,
    );

    expect(Array.from(samples)).toEqual([0.5, -0.5]);
  });

  it("encodes mono PCM with a valid WAV header", async () => {
    const wav = encodeMonoPcm16Wav(new Float32Array([-1, 0, 1]), 16_000);
    const view = new DataView(await wav.arrayBuffer());
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, offset, length));

    expect(wav.type).toBe("audio/wav");
    expect(wav.size).toBe(50);
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(32_767);
  });
});
