import { isDesktopPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRemoteBrowserStatus } from "~/rpc/serverState";

export interface BrowserPreviewAvailability {
  readonly available: boolean;
  readonly desktop: boolean;
  readonly remote: boolean;
}

export function useBrowserPreviewAvailability(): BrowserPreviewAvailability {
  const remoteBrowser = useRemoteBrowserStatus();
  const desktop = isDesktopPreviewSupportedInRuntime();
  const remote = remoteBrowser.enabled;
  return {
    available: desktop || remote,
    desktop,
    remote,
  };
}
