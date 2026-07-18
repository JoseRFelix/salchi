import { useEffect, useRef, useState } from "react";

import { calculateDictationAudioLevel, formatDictationRecordingDuration } from "../../dictation";

const SAMPLE_INTERVAL_MS = 45;
const BAR_WIDTH_PX = 2;
const BAR_GAP_PX = 3;
const MIN_BAR_HEIGHT_PX = 2;

export function ComposerDictationVisualizer(props: {
  readonly stream: MediaStream;
  readonly startedAtMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const updateElapsedTime = () => {
      const nextElapsedSeconds = Math.max(
        0,
        Math.floor((performance.now() - props.startedAtMs) / 1_000),
      );
      setElapsedSeconds((current) =>
        current === nextElapsedSeconds ? current : nextElapsedSeconds,
      );
    };

    updateElapsedTime();
    const timer = window.setInterval(updateElapsedTime, 250);
    return () => window.clearInterval(timer);
  }, [props.startedAtMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drawingContext = canvas.getContext("2d");
    if (!drawingContext) return;

    let audioContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let lastSampleTime = 0;
    let history: number[] = [];
    let barColor = getComputedStyle(canvas).color;

    const resizeCanvas = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      barColor = getComputedStyle(canvas).color;
    };

    try {
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(props.stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
    } catch {
      void audioContext?.close().catch(() => undefined);
      return;
    }

    const samples = new Uint8Array(analyser.fftSize);
    const draw = (timestamp: number) => {
      if (!analyser) return;

      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const barCount = Math.max(12, Math.floor(width / (BAR_WIDTH_PX + BAR_GAP_PX)));

      if (history.length !== barCount) {
        history =
          history.length > barCount
            ? history.slice(history.length - barCount)
            : [...Array<number>(barCount - history.length).fill(0), ...history];
      }

      if (timestamp - lastSampleTime >= SAMPLE_INTERVAL_MS) {
        analyser.getByteTimeDomainData(samples);
        const rawLevel = calculateDictationAudioLevel(samples);
        const visibleLevel = rawLevel < 0.015 ? 0 : Math.min(1, rawLevel * 4.5);
        history.shift();
        history.push(visibleLevel);
        lastSampleTime = timestamp;
      }

      drawingContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawingContext.clearRect(0, 0, width, height);
      drawingContext.fillStyle = barColor;

      for (let index = 0; index < history.length; index += 1) {
        const level = history[index] ?? 0;
        const barHeight = Math.max(MIN_BAR_HEIGHT_PX, level * (height - 2));
        const x = index * (BAR_WIDTH_PX + BAR_GAP_PX);
        drawingContext.fillRect(x, (height - barHeight) / 2, BAR_WIDTH_PX, barHeight);
      }

      animationFrame = window.requestAnimationFrame(draw);
    };

    resizeCanvas();
    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
    animationFrame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      source?.disconnect();
      analyser?.disconnect();
      void audioContext?.close().catch(() => undefined);
    };
  }, [props.stream]);

  const duration = formatDictationRecordingDuration(elapsedSeconds * 1_000);

  return (
    <div
      data-chat-composer-dictation-waveform="true"
      className="flex h-8 min-w-0 flex-1 items-center gap-2"
      aria-label={`Recording audio, ${duration}`}
    >
      <div className="relative h-6 min-w-12 flex-1 overflow-hidden">
        <div
          className="border-muted-foreground/35 absolute inset-x-0 top-1/2 border-t border-dashed"
          aria-hidden="true"
        />
        <canvas
          ref={canvasRef}
          className="text-foreground/85 relative block size-full"
          aria-hidden="true"
        />
      </div>
      <span className="text-muted-foreground w-10 shrink-0 text-right text-sm tabular-nums">
        {duration}
      </span>
    </div>
  );
}
