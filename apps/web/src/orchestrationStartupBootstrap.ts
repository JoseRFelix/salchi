import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { getClientSettings } from "./hooks/useSettings";
import { deriveLogicalProjectKeyFromSettings, derivePhysicalProjectKey } from "./logicalProject";
import { readCachedEnvironmentStateEntries } from "./orchestrationStartupCache";
import { useStore } from "./store";
import type { Project } from "./types";
import { useUiStateStore, type SyncThreadInput } from "./uiStateStore";

export interface OrchestrationStartupCacheIndex {
  readonly threadIdsByEnvironment: Readonly<Record<EnvironmentId, readonly ThreadId[]>>;
}

export function hydrateOrchestrationStartupCache(): OrchestrationStartupCacheIndex {
  const entries = readCachedEnvironmentStateEntries();
  const threadIdsByEnvironment: Record<EnvironmentId, readonly ThreadId[]> = {};
  const cachedProjects: Project[] = [];
  const cachedThreads: SyncThreadInput[] = [];

  for (const { environmentId, state } of entries) {
    useStore.getState().hydrateCachedEnvironmentState(environmentId, state);
    // Thread detail can be cached before the shell stream has delivered its sidebar summary.
    // Rebuild those missing summaries from the cached shell/detail state so the sidebar and chat
    // become available in the same pre-connection paint.
    useStore.getState().syncSidebarThreadSummariesForEnvironment(environmentId);
    const hydratedState = useStore.getState().environmentStateById[environmentId] ?? state;
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
