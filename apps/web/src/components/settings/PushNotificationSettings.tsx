import { BellIcon, BellOffIcon, LoaderIcon, SendIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  disablePushNotifications,
  enablePushNotifications,
  getBrowserPushSupport,
  getNotificationPermission,
  pushSupportReasonLabel,
  reconcileCurrentPushSubscription,
  sendTestPushNotification,
} from "../../push/notifications";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

type PendingAction = "enable" | "disable" | "test" | null;

export function PushNotificationSettingsRow() {
  const support = useMemo(() => getBrowserPushSupport(), []);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    getNotificationPermission(),
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(support.supported);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const refresh = useCallback(async () => {
    if (!support.supported) {
      setIsSubscribed(false);
      setIsLoading(false);
      setPermission(getNotificationPermission());
      return;
    }

    setIsLoading(true);
    try {
      const subscription = await reconcileCurrentPushSubscription();
      setIsSubscribed(subscription !== null);
      setPermission(getNotificationPermission());
    } catch {
      setIsSubscribed(false);
    } finally {
      setIsLoading(false);
    }
  }, [support.supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: Exclude<PendingAction, null>, task: () => Promise<unknown>) => {
      setPendingAction(action);
      try {
        await task();
        await refresh();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Push notification update failed",
            description: error instanceof Error ? error.message : "Unable to update notifications.",
          }),
        );
      } finally {
        setPendingAction(null);
      }
    },
    [refresh],
  );

  const handleEnable = useCallback(() => {
    void runAction("enable", async () => {
      await enablePushNotifications();
      toastManager.add({
        type: "success",
        title: "Push notifications enabled",
        description: "This browser is subscribed to server notifications.",
      });
    });
  }, [runAction]);

  const handleDisable = useCallback(() => {
    void runAction("disable", disablePushNotifications);
  }, [runAction]);

  const handleTest = useCallback(() => {
    void runAction("test", async () => {
      const result = await sendTestPushNotification();
      toastManager.add({
        type: "success",
        title: "Test notification sent",
        description:
          result.sentCount === 1
            ? "Sent to this browser."
            : `Sent to ${result.sentCount.toString()} browsers.`,
      });
    });
  }, [runAction]);

  const description = support.supported
    ? "Receive browser alerts when an agent needs attention or completes a turn."
    : pushSupportReasonLabel(support.reason);
  const status =
    permission === "denied"
      ? "Notifications are blocked for this site in the browser."
      : isSubscribed
        ? "Enabled for this browser."
        : "Disabled for this browser.";
  const controlsDisabled = isLoading || pendingAction !== null || !support.supported;

  return (
    <SettingsRow
      title="Push notifications"
      description={description}
      status={support.supported ? status : null}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {isLoading ? (
            <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
          ) : isSubscribed ? (
            <>
              <Button size="xs" variant="outline" disabled={controlsDisabled} onClick={handleTest}>
                {pendingAction === "test" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <SendIcon className="size-3.5" />
                )}
                Test
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={controlsDisabled}
                onClick={handleDisable}
              >
                {pendingAction === "disable" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <BellOffIcon className="size-3.5" />
                )}
                Disable
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={controlsDisabled || permission === "denied"}
              onClick={handleEnable}
            >
              {pendingAction === "enable" ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <BellIcon className="size-3.5" />
              )}
              Enable
            </Button>
          )}
        </div>
      }
    />
  );
}
