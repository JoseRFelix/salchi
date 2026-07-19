import { TRANSCRIPTION_MAX_RECORDING_MS, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircleIcon, MicIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DictationPcmRecorder,
  getEnvironmentTranscriptionStatus,
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
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { preserveComposerFocusOnPointerDown } from "./composerFocus";
import { ComposerDictationProcessingIndicator } from "./ComposerDictationProcessingIndicator";
import { ComposerDictationVisualizer } from "./ComposerDictationVisualizer";

type DictationState = "idle" | "requesting" | "recording" | "transcribing" | "retry";

const IOS_HAPTIC_SWITCH_ATTRIBUTE = { switch: "" } as const;

interface RetainedRecording {
  readonly audio: Blob;
  readonly environmentId: EnvironmentId;
  normalizedAudio: Blob | null;
}

export function ComposerDictationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onTranscript: (text: string) => void;
  readonly onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pcmRecorderRef = useRef<DictationPcmRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedAtRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const retainedRecordingRef = useRef<RetainedRecording | null>(null);
  const submissionRef = useRef<RetainedRecording | null>(null);
  const retryToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useScreenWakeLock(state === "recording" || state === "transcribing");

  const browserSupportsRecording =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined";

  const statusQuery = useQuery({
    queryKey: ["local-transcription-status", props.environmentId],
    queryFn: () => getEnvironmentTranscriptionStatus(props.environmentId),
    enabled: browserSupportsRecording,
    retry: false,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const status = query.state.data;
      return status?.state === "ready" ||
        status?.state === "error" ||
        status?.state === "unavailable"
        ? false
        : 750;
    },
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

  const closeRetryToast = useCallback(() => {
    if (retryToastIdRef.current === null) return;
    toastManager.close(retryToastIdRef.current);
    retryToastIdRef.current = null;
  }, []);

  const transcribeRecording = useCallback(
    async function transcribeRecording(recording: RetainedRecording): Promise<void> {
      if (submissionRef.current !== null) return;

      submissionRef.current = recording;
      retainedRecordingRef.current = recording;
      closeRetryToast();
      if (mountedRef.current) setState("transcribing");

      let text: string;
      try {
        const normalizedAudio =
          recording.normalizedAudio ?? (await normalizeDictationAudioToWav(recording.audio));
        recording.normalizedAudio = normalizedAudio;
        ({ text } = await transcribeEnvironmentAudio(recording.environmentId, normalizedAudio));
      } catch (error: unknown) {
        if (!mountedRef.current) return;

        retainedRecordingRef.current = recording;
        setState("retry");
        let toastId!: ReturnType<typeof toastManager.add>;
        toastId = toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not transcribe recording",
            description: error instanceof Error ? error.message : "Local transcription failed.",
            timeout: 0,
            actionVariant: "outline",
            actionProps: {
              children: "Resend",
              onClick: () => {
                if (retainedRecordingRef.current !== recording) return;
                closeRetryToast();
                void transcribeRecording(recording);
              },
            },
          }),
        );
        retryToastIdRef.current = toastId;
        return;
      } finally {
        if (submissionRef.current === recording) submissionRef.current = null;
      }

      if (!mountedRef.current) return;
      if (retainedRecordingRef.current === recording) retainedRecordingRef.current = null;
      setState("idle");
      const transcript = normalizeDictationTranscript(text);
      if (transcript) {
        props.onTranscript(transcript);
      } else {
        toastManager.add({
          type: "info",
          title: "No speech detected",
          description: "Try recording again a little closer to the microphone.",
        });
      }
    },
    [closeRetryToast, props.onTranscript],
  );

  const retryRecording = useCallback(() => {
    const recording = retainedRecordingRef.current;
    if (recording) void transcribeRecording(recording);
  }, [transcribeRecording]);

  const discardRecording = useCallback(() => {
    if (submissionRef.current !== null) return;
    retainedRecordingRef.current = null;
    closeRetryToast();
    setState("idle");
  }, [closeRetryToast]);

  const acceptCapturedRecording = useCallback(
    (audio: Blob, normalizedAudio: Blob | null) => {
      if (!mountedRef.current) return;
      if (audio.size === 0) {
        setState("idle");
        toastManager.add({ type: "error", title: "The recording was empty" });
        return;
      }

      const recording: RetainedRecording = {
        audio,
        environmentId: props.environmentId,
        normalizedAudio,
      };
      retainedRecordingRef.current = recording;
      void transcribeRecording(recording);
    },
    [props.environmentId, transcribeRecording],
  );

  const stopRecording = useCallback(() => {
    clearStopTimer();
    const pcmRecorder = pcmRecorderRef.current;
    if (pcmRecorder) {
      pcmRecorderRef.current = null;
      setState("transcribing");
      void pcmRecorder
        .stop()
        .then((audio) => acceptCapturedRecording(audio, audio))
        .catch((error: unknown) => {
          if (!mountedRef.current) return;
          setState("idle");
          toastManager.add({
            type: "error",
            title: "Microphone recording failed",
            description: error instanceof Error ? error.message : "Audio capture failed.",
          });
        })
        .finally(stopTracks);
      return;
    }

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, [acceptCapturedRecording, clearStopTimer, stopTracks]);

  const startRecording = useCallback(async () => {
    const usePcmCapture = isIosWebkit();
    const startSound = prepareDictationStartSound();
    const preparedPcmRecorder = usePcmCapture ? prepareDictationPcmRecorder() : null;
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      triggerDictationStartVibration();
      await startSound.play();
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      streamRef.current = stream;
      if (preparedPcmRecorder) {
        const pcmRecorder = await preparedPcmRecorder.start(stream);
        if (!mountedRef.current) {
          void pcmRecorder
            .stop()
            .catch(() => undefined)
            .finally(stopTracks);
          return;
        }
        pcmRecorderRef.current = pcmRecorder;
        recordingStartedAtRef.current = performance.now();
        setState("recording");
        stopTimerRef.current = window.setTimeout(stopRecording, TRANSCRIPTION_MAX_RECORDING_MS);
        return;
      }

      chunksRef.current = [];
      const mimeType = selectDictationAudioMimeType((candidate) =>
        typeof MediaRecorder.isTypeSupported === "function"
          ? MediaRecorder.isTypeSupported(candidate)
          : false,
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      let recordingFailed = false;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("error", () => {
        recordingFailed = true;
        clearStopTimer();
        stopTracks();
        recorderRef.current = null;
        if (mountedRef.current) {
          setState("idle");
          toastManager.add({
            type: "error",
            title: "Microphone recording failed",
          });
        }
      });
      recorder.addEventListener("stop", () => {
        clearStopTimer();
        stopTracks();
        recorderRef.current = null;
        if (recordingFailed) {
          chunksRef.current = [];
          return;
        }
        const audio = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        chunksRef.current = [];
        acceptCapturedRecording(audio, null);
      });

      recordingStartedAtRef.current = performance.now();
      if (usePcmCapture) {
        recorder.start();
      } else {
        recorder.start(1_000);
      }
      setState("recording");
      stopTimerRef.current = window.setTimeout(stopRecording, TRANSCRIPTION_MAX_RECORDING_MS);
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
      startSound.dispose();
      preparedPcmRecorder?.dispose();
    }
  }, [acceptCapturedRecording, clearStopTimer, stopRecording, stopTracks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearStopTimer();
      closeRetryToast();
      const pcmRecorder = pcmRecorderRef.current;
      pcmRecorderRef.current = null;
      if (pcmRecorder) {
        void pcmRecorder.stop().finally(stopTracks);
        return;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks();
    };
  }, [clearStopTimer, closeRetryToast, stopTracks]);

  useEffect(() => {
    props.onActiveChange?.(state !== "idle");
  }, [props.onActiveChange, state]);

  if (!browserSupportsRecording || statusQuery.data?.configured === false) {
    return null;
  }

  const recording = state === "recording";
  const requesting = state === "requesting";
  const transcribing = state === "transcribing";
  const retry = state === "retry";
  const busy = requesting;
  const label = recording
    ? "Stop and transcribe"
    : requesting
      ? "Starting microphone"
      : transcribing
        ? "Transcribing"
        : retry
          ? "Recording saved"
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
          <span className="truncate">Recording saved</span>
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
  if (recording && streamRef.current) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ComposerDictationVisualizer
          stream={streamRef.current}
          startedAtMs={recordingStartedAtRef.current}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                aria-label={label}
                aria-pressed="true"
                className="shrink-0 rounded-full"
                onPointerDown={preserveComposerFocusOnPointerDown}
                onClick={stopRecording}
              />
            }
          >
            <SquareIcon className="size-3 fill-current" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  if (transcribing) {
    return <ComposerDictationProcessingIndicator status={statusQuery.data} />;
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
              onPointerDown={preserveComposerFocusOnPointerDown}
              onClick={recording ? stopRecording : () => void startRecording()}
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
