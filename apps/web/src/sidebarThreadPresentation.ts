import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { ScopedProjectRef, ScopedThreadRef } from "@salchi/contracts";
import { truncate } from "@salchi/shared/String";

import type { ComposerThreadDraftState, DraftId, DraftThreadState } from "./composerDraftStore";
import type { LocalDispatchSnapshot } from "./components/ChatView.logic";
import type { SidebarThreadSummary, Thread } from "./types";

export interface SidebarThreadPresentation {
  readonly threads: SidebarThreadSummary[];
  readonly pendingThreadKeys: ReadonlySet<string>;
  readonly draftThreadKeys: ReadonlySet<string>;
  readonly draftIdByThreadKey: ReadonlyMap<string, DraftId>;
}

export interface SidebarDraftThreadInput {
  readonly draftId: DraftId;
  readonly thread: DraftThreadState;
  readonly composerDraft: ComposerThreadDraftState | null;
}

export interface SidebarThreadPresentationInput {
  readonly serverThreads: readonly SidebarThreadSummary[];
  readonly draftThreads: readonly SidebarDraftThreadInput[];
  readonly localDispatchByThreadKey: Readonly<Record<string, LocalDispatchSnapshot | undefined>>;
  readonly serverThreadByKey?: ReadonlyMap<string, Thread>;
  readonly projectRefs?: readonly ScopedProjectRef[];
}

function threadKey(ref: ScopedThreadRef): string {
  return scopedThreadKey(ref);
}

function draftThreadRef(draftThread: DraftThreadState): ScopedThreadRef {
  return scopeThreadRef(draftThread.environmentId, draftThread.threadId);
}

export function hasPendingComposerInput(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  return Boolean(
    draft &&
    (draft.prompt.trim().length > 0 ||
      draft.images.length > 0 ||
      draft.persistedAttachments.length > 0 ||
      draft.terminalContexts.length > 0),
  );
}

export function placeDraftThreadsFirst<TThread extends SidebarThreadSummary>(
  threads: readonly TThread[],
  draftThreadKeys: ReadonlySet<string>,
): TThread[] {
  if (draftThreadKeys.size === 0) {
    return [...threads];
  }

  const draftThreads: TThread[] = [];
  const serverThreads: TThread[] = [];
  for (const thread of threads) {
    const target = draftThreadKeys.has(threadKey(scopeThreadRef(thread.environmentId, thread.id)))
      ? draftThreads
      : serverThreads;
    target.push(thread);
  }
  return [...draftThreads, ...serverThreads];
}

function matchesProjectRefs(
  draftThread: DraftThreadState,
  projectRefs: readonly ScopedProjectRef[] | undefined,
): boolean {
  if (projectRefs === undefined) {
    return true;
  }
  return projectRefs.some(
    (ref) =>
      ref.environmentId === draftThread.environmentId && ref.projectId === draftThread.projectId,
  );
}

function latestServerUserMessageAt(thread: Thread | undefined): string | null {
  if (!thread) {
    return null;
  }
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }
  return null;
}

function resolveServerThread(
  serverThreadByKey: ReadonlyMap<string, Thread> | undefined,
  rowRef: ScopedThreadRef,
  draftRef: ScopedThreadRef,
): Thread | undefined {
  return serverThreadByKey?.get(threadKey(rowRef)) ?? serverThreadByKey?.get(threadKey(draftRef));
}

function buildPendingThreadSummary(input: {
  readonly composerDraft: ComposerThreadDraftState | null;
  readonly draftThread: DraftThreadState;
  readonly localDispatch: LocalDispatchSnapshot | null;
  readonly serverThread: Thread | undefined;
  readonly rowRef: ScopedThreadRef;
}): SidebarThreadSummary {
  const { composerDraft, draftThread, localDispatch, rowRef, serverThread } = input;
  const activityAt =
    localDispatch?.startedAt ??
    serverThread?.updatedAt ??
    serverThread?.createdAt ??
    draftThread.createdAt;
  const latestUserMessageAt =
    localDispatch?.startedAt ?? latestServerUserMessageAt(serverThread) ?? activityAt;
  const promptTitle = truncate(composerDraft?.prompt ?? "");
  const title = serverThread?.title.trim() ? serverThread.title : promptTitle || "New thread";

  return {
    id: rowRef.threadId,
    environmentId: rowRef.environmentId,
    projectId: draftThread.projectId,
    title,
    interactionMode: serverThread?.interactionMode ?? draftThread.interactionMode,
    session: serverThread?.session ?? null,
    createdAt: serverThread?.createdAt ?? draftThread.createdAt,
    archivedAt: serverThread?.archivedAt ?? null,
    updatedAt: activityAt,
    latestTurn: serverThread?.latestTurn ?? null,
    branch: serverThread?.branch ?? draftThread.branch,
    worktreePath: serverThread?.worktreePath ?? draftThread.worktreePath,
    latestUserMessageAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

export function buildSidebarThreadPresentation(
  input: SidebarThreadPresentationInput,
): SidebarThreadPresentation {
  const serverThreadKeys = new Set(
    input.serverThreads.map((thread) => threadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const pendingThreadKeys = new Set<string>();
  const draftThreadKeys = new Set<string>();
  const draftIdByThreadKey = new Map<string, DraftId>();
  const pendingThreads: SidebarThreadSummary[] = [];

  for (const draftInput of input.draftThreads) {
    const draftThread = draftInput.thread;
    if (!matchesProjectRefs(draftThread, input.projectRefs)) {
      continue;
    }

    const draftRef = draftThreadRef(draftThread);
    const rowRef = draftThread.promotedTo ?? draftRef;
    const rowKey = threadKey(rowRef);
    if (serverThreadKeys.has(rowKey) || pendingThreadKeys.has(rowKey)) {
      continue;
    }

    const draftKey = threadKey(draftRef);
    const localDispatch =
      input.localDispatchByThreadKey[rowKey] ?? input.localDispatchByThreadKey[draftKey] ?? null;
    const isPromotedMissingSidebarSummary = draftThread.promotedTo != null;
    const isComposerDraft =
      !localDispatch &&
      !isPromotedMissingSidebarSummary &&
      hasPendingComposerInput(draftInput.composerDraft);
    if (!localDispatch && !isPromotedMissingSidebarSummary && !isComposerDraft) {
      continue;
    }

    pendingThreadKeys.add(rowKey);
    if (isComposerDraft) {
      draftThreadKeys.add(rowKey);
      draftIdByThreadKey.set(rowKey, draftInput.draftId);
    }
    pendingThreads.push(
      buildPendingThreadSummary({
        composerDraft: draftInput.composerDraft,
        draftThread,
        localDispatch,
        rowRef,
        serverThread: resolveServerThread(input.serverThreadByKey, rowRef, draftRef),
      }),
    );
  }

  return {
    threads: [...input.serverThreads, ...pendingThreads],
    pendingThreadKeys,
    draftThreadKeys,
    draftIdByThreadKey,
  };
}
