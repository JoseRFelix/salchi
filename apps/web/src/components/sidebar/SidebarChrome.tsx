import { Link, useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../../branding";
import { ConnectionStatusGlyph, useConnectionIndicatorView } from "../ConnectionStatusIndicator";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarFooterItems } from "./SidebarFooterItems";

function SalchiLogo() {
  return (
    <span aria-hidden="true" className="relative size-[25px] shrink-0 overflow-hidden">
      <img
        alt=""
        className="absolute -top-[5.25px] -left-[7px] size-[39px] max-w-none"
        src="/salchi-logo.png"
      />
    </span>
  );
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <SalchiLogo />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                {APP_DISPLAY_NAME}
              </span>
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]">
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">{wordmark}</SidebarHeader>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarFooterItems />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarSettingsButton onClick={handleSettingsClick} />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

const SidebarSettingsButton = memo(function SidebarSettingsButton({
  onClick,
}: {
  readonly onClick: () => void;
}) {
  const connection = useConnectionIndicatorView();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            aria-label={`Settings. Connection status: ${connection.label}.`}
            onClick={onClick}
          >
            <SettingsIcon className="size-3.5" />
            <span>Settings</span>
            <span
              aria-hidden="true"
              className="ms-auto flex size-3.5 shrink-0 items-center justify-center"
            >
              <ConnectionStatusGlyph tone={connection.tone} />
            </span>
          </SidebarMenuButton>
        }
      />
      <TooltipPopup align="end" side="top">
        {connection.label}
      </TooltipPopup>
    </Tooltip>
  );
});
