import { EnvironmentId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  toastManager.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ComposerDictationButton", () => {
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
