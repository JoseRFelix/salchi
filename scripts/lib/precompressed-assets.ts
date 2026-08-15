// @effect-diagnostics nodeBuiltinImport:off - This build helper precompresses emitted web assets.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import {
  brotliCompress as brotliCompressCallback,
  constants as zlibConstants,
  gzip as gzipCallback,
} from "node:zlib";

const brotliCompress = promisify(brotliCompressCallback);
const gzip = promisify(gzipCallback);

const MIN_PRECOMPRESS_BYTES = 1_024;
const PRECOMPRESS_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".text",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".xml",
]);
const MAX_COMPRESSION_CONCURRENCY = 8;

export interface PrecompressedAssetsSummary {
  readonly sourceFiles: number;
  readonly brotliFiles: number;
  readonly gzipFiles: number;
  readonly sourceBytes: number;
  readonly brotliBytes: number;
  readonly gzipBytes: number;
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      return entry.isDirectory() ? listFilesRecursively(entryPath) : [entryPath];
    }),
  );
  return nestedFiles.flat();
}

export function shouldPrecompressAsset(filePath: string, byteLength: number): boolean {
  return (
    byteLength >= MIN_PRECOMPRESS_BYTES &&
    PRECOMPRESS_EXTENSIONS.has(extname(filePath).toLowerCase())
  );
}

export async function precompressAssets(directory: string): Promise<PrecompressedAssetsSummary> {
  const files = await listFilesRecursively(directory);
  const candidates: Array<{ readonly filePath: string; readonly source: Buffer }> = [];

  for (const filePath of files) {
    if (!PRECOMPRESS_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const source = await readFile(filePath);
    if (shouldPrecompressAsset(filePath, source.byteLength)) {
      candidates.push({ filePath, source });
    }
  }

  let nextCandidate = 0;
  let brotliFiles = 0;
  let gzipFiles = 0;
  let brotliBytes = 0;
  let gzipBytes = 0;

  const compressNext = async () => {
    while (nextCandidate < candidates.length) {
      const candidate = candidates[nextCandidate];
      nextCandidate += 1;
      if (!candidate) continue;

      const [brotli, gzipped] = await Promise.all([
        brotliCompress(candidate.source, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
          },
        }),
        gzip(candidate.source, { level: 9 }),
      ]);

      if (brotli.byteLength < candidate.source.byteLength) {
        await writeFile(`${candidate.filePath}.br`, brotli);
        brotliFiles += 1;
        brotliBytes += brotli.byteLength;
      }
      if (gzipped.byteLength < candidate.source.byteLength) {
        await writeFile(`${candidate.filePath}.gz`, gzipped);
        gzipFiles += 1;
        gzipBytes += gzipped.byteLength;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_COMPRESSION_CONCURRENCY, candidates.length) }, compressNext),
  );

  return {
    sourceFiles: candidates.length,
    brotliFiles,
    gzipFiles,
    sourceBytes: candidates.reduce((total, candidate) => total + candidate.source.byteLength, 0),
    brotliBytes,
    gzipBytes,
  };
}
