import { describe, expect, it, vi } from "vitest";

import {
  calculateDictationAudioLevel,
  encodeMonoPcm16Wav,
  formatDictationRecordingDuration,
  localTranscriptionStatusQueryKey,
  localTranscriptionStatusRefetchInterval,
  normalizeDictationTranscript,
  prepareDictationPcmRecorder,
  prepareDictationStartSound,
  resampleToMonoPcm,
  resolveDictationInstallationState,
  resolveDictationInsertion,
  selectDictationAudioMimeType,
  triggerDictationStartVibration,
} from "./dictation";

describe("dictation status refresh", () => {
  it("uses the selected model as part of the status cache contract", () => {
    const environmentId = "env-local" as Parameters<typeof localTranscriptionStatusQueryKey>[0];

    expect(localTranscriptionStatusQueryKey(environmentId, "base.en")).toEqual([
      "local-transcription-status",
      environmentId,
      "base.en",
    ]);
    expect(localTranscriptionStatusQueryKey(environmentId, "small.en")).not.toEqual(
      localTranscriptionStatusQueryKey(environmentId, "base.en"),
    );
  });

  it("resumes polling terminal status while a recording is being transcribed", () => {
    const ready = {
      configured: true,
      state: "ready" as const,
      downloadedBytes: null,
      totalBytes: null,
      message: null,
    };

    expect(localTranscriptionStatusRefetchInterval({ transcribing: false, status: ready })).toBe(
      false,
    );
    expect(localTranscriptionStatusRefetchInterval({ transcribing: true, status: ready })).toBe(
      750,
    );
  });

  it("polls non-terminal installation states and stops on terminal failures", () => {
    expect(
      localTranscriptionStatusRefetchInterval({
        transcribing: false,
        status: {
          configured: true,
          state: "downloading-model",
          downloadedBytes: 1,
          totalBytes: 2,
          message: null,
        },
      }),
    ).toBe(750);
    expect(
      localTranscriptionStatusRefetchInterval({
        transcribing: false,
        status: {
          configured: true,
          state: "error",
          downloadedBytes: null,
          totalBytes: null,
          message: "failed",
        },
      }),
    ).toBe(false);
  });
});

describe("dictation recording start sound", () => {
  it("plays a short ascending cue and closes its audio context", async () => {
    let state: AudioContextState = "suspended";
    let endedListener: EventListenerOrEventListenerObject | null = null;
    const frequency = {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    };
    const gainParam = {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    };
    const oscillator = {
      type: "sine",
      frequency,
      connect: vi.fn(),
      disconnect: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        endedListener = listener;
      }),
      start: vi.fn(),
      stop: vi.fn(() => {
        queueMicrotask(() => {
          if (typeof endedListener === "function") {
            endedListener(new Event("ended"));
          } else {
            endedListener?.handleEvent(new Event("ended"));
          }
        });
      }),
    };
    const gain = {
      gain: gainParam,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      get state() {
        return state;
      },
      currentTime: 4,
      destination: {},
      resume: vi.fn(async () => {
        state = "running";
      }),
      close: vi.fn(async () => {
        state = "closed";
      }),
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
    };

    const sound = prepareDictationStartSound(() => context as unknown as AudioContext);
    await sound.play();

    expect(context.resume).toHaveBeenCalledOnce();
    expect(frequency.setValueAtTime).toHaveBeenCalledWith(660, 4);
    expect(frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(880, 4.1);
    expect(oscillator.start).toHaveBeenCalledWith(4);
    expect(oscillator.stop).toHaveBeenCalledWith(4.1);
    expect(context.close).toHaveBeenCalledOnce();
  });
});

describe("dictation recording start vibration", () => {
  it("requests a short vibration when the browser supports it", () => {
    const vibrate = vi.fn(() => true);

    expect(triggerDictationStartVibration({ vibrate })).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(50);
  });

  it("does not fail recording when vibration is unavailable or rejected", () => {
    expect(triggerDictationStartVibration(null)).toBe(false);
    expect(
      triggerDictationStartVibration({
        vibrate: () => {
          throw new Error("Vibration unavailable");
        },
      }),
    ).toBe(false);
  });
});

describe("dictation PCM recording", () => {
  it("captures microphone samples directly as canonical WAV", async () => {
    let state: AudioContextState = "running";
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const processor = {
      onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const mutedOutput = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      get state() {
        return state;
      },
      sampleRate: 16_000,
      destination: {},
      resume: vi.fn(async () => {
        state = "running";
      }),
      close: vi.fn(async () => {
        state = "closed";
      }),
      createMediaStreamSource: vi.fn(() => source),
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => mutedOutput),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const prepared = prepareDictationPcmRecorder(() => context as unknown as AudioContext);
    expect(prepared).not.toBeNull();

    const stream = {
      getTracks: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaStream;
    const recorder = await prepared?.start(stream);
    processor.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array([-1, 0, 1]),
      },
    } as unknown as AudioProcessingEvent);
    const wav = await recorder?.stop();
    const view = new DataView(await wav!.arrayBuffer());

    expect(context.createScriptProcessor).toHaveBeenCalledWith(4_096, 1, 1);
    expect(mutedOutput.gain.value).toBe(0);
    expect(wav?.type).toBe("audio/wav");
    expect(wav?.size).toBe(50);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(32_767);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("reports a capture interruption once and removes every listener on stop", async () => {
    let state: AudioContextState | "interrupted" = "running";
    let contextStateListener: EventListener = () => undefined;
    const track = new EventTarget() as MediaStreamTrack;
    const stream = Object.assign(new EventTarget(), {
      getTracks: () => [track],
    }) as unknown as MediaStream;
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const processor = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const output = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      get state() {
        return state;
      },
      sampleRate: 16_000,
      destination: {},
      resume: vi.fn(async () => {
        state = "running";
      }),
      close: vi.fn(async () => {
        state = "closed";
        contextStateListener(new Event("statechange"));
      }),
      createMediaStreamSource: vi.fn(() => source),
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => output),
      addEventListener: vi.fn((_type: string, listener: EventListener) => {
        contextStateListener = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const onInterrupted = vi.fn();
    const prepared = prepareDictationPcmRecorder(() => context as unknown as AudioContext);
    const recorder = await prepared?.start(stream, { onInterrupted });

    track.dispatchEvent(new Event("ended"));
    stream.dispatchEvent(new Event("inactive"));
    await Promise.resolve();

    expect(onInterrupted).toHaveBeenCalledOnce();
    expect(onInterrupted).toHaveBeenCalledWith("track-ended");

    await recorder?.stop();
    track.dispatchEvent(new Event("ended"));
    contextStateListener(new Event("statechange"));
    await Promise.resolve();

    expect(onInterrupted).toHaveBeenCalledOnce();
    expect(context.removeEventListener).toHaveBeenCalledWith("statechange", contextStateListener);
  });

  it.each(["suspended", "interrupted", "closed"] as const)(
    "reports an AudioContext %s state",
    async (nextState) => {
      let state: AudioContextState | "interrupted" = "running";
      let contextStateListener: EventListener = () => undefined;
      const context = {
        get state() {
          return state;
        },
        sampleRate: 16_000,
        destination: {},
        resume: vi.fn(async () => undefined),
        close: vi.fn(async () => {
          state = "closed";
        }),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        createScriptProcessor: vi.fn(() => ({
          onaudioprocess: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
        createGain: vi.fn(() => ({
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
        addEventListener: vi.fn((_type: string, listener: EventListener) => {
          contextStateListener = listener;
        }),
        removeEventListener: vi.fn(),
      };
      const stream = {
        getTracks: () => [],
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as MediaStream;
      const onInterrupted = vi.fn();
      const prepared = prepareDictationPcmRecorder(() => context as unknown as AudioContext);
      const recorder = await prepared?.start(stream, { onInterrupted });

      state = nextState;
      contextStateListener(new Event("statechange"));
      await Promise.resolve();

      expect(onInterrupted).toHaveBeenCalledWith(`audio-context-${nextState}`);
      await recorder?.stop();
    },
  );
});

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

  it("ignores Whisper blank-audio sentinels", () => {
    expect(normalizeDictationTranscript("  [BLANK_AUDIO]  ")).toBe("");
    expect(resolveDictationInsertion("Keep this", 4, "[BLANK_AUDIO]")).toBeNull();
    expect(resolveDictationInsertion("Keep this", 4, "[blank_audio] [BLANK_AUDIO]")).toBeNull();
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
