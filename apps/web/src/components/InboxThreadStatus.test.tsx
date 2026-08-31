import { EnvironmentId, ProjectId, ThreadId } from "@salchi/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../types";
import { InboxThreadStatus } from "./InboxThreadStatus";

function makeThread(): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-status-presentation"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-local"),
    title: "Status presentation",
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-31T12:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: "2026-08-31T12:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function renderStatus(input: {
  readonly hasActiveLocalDispatch?: boolean;
  readonly isWoke?: boolean;
}): string {
  return renderToStaticMarkup(
    <InboxThreadStatus
      activityAt="2026-08-31T12:00:00.000Z"
      hasActiveLocalDispatch={input.hasActiveLocalDispatch ?? false}
      isActive={false}
      isWoke={input.isWoke ?? false}
      thread={makeThread()}
    />,
  );
}

describe("InboxThreadStatus", () => {
  it("animates the working indicator while respecting reduced motion", () => {
    const markup = renderStatus({ hasActiveLocalDispatch: true });

    expect(markup).toContain('aria-label="Working"');
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("does not animate a non-working status indicator", () => {
    const markup = renderStatus({ isWoke: true });

    expect(markup).toContain('aria-label="Woke"');
    expect(markup).not.toContain("animate-spin");
  });
});
