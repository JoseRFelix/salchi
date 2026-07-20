import { scopeThreadRef } from "@salchi/client-runtime";
import type { ScopedThreadRef } from "@salchi/contracts";

import { threadHasStarted } from "./threadLifecycle";
import { DraftId, type DraftThreadState, useComposerDraftStore } from "./composerDraftStore";
import {
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadExistsByRef,
  useStore,
} from "./store";

export function draftThreadServerRef(draftThread: DraftThreadState): ScopedThreadRef {
  return scopeThreadRef(draftThread.environmentId, draftThread.threadId);
}

export function draftThreadExistsOnServer(draftThread: DraftThreadState): boolean {
  return selectThreadExistsByRef(useStore.getState(), draftThreadServerRef(draftThread));
}

export function finalizeMaterializedPromotedDraftThreadByRef(threadRef: ScopedThreadRef): boolean {
  const state = useStore.getState();
  if (
    !threadHasStarted(selectThreadByRef(state, threadRef)) ||
    selectSidebarThreadSummaryByRef(state, threadRef) === undefined
  ) {
    return false;
  }

  const draftStore = useComposerDraftStore.getState();
  let finalized = false;
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.promotedTo?.environmentId !== threadRef.environmentId ||
      draftThread.promotedTo.threadId !== threadRef.threadId ||
      draftStore.logicalProjectDraftThreadKeyByLogicalProjectKey[draftThread.logicalProjectKey] ===
        draftId
    ) {
      continue;
    }
    draftStore.finalizePromotedDraftThread(DraftId.make(draftId));
    finalized = true;
  }
  return finalized;
}

export function finalizeMaterializedPromotedDraftThreadsByRef(
  threadRefs: Iterable<ScopedThreadRef>,
): void {
  for (const threadRef of threadRefs) {
    finalizeMaterializedPromotedDraftThreadByRef(threadRef);
  }
}
