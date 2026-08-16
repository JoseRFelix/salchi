import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { PwaPushNotificationPrompt } from "./pwa-push-notification-prompt";
import { PushSubscriptionReconciler } from "../push/PushSubscriptionReconciler";
import { selectHasRunningTurnAcrossEnvironments, useStore } from "../store";

export function RootDeferredOverlays({
  primaryEnvironmentAuthenticated,
}: {
  primaryEnvironmentAuthenticated: boolean;
}) {
  const hasRunningTurn = useStore(selectHasRunningTurnAcrossEnvironments);

  return (
    <>
      {primaryEnvironmentAuthenticated ? <PushSubscriptionReconciler /> : null}
      {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
      {primaryEnvironmentAuthenticated ? (
        <PwaPushNotificationPrompt hasRunningTurn={hasRunningTurn} />
      ) : null}
    </>
  );
}
