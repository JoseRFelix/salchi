import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isStandalonePwa } from "../env";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  enablePushNotifications,
  getBrowserPushSupport,
  getCurrentPushSubscription,
  getNotificationPermission,
  preparePushNotifications,
  type PreparedPushNotifications,
} from "../push/notifications";
import {
  isPwaPushPromptHandled,
  markPwaPushPromptHandled,
  shouldOfferPwaPushPrompt,
} from "../push/pwa-push-prompt";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

let pwaPushPromptEligibilityChecked = false;
const DESKTOP_PUSH_PROMPT_DELAY_MS = 5_000;

interface PushNotificationPromptDialogProps {
  readonly description: string;
  readonly isEnabling: boolean;
  readonly onDismiss: () => void;
  readonly onEnable: () => void;
  readonly open: boolean;
}

export function PushNotificationPromptDialog({
  description,
  isEnabling,
  onDismiss,
  onEnable,
  open,
}: PushNotificationPromptDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isEnabling) {
          return;
        }
        if (!nextOpen) {
          onDismiss();
        }
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!isEnabling}>
        <DialogHeader>
          <DialogTitle>Enable push notifications?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={isEnabling} onClick={onDismiss}>
            Not now
          </Button>
          <Button disabled={isEnabling} onClick={onEnable}>
            {isEnabling ? <LoaderIcon className="size-4 animate-spin" /> : "Enable notifications"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function PwaPushNotificationPrompt({ hasRunningTurn }: { hasRunningTurn: boolean }) {
  const support = useMemo(() => getBrowserPushSupport(), []);
  const isMobile = useIsMobile();
  const surface = isStandalonePwa() ? "standalone-pwa" : isMobile ? "other" : "desktop-web";
  const preparedPushRef = useRef<PreparedPushNotifications | null>(null);
  const [open, setOpen] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);

  useEffect(() => {
    if (pwaPushPromptEligibilityChecked) {
      return;
    }

    const permission = getNotificationPermission();
    const promptHandled = isPwaPushPromptHandled();
    const syncEligible = shouldOfferPwaPushPrompt({
      surface,
      hasRunningTurn,
      pushSupported: support.supported,
      permission,
      isSubscribed: false,
      promptHandled,
    });

    if (!syncEligible) {
      return;
    }

    const timeoutId = setTimeout(
      () => {
        if (pwaPushPromptEligibilityChecked) {
          return;
        }
        pwaPushPromptEligibilityChecked = true;

        void (async () => {
          try {
            const prepared = await preparePushNotifications();
            const subscription = await getCurrentPushSubscription(prepared);
            if (subscription !== null) {
              markPwaPushPromptHandled();
              return;
            }
            preparedPushRef.current = prepared;
            setOpen(true);
          } catch {
            // If setup or subscription status cannot be determined, skip the prompt.
          }
        })();
      },
      surface === "desktop-web" ? DESKTOP_PUSH_PROMPT_DELAY_MS : 0,
    );

    return () => clearTimeout(timeoutId);
  }, [hasRunningTurn, support.supported, surface]);

  const handleDismiss = useCallback(() => {
    markPwaPushPromptHandled();
    setOpen(false);
  }, []);

  const handleEnable = useCallback(() => {
    setIsEnabling(true);
    void (async () => {
      try {
        await enablePushNotifications(preparedPushRef.current ?? undefined);
        markPwaPushPromptHandled();
        setOpen(false);
        toastManager.add({
          type: "success",
          title: "Push notifications enabled",
          description: "This browser is subscribed to server notifications.",
        });
      } catch (error) {
        if (getNotificationPermission() !== "granted") {
          markPwaPushPromptHandled();
        }
        setOpen(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Push notification update failed",
            description: error instanceof Error ? error.message : "Unable to update notifications.",
          }),
        );
      } finally {
        setIsEnabling(false);
      }
    })();
  }, []);

  const description =
    surface === "desktop-web"
      ? "Switch tabs or windows while this turn runs. Salchi will alert you when it finishes or needs your approval or input."
      : "Get alerts when an agent needs approval or input, or when a turn completes. This is especially useful when the app is in the background on mobile.";

  return (
    <PushNotificationPromptDialog
      description={description}
      isEnabling={isEnabling}
      onDismiss={handleDismiss}
      onEnable={handleEnable}
      open={open}
    />
  );
}
