// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const PROCESS_TREE_TERMINATE_GRACE = "500 millis" as const satisfies Duration.Input;

function readProcessRows(): ReadonlyArray<{ readonly pid: number; readonly ppid: number }> {
  if (process.platform === "win32") return [];
  try {
    const raw = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
    });
    return raw.split(/\r?\n/g).flatMap((line) => {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : [];
    });
  } catch {
    return [];
  }
}

function collectDescendantPids(rootPid: number): ReadonlyArray<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of readProcessRows()) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }
  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    descendants.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function readProcessGroupId(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const value = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 1_024,
      }).trim(),
    );
    return Number.isInteger(value) && value > 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, signalName: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signalName);
    return true;
  } catch {
    return false;
  }
}

function signalTree(input: {
  readonly rootPid: number;
  readonly processGroupId: number | undefined;
  readonly descendants: ReadonlyArray<number>;
  readonly signalName: "SIGTERM" | "SIGKILL";
}): boolean {
  const ownProcessGroupId = readProcessGroupId(process.pid);
  const canSignalGroup =
    input.processGroupId !== undefined &&
    (input.processGroupId === input.rootPid || input.processGroupId !== ownProcessGroupId);
  if (canSignalGroup && signal(-input.processGroupId!, input.signalName)) return true;
  for (const pid of input.descendants.toReversed()) signal(pid, input.signalName);
  signal(input.rootPid, input.signalName);
  return false;
}

export const terminateProcessTree = Effect.fn("processTree.terminate")(function* (input: {
  readonly rootPid: number;
  readonly label: string;
  readonly grace?: Duration.Input | undefined;
}) {
  if (!Number.isInteger(input.rootPid) || input.rootPid < 1 || !isRunning(input.rootPid)) return;
  const processGroupId = readProcessGroupId(input.rootPid);
  const descendants = collectDescendantPids(input.rootPid);
  const groupSignaled = signalTree({
    rootPid: input.rootPid,
    processGroupId,
    descendants,
    signalName: "SIGTERM",
  });
  yield* Effect.sleep(input.grace ?? PROCESS_TREE_TERMINATE_GRACE);

  const remaining = [input.rootPid, ...descendants].filter(isRunning);
  if (remaining.length > 0) {
    signalTree({
      rootPid: input.rootPid,
      processGroupId,
      descendants: remaining.filter((pid) => pid !== input.rootPid),
      signalName: "SIGKILL",
    });
  }
  yield* Effect.logDebug("Process tree cleanup completed", {
    "process.label": input.label,
    "process.pid": input.rootPid,
    "process.descendant_pids": descendants,
    "process_group.id": processGroupId,
    "process_group.signal_sent": groupSignaled,
    force_killed: remaining.length > 0,
  });
});
