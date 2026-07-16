import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { PwaPushNotificationPrompt } from "./pwa-push-notification-prompt";

export function RootDeferredOverlays({
  primaryEnvironmentAuthenticated,
}: {
  primaryEnvironmentAuthenticated: boolean;
}) {
  return (
    <>
      {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
      {primaryEnvironmentAuthenticated ? <PwaPushNotificationPrompt /> : null}
    </>
  );
}
