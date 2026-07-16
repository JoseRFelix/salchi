import { SidebarConnectionStatus } from "../ConnectionStatusIndicator";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarPwaUpdateButton } from "./SidebarPwaUpdateButton";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarUsageIndicator } from "./SidebarUsageIndicator";

export function SidebarDeferredFooterItems() {
  return (
    <>
      <SidebarPwaUpdateButton />
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarUsageIndicator />
      <SidebarConnectionStatus />
    </>
  );
}
