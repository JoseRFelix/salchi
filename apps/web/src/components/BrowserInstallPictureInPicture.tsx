import type { EnvironmentId, ThreadId } from "@salchi/contracts";
import { AppWindowIcon, XIcon } from "lucide-react";

import type {
  BrowserViewportState,
  BrowserViewportStateAction,
} from "../browser/browserViewportState";
import { useManagedBrowserInstall } from "../browser/useManagedBrowserInstall";
import { BrowserInstallOffer } from "./BrowserInstallOffer";

export function BrowserInstallPictureInPicture(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onOpenPanel: () => void;
  readonly onStateAction: (action: BrowserViewportStateAction) => void;
  readonly state: BrowserViewportState;
  readonly threadId: ThreadId;
}) {
  const managedBrowser = useManagedBrowserInstall({
    active: true,
    environmentId: props.environmentId,
    onStateAction: props.onStateAction,
    state: props.state,
    threadId: props.threadId,
  });
  if (props.state.unavailableReason === null) return null;

  return (
    <section
      aria-label="Browser installation required"
      className="absolute bottom-3 right-3 z-40 w-[min(24rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-border/80 bg-card shadow-xl"
      data-testid="browser-install-picture-in-picture"
    >
      <header className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
        <AppWindowIcon className="size-3.5 text-primary" />
        <button
          className="min-w-0 flex-1 truncate text-left font-medium text-xs"
          onClick={props.onOpenPanel}
          type="button"
        >
          Browser setup needed
        </button>
        <button
          aria-label="Close browser setup prompt"
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onClose}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>
      <BrowserInstallOffer
        compact
        dependencyCommand={props.state.dependencyCommand}
        installState={props.state.installState}
        loading={managedBrowser.pendingOperation !== null}
        onCancel={() => void managedBrowser.cancel()}
        onCheckAgain={() => void managedBrowser.checkAgain()}
        onInstall={() => void managedBrowser.install()}
        onRetryStart={() => void managedBrowser.start()}
        onVariantChange={(variant) => void managedBrowser.selectVariant(variant)}
        reason={props.state.unavailableReason}
        selectedVariant={managedBrowser.managedVariant}
      />
    </section>
  );
}
