import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { PwaPushNotificationPrompt } from "./pwa-push-notification-prompt";
import { PushSubscriptionReconciler } from "../push/PushSubscriptionReconciler";

export function RootDeferredOverlays({
  primaryEnvironmentAuthenticated,
}: {
  primaryEnvironmentAuthenticated: boolean;
}) {
  return (
    <>
      {primaryEnvironmentAuthenticated ? <PushSubscriptionReconciler /> : null}
      {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
      {primaryEnvironmentAuthenticated ? <PwaPushNotificationPrompt /> : null}
    </>
  );
}
