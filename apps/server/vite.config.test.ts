import { assert, describe, it } from "@effect/vitest";

import { shouldBundleCliDependency } from "./vite.config.ts";

describe("shouldBundleCliDependency", () => {
  it("bundles the patched WebSocket server adapters into release artifacts", () => {
    assert.isTrue(shouldBundleCliDependency("@effect/platform-node/NodeHttpServer"));
    assert.isTrue(shouldBundleCliDependency("@effect/platform-bun/BunHttpServer"));
  });

  it("keeps unrelated Effect platform modules external", () => {
    assert.isFalse(shouldBundleCliDependency("@effect/platform-node/NodeRuntime"));
    assert.isFalse(shouldBundleCliDependency("@effect/platform-bun/BunRuntime"));
  });
});
