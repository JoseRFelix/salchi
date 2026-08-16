export const BRAND_ASSET_PATHS = {
  salchiIconPng: "assets/salchi/salchi-icon-1024.png",
  salchiIcon512Png: "assets/salchi/salchi-icon-512.png",
  salchiIcon192Png: "assets/salchi/salchi-icon-192.png",
  salchiAppleTouchIconPng: "assets/salchi/salchi-icon-180.png",
  salchiIconIco: "assets/salchi/salchi-icon.ico",
  salchiReadmeLogoPng: "assets/salchi/salchi-logo.png",
  salchiWebLogoPng: "assets/salchi/salchi-logo.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForConfiguredChannel(
  channel: string | null | undefined,
): WebAssetBrand {
  const normalizedChannel = channel?.trim().toLowerCase();
  return normalizedChannel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  salchiLogoPng: "salchi-logo.png",
  salchiPwa192Png: "salchi-pwa-192.png",
  salchiPwa512Png: "salchi-pwa-512.png",
  salchiAppleTouchIconPng: "apple-touch-icon.png",
} as const;

const SALCHI_WEB_ICON_SOURCE_PATHS = {
  salchiLogoPng: BRAND_ASSET_PATHS.salchiWebLogoPng,
  salchiPwa192Png: BRAND_ASSET_PATHS.salchiIcon192Png,
  salchiPwa512Png: BRAND_ASSET_PATHS.salchiIcon512Png,
  salchiAppleTouchIconPng: BRAND_ASSET_PATHS.salchiAppleTouchIconPng,
} as const satisfies Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: SALCHI_WEB_ICON_SOURCE_PATHS,
  nightly: SALCHI_WEB_ICON_SOURCE_PATHS,
  production: SALCHI_WEB_ICON_SOURCE_PATHS,
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.salchiLogoPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.salchiLogoPng}`,
    },
    {
      sourceRelativePath: sourcePaths.salchiPwa192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.salchiPwa192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.salchiPwa512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.salchiPwa512Png}`,
    },
    {
      sourceRelativePath: sourcePaths.salchiAppleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.salchiAppleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const PUBLISH_ICON_OVERRIDES = resolveWebIconOverrides("production", "dist/client");
