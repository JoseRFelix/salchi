// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";

export type ManagedChromeInstallDisposition =
  | { readonly _tag: "install" }
  | {
      readonly _tag: "needs-elevation";
      readonly elevationCommand: string;
      readonly reason: string;
    }
  | { readonly _tag: "unsupported"; readonly reason: string };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function parseLinuxDistributionId(osRelease: string): string | undefined {
  const match = /^ID=(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m.exec(osRelease);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
}

export function readLinuxDistributionId(): string | undefined {
  try {
    return parseLinuxDistributionId(readFileSync("/etc/os-release", "utf8"));
  } catch {
    return undefined;
  }
}

export function managedChromeInstallDisposition(input: {
  readonly platform: NodeJS.Platform | string;
  readonly arch: string;
  readonly distributionId?: string | undefined;
  readonly nodeExecutable: string;
  readonly playwrightCli: string;
}): ManagedChromeInstallDisposition {
  if (input.platform !== "linux") return { _tag: "install" };

  if (input.arch !== "x64") {
    return {
      _tag: "unsupported",
      reason:
        `Playwright's Google Chrome installer does not support Linux ${input.arch}. ` +
        "Install a compatible branded Chrome yourself and set SALCHI_BROWSER_PATH, or use Chromium.",
    };
  }

  const distributionId = input.distributionId?.toLowerCase();
  if (distributionId === "ubuntu" || distributionId === "debian") {
    return {
      _tag: "needs-elevation",
      elevationCommand: `sudo -- ${shellQuote(input.nodeExecutable)} ${shellQuote(input.playwrightCli)} install chrome`,
      reason:
        "Google Chrome is installed as a system package on Linux. Salchi will not run an elevated installer.",
    };
  }

  if (
    distributionId === "fedora" ||
    distributionId === "rhel" ||
    distributionId === "centos" ||
    distributionId === "rocky" ||
    distributionId === "almalinux"
  ) {
    return {
      _tag: "needs-elevation",
      elevationCommand:
        "sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm",
      reason:
        "Playwright's Chrome installer only supports Debian-family Linux; install Google's system package directly on this distribution.",
    };
  }

  return {
    _tag: "unsupported",
    reason:
      `Playwright cannot install Google Chrome on this Linux distribution${distributionId ? ` (${distributionId})` : ""}. ` +
      "Install Chrome yourself and set SALCHI_BROWSER_PATH, or use Chromium.",
  };
}
