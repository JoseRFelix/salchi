import type { ComponentProps } from "react";

import { Sheet } from "./sheet";

const TOAST_PORTAL_SELECTOR = '[data-slot="toast-portal"], [data-slot="toast-portal-anchored"]';
const COMMAND_DIALOG_PORTAL_SELECTOR =
  '[data-slot="command-dialog-backdrop"], [data-slot="command-dialog-viewport"], [data-slot="command-dialog-popup"]';

type SheetOpenChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Sheet>["onOpenChange"]>
>[1];

function targetIsInPortal(target: EventTarget | null | undefined, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

function isPortalDismissalRequest(eventDetails: SheetOpenChangeDetails, selector: string): boolean {
  if (eventDetails.reason !== "outside-press" && eventDetails.reason !== "focus-out") {
    return false;
  }

  if (targetIsInPortal(eventDetails.event.target, selector)) {
    return true;
  }

  return (
    "relatedTarget" in eventDetails.event &&
    targetIsInPortal(eventDetails.event.relatedTarget, selector)
  );
}

export function isToastPortalDismissalRequest(eventDetails: SheetOpenChangeDetails): boolean {
  return isPortalDismissalRequest(eventDetails, TOAST_PORTAL_SELECTOR);
}

export function isCommandDialogPortalDismissalRequest(
  eventDetails: SheetOpenChangeDetails,
): boolean {
  return isPortalDismissalRequest(eventDetails, COMMAND_DIALOG_PORTAL_SELECTOR);
}
