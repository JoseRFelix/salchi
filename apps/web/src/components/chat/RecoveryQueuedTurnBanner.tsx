import type { MessageId } from "@salchi/contracts";
import { ShieldAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const MAX_PREVIEW_LENGTH = 140;

function recoveryMessagePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PREVIEW_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

export function createRecoveryQueuedTurnBannerItem(input: {
  readonly messageId: MessageId;
  readonly text: string;
  readonly isSending: boolean;
  readonly isDiscarding: boolean;
  readonly onSend: () => void;
  readonly onDiscard: () => void;
}): ComposerBannerStackItem {
  const preview = recoveryMessagePreview(input.text);
  const busy = input.isSending || input.isDiscarding;

  return {
    id: `recovery-queued-turn:${input.messageId}`,
    variant: "warning",
    icon: <ShieldAlertIcon />,
    title: "Another message was queued during recovery — Send or discard?",
    description:
      preview.length > 0
        ? `Salchi paused “${preview}” so it won’t run automatically.`
        : "Salchi paused this message so it won’t run automatically.",
    actions: (
      <>
        <Button size="xs" disabled={busy} onClick={input.onSend}>
          {input.isSending ? "Sending…" : "Send"}
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={input.onDiscard}>
          {input.isDiscarding ? "Discarding…" : "Discard"}
        </Button>
      </>
    ),
  };
}
