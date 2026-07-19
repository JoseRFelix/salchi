import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import {
  extractWhisperTranscriptionText,
  makeLocalTranscription,
  makeManagedLocalTranscription,
  makeWhisperInferenceFormData,
  resolveWhisperAudioContext,
  resolveWhisperInferenceUrl,
} from "./LocalTranscription.ts";
import { ManagedWhisperError, resolveManagedWhisperRuntimeAsset } from "./ManagedWhisper.ts";

function managedWhisperProcess(
  inferenceUrl: URL,
  awaitTermination: Effect.Effect<never, ManagedWhisperError> = Effect.never,
) {
  return { inferenceUrl, awaitTermination };
}

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
                const inferenceUrl = yield* Deferred.await(
                  model === "small.en" ? smallReady : baseReady,
                );
                return managedWhisperProcess(inferenceUrl);
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

  it.effect("does not close an active sidecar while its transcription is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseClosed = yield* Deferred.make<void>();
        const transcriptionStarted = yield* Deferred.make<void>();
        const releaseTranscription = yield* Deferred.make<void>();
        const smallProvisioned = yield* Deferred.make<void>();
        const managed = yield* makeManagedLocalTranscription({
          initialModel: "base.en",
          retryDelays: [],
          provision: (model) =>
            Effect.gen(function* () {
              if (model === "base.en") {
                yield* Effect.addFinalizer(() => Deferred.succeed(baseClosed, undefined));
                return managedWhisperProcess(new URL("http://127.0.0.1:8601/inference"));
              }
              yield* Deferred.succeed(smallProvisioned, undefined);
              return managedWhisperProcess(new URL("http://127.0.0.1:8602/inference"));
            }),
          transcribeAt: (url) =>
            url.port === "8601"
              ? Deferred.succeed(transcriptionStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseTranscription)),
                  Effect.as({ text: url.port }),
                )
              : Effect.succeed({ text: url.port }),
        });

        const inFlight = yield* managed.service
          .transcribe({ audio: new Uint8Array([1]), contentType: "audio/wav" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(transcriptionStarted);
        yield* managed.selectModel("small.en");
        yield* Deferred.await(smallProvisioned);
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(baseClosed)).toBe(false);
        yield* Deferred.succeed(releaseTranscription, undefined);
        expect(yield* Fiber.join(inFlight)).toEqual({ text: "8601" });
        expect(
          yield* managed.service.transcribe({
            audio: new Uint8Array([2]),
            contentType: "audio/wav",
          }),
        ).toEqual({ text: "8602" });
        expect(yield* Deferred.isDone(baseClosed)).toBe(true);
      }),
    ),
  );

  it.effect("keeps the healthy sidecar when a replacement model fails", () =>
    Effect.gen(function* () {
      const baseClosed = yield* Deferred.make<void>();
      const failedCandidateClosed = yield* Deferred.make<void>();
      const smallAttempted = yield* Deferred.make<void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* makeManagedLocalTranscription({
            initialModel: "base.en",
            retryDelays: [],
            provision: (model) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(
                    model === "base.en" ? baseClosed : failedCandidateClosed,
                    undefined,
                  ),
                );
                if (model === "small.en") {
                  yield* Deferred.succeed(smallAttempted, undefined);
                  return yield* new ManagedWhisperError({ detail: "model download failed" });
                }
                return managedWhisperProcess(new URL("http://127.0.0.1:8101/inference"));
              }),
            transcribeAt: (url) => Effect.succeed({ text: url.port }),
          });

          expect(
            yield* managed.service.transcribe({
              audio: new Uint8Array([1]),
              contentType: "audio/wav",
            }),
          ).toEqual({ text: "8101" });
          yield* managed.selectModel("small.en");
          yield* Deferred.await(smallAttempted);

          expect(
            yield* managed.service.transcribe({
              audio: new Uint8Array([2]),
              contentType: "audio/wav",
            }),
          ).toEqual({ text: "8101" });
          expect(yield* managed.service.getStatus).toEqual({
            configured: true,
            state: "error",
            downloadedBytes: null,
            totalBytes: null,
            message: "model download failed",
          });
          expect(yield* Deferred.isDone(failedCandidateClosed)).toBe(true);
          expect(yield* Deferred.isDone(baseClosed)).toBe(false);

          yield* managed.selectModel("base.en");
          expect(yield* managed.service.getStatus).toMatchObject({ state: "ready" });
          expect(
            yield* managed.service.transcribe({
              audio: new Uint8Array([3]),
              contentType: "audio/wav",
            }),
          ).toEqual({ text: "8101" });
        }),
      );

      expect(yield* Deferred.isDone(baseClosed)).toBe(true);
    }),
  );

  it.effect("cancels an obsolete model install and only commits the latest selection", () =>
    Effect.gen(function* () {
      const smallStarted = yield* Deferred.make<void>();
      const smallClosed = yield* Deferred.make<void>();
      const tinyStarted = yield* Deferred.make<void>();
      const tinyReady = yield* Deferred.make<URL>();
      const closedModels: string[] = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* makeManagedLocalTranscription({
            initialModel: "base.en",
            retryDelays: [],
            provision: (model) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closedModels.push(model);
                  }).pipe(
                    Effect.andThen(
                      model === "small.en" ? Deferred.succeed(smallClosed, undefined) : Effect.void,
                    ),
                  ),
                );
                if (model === "small.en") {
                  yield* Deferred.succeed(smallStarted, undefined);
                  return yield* Effect.never;
                }
                if (model === "tiny.en") {
                  yield* Deferred.succeed(tinyStarted, undefined);
                  const inferenceUrl = yield* Deferred.await(tinyReady);
                  return managedWhisperProcess(inferenceUrl);
                }
                return managedWhisperProcess(new URL("http://127.0.0.1:8201/inference"));
              }),
            transcribeAt: (url) => Effect.succeed({ text: url.port }),
          });

          expect(
            yield* managed.service.transcribe({
              audio: new Uint8Array([1]),
              contentType: "audio/wav",
            }),
          ).toEqual({ text: "8201" });
          yield* managed.selectModel("small.en");
          yield* Deferred.await(smallStarted);
          const waitingForSmall = yield* managed.service
            .transcribe({ audio: new Uint8Array([2]), contentType: "audio/wav" })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* managed.selectModel("tiny.en");
          yield* Deferred.await(tinyStarted);
          yield* Deferred.await(smallClosed);

          yield* Deferred.succeed(tinyReady, new URL("http://127.0.0.1:8203/inference"));
          expect(yield* Fiber.join(waitingForSmall)).toEqual({ text: "8203" });
          expect(
            yield* managed.service.transcribe({
              audio: new Uint8Array([2]),
              contentType: "audio/wav",
            }),
          ).toEqual({ text: "8203" });
          expect(yield* managed.service.getStatus).toMatchObject({ state: "ready" });
          expect(closedModels).toEqual(expect.arrayContaining(["base.en", "small.en"]));
          expect(closedModels).not.toContain("tiny.en");
        }),
      );

      expect(closedModels).toContain("tiny.en");
    }),
  );

  it.effect("allows an explicitly retried model after provisioning was exhausted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let provisionCalls = 0;
        const managed = yield* makeManagedLocalTranscription({
          initialModel: "base.en",
          retryDelays: [],
          provision: () =>
            Effect.gen(function* () {
              provisionCalls += 1;
              if (provisionCalls === 1) {
                return yield* new ManagedWhisperError({ detail: "first setup failed" });
              }
              return managedWhisperProcess(new URL("http://127.0.0.1:8502/inference"));
            }),
          transcribeAt: (url) => Effect.succeed({ text: url.port }),
        });

        const first = yield* managed.service
          .transcribe({ audio: new Uint8Array([1]), contentType: "audio/wav" })
          .pipe(Effect.result);
        expect(first._tag).toBe("Failure");
        expect(provisionCalls).toBe(1);

        yield* managed.selectModel("base.en");
        expect(
          yield* managed.service.transcribe({
            audio: new Uint8Array([2]),
            contentType: "audio/wav",
          }),
        ).toEqual({ text: "8502" });
        expect(provisionCalls).toBe(2);
      }),
    ),
  );

  it.effect("restarts a sidecar that exits after becoming ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstTermination = yield* Deferred.make<never, ManagedWhisperError>();
        const recoveryStarted = yield* Deferred.make<void>();
        const recoveryReady = yield* Deferred.make<URL>();
        let provisionCalls = 0;

        const managed = yield* makeManagedLocalTranscription({
          initialModel: "base.en",
          retryDelays: [],
          provision: () =>
            Effect.gen(function* () {
              provisionCalls += 1;
              if (provisionCalls === 1) {
                return managedWhisperProcess(
                  new URL("http://127.0.0.1:8301/inference"),
                  Deferred.await(firstTermination),
                );
              }
              yield* Deferred.succeed(recoveryStarted, undefined);
              return managedWhisperProcess(yield* Deferred.await(recoveryReady));
            }),
          transcribeAt: (url) => Effect.succeed({ text: url.port }),
        });

        expect(
          yield* managed.service.transcribe({
            audio: new Uint8Array([1]),
            contentType: "audio/wav",
          }),
        ).toEqual({ text: "8301" });
        yield* Deferred.fail(
          firstTermination,
          new ManagedWhisperError({ detail: "sidecar crashed" }),
        );
        yield* Deferred.await(recoveryStarted);
        expect(yield* managed.service.getStatus).toMatchObject({
          state: "checking",
          message: "Restarting local dictation…",
        });

        const waiting = yield* managed.service
          .transcribe({ audio: new Uint8Array([2]), contentType: "audio/wav" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(recoveryReady, new URL("http://127.0.0.1:8302/inference"));

        expect(yield* Fiber.join(waiting)).toEqual({ text: "8302" });
        expect(provisionCalls).toBe(2);
        expect(yield* managed.service.getStatus).toMatchObject({ state: "ready" });
      }),
    ),
  );

  it.effect("retries transient provisioning failures with the configured backoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attempts = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ] as const;
        let provisionCalls = 0;
        const managed = yield* makeManagedLocalTranscription({
          initialModel: "base.en",
          retryDelays: ["1 second", "5 seconds"],
          provision: () =>
            Effect.gen(function* () {
              const attempt = provisionCalls;
              provisionCalls += 1;
              yield* Deferred.succeed(attempts[attempt]!, undefined);
              if (attempt < 2) {
                return yield* new ManagedWhisperError({ detail: `failure ${attempt + 1}` });
              }
              return managedWhisperProcess(new URL("http://127.0.0.1:8403/inference"));
            }),
          transcribeAt: (url) => Effect.succeed({ text: url.port }),
        });
        const transcription = yield* managed.service
          .transcribe({ audio: new Uint8Array([1]), contentType: "audio/wav" })
          .pipe(Effect.forkChild);

        yield* Deferred.await(attempts[0]);
        expect(provisionCalls).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(attempts[1]);
        expect(provisionCalls).toBe(2);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(attempts[2]);

        expect(yield* Fiber.join(transcription)).toEqual({ text: "8403" });
        expect(provisionCalls).toBe(3);
        expect(yield* managed.service.getStatus).toMatchObject({ state: "ready" });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts pending model provisioning when the owner scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const scopeClosed = yield* Deferred.make<void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* makeManagedLocalTranscription({
            initialModel: "base.en",
            retryDelays: [],
            provision: () =>
              Effect.addFinalizer(() => Deferred.succeed(scopeClosed, undefined)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
            transcribeAt: () => Effect.succeed({ text: "unused" }),
          });
          yield* Deferred.await(started);
        }),
      );

      yield* Deferred.await(interrupted);
      yield* Deferred.await(scopeClosed);
    }),
  );

  it.effect("does not restart an active sidecar during intentional owner shutdown", () =>
    Effect.gen(function* () {
      let provisionCalls = 0;
      const termination = yield* Deferred.make<never, ManagedWhisperError>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* makeManagedLocalTranscription({
            initialModel: "base.en",
            retryDelays: [],
            provision: () =>
              Effect.gen(function* () {
                provisionCalls += 1;
                yield* Effect.addFinalizer(() =>
                  Deferred.fail(
                    termination,
                    new ManagedWhisperError({ detail: "intentional shutdown" }),
                  ).pipe(Effect.asVoid),
                );
                return managedWhisperProcess(
                  new URL("http://127.0.0.1:8701/inference"),
                  Deferred.await(termination),
                );
              }),
            transcribeAt: (url) => Effect.succeed({ text: url.port }),
          });

          expect(
            yield* managed.service.transcribe({
              audio: new Uint8Array([1]),
              contentType: "audio/wav",
            }),
          ).toEqual({ text: "8701" });
        }),
      );

      expect(provisionCalls).toBe(1);
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
