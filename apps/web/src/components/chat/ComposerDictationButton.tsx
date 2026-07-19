import { TRANSCRIPTION_MAX_RECORDING_MS, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getEnvironmentTranscriptionStatus,
  normalizeDictationAudioToWav,
  selectDictationAudioMimeType,
  transcribeEnvironmentAudio,
} from "../../dictation";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { preserveComposerFocusOnPointerDown } from "./composerFocus";
import { ComposerDictationProcessingIndicator } from "./ComposerDictationProcessingIndicator";
import { ComposerDictationVisualizer } from "./ComposerDictationVisualizer";

type DictationState = "idle" | "requesting" | "recording" | "transcribing";

export function ComposerDictationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onTranscript: (text: string) => void;
  readonly onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedAtRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

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

  const stopRecording = useCallback(() => {
    clearStopTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setState("transcribing");
      recorder.stop();
    }
  }, [clearStopTimer]);

  const startRecording = useCallback(async () => {
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

      streamRef.current = stream;
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

        if (!mountedRef.current) return;
        if (audio.size === 0) {
          setState("idle");
          toastManager.add({ type: "error", title: "The recording was empty" });
          return;
        }

        setState("transcribing");
        void normalizeDictationAudioToWav(audio)
          .then((wav) => transcribeEnvironmentAudio(props.environmentId, wav))
          .then(({ text }) => {
            if (!mountedRef.current) return;
            if (text.trim()) {
              props.onTranscript(text);
            } else {
              toastManager.add({
                type: "info",
                title: "No speech detected",
                description: "Try recording again a little closer to the microphone.",
              });
            }
          })
          .catch((error: unknown) => {
            if (!mountedRef.current) return;
            toastManager.add({
              type: "error",
              title: "Could not transcribe recording",
              description: error instanceof Error ? error.message : "Local transcription failed.",
            });
          })
          .finally(() => {
            if (mountedRef.current) setState("idle");
          });
      });

      recordingStartedAtRef.current = performance.now();
      recorder.start(1_000);
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
    }
  }, [clearStopTimer, props, stopRecording, stopTracks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearStopTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks();
    };
  }, [clearStopTimer, stopTracks]);

  useEffect(() => {
    props.onActiveChange?.(state !== "idle");
  }, [props.onActiveChange, state]);

  if (!browserSupportsRecording || statusQuery.data?.configured === false) {
    return null;
  }

  const recording = state === "recording";
  const requesting = state === "requesting";
  const transcribing = state === "transcribing";
  const busy = requesting;
  const label = recording
    ? "Stop and transcribe"
    : requesting
      ? "Starting microphone"
      : transcribing
        ? "Transcribing"
        : "Dictate";
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
                onClick={stopRecording}
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
    <div className="flex shrink-0 items-center">
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
    </div>
  );
}
