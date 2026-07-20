import { TRANSCRIPTION_MAX_RECORDING_MS, type EnvironmentId } from "@salchi/contracts";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircleIcon, MicIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DictationCaptureInterruption,
  type DictationPcmRecorder,
  type PreparedDictationPcmRecorder,
  type PreparedDictationStartSound,
  getEnvironmentTranscriptionStatus,
  localTranscriptionStatusQueryKey,
  localTranscriptionStatusRefetchInterval,
  normalizeDictationAudioToWav,
  normalizeDictationTranscript,
  prepareDictationPcmRecorder,
  prepareDictationStartSound,
  selectDictationAudioMimeType,
  transcribeEnvironmentAudio,
  triggerDictationStartVibration,
} from "../../dictation";
import { isIosWebkit } from "../../env";
import { useScreenWakeLock } from "../../hooks/useScreenWakeLock";
import {
  createRetainedDictationRecordingId,
  discardRetainedDictationRecording,
  loadRetainedDictationRecording,
  type RetainedDictationRecording,
  retainDictationRecording,
  subscribeRetainedDictationRecording,
} from "../../retainedDictationRecordingStore";
import { useSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { preserveComposerFocusOnPointerDown } from "./composerFocus";
import { ComposerDictationProcessingIndicator } from "./ComposerDictationProcessingIndicator";
import { ComposerDictationVisualizer } from "./ComposerDictationVisualizer";

type DictationState = "idle" | "requesting" | "recording" | "transcribing" | "retry";
type RetentionMode = "memory-only" | "persistent";

const IOS_HAPTIC_SWITCH_ATTRIBUTE = { switch: "" } as const;
export const DICTATION_TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1_000;

interface DictationSubmission {
  readonly controller: AbortController;
  readonly timeoutId: ReturnType<typeof globalThis.setTimeout>;
}

interface CapturedRecordingOptions {
  readonly transcribe: boolean;
  readonly interruptionDescription?: string;
}

interface StopRecordingOptions {
  readonly retainOnly?: boolean;
  readonly interruptionDescription?: string;
}

function interruptionDescription(reason: DictationCaptureInterruption): string {
  switch (reason) {
    case "track-ended":
    case "stream-inactive":
      return "The microphone disconnected. Your partial recording was saved.";
    case "audio-context-closed":
    case "audio-context-interrupted":
    case "audio-context-suspended":
      return "Audio capture was interrupted. Your partial recording was saved.";
  }
}

export function ComposerDictationButton(props: {
  readonly recordingOwnerKey: string;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onTranscript: (text: string) => void;
  readonly onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const transcriptionModel = useSettings((settings) => settings.transcriptionModel);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pcmRecorderRef = useRef<DictationPcmRecorder | null>(null);
  const preparedPcmRecorderRef = useRef<PreparedDictationPcmRecorder | null>(null);
  const preparedStartSoundRef = useRef<PreparedDictationStartSound | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedAtRef = useRef(0);
  const stopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(props.onTranscript);
  const onActiveChangeRef = useRef(props.onActiveChange);
  const startAttemptRef = useRef<symbol | null>(null);
  const retainedRecordingRef = useRef<RetainedDictationRecording | null>(null);
  const submissionRef = useRef<DictationSubmission | null>(null);
  const retryToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const [retentionMode, setRetentionMode] = useState<RetentionMode | null>(null);
  const [retainedRecordingLoaded, setRetainedRecordingLoaded] = useState(false);

  onTranscriptRef.current = props.onTranscript;
  onActiveChangeRef.current = props.onActiveChange;

  useScreenWakeLock(state === "recording" || state === "transcribing");

  const browserSupportsRecording =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined";

  const statusQuery = useQuery({
    queryKey: localTranscriptionStatusQueryKey(props.environmentId, transcriptionModel),
    queryFn: () => getEnvironmentTranscriptionStatus(props.environmentId),
    enabled: browserSupportsRecording,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      localTranscriptionStatusRefetchInterval({
        transcribing: state === "transcribing",
        status: query.state.data,
      }),
  });

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const stopTracks = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
  }, []);

  const stopStream = useCallback((stream: MediaStream) => {
    for (const track of stream.getTracks()) track.stop();
    if (streamRef.current === stream) streamRef.current = null;
  }, []);

  const closeRetryToast = useCallback(() => {
    if (retryToastIdRef.current === null) return;
    toastManager.close(retryToastIdRef.current);
    retryToastIdRef.current = null;
  }, []);

  const abortSubmission = useCallback((reason: DOMException) => {
    const submission = submissionRef.current;
    if (!submission) return;
    submissionRef.current = null;
    globalThis.clearTimeout(submission.timeoutId);
    submission.controller.abort(reason);
  }, []);

  const persistRecording = useCallback(async (recording: RetainedDictationRecording) => {
    try {
      const persisted = await retainDictationRecording(recording);
      if (mountedRef.current && retainedRecordingRef.current?.id === recording.id) {
        setRetentionMode(persisted ? "persistent" : "memory-only");
      }
      return persisted;
    } catch {
      if (mountedRef.current && retainedRecordingRef.current?.id === recording.id) {
        setRetentionMode("memory-only");
      }
      return false;
    }
  }, []);

  const transcribeRecording = useCallback(
    async function transcribeRecording(recording: RetainedDictationRecording): Promise<void> {
      if (submissionRef.current !== null) return;

      const controller = new AbortController();
      const timeoutId = globalThis.setTimeout(() => {
        controller.abort(
          new DOMException(
            "Transcription timed out. The recording is still available to resend.",
            "TimeoutError",
          ),
        );
      }, DICTATION_TRANSCRIPTION_TIMEOUT_MS);
      const submission: DictationSubmission = {
        controller,
        timeoutId,
      };
      submissionRef.current = submission;
      retainedRecordingRef.current = recording;
      closeRetryToast();
      if (mountedRef.current) setState("transcribing");

      let text: string;
      let retainedRecording = recording;
      try {
        const normalizedAudio =
          recording.normalizedAudio ?? (await normalizeDictationAudioToWav(recording.audio));
        if (controller.signal.aborted) throw controller.signal.reason;
        if (recording.normalizedAudio === null) {
          retainedRecording = { ...recording, normalizedAudio };
          retainedRecordingRef.current = retainedRecording;
          await persistRecording(retainedRecording);
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        ({ text } = await transcribeEnvironmentAudio(recording.environmentId, normalizedAudio, {
          signal: controller.signal,
        }));
      } catch (error: unknown) {
        if (!mountedRef.current) return;

        retainedRecordingRef.current = retainedRecording;
        setState("retry");
        let toastId!: ReturnType<typeof toastManager.add>;
        const failure =
          controller.signal.aborted && controller.signal.reason instanceof Error
            ? controller.signal.reason
            : error;
        toastId = toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not transcribe recording",
            description: failure instanceof Error ? failure.message : "Local transcription failed.",
            timeout: 0,
            actionVariant: "outline",
            actionProps: {
              children: "Resend",
              onClick: () => {
                const retained = retainedRecordingRef.current;
                if (!retained || retained.id !== retainedRecording.id) return;
                closeRetryToast();
                void transcribeRecording(retained);
              },
            },
          }),
        );
        retryToastIdRef.current = toastId;
        return;
      } finally {
        globalThis.clearTimeout(timeoutId);
        if (submissionRef.current === submission) submissionRef.current = null;
      }

      if (!mountedRef.current || controller.signal.aborted) return;
      if (retainedRecordingRef.current?.id === retainedRecording.id) {
        retainedRecordingRef.current = null;
      }
      setRetentionMode(null);
      void discardRetainedDictationRecording(props.recordingOwnerKey, retainedRecording.id);
      setState("idle");
      const transcript = normalizeDictationTranscript(text);
      if (transcript) {
        onTranscriptRef.current(transcript);
      } else {
        toastManager.add({
          type: "info",
          title: "No speech detected",
          description: "Try recording again a little closer to the microphone.",
        });
      }
    },
    [closeRetryToast, persistRecording, props.recordingOwnerKey],
  );

  const retryRecording = useCallback(() => {
    const recording = retainedRecordingRef.current;
    if (recording) void transcribeRecording(recording);
  }, [transcribeRecording]);

  const discardRecording = useCallback(() => {
    if (submissionRef.current !== null) return;
    const recording = retainedRecordingRef.current;
    retainedRecordingRef.current = null;
    setRetentionMode(null);
    closeRetryToast();
    setState("idle");
    if (recording) {
      void discardRetainedDictationRecording(props.recordingOwnerKey, recording.id);
    }
  }, [closeRetryToast, props.recordingOwnerKey]);

  const acceptCapturedRecording = useCallback(
    async (
      audio: Blob,
      normalizedAudio: Blob | null,
      options: CapturedRecordingOptions,
    ): Promise<void> => {
      if (audio.size === 0) {
        if (mountedRef.current) {
          setState("idle");
          toastManager.add({ type: "error", title: "The recording was empty" });
        }
        return;
      }

      const recording: RetainedDictationRecording = {
        id: createRetainedDictationRecordingId(),
        ownerKey: props.recordingOwnerKey,
        audio,
        environmentId: props.environmentId,
        normalizedAudio,
        createdAt: Date.now(),
      };
      retainedRecordingRef.current = recording;
      const persisted = await persistRecording(recording);
      if (!mountedRef.current || retainedRecordingRef.current?.id !== recording.id) return;

      if (!options.transcribe) {
        setState("retry");
        let toastId!: ReturnType<typeof toastManager.add>;
        toastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Recording stopped",
            description:
              options.interruptionDescription ??
              (persisted
                ? "Your partial recording was saved."
                : "Your partial recording is available until this page closes."),
            timeout: 0,
            actionVariant: "outline",
            actionProps: {
              children: "Resend",
              onClick: () => {
                const retained = retainedRecordingRef.current;
                if (!retained || retained.id !== recording.id) return;
                closeRetryToast();
                void transcribeRecording(retained);
              },
            },
          }),
        );
        retryToastIdRef.current = toastId;
        return;
      }
      await transcribeRecording(recording);
    },
    [
      closeRetryToast,
      persistRecording,
      props.environmentId,
      props.recordingOwnerKey,
      transcribeRecording,
    ],
  );

  const stopRecording = useCallback(
    (options?: StopRecordingOptions) => {
      clearStopTimer();
      const pcmRecorder = pcmRecorderRef.current;
      if (pcmRecorder) {
        pcmRecorderRef.current = null;
        if (mountedRef.current) setState("transcribing");
        const audioPromise = pcmRecorder.stop();
        stopTracks();
        void audioPromise
          .then((audio) =>
            acceptCapturedRecording(audio, audio, {
              transcribe: options?.retainOnly !== true,
              ...(options?.interruptionDescription
                ? { interruptionDescription: options.interruptionDescription }
                : {}),
            }),
          )
          .catch((error: unknown) => {
            if (!mountedRef.current) return;
            setState("idle");
            toastManager.add({
              type: "error",
              title: "Microphone recording failed",
              description: error instanceof Error ? error.message : "Audio capture failed.",
            });
          });
        return;
      }

      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        if (mountedRef.current) setState("transcribing");
        recorder.stop();
      }
    },
    [acceptCapturedRecording, clearStopTimer, stopTracks],
  );

  const startRecording = useCallback(async () => {
    if (
      !retainedRecordingLoaded ||
      startAttemptRef.current !== null ||
      retainedRecordingRef.current !== null
    ) {
      return;
    }
    const attempt = Symbol("dictation-start");
    startAttemptRef.current = attempt;
    const usePcmCapture = isIosWebkit();
    let startSound: PreparedDictationStartSound | null = null;
    let preparedPcmRecorder: PreparedDictationPcmRecorder | null = null;
    setState("requesting");
    try {
      startSound = prepareDictationStartSound();
      preparedStartSoundRef.current = startSound;
      preparedPcmRecorder = usePcmCapture ? prepareDictationPcmRecorder() : null;
      preparedPcmRecorderRef.current = preparedPcmRecorder;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mountedRef.current || startAttemptRef.current !== attempt) {
        stopStream(stream);
        return;
      }

      triggerDictationStartVibration();
      await startSound.play();
      if (!mountedRef.current || startAttemptRef.current !== attempt) {
        stopStream(stream);
        return;
      }

      streamRef.current = stream;
      if (preparedPcmRecorder) {
        const pcmRecorder = await preparedPcmRecorder.start(stream, {
          onInterrupted: (reason) => {
            if (!mountedRef.current || pcmRecorderRef.current === null) return;
            stopRecording({
              retainOnly: true,
              interruptionDescription: interruptionDescription(reason),
            });
          },
        });
        if (!mountedRef.current || startAttemptRef.current !== attempt) {
          const stopPromise = pcmRecorder.stop().catch(() => undefined);
          stopStream(stream);
          void stopPromise;
          return;
        }
        pcmRecorderRef.current = pcmRecorder;
        recordingStartedAtRef.current = performance.now();
        setState("recording");
        stopTimerRef.current = window.setTimeout(stopRecording, TRANSCRIPTION_MAX_RECORDING_MS);
        return;
      }

      const chunks: Blob[] = [];
      const mimeType = selectDictationAudioMimeType((candidate) =>
        typeof MediaRecorder.isTypeSupported === "function"
          ? MediaRecorder.isTypeSupported(candidate)
          : false,
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      const tracks = stream.getTracks();
      let interruptedStopOptions: StopRecordingOptions | undefined;
      const stopInterruptedRecording = (description: string) => {
        interruptedStopOptions ??= {
          retainOnly: true,
          interruptionDescription: description,
        };
        clearStopTimer();
        if (mountedRef.current) setState("transcribing");
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // A concurrent browser-driven stop will still deliver the stop event.
          }
        }
        stopStream(stream);
      };
      const handleStreamInactive = () => {
        stopInterruptedRecording("The microphone disconnected. Your partial recording was saved.");
      };
      const handleTrackEnded = () => {
        stopInterruptedRecording("The microphone disconnected. Your partial recording was saved.");
      };
      const removeCaptureInterruptionListeners = () => {
        stream.removeEventListener("inactive", handleStreamInactive);
        for (const track of tracks) track.removeEventListener("ended", handleTrackEnded);
      };

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        stopInterruptedRecording("Audio capture failed. Your partial recording was saved.");
      });
      recorder.addEventListener("stop", () => {
        removeCaptureInterruptionListeners();
        clearStopTimer();
        stopTracks();
        if (recorderRef.current === recorder) recorderRef.current = null;
        const audio = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        chunks.length = 0;
        void acceptCapturedRecording(audio, null, {
          transcribe: mountedRef.current && interruptedStopOptions?.retainOnly !== true,
          ...(interruptedStopOptions?.interruptionDescription
            ? { interruptionDescription: interruptedStopOptions.interruptionDescription }
            : {}),
        });
      });
      stream.addEventListener("inactive", handleStreamInactive);
      for (const track of tracks) track.addEventListener("ended", handleTrackEnded);

      recordingStartedAtRef.current = performance.now();
      try {
        if (usePcmCapture) {
          recorder.start();
        } else {
          recorder.start(1_000);
        }
      } catch (error) {
        removeCaptureInterruptionListeners();
        if (recorderRef.current === recorder) recorderRef.current = null;
        throw error;
      }
      setState("recording");
      stopTimerRef.current = window.setTimeout(stopRecording, TRANSCRIPTION_MAX_RECORDING_MS);
      if (tracks.length > 0 && stream.active === false) handleStreamInactive();
      for (const track of tracks) {
        if (track.readyState === "ended") handleTrackEnded();
      }
    } catch (error) {
      stopTracks();
      if (!mountedRef.current) return;
      setState("idle");
      toastManager.add({
        type: "error",
        title: "Microphone access failed",
        description:
          error instanceof Error
            ? error.message
            : "Allow microphone access in your browser settings and try again.",
      });
    } finally {
      if (preparedStartSoundRef.current === startSound) {
        startSound?.dispose();
        preparedStartSoundRef.current = null;
      }
      if (preparedPcmRecorderRef.current === preparedPcmRecorder) {
        preparedPcmRecorder?.dispose();
        preparedPcmRecorderRef.current = null;
      }
      if (startAttemptRef.current === attempt) startAttemptRef.current = null;
    }
  }, [
    acceptCapturedRecording,
    clearStopTimer,
    retainedRecordingLoaded,
    stopRecording,
    stopStream,
    stopTracks,
  ]);

  useEffect(() => {
    let disposed = false;
    const restore = (recording: RetainedDictationRecording | null) => {
      if (disposed || !mountedRef.current || !recording) return;
      if (retainedRecordingRef.current?.id === recording.id || submissionRef.current !== null)
        return;
      if (
        startAttemptRef.current !== null ||
        recorderRef.current !== null ||
        pcmRecorderRef.current !== null ||
        streamRef.current !== null
      ) {
        return;
      }
      retainedRecordingRef.current = recording;
      setRetentionMode("persistent");
      setState("retry");
    };
    const unsubscribe = subscribeRetainedDictationRecording(props.recordingOwnerKey, restore);
    void loadRetainedDictationRecording(props.recordingOwnerKey)
      .then(restore)
      .finally(() => {
        if (!disposed && mountedRef.current) setRetainedRecordingLoaded(true);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [props.recordingOwnerKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startAttemptRef.current = null;
      clearStopTimer();
      closeRetryToast();
      abortSubmission(new DOMException("Dictation session closed.", "AbortError"));
      preparedStartSoundRef.current?.dispose();
      preparedStartSoundRef.current = null;
      preparedPcmRecorderRef.current?.dispose();
      preparedPcmRecorderRef.current = null;
      const pcmRecorder = pcmRecorderRef.current;
      pcmRecorderRef.current = null;
      if (pcmRecorder) {
        const audioPromise = pcmRecorder.stop();
        stopTracks();
        void audioPromise
          .then((audio) => acceptCapturedRecording(audio, audio, { transcribe: false }))
          .catch(() => undefined);
        onActiveChangeRef.current?.(false);
        return;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks();
      onActiveChangeRef.current?.(false);
    };
  }, [abortSubmission, acceptCapturedRecording, clearStopTimer, closeRetryToast, stopTracks]);

  useEffect(() => {
    props.onActiveChange?.(state !== "idle");
  }, [props.onActiveChange, state]);

  if (!browserSupportsRecording || (statusQuery.data?.configured === false && state === "idle")) {
    return null;
  }

  const recording = state === "recording";
  const requesting = state === "requesting";
  const transcribing = state === "transcribing";
  const retry = state === "retry";
  const restoringRecording = !retainedRecordingLoaded;
  const busy = requesting || restoringRecording;
  const retainedRecordingLabel =
    retentionMode === "memory-only" ? "Recording kept temporarily" : "Recording saved";
  const label = recording
    ? "Stop and transcribe"
    : restoringRecording
      ? "Checking saved recording"
      : requesting
        ? "Starting microphone"
        : transcribing
          ? "Transcribing"
          : retry
            ? retainedRecordingLabel
            : "Dictate";
  if (retry) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 text-xs"
          data-chat-composer-dictation-retry="true"
          role="status"
        >
          <MicIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{retainedRecordingLabel}</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Discard recording"
                className="size-8 shrink-0 rounded-full sm:size-8"
                onPointerDown={preserveComposerFocusOnPointerDown}
                onClick={discardRecording}
              />
            }
          >
            <XIcon className="size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">Discard recording</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                aria-label="Resend recording"
                className="size-8 shrink-0 rounded-full sm:size-8"
                onPointerDown={preserveComposerFocusOnPointerDown}
                onClick={retryRecording}
              />
            }
          >
            <RotateCcwIcon className="size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">Resend recording</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  if ((recording && streamRef.current) || transcribing) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {recording && streamRef.current ? (
          <ComposerDictationVisualizer
            stream={streamRef.current}
            startedAtMs={recordingStartedAtRef.current}
          />
        ) : (
          <ComposerDictationProcessingIndicator status={statusQuery.data} />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                aria-label={label}
                aria-pressed={recording}
                disabled={transcribing}
                className="size-8 shrink-0 rounded-full sm:size-8"
                onPointerDown={preserveComposerFocusOnPointerDown}
                onClick={() => stopRecording()}
              />
            }
          >
            {transcribing ? (
              <Spinner
                data-chat-composer-dictation-spinner="true"
                className="size-4"
                aria-hidden="true"
              />
            ) : (
              <SquareIcon className="size-3 fill-current" aria-hidden="true" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="relative flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy || (!recording && props.disabled)}
              aria-label={label}
              aria-pressed={recording}
              className="size-8 sm:size-8"
              onPointerDown={preserveComposerFocusOnPointerDown}
              onClick={recording ? () => stopRecording() : () => void startRecording()}
            />
          }
        >
          {recording ? (
            <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
          ) : busy ? (
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <MicIcon className="size-4" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {isIosWebkit() ? (
        <input
          {...IOS_HAPTIC_SWITCH_ATTRIBUTE}
          type="checkbox"
          aria-hidden="true"
          tabIndex={-1}
          disabled={busy || props.disabled}
          data-ios-dictation-haptic-switch="true"
          data-testid="ios-dictation-haptic-switch"
          className="absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:pointer-events-none"
          onPointerDown={preserveComposerFocusOnPointerDown}
          onChange={() => void startRecording()}
        />
      ) : null}
    </div>
  );
}
