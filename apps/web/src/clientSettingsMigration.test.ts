import { describe, expect, it } from "vitest";
import {
  CURRENT_CLIENT_SETTINGS_VERSION,
  DEFAULT_CLIENT_SETTINGS,
} from "@salchi/contracts/settings";

import { migrateClientSettings } from "./clientSettingsMigration";

describe("migrateClientSettings", () => {
  it("resets the legacy task-panel auto-open default", () => {
    const migrated = migrateClientSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      clientSettingsVersion: 0,
      autoOpenPlanSidebar: true,
    });

    expect(migrated.clientSettingsVersion).toBe(CURRENT_CLIENT_SETTINGS_VERSION);
    expect(migrated.autoOpenPlanSidebar).toBe(false);
  });

  it("preserves an opt-in saved after the migration", () => {
    const current = {
      ...DEFAULT_CLIENT_SETTINGS,
      autoOpenPlanSidebar: true,
    };

    expect(migrateClientSettings(current)).toBe(current);
    expect(migrateClientSettings(current).autoOpenPlanSidebar).toBe(true);
  });
});
