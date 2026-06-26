import { useEffect, useRef } from "react";
import type { ImportedColorThemeReference } from "@t3tools/contracts/settings";

import { ensureLocalApi } from "../localApi";
import {
  getImportedTheme,
  importedThemeRecordsFromImportResult,
  saveImportedThemes,
} from "../importedThemes";
import { DEFAULT_THEME_SENTINEL, setColorThemeSelection } from "./useColorTheme";
import {
  getClientSettings,
  useClientSettingsHydrated,
  useSettings,
  useUpdateSettings,
} from "./useSettings";
import { useServerConfig } from "~/rpc/serverState";

/**
 * Reconciles the synced color-theme selection (server settings) into the local
 * fast path, and re-fetches any imported (Open VSX) theme referenced by the
 * synced selection whose colors aren't cached on this device. Mounted once at
 * the app root so a theme chosen on one device follows the user to another.
 */
export function useColorThemeSync() {
  const colorThemeLight = useSettings((settings) => settings.colorThemeLight);
  const colorThemeDark = useSettings((settings) => settings.colorThemeDark);
  const importedThemes = useSettings((settings) => settings.importedThemes);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const { updateSettings } = useUpdateSettings();
  const serverConfig = useServerConfig();
  const attemptedLegacyMigrationRef = useRef(false);

  useEffect(() => {
    if (!clientSettingsHydrated || !serverConfig) return;

    if (!attemptedLegacyMigrationRef.current) {
      attemptedLegacyMigrationRef.current = true;
      const legacyClientSettings = getClientSettings();
      if (
        shouldPromoteLegacyColorThemeSettings({
          server: {
            colorThemeLight,
            colorThemeDark,
            importedThemes,
          },
          legacy: {
            colorThemeLight: legacyClientSettings.colorThemeLight,
            colorThemeDark: legacyClientSettings.colorThemeDark,
            importedThemes: legacyClientSettings.importedThemes,
          },
        })
      ) {
        updateSettings({
          colorThemeLight: legacyClientSettings.colorThemeLight,
          colorThemeDark: legacyClientSettings.colorThemeDark,
          importedThemes: dedupeImportedThemeReferences(legacyClientSettings.importedThemes),
        });
        setColorThemeSelection(
          legacyClientSettings.colorThemeLight,
          legacyClientSettings.colorThemeDark,
        );
        return;
      }
    }

    setColorThemeSelection(colorThemeLight, colorThemeDark);
  }, [
    clientSettingsHydrated,
    colorThemeDark,
    colorThemeLight,
    importedThemes,
    serverConfig,
    updateSettings,
  ]);

  useEffect(() => {
    for (const ref of importedThemes) {
      if (getImportedTheme(ref.id)) continue;
      void ensureLocalApi()
        .themes.import({ namespace: ref.namespace, name: ref.name, version: ref.version })
        .then((result) => saveImportedThemes(importedThemeRecordsFromImportResult(result)))
        .catch(() => {
          // Best-effort: a missing imported theme falls back to its mapped
          // tokens being unavailable until the next successful import.
        });
    }
  }, [importedThemes]);
}

function isDefaultColorThemeSelection(input: {
  readonly colorThemeLight: string;
  readonly colorThemeDark: string;
  readonly importedThemes: ReadonlyArray<ImportedColorThemeReference>;
}): boolean {
  return (
    input.colorThemeLight === DEFAULT_THEME_SENTINEL &&
    input.colorThemeDark === DEFAULT_THEME_SENTINEL &&
    input.importedThemes.length === 0
  );
}

function shouldPromoteLegacyColorThemeSettings(input: {
  readonly server: {
    readonly colorThemeLight: string;
    readonly colorThemeDark: string;
    readonly importedThemes: ReadonlyArray<ImportedColorThemeReference>;
  };
  readonly legacy: {
    readonly colorThemeLight: string;
    readonly colorThemeDark: string;
    readonly importedThemes: ReadonlyArray<ImportedColorThemeReference>;
  };
}): boolean {
  return isDefaultColorThemeSelection(input.server) && !isDefaultColorThemeSelection(input.legacy);
}

function dedupeImportedThemeReferences(
  references: ReadonlyArray<ImportedColorThemeReference>,
): ImportedColorThemeReference[] {
  const seen = new Set<string>();
  const deduped: ImportedColorThemeReference[] = [];
  for (const reference of references) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    deduped.push(reference);
  }
  return deduped;
}
