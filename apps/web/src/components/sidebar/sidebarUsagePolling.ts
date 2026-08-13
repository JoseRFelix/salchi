export interface SidebarUsagePollingScheduler {
  readonly setInterval: (callback: () => void, intervalMs: number) => number;
  readonly clearInterval: (intervalId: number) => void;
  readonly addEventListener?: (type: "focus", callback: () => void) => void;
  readonly removeEventListener?: (type: "focus", callback: () => void) => void;
}

export const SIDEBAR_USAGE_BACKGROUND_REFRESH_INTERVAL_MS = 60_000;

export function startSidebarUsagePolling(
  refresh: () => void | Promise<unknown>,
  intervalMs: number = SIDEBAR_USAGE_BACKGROUND_REFRESH_INTERVAL_MS,
  scheduler: SidebarUsagePollingScheduler = window,
): () => void {
  void refresh();
  const handleFocus = () => {
    void refresh();
  };
  scheduler.addEventListener?.("focus", handleFocus);
  const intervalId = scheduler.setInterval(() => {
    void refresh();
  }, intervalMs);

  return () => {
    scheduler.clearInterval(intervalId);
    scheduler.removeEventListener?.("focus", handleFocus);
  };
}
