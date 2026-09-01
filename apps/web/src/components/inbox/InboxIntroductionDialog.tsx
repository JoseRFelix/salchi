import {
  AlarmClockIcon,
  CircleCheckIcon,
  FolderIcon,
  InboxIcon,
  PinIcon,
  SparklesIcon,
} from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import { useCallback } from "react";

import type { SidebarNavigationMode } from "@salchi/contracts/settings";
import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { shouldShowInboxIntroduction, sidebarNavigationChoicePatch } from "../appSidebarVariant";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function InboxPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-border/70 bg-sidebar shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <InboxIcon className="size-3.5" />
        </span>
        <span className="text-xs font-medium">All projects</span>
        <span className="ml-auto rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[9px] text-muted-foreground">
          Filter
        </span>
      </div>
      <div className="space-y-2 p-2.5">
        <div>
          <div className="mb-1 px-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400">
            Drafts
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 px-2 py-1.5">
            <span className="size-1.5 rounded-full bg-amber-500" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium">Improve onboarding flow</div>
              <div className="truncate text-[9px] text-muted-foreground">
                Website · Unsent prompt
              </div>
            </div>
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 px-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <PinIcon className="size-2.5" /> Pinned
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-background/70 px-2 py-1.5">
            <FolderIcon className="size-3 text-violet-500" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium">Sidebar performance pass</div>
              <div className="truncate text-[9px] text-muted-foreground">Salchi · main</div>
            </div>
            <span className="flex items-center gap-1 text-[9px] text-emerald-600 dark:text-emerald-400">
              <SparklesIcon className="size-2.5" /> Working
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-blue-500/15 bg-blue-500/6 px-2 py-1.5 text-[9px] text-blue-600 dark:text-blue-400">
            <AlarmClockIcon className="size-3" /> Snoozed until later
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-[9px] text-muted-foreground">
            <CircleCheckIcon className="size-3" /> Settled history
          </div>
        </div>
      </div>
    </div>
  );
}

export function InboxIntroductionDialog() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const settingsHydrated = useClientSettingsHydrated();
  const hasSeenInboxIntroduction = useSettings((settings) => settings.hasSeenInboxIntroduction);
  const sidebarNavigationMode = useSettings((settings) => settings.sidebarNavigationMode);
  const { updateSettings } = useUpdateSettings();
  const open = shouldShowInboxIntroduction({
    hasSeenInboxIntroduction,
    pathname,
    settingsHydrated,
    sidebarNavigationMode,
  });

  const chooseMode = useCallback(
    (mode: SidebarNavigationMode) => {
      updateSettings(sidebarNavigationChoicePatch(mode));
    },
    [updateSettings],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) {
          chooseMode("project");
        }
      }}
    >
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader className="pb-4 text-center sm:text-left">
          <div className="mx-auto mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary sm:mx-0">
            <InboxIcon className="size-5" />
          </div>
          <DialogTitle>Meet Inbox</DialogTitle>
          <DialogDescription>
            See work from every project in one place, organized by what needs your attention next.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <InboxPreview />
          <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
            <li className="rounded-lg bg-muted/55 p-2.5">
              <strong className="block text-xs font-medium text-foreground">One work queue</strong>
              <span className="text-xs">Drafts and active work across projects.</span>
            </li>
            <li className="rounded-lg bg-muted/55 p-2.5">
              <strong className="block text-xs font-medium text-foreground">Stay focused</strong>
              <span className="text-xs">Pin priorities and snooze work for later.</span>
            </li>
            <li className="rounded-lg bg-muted/55 p-2.5">
              <strong className="block text-xs font-medium text-foreground">Keep context</strong>
              <span className="text-xs">Project identity stays visible on every row.</span>
            </li>
          </ul>
          <p className="text-center text-xs text-muted-foreground sm:text-left">
            You can switch views any time in Settings → Inbox.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => chooseMode("project")}>
            Keep Project view
          </Button>
          <Button onClick={() => chooseMode("inbox")}>Switch to Inbox</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
