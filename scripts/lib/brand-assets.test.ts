// @effect-diagnostics nodeBuiltinImport:off - The regression test reads PNG headers from repository assets.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
  resolveWebAssetBrandForConfiguredChannel,
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

function readPngSize(filePath: string): { readonly width: number; readonly height: number } {
  const png = readFileSync(new URL(`../../${filePath}`, import.meta.url));
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe("brand-assets", () => {
  it("maps server publish web assets to production icons", () => {
    expect(PUBLISH_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiWebLogoPng,
        targetRelativePath: "dist/client/salchi-logo.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiIcon192Png,
        targetRelativePath: "dist/client/salchi-pwa-192.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiIcon512Png,
        targetRelativePath: "dist/client/salchi-pwa-512.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.salchiAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiWebLogoPng,
      targetRelativePath: "dist/client/salchi-logo.png",
    });
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiWebLogoPng,
      targetRelativePath: "apps/web/dist/salchi-logo.png",
    });
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiIcon512Png,
      targetRelativePath: "apps/web/dist/salchi-pwa-512.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.salchiIcon192Png,
      targetRelativePath: "apps/web/dist/salchi-pwa-192.png",
    });
  });

  it("ships Salchi icon sources at their declared pixel sizes", () => {
    expect(BRAND_ASSET_PATHS.salchiReadmeLogoPng).toBe(BRAND_ASSET_PATHS.salchiWebLogoPng);
    expect(readPngSize(BRAND_ASSET_PATHS.salchiReadmeLogoPng)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(readPngSize(BRAND_ASSET_PATHS.salchiIconPng)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(readPngSize(BRAND_ASSET_PATHS.salchiIcon512Png)).toEqual({
      width: 512,
      height: 512,
    });
    expect(readPngSize(BRAND_ASSET_PATHS.salchiIcon192Png)).toEqual({
      width: 192,
      height: 192,
    });
    expect(readPngSize(BRAND_ASSET_PATHS.salchiAppleTouchIconPng)).toEqual({
      width: 180,
      height: 180,
    });
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });

  it("defaults configured web asset channels to production", () => {
    expect(resolveWebAssetBrandForConfiguredChannel(undefined)).toBe("production");
    expect(resolveWebAssetBrandForConfiguredChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForConfiguredChannel("preview")).toBe("production");
    expect(resolveWebAssetBrandForConfiguredChannel(" nightly ")).toBe("nightly");
  });
});
