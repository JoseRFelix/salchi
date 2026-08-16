// @effect-diagnostics nodeBuiltinImport:off - publish verification exercises a Node executable.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { expect } from "vitest";

import {
  assertPortableCliEntrypoint,
  CliEntrypointVerificationError,
} from "./verify-cli-entrypoint.ts";

describe("CLI entrypoint verification", () => {
  it("accepts the unconditional executable entrypoint", async () => {
    const entrypointPath = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const source = await readFile(entrypointPath, "utf8");

    expect(() => assertPortableCliEntrypoint(source, entrypointPath)).not.toThrow();
  });

  it("rejects import.meta.main because supported Node releases silently ignore it", () => {
    expect(() =>
      assertPortableCliEntrypoint("if (import.meta.main) run();", "dist/bin.mjs"),
    ).toThrowError(CliEntrypointVerificationError);
    expect(() =>
      assertPortableCliEntrypoint("if (import.meta.main) run();", "dist/bin.mjs"),
    ).toThrow(/silently skips execution/);
  });

  it("accepts portable entrypoint source", () => {
    assert.doesNotThrow(() => assertPortableCliEntrypoint("run();", "dist/bin.mjs"));
  });
});
