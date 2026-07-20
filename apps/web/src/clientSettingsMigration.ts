import { CURRENT_CLIENT_SETTINGS_VERSION, type ClientSettings } from "@salchi/contracts/settings";

export function migrateClientSettings(settings: ClientSettings): ClientSettings {
  if (settings.clientSettingsVersion >= CURRENT_CLIENT_SETTINGS_VERSION) {
    return settings;
  }

  return {
    ...settings,
    // Auto-opening was previously the default, so legacy persisted settings cannot distinguish
    // that default from an explicit opt-in. Reset it once now that the panel is opt-in.
    autoOpenPlanSidebar: false,
    clientSettingsVersion: CURRENT_CLIENT_SETTINGS_VERSION,
  };
}
