// @effect-diagnostics nodeBuiltinImport:off
import type { ThreadId } from "@salchi/contracts";
import * as Path from "node:path";

import type { BrowserProviderProcessRoot } from "./BrowserProviderProcessRegistry.ts";

export const ROGUE_BROWSER_WATCHDOG_INTERVAL_MILLIS = 60_000;
export const ROGUE_BROWSER_VIEWPORT_NOTICE = "agent launched an external browser";

export interface RogueBrowserProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface RogueBrowserProcess {
  readonly command: string;
  readonly pid: number;
  readonly providerPid: number;
  readonly threadId: ThreadId;
}

const CHROMIUM_EXECUTABLE_PATTERN =
  /(?:^|[/\\])(?:chrome(?:-wrapper)?|chromium(?:-browser)?|google-chrome(?:-stable)?|msedge)(?:\.exe)?(?:\s|$)/i;

function readUserDataDirectory(command: string): string | undefined {
  const match = /(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isInsideDirectory(candidate: string, root: string): boolean {
  const resolvedCandidate = Path.resolve(candidate);
  const resolvedRoot = Path.resolve(root);
  const relative = Path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith(`..${Path.sep}`) && relative !== "..");
}

function isTopLevelChromium(command: string): boolean {
  return CHROMIUM_EXECUTABLE_PATTERN.test(command) && !/(?:^|\s)--type(?:=|\s)/i.test(command);
}

function findOwningProvider(
  row: RogueBrowserProcessRow,
  rowsByPid: ReadonlyMap<number, RogueBrowserProcessRow>,
  providersByPid: ReadonlyMap<number, BrowserProviderProcessRoot>,
): BrowserProviderProcessRoot | undefined {
  const visited = new Set<number>();
  let currentPid = row.ppid;
  while (currentPid > 0 && !visited.has(currentPid)) {
    visited.add(currentPid);
    const provider = providersByPid.get(currentPid);
    if (provider !== undefined) return provider;
    const parent = rowsByPid.get(currentPid);
    if (parent === undefined || parent.ppid === currentPid) return undefined;
    currentPid = parent.ppid;
  }
  return undefined;
}

/** Pure process-table matcher used by the periodic manager watchdog. */
export function findRogueBrowserProcesses(input: {
  readonly processRows: ReadonlyArray<RogueBrowserProcessRow>;
  readonly profileRoot: string;
  readonly providerProcesses: ReadonlyArray<BrowserProviderProcessRoot>;
}): ReadonlyArray<RogueBrowserProcess> {
  const rowsByPid = new Map(input.processRows.map((row) => [row.pid, row]));
  const providersByPid = new Map(
    input.providerProcesses.map((provider) => [provider.pid, provider]),
  );

  return input.processRows.flatMap((row) => {
    if (!isTopLevelChromium(row.command)) return [];
    const userDataDirectory = readUserDataDirectory(row.command);
    if (
      userDataDirectory !== undefined &&
      isInsideDirectory(userDataDirectory, input.profileRoot)
    ) {
      return [];
    }
    const provider = findOwningProvider(row, rowsByPid, providersByPid);
    return provider === undefined
      ? []
      : [
          {
            command: row.command,
            pid: row.pid,
            providerPid: provider.pid,
            threadId: provider.threadId,
          },
        ];
  });
}
