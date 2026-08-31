import { AlarmClockIcon, CircleCheckIcon, CircleDashedIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  formatInboxWorkingDurationLabel,
  resolveInboxThreadStatus,
  resolveInboxWorkingStartedAt,
  type InboxBackgroundLiveness,
} from "../inboxThreadStatus";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "../lib/utils";

function compactTimeLabel(label: string): string {
  if (label === "just now") {
    return "now";
  }
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function WorkingDuration(props: { readonly startedAt: string | null }) {
  const startedAtMs = props.startedAt === null ? Number.NaN : Date.parse(props.startedAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedAtMs)) {
      return;
    }
    const interval = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [startedAtMs]);
  if (Number.isNaN(startedAtMs)) {
    return null;
  }
  return (
    <span aria-hidden className="font-mono tabular-nums">
      {formatInboxWorkingDurationLabel(Date.now() - startedAtMs)}
    </span>
  );
}

export function InboxThreadStatus(props: {
  readonly activityAt: string;
  readonly hasActiveLocalDispatch: boolean;
  readonly isActive: boolean;
  readonly isWoke: boolean;
  readonly backgroundLiveness?: InboxBackgroundLiveness;
  readonly thread: SidebarThreadSummary;
  readonly onAcknowledgeWoke?: (() => void) | undefined;
}) {
  const status = resolveInboxThreadStatus({
    thread: props.thread,
    hasActiveLocalDispatch: props.hasActiveLocalDispatch,
    isActive: props.isActive,
    isWoke: props.isWoke,
    backgroundLiveness: props.backgroundLiveness ?? null,
  });

  if (status === "ready") {
    return (
      <span className="text-[11px] text-muted-foreground/55 tabular-nums">
        {compactTimeLabel(formatRelativeTimeLabel(props.activityAt))}
      </span>
    );
  }

  const presentation =
    status === "working"
      ? {
          label: "Working",
          className: cn("text-sky-600 dark:text-sky-400", !props.isActive && "opacity-75"),
          icon: <CircleDashedIcon aria-hidden className="size-3.5 shrink-0" />,
        }
      : status === "monitoring"
        ? {
            label: "Monitoring",
            className: "text-sky-600 dark:text-sky-400",
            icon: null,
          }
        : status === "approval"
          ? {
              label: "Approval",
              className: "text-amber-700 dark:text-amber-300",
              icon: null,
            }
          : status === "input"
            ? {
                label: "Input",
                className: "text-indigo-600 dark:text-indigo-300",
                icon: null,
              }
            : status === "failed"
              ? {
                  label: "Failed",
                  className: "text-red-700 dark:text-red-300",
                  icon: null,
                }
              : status === "woke"
                ? {
                    label: "Woke",
                    className: "text-amber-700 dark:text-amber-300",
                    icon: <AlarmClockIcon aria-hidden className="size-3.5 shrink-0" />,
                  }
                : {
                    label: "Done",
                    className: "text-emerald-700 dark:text-emerald-300",
                    icon: <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />,
                  };

  const content = (
    <>
      {presentation.icon}
      <span role="status">{presentation.label}</span>
      {status === "working" ? (
        <WorkingDuration startedAt={resolveInboxWorkingStartedAt(props.thread)} />
      ) : null}
    </>
  );

  return status === "woke" && props.onAcknowledgeWoke ? (
    <button
      type="button"
      aria-label="Acknowledge woke thread"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-[11px] font-medium hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        presentation.className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        props.onAcknowledgeWoke?.();
      }}
    >
      {content}
    </button>
  ) : (
    <span
      aria-label={presentation.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] font-medium",
        presentation.className,
      )}
    >
      {content}
    </span>
  );
}
