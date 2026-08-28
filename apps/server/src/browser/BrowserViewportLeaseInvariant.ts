export const BROWSER_VIEWPORT_LEASE_INVARIANT_GRACE_MILLIS = 30_000;

export interface BrowserViewportLeaseInvariantState {
  readonly logged: boolean;
  readonly violationStartedAt: number | undefined;
}

export const initialBrowserViewportLeaseInvariantState: BrowserViewportLeaseInvariantState = {
  logged: false,
  violationStartedAt: undefined,
};

/**
 * Tracks the impossible state where the idle controller sees subscribers but
 * no named visible-surface lease owns them. The caller logs when `shouldLog`
 * first becomes true and keeps checking until the invariant recovers.
 */
export function updateBrowserViewportLeaseInvariant(
  state: BrowserViewportLeaseInvariantState,
  input: {
    readonly now: number;
    readonly subscriberCount: number;
    readonly visibleLeaseCount: number;
  },
): { readonly state: BrowserViewportLeaseInvariantState; readonly shouldLog: boolean } {
  if (input.subscriberCount === 0 || input.visibleLeaseCount > 0) {
    return { state: initialBrowserViewportLeaseInvariantState, shouldLog: false };
  }

  const violationStartedAt = state.violationStartedAt ?? input.now;
  const shouldLog =
    !state.logged &&
    input.now - violationStartedAt >= BROWSER_VIEWPORT_LEASE_INVARIANT_GRACE_MILLIS;
  return {
    state: {
      logged: state.logged || shouldLog,
      violationStartedAt,
    },
    shouldLog,
  };
}
