import { useEffect } from "react";
import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";

import { useLocalDispatchStore } from "../localDispatchStore";
import { derivePhase } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import { hasServerAcknowledgedLocalDispatch } from "../components/ChatView.logic";

export function useSidebarLocalDispatchReconciliation(
  sidebarThreads: readonly SidebarThreadSummary[],
) {
  const localDispatchByThreadKey = useLocalDispatchStore((state) => state.localDispatchByThreadKey);
  const clearLocalDispatchByThreadKey = useLocalDispatchStore(
    (state) => state.clearLocalDispatchByThreadKey,
  );

  useEffect(() => {
    const entries = Object.entries(localDispatchByThreadKey);
    if (entries.length === 0) {
      return;
    }

    const sidebarThreadByKey = new Map(
      sidebarThreads.map(
        (thread) =>
          [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
      ),
    );
    for (const [threadKey, localDispatch] of entries) {
      const thread = sidebarThreadByKey.get(threadKey);
      if (!thread) {
        continue;
      }
      if (
        hasServerAcknowledgedLocalDispatch({
          localDispatch,
          phase: derivePhase(thread.session, thread.latestTurn),
          latestTurn: thread.latestTurn,
          session: thread.session,
          pendingApprovalCreatedAt: null,
          pendingUserInputCreatedAt: null,
          threadError: null,
        })
      ) {
        clearLocalDispatchByThreadKey(threadKey);
      }
    }
  }, [clearLocalDispatchByThreadKey, localDispatchByThreadKey, sidebarThreads]);
}
