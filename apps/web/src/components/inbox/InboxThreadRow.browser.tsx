// Production CSS contains the responsive behavior under test.
import "../../index.css";

import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId, TurnId } from "@salchi/contracts";
import { SearchIcon, SettingsIcon } from "lucide-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { SidebarThreadSummary } from "../../types";
import { SidebarProvider } from "../ui/sidebar";
import { InboxThreadRow } from "./InboxThreadRow";

const NOW = "2026-09-01T05:30:00.000Z";

function makeWorkingThread(): SidebarThreadSummary {
  return {
    id: ThreadId.make("mobile-working-thread"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-salchi"),
    title: "Investigate mobile working status",
    interactionMode: "default",
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: TurnId.make("turn-mobile-working"),
      createdAt: "2026-09-01T05:29:00.000Z",
      updatedAt: "2026-09-01T05:29:00.000Z",
    },
    createdAt: "2026-09-01T05:28:00.000Z",
    updatedAt: "2026-09-01T05:30:00.000Z",
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make("turn-mobile-working"),
      state: "running",
      requestedAt: "2026-09-01T05:29:00.000Z",
      startedAt: "2026-09-01T05:29:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    branch: "fix/mobile-working-status",
    worktreePath: null,
    latestUserMessageAt: "2026-09-01T05:29:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function WorkingThreadRow() {
  const thread = makeWorkingThread();
  return (
    <InboxThreadRow
      thread={thread}
      lifecycleThread={thread}
      depth={0}
      childCount={0}
      section="active"
      projectIdentity={{ cwd: "/repo/salchi", displayName: "Salchi", environmentLabel: null }}
      lifecycleThreadKey="environment-local:mobile-working-thread"
      isLifecycleRoot
      isActive={false}
      isDraft={false}
      draftId={null}
      isSelected={false}
      hasActiveLocalDispatch={false}
      localDispatchStartedAt={null}
      backgroundLiveness={null}
      isPending={false}
      isThreadExpanded={false}
      now={NOW}
      timestampFormat="locale"
      lastVisitedAt={null}
      canPin
      canSnooze
      canSettle
      canReorderPinned={false}
      canRegenerateTitle
      canMarkUnread
      canMovePinUp={false}
      canMovePinDown={false}
      changeRequestSnapshot={null}
      isRenaming={false}
      renameValue=""
      isRegeneratingTitle={false}
      onNavigate={() => undefined}
      onAction={() => undefined}
      onToggleExpanded={() => undefined}
      onPinnedDragStart={() => undefined}
      onPinnedDrop={() => undefined}
      onAcknowledgeWoke={() => undefined}
      onStartRename={() => undefined}
      onRenameValueChange={() => undefined}
      onCommitRename={() => undefined}
      onCancelRename={() => undefined}
    />
  );
}

function MobileInboxShowcase() {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        data-testid="mobile-inbox-showcase"
        className="flex h-screen w-[min(24rem,88vw)] flex-col border-r border-border bg-card"
      >
        <header className="flex h-[52px] shrink-0 items-center justify-between px-4">
          <span className="text-lg font-semibold tracking-tight">Salchi</span>
          <SettingsIcon className="size-4 text-muted-foreground" />
        </header>
        <div className="px-3 pb-3">
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-muted-foreground">
            <SearchIcon className="size-4" />
            <span className="text-sm">Search threads</span>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/65">
          <span>Active</span>
          <span>1</span>
        </div>
        <ul className="px-2">
          <WorkingThreadRow />
        </ul>
      </aside>
      <main className="flex flex-1 items-center justify-center bg-muted/25 text-sm text-muted-foreground">
        Conversation
      </main>
    </div>
  );
}

describe("InboxThreadRow mobile status", () => {
  it("keeps the working status visible at mobile width", async () => {
    await page.viewport(430, 932);
    const screen = await render(
      <SidebarProvider>
        <MobileInboxShowcase />
      </SidebarProvider>,
    );

    await expect.element(page.getByLabelText("Working", { exact: true })).toBeVisible();

    await screen.unmount();
  });
});
