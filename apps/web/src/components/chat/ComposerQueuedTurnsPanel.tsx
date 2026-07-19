import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import type { MessageId } from "@t3tools/contracts";
import type { QueuedTurn } from "../../types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerQueuedTurnsPanelProps {
  queuedTurns: readonly QueuedTurn[];
  cancelingQueuedMessageIds: ReadonlySet<MessageId>;
  steeringQueuedMessageIds: ReadonlySet<MessageId>;
  updatingQueuedMessageIds: ReadonlySet<MessageId>;
  persistedQueuedMessageIds: ReadonlySet<MessageId>;
  canSteerQueuedTurns: boolean;
  onUpdateQueuedTurn: (messageId: MessageId, text: string) => Promise<boolean>;
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

function resolveSteerDisabledReason(input: {
  isSteerable: boolean;
  isSteering: boolean;
  isCanceling: boolean;
  isUpdating: boolean;
}): string | null {
  if (input.isSteering) {
    return "Steering is already in progress";
  }
  if (input.isCanceling) {
    return "This queued message is being canceled";
  }
  if (input.isUpdating) {
    return "This queued message is being updated";
  }
  if (!input.isSteerable) {
    return "Waiting for queued message to sync";
  }
  return null;
}

function SyncingActionIcon(props: { children: ReactNode; syncing: boolean }) {
  if (!props.syncing) {
    return props.children;
  }

  return (
    <span className="relative inline-flex items-center justify-center">
      <span className="opacity-25">{props.children}</span>
      <LoaderCircleIcon className="absolute animate-spin opacity-100" />
    </span>
  );
}

function QueuedTurnSteerButton(props: {
  messageId: MessageId;
  isSteerable: boolean;
  isSteering: boolean;
  isCanceling: boolean;
  isUpdating: boolean;
  onSteerQueuedTurn: (messageId: MessageId) => void;
}) {
  const disabledReason = resolveSteerDisabledReason(props);
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2"
      disabled={disabledReason !== null}
      aria-label="Steer queued message into the current turn"
      onClick={() => props.onSteerQueuedTurn(props.messageId)}
    >
      <SyncingActionIcon syncing={props.isSteering || !props.isSteerable}>
        <CornerDownLeftIcon />
      </SyncingActionIcon>
      Steer
    </Button>
  );

  if (!disabledReason) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex cursor-not-allowed rounded-lg"
            aria-label={`Steer unavailable: ${disabledReason}`}
            tabIndex={0}
          >
            {button}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-64 text-balance leading-snug">
        {disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
}

export const ComposerQueuedTurnsPanel = memo(function ComposerQueuedTurnsPanel(
  props: ComposerQueuedTurnsPanelProps,
) {
  const {
    queuedTurns,
    cancelingQueuedMessageIds,
    steeringQueuedMessageIds,
    updatingQueuedMessageIds,
    persistedQueuedMessageIds,
    canSteerQueuedTurns,
    onUpdateQueuedTurn,
    onCancelQueuedTurn,
    onSteerQueuedTurn,
  } = props;
  const [open, setOpen] = useState(queuedTurns.length > 0);
  const [editingMessageId, setEditingMessageId] = useState<MessageId | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const previousCountRef = useRef(queuedTurns.length);

  useEffect(() => {
    if (previousCountRef.current === 0 && queuedTurns.length > 0) {
      setOpen(true);
    }
    previousCountRef.current = queuedTurns.length;
  }, [queuedTurns.length]);

  useEffect(() => {
    if (
      editingMessageId !== null &&
      !queuedTurns.some((queuedTurn) => queuedTurn.messageId === editingMessageId)
    ) {
      setEditingMessageId(null);
      setEditDraft("");
    }
  }, [editingMessageId, queuedTurns]);

  const stopEditing = () => {
    setEditingMessageId(null);
    setEditDraft("");
  };

  const saveEdit = async (queuedTurn: QueuedTurn) => {
    const text = editDraft.trim();
    if (text === queuedTurn.text) {
      stopEditing();
      return;
    }
    if (text.length === 0 && queuedTurn.attachments.length === 0) {
      return;
    }
    if (await onUpdateQueuedTurn(queuedTurn.messageId, text)) {
      stopEditing();
    }
  };

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
              const isPersisted = persistedQueuedMessageIds.has(queuedTurn.messageId);
              const isCanceling = cancelingQueuedMessageIds.has(queuedTurn.messageId);
              const isUpdating = updatingQueuedMessageIds.has(queuedTurn.messageId);
              const isEditing = editingMessageId === queuedTurn.messageId;
              const canSaveEdit =
                (editDraft.trim().length > 0 || attachmentCount > 0) &&
                editDraft.trim() !== queuedTurn.text;
              return (
                <div
                  key={queuedTurn.messageId}
                  className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-background/55"
                >
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div>
                        <Textarea
                          autoFocus
                          size="sm"
                          rows={2}
                          value={editDraft}
                          disabled={isUpdating}
                          aria-label="Edit queued message"
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              stopEditing();
                              return;
                            }
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              void saveEdit(queuedTurn);
                            }
                          }}
                        />
                        <div className="mt-1.5 flex justify-end gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={isUpdating}
                            onClick={stopEditing}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            disabled={!canSaveEdit || isUpdating || isCanceling || isSteering}
                            onClick={() => void saveEdit(queuedTurn)}
                          >
                            {isUpdating ? <LoaderCircleIcon className="animate-spin" /> : null}
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5">
                        {queuedTurn.text}
                      </div>
                    )}
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
                  {!isEditing ? (
                    <div className="mt-0.5 flex shrink-0 items-center gap-1">
                      {canSteerQueuedTurns ? (
                        <QueuedTurnSteerButton
                          messageId={queuedTurn.messageId}
                          isSteerable={isPersisted}
                          isSteering={isSteering}
                          isCanceling={isCanceling}
                          isUpdating={isUpdating}
                          onSteerQueuedTurn={onSteerQueuedTurn}
                        />
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="z-10 shrink-0 text-muted-foreground"
                        disabled={!isPersisted || isCanceling || isSteering || isUpdating}
                        aria-label="Edit queued message"
                        title="Edit queued message"
                        onClick={() => {
                          setEditingMessageId(queuedTurn.messageId);
                          setEditDraft(queuedTurn.text);
                        }}
                      >
                        <SyncingActionIcon syncing={!isPersisted}>
                          <PencilIcon />
                        </SyncingActionIcon>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={isCanceling || isSteering || isUpdating}
                        aria-label="Cancel queued message"
                        title="Cancel queued message"
                        onClick={() => onCancelQueuedTurn(queuedTurn.messageId)}
                      >
                        <SyncingActionIcon syncing={!isPersisted}>
                          <Trash2Icon />
                        </SyncingActionIcon>
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
