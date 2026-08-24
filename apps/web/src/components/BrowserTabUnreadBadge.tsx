import { useEffect, useMemo } from "react";

import { applyBrowserTabUnreadBadge } from "../browserTabUnreadBadge";
import { useStore } from "../store";
import { createHasUnreadCompletionSelector } from "../unreadCompletionStore";

/** Keeps the browser-tab favicon in sync with the user's unread completed threads. */
export function BrowserTabUnreadBadge() {
  const selectHasUnreadThreads = useMemo(createHasUnreadCompletionSelector, []);
  const hasUnreadThreads = useStore(selectHasUnreadThreads);

  useEffect(() => applyBrowserTabUnreadBadge(hasUnreadThreads), [hasUnreadThreads]);

  return null;
}
