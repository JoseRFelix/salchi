import { scopedProjectKey, scopeProjectRef } from "@salchi/client-runtime";

import { getThreadSortTimestamp, sortThreads } from "../lib/threadSort";
import type { Project, SidebarThreadSummary } from "../types";

export const RECENT_PROJECT_LIMIT = 2;
export const RECENT_THREADS_PER_PROJECT_LIMIT = 2;

export interface RecentThreadProjectGroup {
  readonly project: Project;
  readonly projectKey: string;
  readonly threads: readonly SidebarThreadSummary[];
  readonly latestTimestamp: number;
}

export function deriveRecentThreadProjectGroups(input: {
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly projectLimit?: number;
  readonly threadsPerProjectLimit?: number;
}): RecentThreadProjectGroup[] {
  const projectLimit = input.projectLimit ?? RECENT_PROJECT_LIMIT;
  const threadsPerProjectLimit = input.threadsPerProjectLimit ?? RECENT_THREADS_PER_PROJECT_LIMIT;
  if (projectLimit <= 0 || threadsPerProjectLimit <= 0) {
    return [];
  }

  const projectByKey = new Map(
    input.projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const threadGroups = new Map<string, SidebarThreadSummary[]>();

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) {
      continue;
    }

    const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    if (!projectByKey.has(projectKey)) {
      continue;
    }

    const existing = threadGroups.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadGroups.set(projectKey, [thread]);
    }
  }

  return [...threadGroups.entries()]
    .flatMap(([projectKey, threads]) => {
      const project = projectByKey.get(projectKey);
      if (!project) {
        return [];
      }

      const sortedThreads = sortThreads(threads, "updated_at").slice(0, threadsPerProjectLimit);
      const latestThread = sortedThreads[0];
      if (!latestThread) {
        return [];
      }

      return [
        {
          project,
          projectKey,
          threads: sortedThreads,
          latestTimestamp: getThreadSortTimestamp(latestThread, "updated_at"),
        },
      ];
    })
    .toSorted((left, right) => {
      if (left.latestTimestamp !== right.latestTimestamp) {
        return right.latestTimestamp - left.latestTimestamp;
      }
      return (
        left.project.name.localeCompare(right.project.name) ||
        left.projectKey.localeCompare(right.projectKey)
      );
    })
    .slice(0, projectLimit);
}
