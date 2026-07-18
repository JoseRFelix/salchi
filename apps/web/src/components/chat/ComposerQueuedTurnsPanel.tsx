import { memo, useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  Trash2Icon,
} from "lucide-react";

import type { MessageId } from "@t3tools/contracts";
import type { QueuedTurn } from "../../types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

interface ComposerQueuedTurnsPanelProps {
  queuedTurns: readonly QueuedTurn[];
  cancelingQueuedMessageIds: ReadonlySet<MessageId>;
  steeringQueuedMessageIds: ReadonlySet<MessageId>;
  steerableQueuedMessageIds: ReadonlySet<MessageId>;
  canSteerQueuedTurns: boolean;
  onCancelQueuedTurn: (messageId: MessageId) => void;
  onSteerQueuedTurn: (messageId: MessageId) => void;
}

function formatQueuedTurnTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export const ComposerQueuedTurnsPanel = memo(function ComposerQueuedTurnsPanel(
  props: ComposerQueuedTurnsPanelProps,
) {
  const {
    queuedTurns,
    cancelingQueuedMessageIds,
    steeringQueuedMessageIds,
    steerableQueuedMessageIds,
    canSteerQueuedTurns,
    onCancelQueuedTurn,
    onSteerQueuedTurn,
  } = props;
  const [open, setOpen] = useState(queuedTurns.length > 0);
  const previousCountRef = useRef(queuedTurns.length);

  useEffect(() => {
    if (previousCountRef.current === 0 && queuedTurns.length > 0) {
      setOpen(true);
    }
    previousCountRef.current = queuedTurns.length;
  }, [queuedTurns.length]);

  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-b border-border/65 bg-muted/15">
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground text-sm sm:px-4"
          aria-label={open ? "Collapse queued messages" : "Expand queued messages"}
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", open ? "rotate-0" : "-rotate-90")}
            aria-hidden="true"
          />
          <span className="font-medium">{queuedTurns.length} Queued</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-1 px-2 pb-2 sm:px-3">
            {queuedTurns.map((queuedTurn) => {
              const attachmentCount = queuedTurn.attachments.length;
              const timestamp = formatQueuedTurnTimestamp(queuedTurn.createdAt);
              const isSteering =
                queuedTurn.steering !== undefined ||
                steeringQueuedMessageIds.has(queuedTurn.messageId);
              return (
                <div
                  key={queuedTurn.messageId}
                  className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-background/55"
                >
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5">
                      {queuedTurn.text}
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground text-xs">
                      {attachmentCount > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <PaperclipIcon className="size-3.5" aria-hidden="true" />
                          {attachmentCount}
                        </span>
                      ) : null}
                      {timestamp ? <span>{timestamp}</span> : null}
                    </div>
                    {attachmentCount > 0 ? (
                      <div className="mt-1.5 flex gap-1.5">
                        {queuedTurn.attachments.slice(0, 3).map((attachment) => (
                          <div
                            key={attachment.id}
                            className="size-9 overflow-hidden rounded border border-border/65 bg-background"
                          >
                            {attachment.previewUrl ? (
                              attachment.type === "image" ? (
                                <img
                                  src={attachment.previewUrl}
                                  alt={attachment.name}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                  <FileTextIcon className="size-4" aria-hidden="true" />
                                </div>
                              )
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                {attachment.type === "pdf" ? (
                                  <FileTextIcon className="size-4" aria-hidden="true" />
                                ) : (
                                  <ImageIcon className="size-4" aria-hidden="true" />
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex shrink-0 items-center gap-1">
                    {canSteerQueuedTurns ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                        disabled={
                          !steerableQueuedMessageIds.has(queuedTurn.messageId) ||
                          isSteering ||
                          cancelingQueuedMessageIds.has(queuedTurn.messageId)
                        }
                        aria-label="Steer queued message into the current turn"
                        title={
                          steerableQueuedMessageIds.has(queuedTurn.messageId)
                            ? "Steer into current turn"
                            : "Waiting for queued message to sync"
                        }
                        onClick={() => onSteerQueuedTurn(queuedTurn.messageId)}
                      >
                        {isSteering ? (
                          <LoaderCircleIcon className="animate-spin" />
                        ) : (
                          <CornerDownLeftIcon />
                        )}
                        Steer now
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={cancelingQueuedMessageIds.has(queuedTurn.messageId) || isSteering}
                      aria-label="Cancel queued message"
                      title="Cancel queued message"
                      onClick={() => onCancelQueuedTurn(queuedTurn.messageId)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
