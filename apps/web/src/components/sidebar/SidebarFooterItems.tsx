import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarPwaUpdateButton } from "./SidebarPwaUpdateButton";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarUsageIndicator } from "./SidebarUsageIndicator";

export function SidebarFooterItems() {
  return (
    <>
      <SidebarPwaUpdateButton />
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarUsageIndicator />
    </>
  );
}
