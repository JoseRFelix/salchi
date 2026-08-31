import { useEffect, useState } from "react";

import { cn } from "../lib/utils";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import {
  type ConnectionIndicatorTone,
  type ConnectionIndicatorView,
  deriveConnectionIndicator,
} from "./ConnectionStatusIndicator.logic";
import { Spinner } from "./ui/spinner";

/**
 * Re-renders once per second while a timed reconnect is pending so the
 * countdown in the detail line stays live. Idle otherwise.
 */
export function useConnectionIndicatorView(): ConnectionIndicatorView {
  const status = useWsConnectionStatus();
  const ticking = status.reconnectPhase === "waiting" && status.nextRetryAt !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [ticking]);

  return deriveConnectionIndicator(status, nowMs);
}

export function ConnectionStatusGlyph({
  tone,
  className,
}: {
  tone: ConnectionIndicatorTone;
  className?: string;
}) {
  if (tone === "syncing") {
    return <Spinner aria-hidden className={cn("size-3 text-muted-foreground", className)} />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        tone === "online" ? "bg-emerald-500" : "animate-pulse bg-destructive",
        className,
      )}
    />
  );
}
