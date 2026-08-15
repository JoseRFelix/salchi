// @effect-diagnostics nodeBuiltinImport:off - The regression test inspects temporary build assets.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { precompressAssets, shouldPrecompressAsset } from "./precompressed-assets.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("precompressed assets", () => {
  it("writes Brotli and gzip sidecars that decode to the emitted asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "salchi-precompressed-assets-"));
    temporaryDirectories.push(directory);
    const source = Buffer.from("const mobilePayload = 'compressible';\n".repeat(200));
    const sourcePath = join(directory, "app.js");
    await writeFile(sourcePath, source);

    const summary = await precompressAssets(directory);

    expect(summary.sourceFiles).toBe(1);
    expect(summary.brotliFiles).toBe(1);
    expect(summary.gzipFiles).toBe(1);
    expect(brotliDecompressSync(await readFile(`${sourcePath}.br`))).toEqual(source);
    expect(gunzipSync(await readFile(`${sourcePath}.gz`))).toEqual(source);
  });

  it("skips small and already-compressed asset formats", () => {
    expect(shouldPrecompressAsset("index.html", 1_024)).toBe(true);
    expect(shouldPrecompressAsset("index.html", 1_023)).toBe(false);
    expect(shouldPrecompressAsset("photo.png", 10_000)).toBe(false);
    expect(shouldPrecompressAsset("font.woff2", 10_000)).toBe(false);
  });
});
