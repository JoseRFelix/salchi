import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import type { DiffWorkerPoolProfile } from "../../diffWorkerPoolConfig";
import {
  useBrowserRightPanelContent,
  usePlanRightPanelContent,
} from "../../rightPanelContentRegistry";
import type { WorkspaceFilePreviewDiffReturnTarget } from "../../workspaceFilePreview";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../DiffPanelShell";
import { RightPanelSheet } from "../RightPanelSheet";
import { WorkspaceFilesPanel } from "../WorkspaceFilesPanel";
import { Sidebar, SidebarProvider, SidebarRail } from "../ui/sidebar";

const DiffPanel = lazy(() => import("../DiffPanel"));

const RIGHT_INLINE_PANEL_WIDTH_STORAGE_KEY = "chat_right_sidebar_width";
const RIGHT_INLINE_PANEL_DEFAULT_WIDTH = "clamp(24rem,34vw,36rem)";
const RIGHT_INLINE_PANEL_MIN_WIDTH = 22 * 16;
const RIGHT_INLINE_PANEL_MAX_WIDTH = 256 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
export const MOBILE_WORKER_POOL_IDLE_GRACE_MS = 10_000;

const rightPanelSidebarStyle = {
  "--sidebar-width": RIGHT_INLINE_PANEL_DEFAULT_WIDTH,
} as CSSProperties;

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
      <DiffPanel mode={props.mode} />
    </Suspense>
  );
};

function useRetainedMobileWorkerPool(active: boolean, enabled: boolean): boolean {
  const [retained, setRetained] = useState(active && enabled);

  useEffect(() => {
    if (!enabled) {
      setRetained(false);
      return;
    }
    if (active) {
      setRetained(true);
      return;
    }
    if (!retained) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRetained(false);
    }, MOBILE_WORKER_POOL_IDLE_GRACE_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, enabled, retained]);

  return enabled && (active || retained);
}

function useSettledWorkerPoolProfile(useSheet: boolean): {
  readonly profile: DiffWorkerPoolProfile;
  readonly settled: boolean;
} {
  const requestedProfile: DiffWorkerPoolProfile = useSheet ? "memory-constrained" : "standard";
  const [profile, setProfile] = useState(requestedProfile);

  useEffect(() => {
    if (profile !== requestedProfile) {
      setProfile(requestedProfile);
    }
  }, [profile, requestedProfile]);

  return {
    profile,
    settled: profile === requestedProfile,
  };
}

export type ChatRightPanelView = "browser" | "diff" | "files" | "plan";

const RightPanelInlineSidebar = (props: {
  activeView: ChatRightPanelView | null;
  onClose: () => void;
  onOpen: () => void;
  onReturnToDiff: (target: WorkspaceFilePreviewDiffReturnTarget) => void;
  renderDiffContent: boolean;
  renderFileContent: boolean;
  renderBrowserContent: ReactNode;
  renderPlanContent: ReactNode;
}) => {
  const {
    activeView,
    onClose,
    onOpen,
    onReturnToDiff,
    renderDiffContent,
    renderFileContent,
    renderBrowserContent,
    renderPlanContent,
  } = props;
  const open = activeView !== null;
  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpen();
        return;
      }
      onClose();
    },
    [onClose, onOpen],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      data-chat-right-panel-primary="true"
      style={rightPanelSidebarStyle}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth: RIGHT_INLINE_PANEL_MAX_WIDTH,
          minWidth: RIGHT_INLINE_PANEL_MIN_WIDTH,
          ...(activeView === "diff" ? { shouldAcceptWidth: shouldAcceptInlineSidebarWidth } : {}),
          storageKey: RIGHT_INLINE_PANEL_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? (
          <div className={cn("h-full min-h-0", activeView !== "diff" && "hidden")}>
            <DiffWorkerPoolProvider>
              <LazyDiffPanel mode="sidebar" />
            </DiffWorkerPoolProvider>
          </div>
        ) : null}
        {renderFileContent ? (
          <div className={cn("h-full min-h-0", activeView !== "files" && "hidden")}>
            <DiffWorkerPoolProvider>
              <WorkspaceFilesPanel
                mode="sidebar"
                onClose={onClose}
                onReturnToDiff={onReturnToDiff}
                panelOpen={activeView === "files"}
              />
            </DiffWorkerPoolProvider>
          </div>
        ) : null}
        {renderPlanContent ? (
          <div className={cn("h-full min-h-0", activeView !== "plan" && "hidden")}>
            {renderPlanContent}
          </div>
        ) : null}
        {renderBrowserContent ? (
          <div className={cn("h-full min-h-0", activeView !== "browser" && "hidden")}>
            {renderBrowserContent}
          </div>
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

export function ChatRightPanels(props: {
  readonly activeView: ChatRightPanelView | null;
  readonly onClose: () => void;
  readonly onOpen: () => void;
  readonly onReturnFromFileToDiff: (target: WorkspaceFilePreviewDiffReturnTarget) => void;
  readonly renderDiffContent: boolean;
  readonly renderFileContent: boolean;
  readonly useSheet: boolean;
}) {
  const {
    activeView,
    onClose,
    onOpen,
    onReturnFromFileToDiff,
    renderDiffContent,
    renderFileContent,
    useSheet,
  } = props;
  const plan = usePlanRightPanelContent();
  const browser = useBrowserRightPanelContent();
  const registeredPanel = browser.open ? browser : plan.open ? plan : null;
  const effectiveActiveView: ChatRightPanelView | null = browser.open
    ? "browser"
    : plan.open
      ? "plan"
      : activeView;
  const effectiveOnClose = registeredPanel?.onClose ?? onClose;
  const hasSheetWorkerContent = renderDiffContent || renderFileContent;
  const retainSheetWorkerPool = useRetainedMobileWorkerPool(hasSheetWorkerContent, useSheet);
  const workerPoolProfile = useSettledWorkerPoolProfile(useSheet);

  // The dependency owns one module-level worker-pool singleton and applies the
  // options from its first mounted provider. Render an empty commit across the
  // responsive boundary so the old profile is fully terminated before another
  // provider can create the replacement pool with different sizing.
  if (!workerPoolProfile.settled) {
    return null;
  }

  if (useSheet) {
    return (
      <RightPanelSheet
        closedChildren={
          retainSheetWorkerPool ? (
            <DiffWorkerPoolProvider profile={workerPoolProfile.profile} />
          ) : null
        }
        open={effectiveActiveView !== null}
        onClose={effectiveOnClose}
      >
        {renderDiffContent || renderFileContent ? (
          <DiffWorkerPoolProvider profile={workerPoolProfile.profile}>
            {renderDiffContent ? (
              <div className={cn("h-full min-h-0", effectiveActiveView !== "diff" && "hidden")}>
                <LazyDiffPanel mode="sheet" />
              </div>
            ) : null}
            {renderFileContent ? (
              <div className={cn("h-full min-h-0", effectiveActiveView !== "files" && "hidden")}>
                <WorkspaceFilesPanel
                  mode="sheet"
                  onClose={effectiveOnClose}
                  onReturnToDiff={onReturnFromFileToDiff}
                  panelOpen={effectiveActiveView === "files"}
                />
              </div>
            ) : null}
          </DiffWorkerPoolProvider>
        ) : null}
        {effectiveActiveView === "plan" ? plan.render("sheet") : null}
        {effectiveActiveView === "browser" ? browser.render("sheet") : null}
      </RightPanelSheet>
    );
  }

  return (
    <RightPanelInlineSidebar
      activeView={effectiveActiveView}
      onClose={effectiveOnClose}
      onOpen={onOpen}
      onReturnToDiff={onReturnFromFileToDiff}
      renderDiffContent={renderDiffContent}
      renderFileContent={renderFileContent}
      renderBrowserContent={effectiveActiveView === "browser" ? browser.render("sidebar") : null}
      renderPlanContent={effectiveActiveView === "plan" ? plan.render("sidebar") : null}
    />
  );
}
