import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { ScopedProjectRef } from "@salchi/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useLocalDispatchStore } from "../localDispatchStore";
import { selectThreadByRef, useStore } from "../store";
import {
  buildSidebarThreadPresentation,
  hasPendingComposerInput,
} from "../sidebarThreadPresentation";
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
  const composerDraftHasPendingInput = useComposerDraftStore(
    useShallow((store) =>
      draftThreadEntries.map(([draftId]) =>
        hasPendingComposerInput(store.draftsByThreadKey[draftId]),
      ),
    ),
  );
  const draftThreads = useMemo(
    () =>
      draftThreadEntries.map(([draftId, thread], index) => ({
        draftId: DraftId.make(draftId),
        thread,
        composerDraft: null,
        hasPendingInput: composerDraftHasPendingInput[index] ?? false,
        draftTitle: "New thread",
      })),
    [composerDraftHasPendingInput, draftThreadEntries],
  );
  const draftServerLookupRefs = useMemo(() => {
    const refsByKey = new Map<string, ReturnType<typeof scopeThreadRef>>();
    for (const [, thread] of draftThreadEntries) {
      const draftRef = scopeThreadRef(thread.environmentId, thread.threadId);
      const rowRef = thread.promotedTo ?? draftRef;
      refsByKey.set(scopedThreadKey(rowRef), rowRef);
      refsByKey.set(scopedThreadKey(draftRef), draftRef);
    }
    return [...refsByKey.values()];
  }, [draftThreadEntries]);
  const localDispatchByThreadKey = useLocalDispatchStore((store) => store.localDispatchByThreadKey);
  const draftServerThreads = useStore(
    useShallow((state) =>
      draftServerLookupRefs.map((threadRef) => selectThreadByRef(state, threadRef) ?? null),
    ),
  );
  const serverThreadByKey = useMemo(() => {
    const threadByKey = new Map<string, Thread>();
    draftServerLookupRefs.forEach((threadRef, index) => {
      const thread = draftServerThreads[index];
      if (thread) {
        threadByKey.set(scopedThreadKey(threadRef), thread);
        threadByKey.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
      }
    });
    return threadByKey;
  }, [draftServerLookupRefs, draftServerThreads]);

  return useMemo(() => {
    const presentation = buildSidebarThreadPresentation({
      serverThreads,
      draftThreads,
      localDispatchByThreadKey,
      serverThreadByKey,
      ...(projectRefs !== undefined ? { projectRefs } : {}),
    });
    const activeLocalDispatchStartedAtByThreadKey = new Map(
      Object.entries(localDispatchByThreadKey).flatMap(([threadKey, dispatch]) =>
        dispatch === undefined ? [] : ([[threadKey, dispatch.startedAt]] as const),
      ),
    );
    for (const { thread } of draftThreads) {
      if (!thread.promotedTo) {
        continue;
      }
      const draftThreadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.threadId));
      const promotedThreadKey = scopedThreadKey(thread.promotedTo);
      const startedAt = activeLocalDispatchStartedAtByThreadKey.get(draftThreadKey);
      if (startedAt !== undefined) {
        activeLocalDispatchStartedAtByThreadKey.set(promotedThreadKey, startedAt);
      }
    }
    return {
      ...presentation,
      activeLocalDispatchThreadKeys: new Set(activeLocalDispatchStartedAtByThreadKey.keys()),
      activeLocalDispatchStartedAtByThreadKey,
    };
  }, [draftThreads, localDispatchByThreadKey, projectRefs, serverThreadByKey, serverThreads]);
}
