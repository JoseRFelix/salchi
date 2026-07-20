import {
  getWsConnectionUiState,
  WS_RECONNECT_MAX_ATTEMPTS,
  type WsConnectionStatus,
} from "../rpc/wsConnectionState";

export type ConnectionIndicatorTone = "online" | "syncing" | "offline";

export interface ConnectionIndicatorView {
  /** Visual treatment: green dot, spinner, or red dot. */
  readonly tone: ConnectionIndicatorTone;
  /** Short status word, shown in the sidebar pill and used for the aria label. */
  readonly label: string;
  /** Longer human explanation, shown in the tooltip / `title`. */
  readonly detail: string;
}

const DEFAULT_CONNECTION_NAME = "Salchi Server";

export function getConnectionDisplayName(status: WsConnectionStatus): string {
  return status.connectionLabel?.trim() || DEFAULT_CONNECTION_NAME;
}

function formatAttempt(status: WsConnectionStatus): string {
  const attempt = Math.max(1, Math.min(status.reconnectAttemptCount, WS_RECONNECT_MAX_ATTEMPTS));
  return `Attempt ${attempt}/${status.reconnectMaxAttempts}`;
}

function formatCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

/**
 * Collapses the raw socket status into the three states the connection dot
 * renders. This is the single source of truth for what the indicator says,
 * shared by the header dot and the sidebar footer pill.
 */
export function deriveConnectionIndicator(
  status: WsConnectionStatus,
  nowMs: number,
): ConnectionIndicatorView {
  const name = getConnectionDisplayName(status);

  if (status.hasConnected && status.reconnectPhase === "exhausted") {
    return {
      tone: "offline",
      label: "Disconnected",
      detail: `Couldn't reconnect to ${name}. Retries exhausted.`,
    };
  }

  switch (getWsConnectionUiState(status)) {
    case "connected":
      return {
        tone: "online",
        label: "Connected",
        detail: `Connected to ${name}.`,
      };
    case "connecting":
      return {
        tone: "syncing",
        label: "Connecting",
        detail: `Connecting to ${name}…`,
      };
    case "reconnecting":
      return {
        tone: "syncing",
        label: "Reconnecting",
        detail:
          status.nextRetryAt === null
            ? `Reconnecting to ${name}… ${formatAttempt(status)}`
            : `Reconnecting to ${name} in ${formatCountdown(
                status.nextRetryAt,
                nowMs,
              )}… ${formatAttempt(status)}`,
      };
    case "offline":
      return {
        tone: "offline",
        label: "Offline",
        detail: "You're offline. Waiting for the network to come back.",
      };
    case "error":
      return {
        tone: "offline",
        label: "Connection error",
        detail: status.lastError?.trim()
          ? `Can't reach ${name}: ${status.lastError.trim()}`
          : `Can't reach ${name}.`,
      };
  }
}
