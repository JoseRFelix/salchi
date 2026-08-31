import type { ClientSettingsPatch, SidebarNavigationMode } from "@salchi/contracts/settings";

export type AppSidebarVariant = "settings" | SidebarNavigationMode;

export function isSettingsSidebarPath(pathname: string): boolean {
  return pathname === "/themes" || pathname === "/settings" || pathname.startsWith("/settings/");
}

export function resolveAppSidebarVariant(input: {
  readonly pathname: string;
  readonly sidebarNavigationMode: SidebarNavigationMode;
}): AppSidebarVariant {
  return isSettingsSidebarPath(input.pathname) ? "settings" : input.sidebarNavigationMode;
}

export function shouldShowInboxIntroduction(input: {
  readonly hasSeenInboxIntroduction: boolean;
  readonly settingsHydrated: boolean;
  readonly sidebarNavigationMode: SidebarNavigationMode;
  readonly pathname: string;
}): boolean {
  return (
    input.settingsHydrated &&
    !input.hasSeenInboxIntroduction &&
    input.sidebarNavigationMode === "project" &&
    !isSettingsSidebarPath(input.pathname)
  );
}

export function sidebarNavigationChoicePatch(
  sidebarNavigationMode: SidebarNavigationMode,
): ClientSettingsPatch {
  return {
    hasSeenInboxIntroduction: true,
    sidebarNavigationMode,
  };
}
