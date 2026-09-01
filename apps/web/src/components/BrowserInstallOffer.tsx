import type { BrowserManagedVariant } from "@salchi/contracts";
import { AppWindowIcon } from "lucide-react";

import type { BrowserViewportState } from "../browser/browserViewportState";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Spinner } from "./ui/spinner";

function formatInstallBytes(bytes: number): string {
  if (bytes <= 0) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MANAGED_VARIANT_OPTIONS = [
  {
    value: "headless-shell",
    title: "Chromium (smaller, ~180 MB)",
    description: "Lightweight headless shell; the most detectable option.",
  },
  {
    value: "chrome",
    title: "Google Chrome (larger, ~350 MB)",
    description: "Better compatibility with sites that block automation.",
  },
] as const satisfies ReadonlyArray<{
  readonly value: BrowserManagedVariant;
  readonly title: string;
  readonly description: string;
}>;

export function BrowserManagedVariantPicker(props: {
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (variant: BrowserManagedVariant) => void;
  readonly value: BrowserManagedVariant;
}) {
  return (
    <div
      aria-label="Managed browser variant"
      className={cn("grid w-full gap-2", !props.compact && "sm:grid-cols-2")}
      role="radiogroup"
    >
      {MANAGED_VARIANT_OPTIONS.map((option) => {
        const selected = props.value === option.value;
        return (
          <button
            aria-checked={selected}
            className={cn(
              "rounded-md border px-3 py-2 text-left transition-colors",
              selected
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted/40",
            )}
            disabled={props.disabled}
            key={option.value}
            onClick={() => props.onChange(option.value)}
            role="radio"
            type="button"
          >
            <span className="block text-xs font-medium">{option.title}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function BrowserInstallOffer(props: {
  readonly compact?: boolean;
  readonly dependencyCommand: string | null;
  readonly installState: BrowserViewportState["installState"];
  readonly loading: boolean;
  readonly onCancel: () => void;
  readonly onCheckAgain: () => void;
  readonly onInstall: () => void;
  readonly onRetryStart: () => void;
  readonly onVariantChange: (variant: BrowserManagedVariant) => void;
  readonly reason: NonNullable<BrowserViewportState["unavailableReason"]>;
  readonly selectedVariant: BrowserManagedVariant;
}) {
  if (props.reason === "missing-libraries") {
    return (
      <Empty className={cn(props.compact && "gap-3 p-4")}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindowIcon />
          </EmptyMedia>
          <EmptyTitle>Browser dependencies required</EmptyTitle>
          <EmptyDescription>
            Chromium is installed, but this server is missing Linux shared libraries.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="w-full max-w-xl gap-3">
          {props.dependencyCommand ? (
            <code className="block w-full select-all overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-left text-xs text-foreground">
              {props.dependencyCommand}
            </code>
          ) : null}
          <Button disabled={props.loading} onClick={props.onRetryStart}>
            {props.loading ? <Spinner className="size-4" /> : null}
            Retry start
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const progress = props.installState?.progress;
  if (props.installState?.status === "installing") {
    const downloaded = formatInstallBytes(progress?.downloadedBytes ?? 0);
    const total = formatInstallBytes(progress?.totalBytes ?? 0);
    const browserName = props.installState.variant === "chrome" ? "Google Chrome" : "Chromium";
    return (
      <Empty className={cn(props.compact && "gap-3 p-4")}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner className="size-5" />
          </EmptyMedia>
          <EmptyTitle>Installing {browserName}</EmptyTitle>
          <EmptyDescription>
            {progress?.phase === "downloading"
              ? `Downloading${downloaded ? ` ${downloaded}` : ""}${total ? ` of ${total}` : ""}…`
              : "Preparing Salchi's managed browser…"}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="w-full max-w-sm gap-3">
          <div
            aria-label={`${browserName} install progress`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress?.percent ?? 0}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${String(progress?.percent ?? 0)}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {String(Math.round(progress?.percent ?? 0))}%
          </div>
          <Button disabled={props.loading} onClick={props.onCancel} variant="outline">
            Cancel
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (props.installState?.status === "needs-elevation") {
    return (
      <Empty className={cn(props.compact && "gap-3 p-4")}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindowIcon />
          </EmptyMedia>
          <EmptyTitle>Google Chrome needs administrator installation</EmptyTitle>
          <EmptyDescription>{props.installState.reason}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="w-full max-w-xl gap-3">
          <BrowserManagedVariantPicker
            {...(props.compact === undefined ? {} : { compact: props.compact })}
            disabled={props.loading}
            onChange={props.onVariantChange}
            value={props.selectedVariant}
          />
          {props.installState.elevationCommand ? (
            <code className="block w-full select-all overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-left text-xs text-foreground">
              {props.installState.elevationCommand}
            </code>
          ) : null}
          <Button disabled={props.loading} onClick={props.onCheckAgain}>
            {props.loading ? <Spinner className="size-4" /> : null}
            Check again
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (props.installState?.status === "installed") {
    const browserName = props.installState.variant === "chrome" ? "Google Chrome" : "Chromium";
    return (
      <Empty className={cn(props.compact && "gap-3 p-4")}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindowIcon />
          </EmptyMedia>
          <EmptyTitle>{browserName} is already installed</EmptyTitle>
          <EmptyDescription>
            Salchi found this browser on the server. No managed download is needed.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="w-full max-w-xl gap-3">
          <BrowserManagedVariantPicker
            {...(props.compact === undefined ? {} : { compact: props.compact })}
            disabled={props.loading}
            onChange={props.onVariantChange}
            value={props.selectedVariant}
          />
          <Button disabled={props.loading} onClick={props.onRetryStart}>
            {props.loading ? <Spinner className="size-4" /> : null}
            Start {browserName}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const failedReason =
    props.installState?.status === "failed" ? props.installState.reason : undefined;
  const browserName = props.selectedVariant === "chrome" ? "Google Chrome" : "Chromium";
  return (
    <Empty className={cn(props.compact && "gap-3 p-4")}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AppWindowIcon />
        </EmptyMedia>
        <EmptyTitle>
          {failedReason ? `${browserName} installation unavailable` : "Install a browser"}
        </EmptyTitle>
        <EmptyDescription>
          {failedReason ??
            "No browser found on the server. Choose a managed browser for Salchi to install."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-xl gap-3">
        <BrowserManagedVariantPicker
          {...(props.compact === undefined ? {} : { compact: props.compact })}
          disabled={props.loading}
          onChange={props.onVariantChange}
          value={props.selectedVariant}
        />
        <Button disabled={props.loading} onClick={props.onInstall}>
          {props.loading ? <Spinner className="size-4" /> : null}
          {failedReason ? `Retry ${browserName}` : `Install ${browserName}`}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
