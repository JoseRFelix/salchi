import { useEffect } from "react";

const WAKE_LOCK_RETRY_BASE_DELAY_MS = 250;
const WAKE_LOCK_MAX_RETRY_ATTEMPTS = 4;
const WAKE_LOCK_STABLE_RESET_MS = 30_000;

/** Keep the display awake while a user-visible operation must remain active. */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (
      !active ||
      typeof navigator === "undefined" ||
      typeof document === "undefined" ||
      navigator.wakeLock === undefined
    ) {
      return;
    }

    let disposed = false;
    let requestInFlight = false;
    let retryAfterInFlight = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let stabilityTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let sentinel: WakeLockSentinel | null = null;

    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const clearStabilityTimer = () => {
      if (stabilityTimer === null) return;
      globalThis.clearTimeout(stabilityTimer);
      stabilityTimer = null;
    };

    const scheduleRetry = () => {
      if (
        disposed ||
        retryTimer !== null ||
        sentinel !== null ||
        document.visibilityState !== "visible" ||
        retryAttempt >= WAKE_LOCK_MAX_RETRY_ATTEMPTS
      ) {
        return;
      }

      const delay = WAKE_LOCK_RETRY_BASE_DELAY_MS * 2 ** retryAttempt;
      retryAttempt += 1;
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        void requestWakeLock();
      }, delay);
    };

    async function requestWakeLock() {
      if (disposed || sentinel !== null || document.visibilityState !== "visible") return;
      if (requestInFlight) {
        retryAfterInFlight = true;
        return;
      }

      clearRetryTimer();
      requestInFlight = true;
      try {
        const acquired = await navigator.wakeLock.request("screen");
        if (disposed || document.visibilityState !== "visible") {
          await acquired.release().catch(() => undefined);
          return;
        }

        sentinel = acquired;
        clearStabilityTimer();
        stabilityTimer = globalThis.setTimeout(() => {
          stabilityTimer = null;
          retryAttempt = 0;
        }, WAKE_LOCK_STABLE_RESET_MS);
        acquired.addEventListener(
          "release",
          () => {
            if (sentinel === acquired) sentinel = null;
            clearStabilityTimer();
            scheduleRetry();
          },
          { once: true },
        );
      } catch {
        // Wake Lock is best-effort and may be rejected by browser or OS policy.
        scheduleRetry();
      } finally {
        requestInFlight = false;
        if (retryAfterInFlight) {
          retryAfterInFlight = false;
          scheduleRetry();
        }
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        retryAttempt = 0;
        clearRetryTimer();
        void requestWakeLock();
      } else {
        clearRetryTimer();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void requestWakeLock();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearRetryTimer();
      clearStabilityTimer();
      const acquired = sentinel;
      sentinel = null;
      void acquired?.release().catch(() => undefined);
    };
  }, [active]);
}
