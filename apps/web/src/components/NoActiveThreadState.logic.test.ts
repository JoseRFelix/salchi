import { EnvironmentId, ProjectId, ThreadId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import { deriveRecentThreadProjectGroups } from "./NoActiveThreadState.logic";
import type { Project, SidebarThreadSummary } from "../types";

const ENVIRONMENT_ID = EnvironmentId.make("env-local");

function makeProject(input: { id: string; name: string; cwd?: string }): Project {
  return {
    id: ProjectId.make(input.id),
    environmentId: ENVIRONMENT_ID,
    name: input.name,
    cwd: input.cwd ?? `/tmp/${input.name}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  };
}

function makeThread(input: {
  id: string;
  projectId: ProjectId;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  latestUserMessageAt?: string | null;
  archivedAt?: string | null;
}): SidebarThreadSummary {
  return {
    id: ThreadId.make(input.id),
    environmentId: ENVIRONMENT_ID,
    projectId: input.projectId,
    title: input.title,
    interactionMode: "default",
    session: null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    updatedAt: input.updatedAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("deriveRecentThreadProjectGroups", () => {
  it("keeps the two most recent projects and two most recent threads per project", () => {
    const projectA = makeProject({ id: "project-a", name: "A" });
    const projectB = makeProject({ id: "project-b", name: "B" });
    const projectC = makeProject({ id: "project-c", name: "C" });

    const groups = deriveRecentThreadProjectGroups({
      projects: [projectA, projectB, projectC],
      threads: [
        makeThread({
          id: "thread-a-old",
          projectId: projectA.id,
          title: "A old",
          latestUserMessageAt: "2026-01-01T00:00:00.000Z",
        }),
        makeThread({
          id: "thread-a-new",
          projectId: projectA.id,
          title: "A new",
          latestUserMessageAt: "2026-01-04T00:00:00.000Z",
        }),
        makeThread({
          id: "thread-a-mid",
          projectId: projectA.id,
          title: "A mid",
          latestUserMessageAt: "2026-01-03T00:00:00.000Z",
        }),
        makeThread({
          id: "thread-b-old",
          projectId: projectB.id,
          title: "B old",
          latestUserMessageAt: "2026-01-02T00:00:00.000Z",
        }),
        makeThread({
          id: "thread-c-newest",
          projectId: projectC.id,
          title: "C newest",
          latestUserMessageAt: "2026-01-06T00:00:00.000Z",
        }),
      ],
    });

    expect(groups.map((group) => group.project.id)).toEqual([projectC.id, projectA.id]);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-c-newest"),
    ]);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-a-new"),
      ThreadId.make("thread-a-mid"),
    ]);
  });

  it("ignores archived threads and threads without a known project", () => {
    const project = makeProject({ id: "project-known", name: "Known" });

    const groups = deriveRecentThreadProjectGroups({
      projects: [project],
      threads: [
        makeThread({
          id: "thread-archived",
          projectId: project.id,
          title: "Archived",
          latestUserMessageAt: "2026-01-06T00:00:00.000Z",
          archivedAt: "2026-01-07T00:00:00.000Z",
        }),
        makeThread({
          id: "thread-missing-project",
          projectId: ProjectId.make("project-missing"),
          title: "Missing",
          latestUserMessageAt: "2026-01-05T00:00:00.000Z",
        }),
        makeThread({
          id: "thread-visible",
          projectId: project.id,
          title: "Visible",
          latestUserMessageAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-visible"),
    ]);
  });
});
