import { useEffect } from "react";

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
    let sentinel: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      if (
        disposed ||
        requestInFlight ||
        sentinel !== null ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      requestInFlight = true;
      try {
        const acquired = await navigator.wakeLock.request("screen");
        if (disposed || document.visibilityState !== "visible") {
          await acquired.release().catch(() => undefined);
          return;
        }

        sentinel = acquired;
        acquired.addEventListener(
          "release",
          () => {
            if (sentinel === acquired) sentinel = null;
          },
          { once: true },
        );
      } catch {
        // Wake Lock is best-effort and may be rejected by browser or OS policy.
      } finally {
        requestInFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void requestWakeLock();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const acquired = sentinel;
      sentinel = null;
      void acquired?.release().catch(() => undefined);
    };
  }, [active]);
}
