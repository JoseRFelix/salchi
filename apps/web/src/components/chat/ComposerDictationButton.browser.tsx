import { EnvironmentId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { DictationPcmRecorderStartOptions } from "../../dictation";

const dictationMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  normalize: vi.fn(),
  preparePcmRecorder: vi.fn(),
  prepareStartSound: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("../../dictation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../dictation")>();
  return {
    ...actual,
    getEnvironmentTranscriptionStatus: dictationMocks.getStatus,
    normalizeDictationAudioToWav: dictationMocks.normalize,
    prepareDictationPcmRecorder: dictationMocks.preparePcmRecorder,
    prepareDictationStartSound: dictationMocks.prepareStartSound,
    transcribeEnvironmentAudio: dictationMocks.transcribe,
  };
});

import {
  loadRetainedDictationRecording,
  resetRetainedDictationRecordingStoreForTests,
  retainDictationRecording,
} from "../../retainedDictationRecordingStore";
import { toastManager } from "../ui/toast";
import { ComposerDictationButton } from "./ComposerDictationButton";

class MockWakeLockSentinel extends EventTarget {
  released = false;
  readonly release = vi.fn(async () => {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const IOS_WEBKIT_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

class MockMediaRecorder extends EventTarget {
  static isTypeSupported(): boolean {
    return true;
  }

  readonly mimeType = "audio/webm;codecs=opus";
  state: "inactive" | "recording" | "paused" = "inactive";

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
  }
}

function overrideProperty(target: object, key: PropertyKey, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  return () => {
    if (original) {
      Object.defineProperty(target, key, original);
    } else {
      Reflect.deleteProperty(target, key);
    }
  };
}

async function renderPcmLifecycleButton(options: {
  readonly pcmStart: (
    stream: MediaStream,
    options?: DictationPcmRecorderStartOptions,
  ) => Promise<{ readonly stop: () => Promise<Blob> }>;
  readonly stream?: MediaStream;
  readonly getUserMedia?: () => Promise<MediaStream>;
  readonly ownerKey?: string;
  readonly transcribe?: (...args: unknown[]) => Promise<{ readonly text: string }>;
}) {
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  const wakeLockSentinel = new MockWakeLockSentinel();
  const wakeLockRequest = vi.fn(async () => wakeLockSentinel as unknown as WakeLockSentinel);
  const getUserMedia = vi.fn(options.getUserMedia ?? (async () => options.stream!));
  const restoreProperties = [
    overrideProperty(navigator, "userAgent", IOS_WEBKIT_USER_AGENT),
    overrideProperty(navigator.mediaDevices, "getUserMedia", getUserMedia),
    overrideProperty(navigator, "wakeLock", { request: wakeLockRequest }),
  ];
  const disposePcmRecorder = vi.fn();
  const disposeStartSound = vi.fn();
  dictationMocks.prepareStartSound.mockReturnValue({
    play: vi.fn(async () => undefined),
    dispose: disposeStartSound,
  });
  dictationMocks.preparePcmRecorder.mockReturnValue({
    start: options.pcmStart,
    dispose: disposePcmRecorder,
  });
  dictationMocks.getStatus.mockResolvedValue({
    configured: true,
    state: "ready",
    downloadedBytes: null,
    totalBytes: null,
    message: null,
  });
  dictationMocks.transcribe.mockImplementation(
    options.transcribe ?? (async () => ({ text: "Transcript" })),
  );

  const onTranscript = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ComposerDictationButton
        recordingOwnerKey={options.ownerKey ?? "pcm-lifecycle-owner"}
        environmentId={EnvironmentId.make("pcm-lifecycle-test")}
        disabled={false}
        onTranscript={onTranscript}
      />
    </QueryClientProvider>,
  );
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await screen.unmount();
  };

  return {
    disposePcmRecorder,
    disposeStartSound,
    getUserMedia,
    onTranscript,
    wakeLockRequest,
    wakeLockSentinel,
    unmount,
    cleanup: async () => {
      await unmount();
      queryClient.clear();
      for (const restore of restoreProperties.toReversed()) restore();
    },
  };
}

beforeEach(async () => {
  await resetRetainedDictationRecordingStoreForTests();
  vi.resetAllMocks();
});

afterEach(async () => {
  toastManager.close();
  await resetRetainedDictationRecordingStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ComposerDictationButton", () => {
  it("stops a PCM recorder that finishes starting after unmount", async () => {
    const trackStop = vi.fn();
    const stream = new MediaStream();
    vi.spyOn(stream, "getTracks").mockReturnValue([
      { stop: trackStop } as unknown as MediaStreamTrack,
    ]);
    const pcmRecorder = deferred<{ readonly stop: () => Promise<Blob> }>();
    const pcmStop = vi.fn(async () => new Blob([], { type: "audio/wav" }));
    const pcmStart = vi.fn(() => pcmRecorder.promise);
    const lifecycle = await renderPcmLifecycleButton({ pcmStart, stream });

    try {
      await page.getByTestId("ios-dictation-haptic-switch").click();
      await vi.waitFor(() => {
        expect(pcmStart).toHaveBeenCalledOnce();
      });

      await lifecycle.unmount();
      expect(trackStop).toHaveBeenCalledOnce();
      expect(lifecycle.wakeLockRequest).not.toHaveBeenCalled();

      pcmRecorder.resolve({ stop: pcmStop });
      await vi.waitFor(() => {
        expect(pcmStop).toHaveBeenCalledOnce();
        expect(lifecycle.disposePcmRecorder).toHaveBeenCalledOnce();
      });
      expect(lifecycle.onTranscript).not.toHaveBeenCalled();
    } finally {
      await lifecycle.cleanup();
    }
  });

  it("disposes prepared audio resources while microphone permission is still pending", async () => {
    const trackStop = vi.fn();
    const stream = new MediaStream();
    vi.spyOn(stream, "getTracks").mockReturnValue([
      { stop: trackStop } as unknown as MediaStreamTrack,
    ]);
    const permission = deferred<MediaStream>();
    const pcmStart = vi.fn(async () => ({
      stop: vi.fn(async () => new Blob([], { type: "audio/wav" })),
    }));
    const lifecycle = await renderPcmLifecycleButton({
      pcmStart,
      getUserMedia: () => permission.promise,
      ownerKey: "pending-permission-owner",
    });

    try {
      await page.getByTestId("ios-dictation-haptic-switch").click();
      await vi.waitFor(() => {
        expect(lifecycle.getUserMedia).toHaveBeenCalledOnce();
      });

      await lifecycle.unmount();
      expect(lifecycle.disposeStartSound).toHaveBeenCalledOnce();
      expect(lifecycle.disposePcmRecorder).toHaveBeenCalledOnce();

      permission.resolve(stream);
      await vi.waitFor(() => {
        expect(trackStop).toHaveBeenCalledOnce();
      });
      expect(pcmStart).not.toHaveBeenCalled();
      expect(lifecycle.onTranscript).not.toHaveBeenCalled();
    } finally {
      await lifecycle.cleanup();
    }
  });

  it("stops microphone tracks before asynchronous PCM finalization completes", async () => {
    const trackStop = vi.fn();
    const stream = new MediaStream();
    vi.spyOn(stream, "getTracks").mockReturnValue([
      { stop: trackStop } as unknown as MediaStreamTrack,
    ]);
    const finalizedAudio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    const finalization = deferred<Blob>();
    const pcmStop = vi.fn(() => finalization.promise);
    const lifecycle = await renderPcmLifecycleButton({
      pcmStart: async () => ({ stop: pcmStop }),
      stream,
      ownerKey: "slow-finalization-owner",
    });

    try {
      await page.getByTestId("ios-dictation-haptic-switch").click();
      await page.getByRole("button", { name: "Stop and transcribe" }).click();
      await vi.waitFor(() => {
        expect(pcmStop).toHaveBeenCalledOnce();
      });
      expect(trackStop).toHaveBeenCalledOnce();
      expect(dictationMocks.transcribe).not.toHaveBeenCalled();

      finalization.resolve(finalizedAudio);
      await vi.waitFor(() => {
        expect(dictationMocks.transcribe).toHaveBeenCalledOnce();
        expect(lifecycle.onTranscript).toHaveBeenCalledWith("Transcript");
      });
    } finally {
      await lifecycle.cleanup();
    }
  });

  it("retains interrupted PCM audio without automatically submitting it", async () => {
    const stream = new MediaStream();
    vi.spyOn(stream, "getTracks").mockReturnValue([
      { stop: vi.fn() } as unknown as MediaStreamTrack,
    ]);
    const partialAudio = new Blob([new Uint8Array([9, 8, 7])], { type: "audio/wav" });
    const pcmStop = vi.fn(async () => partialAudio);
    let interruption: DictationPcmRecorderStartOptions["onInterrupted"];
    const lifecycle = await renderPcmLifecycleButton({
      pcmStart: async (_stream, options) => {
        interruption = options?.onInterrupted;
        return { stop: pcmStop };
      },
      stream,
      ownerKey: "interrupted-capture-owner",
    });

    try {
      await page.getByTestId("ios-dictation-haptic-switch").click();
      await vi.waitFor(() => {
        expect(interruption).toBeTypeOf("function");
      });
      interruption?.("track-ended");

      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Resend recording" })).toBeVisible();
        expect(pcmStop).toHaveBeenCalledOnce();
      });
      expect(dictationMocks.transcribe).not.toHaveBeenCalled();
      await expect(
        loadRetainedDictationRecording("interrupted-capture-owner"),
      ).resolves.toMatchObject({ audio: partialAudio, normalizedAudio: partialAudio });

      await page.getByRole("button", { name: "Resend recording" }).click();
      await vi.waitFor(() => {
        expect(dictationMocks.transcribe).toHaveBeenCalledOnce();
        expect(lifecycle.onTranscript).toHaveBeenCalledWith("Transcript");
      });
    } finally {
      await lifecycle.cleanup();
    }
  });

  it("aborts an in-flight transcription on unmount and leaves its recording retained", async () => {
    const stream = new MediaStream();
    vi.spyOn(stream, "getTracks").mockReturnValue([
      { stop: vi.fn() } as unknown as MediaStreamTrack,
    ]);
    const audio = new Blob([new Uint8Array([3, 2, 1])], { type: "audio/wav" });
    const transcription = deferred<{ text: string }>();
    const transcribe = vi.fn((..._args: unknown[]) => transcription.promise);
    const lifecycle = await renderPcmLifecycleButton({
      pcmStart: async () => ({ stop: async () => audio }),
      stream,
      transcribe,
      ownerKey: "aborted-transcription-owner",
    });

    try {
      await page.getByTestId("ios-dictation-haptic-switch").click();
      await page.getByRole("button", { name: "Stop and transcribe" }).click();
      await vi.waitFor(() => {
        expect(transcribe).toHaveBeenCalledOnce();
      });
      const signal = (transcribe.mock.calls[0]![2] as { signal: AbortSignal }).signal;
      expect(signal.aborted).toBe(false);

      await lifecycle.unmount();
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ name: "AbortError" });
      expect(lifecycle.onTranscript).not.toHaveBeenCalled();
      await expect(
        loadRetainedDictationRecording("aborted-transcription-owner"),
      ).resolves.toMatchObject({ audio, normalizedAudio: audio });
    } finally {
      transcription.resolve({ text: "Late transcript" });
      await lifecycle.cleanup();
    }
  });

  it("restores retained audio only for its owning thread", async () => {
    const ownerKey = "restored-recording-owner";
    const restoredEnvironmentId = EnvironmentId.make("restored-recording-environment");
    const audio = new Blob([new Uint8Array([4, 2])], { type: "audio/wav" });
    await retainDictationRecording({
      id: "restored-recording",
      ownerKey,
      environmentId: restoredEnvironmentId,
      audio,
      normalizedAudio: audio,
      createdAt: Date.now(),
    });

    const unrelated = await renderPcmLifecycleButton({
      pcmStart: async () => ({ stop: async () => audio }),
      stream: new MediaStream(),
      ownerKey: "another-recording-owner",
    });
    try {
      await expect.element(page.getByRole("button", { name: "Dictate" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Resend recording" }))
        .not.toBeInTheDocument();
    } finally {
      await unrelated.cleanup();
    }

    const restored = await renderPcmLifecycleButton({
      pcmStart: async () => ({ stop: async () => audio }),
      stream: new MediaStream(),
      ownerKey,
    });
    try {
      await expect.element(page.getByRole("button", { name: "Resend recording" })).toBeVisible();
      await page.getByRole("button", { name: "Resend recording" }).click();
      await vi.waitFor(() => {
        expect(dictationMocks.transcribe).toHaveBeenCalledWith(restoredEnvironmentId, audio, {
          signal: expect.any(AbortSignal),
        });
        expect(restored.onTranscript).toHaveBeenCalledWith("Transcript");
      });
      await expect(loadRetainedDictationRecording(ownerKey)).resolves.toBeNull();
    } finally {
      await restored.cleanup();
    }
  });

  it("retains MediaRecorder chunks when capture fails", async () => {
    const capturedAudio = new Blob([new Uint8Array([6, 5, 4])], {
      type: "audio/webm;codecs=opus",
    });
    const normalizedAudio = new Blob([new Uint8Array([1, 1, 2])], { type: "audio/wav" });
    let failRecording: () => void = () => undefined;

    class FailingMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }

      readonly mimeType = "audio/webm;codecs=opus";
      state: "inactive" | "recording" | "paused" = "inactive";

      constructor() {
        super();
        failRecording = () => this.fail();
      }

      start(): void {
        this.state = "recording";
      }

      stop(): void {
        if (this.state === "inactive") return;
        this.state = "inactive";
        queueMicrotask(() => {
          const dataEvent = new Event("dataavailable");
          Object.defineProperty(dataEvent, "data", { value: capturedAudio });
          this.dispatchEvent(dataEvent);
          this.dispatchEvent(new Event("stop"));
        });
      }

      fail(): void {
        this.dispatchEvent(new Event("error"));
      }
    }

    vi.stubGlobal("MediaRecorder", FailingMediaRecorder);
    const track = Object.assign(new EventTarget(), { stop: vi.fn(), readyState: "live" });
    const stream = Object.assign(new EventTarget(), {
      active: true,
      getTracks: () => [track],
    }) as unknown as MediaStream;
    const wakeLock = new MockWakeLockSentinel();
    const restoreProperties = [
      overrideProperty(navigator, "userAgent", "Mozilla/5.0 Chrome/140.0"),
      overrideProperty(
        navigator.mediaDevices,
        "getUserMedia",
        vi.fn(async () => stream),
      ),
      overrideProperty(navigator, "wakeLock", {
        request: vi.fn(async () => wakeLock as unknown as WakeLockSentinel),
      }),
    ];
    dictationMocks.prepareStartSound.mockReturnValue({
      play: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    dictationMocks.getStatus.mockResolvedValue({
      configured: true,
      state: "ready",
      downloadedBytes: null,
      totalBytes: null,
      message: null,
    });
    dictationMocks.normalize.mockResolvedValue(normalizedAudio);
    dictationMocks.transcribe.mockResolvedValue({ text: "Recovered transcript" });
    const onTranscript = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ComposerDictationButton
          recordingOwnerKey="failed-media-recorder-owner"
          environmentId={EnvironmentId.make("failed-media-recorder-environment")}
          disabled={false}
          onTranscript={onTranscript}
        />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Dictate" }).click();
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
      });
      failRecording();

      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Resend recording" })).toBeVisible();
      });
      expect(track.stop).toHaveBeenCalledOnce();
      expect(dictationMocks.normalize).not.toHaveBeenCalled();
      expect(dictationMocks.transcribe).not.toHaveBeenCalled();
      await expect(
        loadRetainedDictationRecording("failed-media-recorder-owner"),
      ).resolves.toMatchObject({ audio: capturedAudio, normalizedAudio: null });

      await page.getByRole("button", { name: "Resend recording" }).click();
      await vi.waitFor(() => {
        expect(dictationMocks.normalize).toHaveBeenCalledWith(capturedAudio);
        expect(dictationMocks.transcribe).toHaveBeenCalledWith(
          EnvironmentId.make("failed-media-recorder-environment"),
          normalizedAudio,
          { signal: expect.any(AbortSignal) },
        );
        expect(onTranscript).toHaveBeenCalledWith("Recovered transcript");
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      for (const restore of restoreProperties.toReversed()) restore();
    }
  });

  it.each(["recording", "transcribing"] as const)(
    "releases PCM capture and wake lock when unmounted while %s",
    async (phase) => {
      const trackStop = vi.fn();
      const stream = new MediaStream();
      vi.spyOn(stream, "getTracks").mockReturnValue([
        { stop: trackStop } as unknown as MediaStreamTrack,
      ]);
      const pcmAudio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
      const pcmStop = vi.fn(async () => pcmAudio);
      const pcmStart = vi.fn(async () => ({ stop: pcmStop }));
      const transcription = deferred<{ text: string }>();
      const lifecycle = await renderPcmLifecycleButton({
        pcmStart,
        stream,
        transcribe: () => transcription.promise,
      });

      try {
        await page.getByTestId("ios-dictation-haptic-switch").click();
        await vi.waitFor(() => {
          expect(page.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
          expect(lifecycle.wakeLockRequest).toHaveBeenCalledOnce();
        });

        if (phase === "transcribing") {
          await page.getByRole("button", { name: "Stop and transcribe" }).click();
          await vi.waitFor(() => {
            expect(dictationMocks.transcribe).toHaveBeenCalledOnce();
            expect(trackStop).toHaveBeenCalledOnce();
          });
          expect(lifecycle.wakeLockSentinel.release).not.toHaveBeenCalled();
        }

        await lifecycle.unmount();
        await vi.waitFor(() => {
          expect(pcmStop).toHaveBeenCalledOnce();
          expect(trackStop).toHaveBeenCalledOnce();
          expect(lifecycle.wakeLockSentinel.release).toHaveBeenCalledOnce();
        });
        expect(lifecycle.onTranscript).not.toHaveBeenCalled();
      } finally {
        transcription.resolve({ text: "Late transcript" });
        await lifecycle.cleanup();
      }
    },
  );

  it("plays its cue, holds a wake lock, and retains failed audio for resend", async () => {
    const lifecycleEvents: string[] = [];
    const recordedAudio = new Blob([new Uint8Array([1, 2, 3])], {
      type: "audio/webm;codecs=opus",
    });
    const normalizedAudio = new Blob([new Uint8Array([4, 5, 6])], { type: "audio/wav" });
    const firstTranscription = deferred<{ text: string }>();
    const wakeLockSentinels: MockWakeLockSentinel[] = [];

    class MockMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }

      readonly mimeType = "audio/webm;codecs=opus";
      state: "inactive" | "recording" | "paused" = "inactive";

      start(): void {
        lifecycleEvents.push("recording");
        this.state = "recording";
      }

      stop(): void {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable");
        Object.defineProperty(dataEvent, "data", { value: recordedAudio });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }

    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    const originalGetUserMedia = Object.getOwnPropertyDescriptor(
      navigator.mediaDevices,
      "getUserMedia",
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: vi.fn(async () => new MediaStream()),
    });
    const originalVibrate = Object.getOwnPropertyDescriptor(navigator, "vibrate");
    const vibrate = vi.fn(() => {
      lifecycleEvents.push("haptic");
      return true;
    });
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: vibrate,
    });
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    const wakeLockRequest = vi.fn(async () => {
      const sentinel = new MockWakeLockSentinel();
      wakeLockSentinels.push(sentinel);
      return sentinel as unknown as WakeLockSentinel;
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: wakeLockRequest },
    });

    const playStartSound = vi.fn(async () => {
      lifecycleEvents.push("sound");
    });
    const disposeStartSound = vi.fn();
    dictationMocks.prepareStartSound.mockReturnValue({
      play: playStartSound,
      dispose: disposeStartSound,
    });
    dictationMocks.getStatus.mockResolvedValue({
      configured: true,
      state: "ready",
      downloadedBytes: null,
      totalBytes: null,
      message: null,
    });
    dictationMocks.normalize.mockResolvedValue(normalizedAudio);
    dictationMocks.transcribe
      .mockImplementationOnce(() => firstTranscription.promise)
      .mockResolvedValueOnce({ text: "Retried transcript" });
    const onTranscript = vi.fn();
    const toastAdd = vi.spyOn(toastManager, "add");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ComposerDictationButton
          recordingOwnerKey="dictation-test-owner"
          environmentId={EnvironmentId.make("dictation-test")}
          disabled={false}
          onTranscript={onTranscript}
        />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Dictate" }).click();
      await vi.waitFor(() => {
        expect(lifecycleEvents).toEqual(["haptic", "sound", "recording"]);
        expect(vibrate).toHaveBeenCalledWith(50);
        expect(wakeLockRequest).toHaveBeenCalledOnce();
      });

      await page.getByRole("button", { name: "Stop and transcribe" }).click();
      await vi.waitFor(() => {
        expect(dictationMocks.transcribe).toHaveBeenCalledOnce();
      });
      expect(wakeLockSentinels[0]?.release).not.toHaveBeenCalled();

      firstTranscription.reject(new Error("Upload unavailable"));
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Resend recording" })).toBeVisible();
        expect(toastAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not transcribe recording",
            description: "Upload unavailable",
            actionProps: expect.objectContaining({ children: "Resend" }),
          }),
        );
        expect(wakeLockSentinels[0]?.release).toHaveBeenCalledOnce();
      });

      await page.getByRole("button", { name: "Resend recording" }).click();
      await vi.waitFor(() => {
        expect(dictationMocks.transcribe).toHaveBeenCalledTimes(2);
        expect(dictationMocks.normalize).toHaveBeenCalledOnce();
        expect(wakeLockRequest).toHaveBeenCalledTimes(2);
        expect(onTranscript).toHaveBeenCalledWith("Retried transcript");
        expect(wakeLockSentinels[1]?.release).toHaveBeenCalledOnce();
      });
      expect(dictationMocks.transcribe.mock.calls[0]?.[1]).toBe(normalizedAudio);
      expect(dictationMocks.transcribe.mock.calls[1]?.[1]).toBe(normalizedAudio);
      expect(disposeStartSound).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      queryClient.clear();
      if (originalGetUserMedia) {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", originalGetUserMedia);
      } else {
        Reflect.deleteProperty(navigator.mediaDevices, "getUserMedia");
      }
      if (originalVibrate) {
        Object.defineProperty(navigator, "vibrate", originalVibrate);
      } else {
        Reflect.deleteProperty(navigator, "vibrate");
      }
      if (originalWakeLock) {
        Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      } else {
        Reflect.deleteProperty(navigator, "wakeLock");
      }
    }
  });

  it("routes an iOS microphone tap through a native haptic switch", async () => {
    const pcmAudio = new Blob([new Uint8Array([7, 8, 9])], { type: "audio/wav" });
    const pcmStop = vi.fn(async () => pcmAudio);
    const pcmStart = vi.fn(async () => ({ stop: pcmStop }));
    const onTranscript = vi.fn();

    class MockMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }

      readonly mimeType = "audio/webm;codecs=opus";
      state: "inactive" | "recording" | "paused" = "inactive";

      start(): void {
        this.state = "recording";
      }

      stop(): void {
        this.state = "inactive";
      }
    }

    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    });
    const originalGetUserMedia = Object.getOwnPropertyDescriptor(
      navigator.mediaDevices,
      "getUserMedia",
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: vi.fn(async () => new MediaStream()),
    });
    dictationMocks.prepareStartSound.mockReturnValue({
      play: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    dictationMocks.preparePcmRecorder.mockReturnValue({
      start: pcmStart,
      dispose: vi.fn(),
    });
    dictationMocks.getStatus.mockResolvedValue({
      configured: true,
      state: "ready",
      downloadedBytes: null,
      totalBytes: null,
      message: null,
    });
    dictationMocks.transcribe.mockResolvedValue({ text: "iOS transcript" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ComposerDictationButton
          recordingOwnerKey="ios-dictation-test-owner"
          environmentId={EnvironmentId.make("ios-dictation-test")}
          disabled={false}
          onTranscript={onTranscript}
        />
      </QueryClientProvider>,
    );

    try {
      const hapticSwitch = document.querySelector<HTMLInputElement>(
        '[data-ios-dictation-haptic-switch="true"]',
      );
      expect(hapticSwitch).not.toBeNull();
      expect(hapticSwitch?.getAttribute("switch")).toBe("");

      await page.getByTestId("ios-dictation-haptic-switch").click();
      await vi.waitFor(() => {
        expect(hapticSwitch?.checked).toBe(true);
        expect(pcmStart).toHaveBeenCalledOnce();
      });

      await page.getByRole("button", { name: "Stop and transcribe" }).click();
      await vi.waitFor(() => {
        expect(pcmStop).toHaveBeenCalledOnce();
        expect(dictationMocks.normalize).not.toHaveBeenCalled();
        expect(dictationMocks.transcribe).toHaveBeenCalledWith(
          EnvironmentId.make("ios-dictation-test"),
          pcmAudio,
          { signal: expect.any(AbortSignal) },
        );
        expect(onTranscript).toHaveBeenCalledWith("iOS transcript");
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      if (originalUserAgent) {
        Object.defineProperty(navigator, "userAgent", originalUserAgent);
      } else {
        Reflect.deleteProperty(navigator, "userAgent");
      }
      if (originalGetUserMedia) {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", originalGetUserMedia);
      } else {
        Reflect.deleteProperty(navigator.mediaDevices, "getUserMedia");
      }
    }
  });
});
