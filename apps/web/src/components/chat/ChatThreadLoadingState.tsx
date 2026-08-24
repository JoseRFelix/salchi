import { BranchToolbarSkeleton } from "../BranchToolbar";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";

const CHAT_LOADING_ROWS = [
  { id: "assistant-early-1", role: "assistant", widths: ["w-7/12", "w-5/12"] },
  { id: "user-early-1", role: "user", widths: ["w-11/12", "w-8/12"] },
  { id: "assistant-early-2", role: "assistant", widths: ["w-9/12", "w-6/12"] },
  { id: "user-early-2", role: "user", widths: ["w-9/12", "w-6/12"] },
  {
    id: "assistant-middle-1",
    role: "assistant",
    widths: ["w-10/12", "w-8/12", "w-5/12"],
  },
  { id: "user-middle-1", role: "user", widths: ["w-11/12", "w-7/12"] },
  { id: "assistant-middle-2", role: "assistant", widths: ["w-8/12", "w-6/12"] },
  { id: "user-middle-2", role: "user", widths: ["w-10/12", "w-7/12"] },
  {
    id: "assistant-recent-1",
    role: "assistant",
    widths: ["w-9/12", "w-7/12", "w-5/12"],
  },
  { id: "user-recent-1", role: "user", widths: ["w-11/12", "w-8/12"] },
  { id: "assistant-recent-2", role: "assistant", widths: ["w-7/12", "w-4/12"] },
  { id: "user-recent-2", role: "user", widths: ["w-10/12", "w-7/12"] },
  {
    id: "assistant-latest",
    role: "assistant",
    widths: ["w-9/12", "w-7/12", "w-5/12"],
  },
  { id: "user-latest", role: "user", widths: ["w-11/12", "w-6/12"] },
] as const;

function ChatLoadingHeader({ label }: { label: string }) {
  return (
    <header
      className={cn(
        "border-b border-border",
        isElectron
          ? "drag-region flex h-[52px] items-center px-3 sm:px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
          : "pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-2 sm:pb-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-3",
      )}
      data-testid="chat-thread-loading-header"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-3">
          <div className="flex h-11 w-8 shrink-0 items-center justify-center md:hidden">
            <SidebarTrigger className="size-7 shrink-0 pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2" />
          </div>
          <div className="flex min-w-0 flex-col justify-center">
            <p className="min-w-0 truncate text-sm font-medium leading-tight text-foreground">
              {label}
            </p>
            <Skeleton className="mt-1.5 h-2.5 w-20 rounded-full" />
          </div>
        </div>
        <div
          aria-hidden="true"
          className="flex shrink-0 items-center justify-end gap-1"
          data-testid="chat-thread-loading-header-actions"
        >
          <Skeleton className="size-11 rounded-xl sm:size-6 sm:rounded-md" />
          <Skeleton className="size-11 rounded-xl sm:size-6 sm:rounded-md" />
          <Skeleton className="size-11 rounded-xl sm:size-6 sm:rounded-md" />
        </div>
      </div>
    </header>
  );
}

function ChatLoadingUserMessage({ widths }: { widths: ReadonlyArray<string> }) {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col items-end gap-0.5 pb-1.5 pt-0.5"
      data-testid="chat-thread-loading-user-message"
    >
      <div className="w-[68%] max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
        <div className="space-y-2">
          {widths.map((width) => (
            <Skeleton className={cn("h-3 rounded-full", width)} key={width} />
          ))}
        </div>
      </div>
      <div className="flex h-5 w-full max-w-[80%] items-center justify-end gap-2 pe-1">
        <Skeleton className="h-2.5 w-12 rounded-full" />
        <Skeleton className="size-3 rounded-sm" />
      </div>
    </div>
  );
}

function ChatLoadingAssistantMessage({ widths }: { widths: ReadonlyArray<string> }) {
  return (
    <div
      aria-hidden="true"
      className="pb-1.5 pt-0.5"
      data-testid="chat-thread-loading-assistant-message"
    >
      <div className="relative min-w-0 px-1 py-0">
        <div className="space-y-2">
          {widths.map((width) => (
            <Skeleton className={cn("h-3 rounded-full", width)} key={width} />
          ))}
        </div>
        <div className="mt-2 flex h-5 items-center gap-2">
          <Skeleton className="size-3 rounded-sm" />
          <Skeleton className="h-2.5 w-12 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function ChatLoadingTimeline() {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3 pb-3 pt-6 sm:px-5 sm:pb-4"
      data-testid="chat-thread-loading-timeline"
    >
      <div className="mx-auto w-full min-w-0 max-w-3xl shrink-0 overflow-hidden">
        {CHAT_LOADING_ROWS.map((row) =>
          row.role === "user" ? (
            <ChatLoadingUserMessage key={row.id} widths={row.widths} />
          ) : (
            <ChatLoadingAssistantMessage key={row.id} widths={row.widths} />
          ),
        )}
      </div>
    </div>
  );
}

function ChatLoadingComposer() {
  return (
    <>
      <div
        aria-hidden="true"
        className="pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-0.5 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-2"
        data-testid="chat-thread-loading-composer"
      >
        <div className="mx-auto w-full min-w-0 max-w-208 rounded-[22px] p-px">
          <div className="rounded-[20px] border border-border bg-card">
            <div className="flex items-center justify-between gap-2 px-3 py-2 sm:hidden">
              <Skeleton className="h-3 w-32 rounded-full" />
              <Skeleton className="size-8 shrink-0 rounded-full" />
            </div>
            <div className="hidden sm:block">
              <div className="space-y-2 px-3 pb-5 pt-3">
                <Skeleton className="h-3 w-44 rounded-full" />
                <Skeleton className="h-3 w-28 rounded-full" />
              </div>
              <div className="flex items-center gap-2 px-3 pb-3">
                <Skeleton className="size-7 rounded-md" />
                <Skeleton className="h-7 w-24 rounded-md" />
                <Skeleton className="h-7 w-16 rounded-md" />
                <Skeleton className="ml-auto size-8 rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <BranchToolbarSkeleton />
    </>
  );
}

export function ChatThreadLoadingState({ label = "Loading conversation..." }: { label?: string }) {
  return (
    <div
      aria-label={label}
      aria-live="polite"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
      data-testid="chat-thread-loading-state"
      role="status"
    >
      <ChatLoadingHeader label={label} />
      <ChatLoadingTimeline />
      <ChatLoadingComposer />
    </div>
  );
}
