import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "~/lib/utils";
import { getThreadActivityTimestamp } from "../lib/threadSort";
import { deriveRecentThreadProjectGroups } from "./NoActiveThreadState.logic";

function RecentChats() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const recentGroups = useMemo(
    () => deriveRecentThreadProjectGroups({ projects, threads }),
    [projects, threads],
  );

  if (recentGroups.length === 0) {
    return null;
  }

  return (
    <div className="mt-7 w-full min-w-0 text-left">
      <div className="mb-3 text-xs font-medium text-muted-foreground uppercase">Recent chats</div>
      <div className="space-y-5">
        {recentGroups.map((group) => (
          <section key={group.projectKey} className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2">
              <div className="truncate text-sm font-medium text-foreground">
                {group.project.name}
              </div>
              <div className="truncate text-xs text-muted-foreground/65" title={group.project.cwd}>
                {group.project.cwd}
              </div>
            </div>
            <div className="mt-2 divide-y divide-border/70 overflow-hidden rounded-md border border-border/65 bg-background/55">
              {group.threads.map((thread) => {
                const timestamp = getThreadActivityTimestamp(thread);
                return (
                  <Link
                    key={`${thread.environmentId}:${thread.id}`}
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId: thread.environmentId,
                      threadId: thread.id,
                    }}
                    className="group flex min-w-0 items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground/90 group-hover:text-foreground">
                      {thread.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground/65">
                      {formatRelativeTimeLabel(timestamp)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
            <RecentChats />
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
