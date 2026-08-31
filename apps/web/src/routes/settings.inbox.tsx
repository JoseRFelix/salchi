import { createFileRoute } from "@tanstack/react-router";

import { InboxSettingsPanel } from "../components/settings/ThreadExperienceSettings";

function SettingsInboxRoute() {
  return <InboxSettingsPanel />;
}

export const Route = createFileRoute("/settings/inbox")({
  component: SettingsInboxRoute,
});
