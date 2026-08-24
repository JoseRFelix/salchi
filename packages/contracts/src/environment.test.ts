import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

it("keeps completion attention capability negotiation backward compatible", () => {
  const legacy = decodeDescriptor({
    environmentId: "environment-legacy",
    label: "Legacy",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.1.0",
    capabilities: { repositoryIdentity: true },
  });
  const current = decodeDescriptor({
    environmentId: "environment-current",
    label: "Current",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.2.0",
    capabilities: { repositoryIdentity: true, completionAttention: true },
  });

  assert.strictEqual(legacy.capabilities.completionAttention, undefined);
  assert.strictEqual(current.capabilities.completionAttention, true);
});
