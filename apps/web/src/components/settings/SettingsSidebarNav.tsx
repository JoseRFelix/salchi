import { useCallback, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  FolderIcon,
  GitBranchIcon,
  InboxIcon,
  KeyboardIcon,
  Link2Icon,
  MessageSquareIcon,
  PaletteIcon,
  Settings2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { SidebarPwaUpdateButton } from "../sidebar/SidebarPwaUpdateButton";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/inbox"
  | "/settings/workspace"
  | "/settings/chat"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived"
  | "/themes";

export interface SettingsNavItem {
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}

export interface SettingsNavGroup {
  label: string;
  items: ReadonlyArray<SettingsNavItem>;
}

export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    label: "Preferences",
    items: [
      { label: "General", to: "/settings/general", icon: Settings2Icon },
      { label: "Inbox", to: "/settings/inbox", icon: InboxIcon },
      { label: "Workspace", to: "/settings/workspace", icon: FolderIcon },
      { label: "Chat", to: "/settings/chat", icon: MessageSquareIcon },
      { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
      { label: "Themes", to: "/themes", icon: PaletteIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { label: "Providers", to: "/settings/providers", icon: BotIcon },
      { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
      { label: "Connections", to: "/settings/connections", icon: Link2Icon },
    ],
  },
  {
    label: "Data",
    items: [{ label: "Archive", to: "/settings/archived", icon: ArchiveIcon }],
  },
];

export const SETTINGS_NAV_ITEMS = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/", replace: true });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup className="px-2 py-1 first:pt-3 last:pb-3" key={group.label}>
            <SidebarGroupLabel className="h-6 px-2 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/50">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.to;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      size="sm"
                      isActive={isActive}
                      className={
                        isActive
                          ? "gap-2.5 px-2.5 py-2 text-left text-[15px] font-medium text-foreground md:text-[13px]"
                          : "gap-2.5 px-2.5 py-2 text-left text-[15px] text-muted-foreground/70 hover:text-foreground/80 md:text-[13px]"
                      }
                      onClick={() => handleSectionClick(item.to)}
                    >
                      <Icon
                        className={
                          isActive
                            ? "size-4 shrink-0 text-foreground"
                            : "size-4 shrink-0 text-muted-foreground/60"
                        }
                      />
                      <span className="truncate">{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarPwaUpdateButton />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
