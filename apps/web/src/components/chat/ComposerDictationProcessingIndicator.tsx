import type { TranscriptionStatus } from "@t3tools/contracts";
import { LoaderCircleIcon } from "lucide-react";

import { resolveDictationInstallationState } from "../../dictation";

export function ComposerDictationProcessingIndicator(props: {
  readonly status: TranscriptionStatus | undefined;
}) {
  const { installing, progress } = resolveDictationInstallationState(props.status);
  const label = installing
    ? progress === null
      ? "Installing dictation"
      : `Installing dictation, ${progress}% complete`
    : "Processing dictation";

  return (
    <div
      data-chat-composer-dictation-processing="true"
      className="flex min-w-0 flex-1 items-center gap-2"
      role="status"
      aria-label={label}
    >
      {installing ? (
        <div
          data-chat-composer-dictation-installing="true"
          className="flex min-w-12 flex-1 items-center gap-2"
        >
          <div
            className="bg-muted relative h-1.5 min-w-12 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Installing dictation"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progress === null ? {} : { "aria-valuenow": progress })}
          >
            <div
              className={
                progress === null
                  ? "bg-primary h-full w-1/3 animate-pulse rounded-full"
                  : "bg-primary h-full rounded-full transition-[width] duration-500"
              }
              style={progress === null ? undefined : { width: `${progress}%` }}
            />
          </div>
          {progress === null ? null : (
            <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
              {progress}%
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="relative h-6 min-w-12 flex-1 overflow-hidden" aria-hidden="true">
            <div className="border-muted-foreground/35 absolute inset-x-0 top-1/2 border-t border-dashed" />
          </div>
          <LoaderCircleIcon
            data-chat-composer-dictation-spinner="true"
            className="text-muted-foreground size-4 shrink-0 animate-spin"
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
}
