import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceSettingsPanel } from "../components/settings/ThreadExperienceSettings";

function SettingsWorkspaceRoute() {
  return <WorkspaceSettingsPanel />;
}

export const Route = createFileRoute("/settings/workspace")({
  component: SettingsWorkspaceRoute,
});
