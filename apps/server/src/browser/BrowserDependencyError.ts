// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type BrowserDependencyPackageManager = "apt" | "dnf";

export interface BrowserDependencyFailure {
  readonly dependencyCommand: string;
  readonly missingLibraries: ReadonlyArray<string>;
}

export function browserErrorDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  return messages.join("\nCaused by: ");
}

const loaderLibraryPattern = /error while loading shared libraries:\s*([^:\s]+):/gi;
const missingLibraryLinePattern = /^\s*([^\s]+\.so(?:\.[^\s]+)*)\s*$/i;

function cleanDiagnostic(value: string): string {
  const ansiColorEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return value
    .replaceAll(ansiColorEscape, "")
    .replaceAll(/[╔╗╚╝║]/g, "")
    .replaceAll(/═+/g, "");
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function extractMissingLibraries(message: string): ReadonlyArray<string> {
  const libraries: string[] = [];
  for (const match of message.matchAll(loaderLibraryPattern)) {
    if (match[1]) libraries.push(match[1]);
  }
  const lines = message.split(/\r?\n/);
  const missingLibrariesIndex = lines.findIndex((line) => line.includes("Missing libraries:"));
  if (missingLibrariesIndex >= 0) {
    for (const line of lines.slice(missingLibrariesIndex + 1)) {
      const match = missingLibraryLinePattern.exec(line.replaceAll(/[║]/g, ""));
      if (!match?.[1]) break;
      libraries.push(match[1]);
    }
  }
  return unique(libraries);
}

function extractAptCommand(message: string): string | undefined {
  const lines = cleanDiagnostic(message).split(/\r?\n/);
  const start = lines.findIndex((line) => /(?:sudo\s+)?apt-get\s+install\s+/.test(line));
  if (start < 0) return undefined;
  const commandLines: string[] = [];
  for (const line of lines.slice(start)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("<3")) break;
    if (commandLines.length > 0 && !commandLines.at(-1)?.endsWith("\\")) break;
    commandLines.push(trimmed);
  }
  const command = commandLines.join(" ").replaceAll(/\\\s*/g, " ").replaceAll(/\s+/g, " ");
  return command.length > 0 ? command : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bundledPlaywrightInstallDepsCommand(): string {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("playwright-core/package.json"));
  return `sudo ${shellQuote(process.execPath)} ${shellQuote(join(packageRoot, "cli.js"))} install-deps chromium-headless-shell`;
}

export function detectBrowserDependencyPackageManager(
  osRelease: string = (() => {
    try {
      return readFileSync("/etc/os-release", "utf8");
    } catch {
      return "";
    }
  })(),
): BrowserDependencyPackageManager {
  const normalized = osRelease.toLowerCase();
  return /(?:^|\n)(?:id|id_like)=[^\n]*(?:fedora|rhel|centos|rocky|alma|suse)/.test(normalized)
    ? "dnf"
    : "apt";
}

export function classifyBrowserDependencyFailure(
  error: unknown,
  packageManager: BrowserDependencyPackageManager = detectBrowserDependencyPackageManager(),
): BrowserDependencyFailure | undefined {
  const message = browserErrorDiagnostic(error);
  const isMissingDependency =
    /Host system is missing dependencies to run browsers/i.test(message) ||
    /error while loading shared libraries:/i.test(message) ||
    /Missing libraries:/i.test(message);
  if (!isMissingDependency) return undefined;

  const missingLibraries = extractMissingLibraries(message);
  const aptCommand = extractAptCommand(message);
  if (packageManager === "apt" && aptCommand !== undefined) {
    return { dependencyCommand: aptCommand, missingLibraries };
  }

  if (packageManager === "dnf" && missingLibraries.length > 0) {
    const packages = missingLibraries.map((library) => `'*/${library.replaceAll("'", "")}'`);
    return {
      dependencyCommand: `sudo dnf install ${packages.join(" ")}`,
      missingLibraries,
    };
  }

  // Use Salchi's bundled Playwright version so the apt package list exactly matches
  // the downloaded browser and never depends on npx resolving a package from the network.
  return {
    dependencyCommand: bundledPlaywrightInstallDepsCommand(),
    missingLibraries,
  };
}
