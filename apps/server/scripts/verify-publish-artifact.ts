#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - npm lifecycle tooling resolves the generated client bundle.
import { fileURLToPath } from "node:url";

import { verifyClientBuildVersion } from "../../../scripts/lib/client-build-metadata.ts";
import serverPackageJson from "../package.json" with { type: "json" };
import { verifyCliEntrypoint } from "./verify-cli-entrypoint.ts";

export async function verifyServerPublishArtifact(
  expectedVersion: string = serverPackageJson.version,
): Promise<void> {
  await verifyCliEntrypoint(
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    expectedVersion,
  );
  await verifyClientBuildVersion(
    fileURLToPath(new URL("../dist/client", import.meta.url)),
    expectedVersion,
  );
}

if (import.meta.main) {
  verifyServerPublishArtifact().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
