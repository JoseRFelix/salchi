import { Suspense, lazy, useCallback, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { usePlanRightPanelContent } from "../../rightPanelContentRegistry";
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

export type ChatRightPanelView = "diff" | "files" | "plan";

const RightPanelInlineSidebar = (props: {
  activeView: ChatRightPanelView | null;
  onClose: () => void;
  onOpen: () => void;
  onReturnToDiff: (target: WorkspaceFilePreviewDiffReturnTarget) => void;
  renderDiffContent: boolean;
  renderFileContent: boolean;
  renderPlanContent: ReactNode;
}) => {
  const {
    activeView,
    onClose,
    onOpen,
    onReturnToDiff,
    renderDiffContent,
    renderFileContent,
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
  const effectiveActiveView: ChatRightPanelView | null = plan.open ? "plan" : activeView;
  const effectiveOnClose = plan.open ? plan.onClose : onClose;

  // The worker-pool provider eagerly allocates WASM workers on mount, so it must
  // stay gated behind whether any panel content actually renders. It is wrapped
  // around the panel *content* (not the Sheet/Sidebar shells) so the shells stay
  // mounted across open/close — otherwise mounting them already-open skips the
  // enter animation. The pool itself is a refcounted singleton, so the separate
  // providers below share one underlying pool.
  if (useSheet) {
    return (
      <RightPanelSheet open={effectiveActiveView !== null} onClose={effectiveOnClose}>
        {renderDiffContent || renderFileContent ? (
          <DiffWorkerPoolProvider>
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
        {plan.open ? plan.render("sheet") : null}
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
      renderPlanContent={plan.open ? plan.render("sidebar") : null}
    />
  );
}
