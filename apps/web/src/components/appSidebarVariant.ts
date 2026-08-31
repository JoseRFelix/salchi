export function isSettingsSidebarPath(pathname: string): boolean {
  return pathname === "/themes" || pathname === "/settings" || pathname.startsWith("/settings/");
}
