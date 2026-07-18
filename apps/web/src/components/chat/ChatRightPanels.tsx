import { Suspense, lazy, useCallback, type CSSProperties } from "react";

import { cn } from "~/lib/utils";

import { closeWorkspaceFilePreview, reopenWorkspaceFilePanel } from "../../workspaceFilePreview";
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

const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const FILE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_file_preview_sidebar_width";
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

const PrimaryRightPanelInlineSidebar = (props: {
  diffOpen: boolean;
  fileOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  onReturnToDiff: (target: WorkspaceFilePreviewDiffReturnTarget) => void;
  renderDiffContent: boolean;
  renderFileContent: boolean;
}) => {
  const {
    diffOpen,
    fileOpen,
    onCloseDiff,
    onOpenDiff,
    onReturnToDiff,
    renderDiffContent,
    renderFileContent,
  } = props;
  const open = diffOpen || fileOpen;
  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (diffOpen) {
          onOpenDiff();
        } else {
          reopenWorkspaceFilePanel();
        }
        return;
      }
      if (diffOpen) {
        onCloseDiff();
      } else {
        closeWorkspaceFilePreview();
      }
    },
    [diffOpen, onCloseDiff, onOpenDiff],
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
          ...(diffOpen ? { shouldAcceptWidth: shouldAcceptInlineSidebarWidth } : {}),
          storageKey: diffOpen
            ? DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY
            : FILE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? (
          <div className={cn("h-full min-h-0", !diffOpen && "hidden")}>
            <DiffWorkerPoolProvider>
              <LazyDiffPanel mode="sidebar" />
            </DiffWorkerPoolProvider>
          </div>
        ) : null}
        {!diffOpen && renderFileContent ? (
          <DiffWorkerPoolProvider>
            <WorkspaceFilesPanel
              mode="sidebar"
              onReturnToDiff={onReturnToDiff}
              panelOpen={fileOpen}
            />
          </DiffWorkerPoolProvider>
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

const WorkspaceFilesInlineSidebar = (props: {
  open: boolean;
  renderContent: boolean;
  onReturnToDiff: (target: WorkspaceFilePreviewDiffReturnTarget) => void;
}) => {
  const { onReturnToDiff, open, renderContent } = props;
  const onOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      reopenWorkspaceFilePanel();
      return;
    }
    closeWorkspaceFilePreview();
  }, []);

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={rightPanelSidebarStyle}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth: RIGHT_INLINE_PANEL_MAX_WIDTH,
          minWidth: RIGHT_INLINE_PANEL_MIN_WIDTH,
          storageKey: FILE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderContent ? (
          <DiffWorkerPoolProvider>
            <WorkspaceFilesPanel mode="sidebar" onReturnToDiff={onReturnToDiff} panelOpen={open} />
          </DiffWorkerPoolProvider>
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

export function ChatRightPanels(props: {
  diff?: {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly onOpen: () => void;
    readonly renderContent: boolean;
  };
  readonly fileOpen: boolean;
  readonly onReturnFromFileToDiff: (target: WorkspaceFilePreviewDiffReturnTarget) => void;
  readonly renderFileContent: boolean;
  readonly useSheet: boolean;
}) {
  const { diff, fileOpen, onReturnFromFileToDiff, renderFileContent, useSheet } = props;

  // The worker-pool provider eagerly allocates WASM workers on mount, so it must
  // stay gated behind whether any panel content actually renders. It is wrapped
  // around the panel *content* (not the Sheet/Sidebar shells) so the shells stay
  // mounted across open/close — otherwise mounting them already-open skips the
  // enter animation. The pool itself is a refcounted singleton, so the separate
  // providers below share one underlying pool.
  if (useSheet) {
    // Mobile keeps diff and files/source-control in a *single* sheet so moving
    // between source control → diff → file preview swaps content in place
    // instead of cross-animating two sheets. Files wins as the active view when
    // it is open (a preview opened on top of the diff, or source control with no
    // diff); otherwise the diff is active. Closing dismisses only the active
    // layer, leaving any layer underneath to swap back into place.
    const diffOpen = diff?.open ?? false;
    const sheetOpen = diffOpen || fileOpen;
    const filesActive = fileOpen;
    const onCloseSheet = () => {
      if (filesActive) {
        closeWorkspaceFilePreview();
        return;
      }
      diff?.onClose();
    };

    return (
      <RightPanelSheet open={sheetOpen} onClose={onCloseSheet}>
        {diff?.renderContent || renderFileContent ? (
          <DiffWorkerPoolProvider>
            {diff?.renderContent ? (
              <div className={cn("h-full min-h-0", filesActive && "hidden")}>
                <LazyDiffPanel mode="sheet" />
              </div>
            ) : null}
            {renderFileContent ? (
              <div className={cn("h-full min-h-0", !filesActive && "hidden")}>
                <WorkspaceFilesPanel
                  mode="sheet"
                  onReturnToDiff={onReturnFromFileToDiff}
                  panelOpen={fileOpen}
                />
              </div>
            ) : null}
          </DiffWorkerPoolProvider>
        ) : null}
      </RightPanelSheet>
    );
  }

  return (
    <>
      <PrimaryRightPanelInlineSidebar
        diffOpen={diff?.open ?? false}
        fileOpen={fileOpen}
        onCloseDiff={diff?.onClose ?? closeWorkspaceFilePreview}
        onOpenDiff={diff?.onOpen ?? reopenWorkspaceFilePanel}
        onReturnToDiff={onReturnFromFileToDiff}
        renderDiffContent={diff?.renderContent ?? false}
        renderFileContent={renderFileContent}
      />
      {diff?.open ? (
        <WorkspaceFilesInlineSidebar
          open={fileOpen}
          renderContent={renderFileContent}
          onReturnToDiff={onReturnFromFileToDiff}
        />
      ) : null}
    </>
  );
}
