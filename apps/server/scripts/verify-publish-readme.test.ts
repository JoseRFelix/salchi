// @effect-diagnostics nodeBuiltinImport:off - publish verification reads the repository README.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, it } from "@effect/vitest";
import { expect } from "vitest";

import {
  assertPortablePublishReadme,
  PublishReadmeVerificationError,
} from "./verify-publish-readme.ts";

describe("publish README verification", () => {
  it("accepts the repository README copied into the npm package", async () => {
    const readmePath = fileURLToPath(new URL("../../../README.md", import.meta.url));
    const readme = await readFile(readmePath, "utf8");

    expect(() => assertPortablePublishReadme(readme, readmePath)).not.toThrow();
  });

  it("rejects Markdown and HTML URLs that npm would resolve from apps/server", () => {
    const readme = [
      "![Screenshot](./assets/screenshots/showcase.png)",
      '<img src="assets/screenshots/mobile.png" />',
      "[Documentation](../docs/guide.md)",
    ].join("\n");

    expect(() => assertPortablePublishReadme(readme, "README.md")).toThrowError(
      PublishReadmeVerificationError,
    );
    for (const destination of [
      "./assets/screenshots/showcase.png",
      "assets/screenshots/mobile.png",
      "../docs/guide.md",
    ]) {
      expect(() => assertPortablePublishReadme(readme, "README.md")).toThrow(destination);
    }
  });

  it("accepts absolute, protocol-relative, and fragment URLs", () => {
    const readme = [
      "![Screenshot](https://raw.githubusercontent.com/example/repo/main/showcase.png)",
      '<a href="mailto:hello@example.com">Email</a>',
      '<img src="//cdn.example.com/mobile.png" />',
      "[Install](#installation)",
    ].join("\n");

    expect(() => assertPortablePublishReadme(readme, "README.md")).not.toThrow();
  });
});
