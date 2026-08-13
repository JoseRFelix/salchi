import type { AppState } from "../../store";
import { useStore } from "../../store";
import { ensureLocalApi } from "../../localApi";

export const SIDEBAR_USAGE_CACHE_TTL_MS = 20_000;

let lastSuccessfulRefreshAtMs = Number.NEGATIVE_INFINITY;
let refreshInFlight: Promise<boolean> | null = null;

function accountRateLimitsToStoreRecord(
  accountRateLimits: ReadonlyArray<{
    readonly providerInstanceId: string;
    readonly rateLimits: unknown;
  }>,
  fetchedAt: string,
): AppState["accountRateLimitsByInstanceId"] {
  return Object.fromEntries(
    accountRateLimits.map((entry) => [
      String(entry.providerInstanceId),
      { rateLimits: entry.rateLimits, updatedAt: fetchedAt },
    ]),
  );
}

/**
 * Refresh usage through one process-wide client request. Callers may ask as often as useful to the
 * UI; this boundary coalesces concurrent requests and enforces the short freshness window.
 */
export function refreshSidebarUsageLimits(
  options: {
    readonly now?: () => number;
    readonly refresh?: () => Promise<{
      readonly accountRateLimits: ReadonlyArray<{
        readonly providerInstanceId: string;
        readonly rateLimits: unknown;
      }>;
    }>;
    readonly updateStore?: (updates: AppState["accountRateLimitsByInstanceId"]) => void;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  if (nowMs - lastSuccessfulRefreshAtMs < SIDEBAR_USAGE_CACHE_TTL_MS) {
    return Promise.resolve(false);
  }
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const refresh = options.refresh ?? (() => ensureLocalApi().server.refreshUsageLimits());
  const updateStore =
    options.updateStore ??
    ((updates: AppState["accountRateLimitsByInstanceId"]) =>
      useStore.getState().setAccountRateLimitsByInstanceId(updates));
  const promise = refresh()
    .then((result) => {
      const refreshedAtMs = now();
      lastSuccessfulRefreshAtMs = refreshedAtMs;
      updateStore(
        accountRateLimitsToStoreRecord(
          result.accountRateLimits,
          new Date(refreshedAtMs).toISOString(),
        ),
      );
      return true;
    })
    .catch(() => false)
    .finally(() => {
      if (refreshInFlight === promise) {
        refreshInFlight = null;
      }
    });

  refreshInFlight = promise;
  return promise;
}

export function resetSidebarUsageRefreshForTests(): void {
  lastSuccessfulRefreshAtMs = Number.NEGATIVE_INFINITY;
  refreshInFlight = null;
}
