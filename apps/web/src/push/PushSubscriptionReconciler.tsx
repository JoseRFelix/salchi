import { useEffect } from "react";

import { getBrowserPushSupport, reconcileCurrentPushSubscription } from "./notifications";

/** Keeps a browser-owned push endpoint attached to the active authenticated session. */
export function PushSubscriptionReconciler() {
  useEffect(() => {
    if (!getBrowserPushSupport().supported) {
      return;
    }

    // Startup reconciliation is best-effort; settings and test sends retry it explicitly.
    void reconcileCurrentPushSubscription().catch(() => undefined);
  }, []);

  return null;
}
