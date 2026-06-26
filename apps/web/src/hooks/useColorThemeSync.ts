import { useEffect } from "react";

import { ensureLocalApi } from "../localApi";
import { getImportedTheme, saveImportedThemes } from "../importedThemes";
import { setColorThemeSelection } from "./useColorTheme";
import { useSettings } from "./useSettings";

/**
 * Reconciles the synced color-theme selection (ClientSettings) into the local
 * fast path, and re-fetches any imported (Open VSX) theme referenced by the
 * synced selection whose colors aren't cached on this device. Mounted once at
 * the app root so a theme chosen on one device follows the user to another.
 */
export function useColorThemeSync() {
  const colorThemeLight = useSettings((settings) => settings.colorThemeLight);
  const colorThemeDark = useSettings((settings) => settings.colorThemeDark);
  const importedThemes = useSettings((settings) => settings.importedThemes);

  useEffect(() => {
    setColorThemeSelection(colorThemeLight, colorThemeDark);
  }, [colorThemeLight, colorThemeDark]);

  useEffect(() => {
    for (const ref of importedThemes) {
      if (getImportedTheme(ref.id)) continue;
      void ensureLocalApi()
        .themes.import({ namespace: ref.namespace, name: ref.name, version: ref.version })
        .then((result) =>
          saveImportedThemes(
            result.themes.map((theme) => ({
              id: theme.id,
              label: theme.label,
              type: theme.type,
              namespace: result.namespace,
              name: result.name,
              version: result.version,
              colors: theme.colors,
            })),
          ),
        )
        .catch(() => {
          // Best-effort: a missing imported theme falls back to its mapped
          // tokens being unavailable until the next successful import.
        });
    }
  }, [importedThemes]);
}
