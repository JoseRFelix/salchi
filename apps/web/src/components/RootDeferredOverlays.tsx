import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { SshPasswordPromptDialog } from "./desktop/SshPasswordPromptDialog";
import { PwaPushNotificationPrompt } from "./pwa-push-notification-prompt";

export function RootDeferredOverlays({
  primaryEnvironmentAuthenticated,
}: {
  primaryEnvironmentAuthenticated: boolean;
}) {
  return (
    <>
      <SshPasswordPromptDialog />
      {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
      {primaryEnvironmentAuthenticated ? <PwaPushNotificationPrompt /> : null}
    </>
  );
}
