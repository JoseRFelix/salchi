// @effect-diagnostics nodeBuiltinImport:off - release tooling reads generated build metadata from disk.
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export const CLIENT_BUILD_METADATA_FILENAME = "salchi-build.json";

export interface ClientBuildMetadata {
  readonly version: string;
}

export class ClientBuildMetadataError extends Error {
  override readonly name = "ClientBuildMetadataError";
}

export function encodeClientBuildMetadata(version: string): string {
  return `${JSON.stringify({ version } satisfies ClientBuildMetadata, null, 2)}\n`;
}

export function decodeClientBuildMetadata(contents: string): ClientBuildMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new ClientBuildMetadataError(
      `Client build metadata is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    parsed.version.trim().length === 0
  ) {
    throw new ClientBuildMetadataError(
      "Client build metadata must contain a non-empty string version.",
    );
  }

  return { version: parsed.version.trim() };
}

export function assertClientBuildVersion(
  metadata: ClientBuildMetadata,
  expectedVersion: string,
): void {
  const normalizedExpectedVersion = expectedVersion.trim();
  if (metadata.version === normalizedExpectedVersion) {
    return;
  }

  throw new ClientBuildMetadataError(
    `Refusing to publish: bundled client version ${metadata.version} does not match package version ${normalizedExpectedVersion}. Rebuild the web client with APP_VERSION=${normalizedExpectedVersion} before publishing.`,
  );
}

export async function verifyClientBuildVersion(
  clientDirectory: string,
  expectedVersion: string,
): Promise<ClientBuildMetadata> {
  const metadataPath = path.join(clientDirectory, CLIENT_BUILD_METADATA_FILENAME);
  let contents: string;
  try {
    contents = await readFile(metadataPath, "utf8");
  } catch (cause) {
    throw new ClientBuildMetadataError(
      `Refusing to publish: missing client build metadata at ${metadataPath}. Rebuild the web client with APP_VERSION=${expectedVersion.trim()} before publishing.`,
      { cause },
    );
  }

  const metadata = decodeClientBuildMetadata(contents);
  assertClientBuildVersion(metadata, expectedVersion);
  return metadata;
}
