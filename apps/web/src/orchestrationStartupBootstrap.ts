import { scopedThreadKey, scopeThreadRef } from "@salchi/client-runtime";
import type { EnvironmentId, ThreadId } from "@salchi/contracts";

import { getClientSettings } from "./hooks/useSettings";
import { deriveLogicalProjectKeyFromSettings, derivePhysicalProjectKey } from "./logicalProject";
import {
  decodeCachedEnvironmentState,
  readCachedEnvironmentStateEntries,
  type CachedEnvironmentStateEntry,
} from "./orchestrationStartupCache";
import { readIndexedDbCachedEnvironmentStateEntries } from "./orchestrationStartupCacheIndexedDb";
import { useStore } from "./store";
import type { Project } from "./types";
import { useUiStateStore, type SyncThreadInput } from "./uiStateStore";

export interface OrchestrationStartupCacheIndex {
  readonly threadIdsByEnvironment: Readonly<Record<EnvironmentId, readonly ThreadId[]>>;
}

interface StartupCacheHydrationEntry {
  readonly environmentId: EnvironmentId;
  readonly state: CachedEnvironmentStateEntry["state"];
  readonly durableShellState?: CachedEnvironmentStateEntry["state"];
}

function hydrateOrchestrationStartupCacheEntries(
  entries: readonly StartupCacheHydrationEntry[],
  mode: "initial" | "detail",
): OrchestrationStartupCacheIndex {
  const threadIdsByEnvironment: Record<EnvironmentId, readonly ThreadId[]> = {};
  const cachedProjects: Project[] = [];
  const cachedThreads: SyncThreadInput[] = [];

  for (const entry of entries) {
    const { environmentId, state } = entry;
    if (mode === "initial") {
      useStore.getState().hydrateCachedEnvironmentState(environmentId, state);
    } else {
      if (entry.durableShellState) {
        useStore
          .getState()
          .hydrateCachedEnvironmentShellState(environmentId, entry.durableShellState);
      }
      useStore.getState().hydrateCachedEnvironmentDetailState(environmentId, state);
    }
    // Thread detail can be cached before the shell stream has delivered its sidebar summary.
    // Rebuild those missing summaries from the cached shell/detail state so the sidebar and chat
    // become available in the same pre-connection paint.
    useStore.getState().syncSidebarThreadSummariesForEnvironment(environmentId);
    const hydratedState = useStore.getState().environmentStateById[environmentId];
    if (!hydratedState) {
      continue;
    }
    threadIdsByEnvironment[environmentId] = hydratedState.threadIds;
    for (const projectId of hydratedState.projectIds) {
      const project = hydratedState.projectById[projectId];
      if (project) {
        cachedProjects.push(project);
      }
    }
    for (const threadId of hydratedState.threadIds) {
      const shell = hydratedState.threadShellById[threadId];
      if (shell) {
        cachedThreads.push({
          key: scopedThreadKey(scopeThreadRef(environmentId, threadId)),
          seedVisitedAt: shell.updatedAt ?? shell.createdAt,
        });
      }
    }
  }

  const clientSettings = getClientSettings();
  useUiStateStore.getState().syncProjects(
    cachedProjects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
  );
  useUiStateStore.getState().syncThreads(cachedThreads);

  return {
    threadIdsByEnvironment,
  };
}

export function hydrateOrchestrationStartupCache(): OrchestrationStartupCacheIndex {
  return hydrateOrchestrationStartupCacheEntries(readCachedEnvironmentStateEntries(), "initial");
}

export async function hydrateOrchestrationIndexedDbStartupCache(): Promise<OrchestrationStartupCacheIndex> {
  const localEntryByEnvironment = new Map(
    readCachedEnvironmentStateEntries().map((entry) => [entry.environmentId, entry] as const),
  );
  const entries = (await readIndexedDbCachedEnvironmentStateEntries()).flatMap((entry) => {
    const state = decodeCachedEnvironmentState(entry.state);
    const localEntry = localEntryByEnvironment.get(entry.environmentId);
    const durableShellState =
      localEntry?.shellComplete === false &&
      localEntry.shellRevision !== null &&
      entry.shellRevision === localEntry.shellRevision
        ? decodeCachedEnvironmentState(entry.shellState)
        : null;
    return state
      ? [
          {
            environmentId: entry.environmentId,
            state,
            ...(durableShellState ? { durableShellState } : {}),
          },
        ]
      : [];
  });
  return hydrateOrchestrationStartupCacheEntries(entries, "detail");
}
