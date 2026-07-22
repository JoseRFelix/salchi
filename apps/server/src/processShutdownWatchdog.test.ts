import { assert, describe, it } from "vitest";

import {
  installProcessShutdownWatchdog,
  type ProcessShutdownWatchdogHost,
  type ShutdownSignal,
} from "./processShutdownWatchdog.ts";

function makeHost() {
  const listeners = new Map<ShutdownSignal, Set<() => void>>();
  const deadlines = new Map<number, () => void>();
  const exitCodes: number[] = [];
  const warnings: string[] = [];
  let nextDeadlineId = 1;

  const host: ProcessShutdownWatchdogHost<number> = {
    addSignalListener: (signal, listener) => {
      const current = listeners.get(signal) ?? new Set();
      current.add(listener);
      listeners.set(signal, current);
    },
    removeSignalListener: (signal, listener) => {
      listeners.get(signal)?.delete(listener);
    },
    scheduleDeadline: (callback) => {
      const id = nextDeadlineId;
      nextDeadlineId += 1;
      deadlines.set(id, callback);
      return id;
    },
    cancelDeadline: (id) => {
      deadlines.delete(id);
    },
    exit: (code) => {
      exitCodes.push(code);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };

  return {
    host,
    exitCodes,
    warnings,
    emit: (signal: ShutdownSignal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    expireDeadline: () => {
      for (const callback of deadlines.values()) callback();
    },
    listenerCount: () =>
      Array.from(listeners.values()).reduce((total, current) => total + current.size, 0),
    deadlineCount: () => deadlines.size,
  };
}

describe("process shutdown watchdog", () => {
  it("forces exit when graceful shutdown exceeds the deadline", () => {
    const testHost = makeHost();
    const watchdog = installProcessShutdownWatchdog({ timeoutMs: 3_000 }, testHost.host);

    testHost.emit("SIGINT");
    assert.deepEqual(testHost.exitCodes, []);
    assert.equal(testHost.deadlineCount(), 1);

    testHost.expireDeadline();
    assert.deepEqual(testHost.exitCodes, [130]);
    assert.match(testHost.warnings.at(-1) ?? "", /forcing exit/u);

    watchdog.dispose();
  });

  it("forces immediate exit when a second signal arrives", () => {
    const testHost = makeHost();
    const watchdog = installProcessShutdownWatchdog({ timeoutMs: 3_000 }, testHost.host);

    testHost.emit("SIGTERM");
    testHost.emit("SIGINT");

    assert.deepEqual(testHost.exitCodes, [143]);
    assert.equal(testHost.deadlineCount(), 0);
    watchdog.dispose();
  });

  it("cancels the deadline and signal listeners when shutdown finishes", () => {
    const testHost = makeHost();
    const watchdog = installProcessShutdownWatchdog({ timeoutMs: 3_000 }, testHost.host);

    testHost.emit("SIGINT");
    watchdog.dispose();

    assert.equal(testHost.deadlineCount(), 0);
    assert.equal(testHost.listenerCount(), 0);
    testHost.expireDeadline();
    assert.deepEqual(testHost.exitCodes, []);
  });
});
