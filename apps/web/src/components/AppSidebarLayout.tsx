import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { useSidebarNavigationMode } from "../hooks/useSettings";
import ThreadSidebar from "./Sidebar";
import { resolveAppSidebarVariant } from "./appSidebarVariant";
import { CommandPaletteOverlay } from "./CommandPaletteBoundary";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const InboxSidebar = lazy(() => import("./InboxSidebar"));
const InboxIntroductionDialog = lazy(async () => {
  const module = await import("./inbox/InboxIntroductionDialog");
  return { default: module.InboxIntroductionDialog };
});

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const sidebarNavigationMode = useSidebarNavigationMode();
  const sidebarVariant = resolveAppSidebarVariant({ pathname, sidebarNavigationMode });
  const [mountDeferredInboxIntroduction, setMountDeferredInboxIntroduction] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMountDeferredInboxIntroduction(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {sidebarVariant === "settings" ? (
          <>
            <SidebarChromeHeader isElectron={isElectron} />
            <SettingsSidebarNav pathname={pathname} />
          </>
        ) : sidebarVariant === "project" ? (
          <ThreadSidebar />
        ) : (
          <Suspense fallback={null}>
            <InboxSidebar />
          </Suspense>
        )}
        <SidebarRail />
      </Sidebar>
      {children}
      <CommandPaletteOverlay />
      {mountDeferredInboxIntroduction ? (
        <Suspense fallback={null}>
          <InboxIntroductionDialog />
        </Suspense>
      ) : null}
    </SidebarProvider>
  );
}
