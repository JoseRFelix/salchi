import { createFileRoute } from "@tanstack/react-router";

import { ChatSettingsPanel } from "../components/settings/ThreadExperienceSettings";

function SettingsChatRoute() {
  return <ChatSettingsPanel />;
}

export const Route = createFileRoute("/settings/chat")({
  component: SettingsChatRoute,
});
