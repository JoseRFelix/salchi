import { describe, expect, it } from "vitest";

import {
  classifyBrowserDependencyFailure,
  detectBrowserDependencyPackageManager,
} from "./BrowserDependencyError.ts";

describe("browser dependency failure classification", () => {
  it("extracts Playwright's exact apt command", () => {
    const failure = classifyBrowserDependencyFailure(
      `Host system is missing dependencies to run browsers.
Alternatively, use apt:
    sudo apt-get install libasound2\\
        libatk1.0-0\\
        libcups2

<3 Playwright Team`,
      "apt",
    );
    expect(failure).toEqual({
      dependencyCommand: "sudo apt-get install libasound2 libatk1.0-0 libcups2",
      missingLibraries: [],
    });
  });

  it("classifies a real dynamic-loader failure and builds an RPM lookup command", () => {
    const failure = classifyBrowserDependencyFailure(
      "/chrome: error while loading shared libraries: libXcomposite.so.1: cannot open shared object file: No such file or directory",
      "dnf",
    );
    expect(failure).toEqual({
      dependencyCommand: "sudo dnf install '*/libXcomposite.so.1'",
      missingLibraries: ["libXcomposite.so.1"],
    });
  });

  it("uses Salchi's bundled Playwright dependency command for an unmapped apt library", () => {
    const failure = classifyBrowserDependencyFailure(
      "/chrome: error while loading shared libraries: libunmapped.so.9: cannot open shared object file",
      "apt",
    );
    expect(failure?.dependencyCommand).toContain("playwright-core/cli.js'");
    expect(failure?.dependencyCommand).toContain("install-deps chromium-headless-shell");
    expect(failure?.dependencyCommand).not.toContain("npx");
  });

  it("does not misclassify ordinary launch failures", () => {
    expect(classifyBrowserDependencyFailure("browserType.launch: executable does not exist")).toBe(
      undefined,
    );
  });

  it("selects dnf for Fedora-family os-release data and apt otherwise", () => {
    expect(detectBrowserDependencyPackageManager('ID="rocky"\nID_LIKE="rhel centos fedora"')).toBe(
      "dnf",
    );
    expect(detectBrowserDependencyPackageManager('ID="ubuntu"\nID_LIKE="debian"')).toBe("apt");
  });
});
