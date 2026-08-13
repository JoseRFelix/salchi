import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Keep dismissals outside reconciled thread state so reconnects cannot restore
// the exact banner the user already acknowledged. A different error or thread
// receives a different key and remains visible.
const dismissedThreadErrors = new Set<string>();

function dismissalKey(threadKey: string, error: string): string {
  return JSON.stringify([threadKey, error]);
}

export function dismissThreadError(threadKey: string, error: string): void {
  dismissedThreadErrors.add(dismissalKey(threadKey, error));
}

export function isThreadErrorDismissed(threadKey: string, error: string): boolean {
  return dismissedThreadErrors.has(dismissalKey(threadKey, error));
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="w-full px-3 pt-3 sm:px-5">
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertDescription>
            <Tooltip>
              <TooltipTrigger render={<span className="line-clamp-3 wrap-break-word" />}>
                {error}
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                {error}
              </TooltipPopup>
            </Tooltip>
          </AlertDescription>
          {onDismiss && (
            <AlertAction>
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            </AlertAction>
          )}
        </Alert>
      </div>
    </div>
  );
});
