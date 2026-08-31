export function isSettingsSidebarPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}
