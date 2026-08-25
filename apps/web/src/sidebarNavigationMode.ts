import type { SidebarNavigationMode } from "@salchi/contracts/settings";

export function isSidebarSettingsPath(pathname: string): boolean {
  return pathname.startsWith("/settings") || pathname.startsWith("/themes");
}

export function resolveRenderedSidebarMode(input: {
  readonly configuredMode: SidebarNavigationMode;
  readonly pathname: string;
}): SidebarNavigationMode {
  return isSidebarSettingsPath(input.pathname) ? "project" : input.configuredMode;
}
