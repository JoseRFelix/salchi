import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@salchi/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SidebarThreadSummary } from "../types";
import { InboxThreadStatus } from "./InboxThreadStatus";

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
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
    ...overrides,
  };
}

function renderStatus(input: {
  readonly hasActiveLocalDispatch?: boolean;
  readonly isWoke?: boolean;
  readonly localDispatchStartedAt?: string | null;
  readonly thread?: SidebarThreadSummary;
}): string {
  return renderToStaticMarkup(
    <InboxThreadStatus
      activityAt="2026-08-31T12:00:00.000Z"
      hasActiveLocalDispatch={input.hasActiveLocalDispatch ?? false}
      localDispatchStartedAt={input.localDispatchStartedAt ?? null}
      isActive={false}
      isWoke={input.isWoke ?? false}
      thread={input.thread ?? makeThread()}
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

  it("starts a local dispatch timer at zero instead of using the stale session timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-02T10:00:00.000Z");
    try {
      const markup = renderStatus({
        hasActiveLocalDispatch: true,
        localDispatchStartedAt: "2026-09-02T10:00:00.000Z",
        thread: makeThread({
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            orchestrationStatus: "ready",
            createdAt: "2026-08-01T10:00:00.000Z",
            updatedAt: "2026-08-01T10:00:00.000Z",
          },
        }),
      });

      expect(markup).toContain(">0s</span>");
      expect(markup).not.toContain("768h");
    } finally {
      vi.useRealTimers();
    }
  });
});
