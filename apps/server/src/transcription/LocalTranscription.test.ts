import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  extractWhisperTranscriptionText,
  makeLocalTranscription,
  makeManagedLocalTranscription,
  makeWhisperInferenceFormData,
  resolveWhisperAudioContext,
  resolveWhisperInferenceUrl,
} from "./LocalTranscription.ts";
import { resolveManagedWhisperRuntimeAsset } from "./ManagedWhisper.ts";

function makeMonoPcm16Wav(durationSeconds: number): Uint8Array {
  const sampleCount = Math.round(durationSeconds * 16_000);
  const headerBytes = 44;
  const bytes = new Uint8Array(headerBytes + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

describe("resolveWhisperInferenceUrl", () => {
  it("uses the standard whisper-server inference route for a loopback base URL", () => {
    expect(resolveWhisperInferenceUrl(new URL("http://127.0.0.1:8080"))?.toString()).toBe(
      "http://127.0.0.1:8080/inference",
    );
  });

  it("preserves an explicitly configured request path", () => {
    expect(
      resolveWhisperInferenceUrl(new URL("http://localhost:8080/whisper/inference"))?.toString(),
    ).toBe("http://localhost:8080/whisper/inference");
  });

  it("rejects non-loopback sidecars", () => {
    expect(resolveWhisperInferenceUrl(new URL("https://speech.example.com"))).toBeUndefined();
  });
});

describe("extractWhisperTranscriptionText", () => {
  it("extracts and trims the upstream json response", () => {
    expect(extractWhisperTranscriptionText({ text: "  fix the login flow\n" })).toBe(
      "fix the login flow",
    );
  });

  it("rejects an unexpected upstream response", () => {
    expect(extractWhisperTranscriptionText({ result: "missing text" })).toBeNull();
  });
});

describe("Whisper inference audio context", () => {
  it("sizes the encoder context to short canonical recordings with padding", () => {
    const resolve = (durationSeconds: number) =>
      resolveWhisperAudioContext({
        audio: makeMonoPcm16Wav(durationSeconds),
        contentType: "audio/wav",
      });

    expect(resolve(1.2)).toBe(256);
    expect(resolve(11)).toBe(768);
    expect(resolve(15.5)).toBe(1_024);
    expect(resolve(24)).toBe(1_280);
  });

  it("uses the full default context for long or unrecognized recordings", () => {
    const longRecording = {
      audio: makeMonoPcm16Wav(25),
      contentType: "audio/wav",
    };
    expect(resolveWhisperAudioContext(longRecording)).toBeNull();
    expect(makeWhisperInferenceFormData(longRecording).get("audio_ctx")).toBeNull();
    expect(
      resolveWhisperAudioContext({
        audio: new Uint8Array([1, 2, 3]),
        contentType: "audio/webm",
      }),
    ).toBeNull();
  });

  it("adds the adaptive context to the whisper-server request", () => {
    const formData = makeWhisperInferenceFormData({
      audio: makeMonoPcm16Wav(1.2),
      contentType: "audio/wav",
    });

    expect(formData.get("audio_ctx")).toBe("256");
    expect(formData.get("language")).toBe("en");
    expect(formData.get("response_format")).toBe("json");
  });
});

describe("makeLocalTranscription", () => {
  it.effect("accepts recordings while provisioning and waits before transcribing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<URL>();
        let transcribeCalls = 0;
        const service = yield* makeLocalTranscription<never>({
          initialStatus: {
            configured: true,
            state: "checking",
            downloadedBytes: null,
            totalBytes: null,
            message: null,
          },
          provision: (onStatus) =>
            onStatus({
              configured: true,
              state: "downloading-model",
              downloadedBytes: 25,
              totalBytes: 100,
              message: null,
            }).pipe(Effect.andThen(Deferred.await(ready))),
          transcribeAt: (url) =>
            Effect.sync(() => {
              transcribeCalls += 1;
              return { text: url.pathname };
            }),
        });

        const transcription = yield* service
          .transcribe({ audio: new Uint8Array([1]), contentType: "audio/wav" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const statusWhileWaiting = yield* service.getStatus;
        const callsWhileWaiting = transcribeCalls;

        yield* Deferred.succeed(ready, new URL("http://127.0.0.1:8080/inference"));
        const transcript = yield* Fiber.join(transcription);
        const readyStatus = yield* service.getStatus;

        expect(callsWhileWaiting).toBe(0);
        expect(statusWhileWaiting).toEqual({
          configured: true,
          state: "downloading-model",
          downloadedBytes: 25,
          totalBytes: 100,
          message: null,
        });
        expect(transcript).toEqual({ text: "/inference" });
        expect(readyStatus.state).toBe("ready");
      }),
    ),
  );

  it.effect("interrupts provisioning when its owning scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* makeLocalTranscription<never>({
            initialStatus: {
              configured: true,
              state: "checking",
              downloadedBytes: null,
              totalBytes: null,
              message: null,
            },
            provision: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never as Effect.Effect<URL>),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
            transcribeAt: () => Effect.succeed({ text: "unused" }),
          });
          yield* Deferred.await(started);
        }),
      );

      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("moves to an error state when provisioning dies unexpectedly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeLocalTranscription<never>({
          initialStatus: {
            configured: true,
            state: "starting",
            downloadedBytes: null,
            totalBytes: null,
            message: null,
          },
          provision: () => Effect.die(new Error("simulated installer defect")),
          transcribeAt: () => Effect.succeed({ text: "unused" }),
        });

        const result = yield* service
          .transcribe({ audio: new Uint8Array([1]), contentType: "audio/wav" })
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        expect(yield* service.getStatus).toEqual({
          configured: true,
          state: "error",
          downloadedBytes: null,
          totalBytes: null,
          message: "Unexpected local dictation setup failure.",
        });
      }),
    ),
  );
});

describe("makeManagedLocalTranscription", () => {
  it.effect("queues transcription while switching models and closes the replaced sidecar", () =>
    Effect.gen(function* () {
      const baseStarted = yield* Deferred.make<void>();
      const smallStarted = yield* Deferred.make<void>();
      const baseReady = yield* Deferred.make<URL>();
      const smallReady = yield* Deferred.make<URL>();
      const smallClosed = yield* Deferred.make<void>();
      const events: Array<string> = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* makeManagedLocalTranscription({
            initialModel: "base.en",
            provision: (model, onStatus) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    events.push(`${model}:closed`);
                  }).pipe(
                    Effect.andThen(
                      model === "small.en" ? Deferred.succeed(smallClosed, undefined) : Effect.void,
                    ),
                  ),
                );
                yield* onStatus({
                  configured: true,
                  state: "downloading-model",
                  downloadedBytes: model === "small.en" ? 50 : 100,
                  totalBytes: 100,
                  message: null,
                });
                yield* Deferred.succeed(
                  model === "small.en" ? smallStarted : baseStarted,
                  undefined,
                );
                return yield* Deferred.await(model === "small.en" ? smallReady : baseReady);
              }),
            transcribeAt: (url) =>
              Effect.sync(() => {
                events.push(`transcribe:${url.port}`);
                return { text: url.port };
              }),
          });

          yield* Deferred.await(baseStarted);
          const baseTranscription = yield* managed.service
            .transcribe({ audio: new Uint8Array([1]), contentType: "audio/wav" })
            .pipe(Effect.forkChild);
          yield* Deferred.succeed(baseReady, new URL("http://127.0.0.1:8001/inference"));
          expect(yield* Fiber.join(baseTranscription)).toEqual({ text: "8001" });

          const switching = yield* managed.selectModel("small.en").pipe(Effect.forkChild);
          yield* Deferred.await(smallStarted);
          expect(yield* managed.service.getStatus).toMatchObject({
            state: "downloading-model",
            downloadedBytes: 50,
          });

          const smallTranscription = yield* managed.service
            .transcribe({ audio: new Uint8Array([2]), contentType: "audio/wav" })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(events).toEqual(["transcribe:8001"]);

          yield* Deferred.succeed(smallReady, new URL("http://127.0.0.1:8002/inference"));
          yield* Fiber.join(switching);
          expect(yield* Fiber.join(smallTranscription)).toEqual({ text: "8002" });
          expect(events).toEqual(["transcribe:8001", "base.en:closed", "transcribe:8002"]);
        }),
      );

      yield* Deferred.await(smallClosed);
      expect(events.at(-1)).toBe("small.en:closed");
    }),
  );
});

describe("resolveManagedWhisperRuntimeAsset", () => {
  it("selects pinned official Linux artifacts", () => {
    expect(resolveManagedWhisperRuntimeAsset("linux", "x64")).toMatchObject({
      bytes: 9_379_235,
      sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
    });
    expect(resolveManagedWhisperRuntimeAsset("linux", "arm64")).toMatchObject({
      bytes: 4_555_819,
      sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
    });
  });

  it("rejects platforms without an official managed artifact", () => {
    expect(resolveManagedWhisperRuntimeAsset("darwin", "arm64")).toBeNull();
  });
});
