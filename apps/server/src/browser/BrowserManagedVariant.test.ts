import { describe, expect, it } from "vitest";

import {
  managedChromeInstallDisposition,
  parseLinuxDistributionId,
} from "./BrowserManagedVariant.ts";

describe("managed Chrome installation support", () => {
  it("classifies Playwright's Debian-family Linux install as needing elevation", () => {
    expect(
      managedChromeInstallDisposition({
        platform: "linux",
        arch: "x64",
        distributionId: "ubuntu",
        nodeExecutable: "/usr/bin/node",
        playwrightCli: "/opt/salchi/node_modules/playwright-core/cli.js",
      }),
    ).toEqual({
      _tag: "needs-elevation",
      elevationCommand:
        "sudo -- '/usr/bin/node' '/opt/salchi/node_modules/playwright-core/cli.js' install chrome",
      reason:
        "Google Chrome is installed as a system package on Linux. Salchi will not run an elevated installer.",
    });
  });

  it("provides a distro package command where Playwright's Linux script is unsupported", () => {
    const disposition = managedChromeInstallDisposition({
      platform: "linux",
      arch: "x64",
      distributionId: "fedora",
      nodeExecutable: "/usr/bin/node",
      playwrightCli: "/opt/playwright/cli.js",
    });

    expect(disposition._tag).toBe("needs-elevation");
    if (disposition._tag === "needs-elevation") {
      expect(disposition.elevationCommand).toBe(
        "sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm",
      );
    }
  });

  it("reports Playwright's Linux Arm64 limitation instead of offering a command that cannot work", () => {
    expect(
      managedChromeInstallDisposition({
        platform: "linux",
        arch: "arm64",
        distributionId: "ubuntu",
        nodeExecutable: "/usr/bin/node",
        playwrightCli: "/opt/playwright/cli.js",
      }),
    ).toEqual({
      _tag: "unsupported",
      reason:
        "Playwright's Google Chrome installer does not support Linux arm64. Install a compatible branded Chrome yourself and set SALCHI_BROWSER_PATH, or use Chromium.",
    });
  });

  it("lets Playwright run its normal installer on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        managedChromeInstallDisposition({
          platform,
          arch: "x64",
          nodeExecutable: "/node",
          playwrightCli: "/playwright/cli.js",
        }),
      ).toEqual({ _tag: "install" });
    }
  });

  it("parses quoted and unquoted os-release identifiers", () => {
    expect(parseLinuxDistributionId('NAME="Ubuntu"\nID="ubuntu"\n')).toBe("ubuntu");
    expect(parseLinuxDistributionId("NAME=Fedora\nID=fedora\n")).toBe("fedora");
  });
});
