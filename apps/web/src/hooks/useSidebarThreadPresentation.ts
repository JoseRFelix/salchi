import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { ScopedProjectRef } from "@salchi/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useLocalDispatchStore } from "../localDispatchStore";
import { getThreadFromEnvironmentState } from "../threadDerivation";
import { useStore } from "../store";
import { buildSidebarThreadPresentation } from "../sidebarThreadPresentation";
import type { SidebarThreadSummary, Thread } from "../types";

export function useSidebarThreadPresentation(
  serverThreads: readonly SidebarThreadSummary[],
  projectRefs?: readonly ScopedProjectRef[],
) {
  const draftThreadsByDraftId = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadEntries = useMemo(
    () =>
      Object.entries(draftThreadsByDraftId).filter(([, thread]) =>
        projectRefs
          ? projectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            )
          : true,
      ),
    [draftThreadsByDraftId, projectRefs],
  );
  const composerDrafts = useComposerDraftStore(
    useShallow((store) =>
      draftThreadEntries.map(([draftId]) => store.draftsByThreadKey[draftId] ?? null),
    ),
  );
  const draftThreads = useMemo(
    () =>
      draftThreadEntries.map(([draftId, thread], index) => ({
        draftId: DraftId.make(draftId),
        thread,
        composerDraft: composerDrafts[index] ?? null,
      })),
    [composerDrafts, draftThreadEntries],
  );
  const localDispatchByThreadKey = useLocalDispatchStore((store) => store.localDispatchByThreadKey);
  const environmentStateById = useStore((state) => state.environmentStateById);
  const serverThreadByKey = useMemo(() => {
    const threadByKey = new Map<string, Thread>();
    for (const environmentState of Object.values(environmentStateById)) {
      for (const threadId of environmentState.threadIds) {
        const thread = getThreadFromEnvironmentState(environmentState, threadId);
        if (thread) {
          threadByKey.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
        }
      }
    }
    return threadByKey;
  }, [environmentStateById]);

  return useMemo(
    () =>
      buildSidebarThreadPresentation({
        serverThreads,
        draftThreads,
        localDispatchByThreadKey,
        serverThreadByKey,
        ...(projectRefs !== undefined ? { projectRefs } : {}),
      }),
    [draftThreads, localDispatchByThreadKey, projectRefs, serverThreadByKey, serverThreads],
  );
}
