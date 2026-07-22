export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ProcessShutdownWatchdogHost<Deadline = unknown> {
  readonly addSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  readonly removeSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  readonly scheduleDeadline: (callback: () => void, delayMs: number) => Deadline;
  readonly cancelDeadline: (deadline: Deadline) => void;
  readonly exit: (code: number) => void;
  readonly warn: (message: string) => void;
}

export interface ProcessShutdownWatchdogOptions {
  readonly timeoutMs?: number;
}

export const PROCESS_SHUTDOWN_TIMEOUT_MS = 3_000;

const exitCodeForSignal = (signal: ShutdownSignal): number => (signal === "SIGINT" ? 130 : 143);

const liveHost: ProcessShutdownWatchdogHost<ReturnType<typeof setTimeout>> = {
  addSignalListener: (signal, listener) => process.on(signal, listener),
  removeSignalListener: (signal, listener) => process.removeListener(signal, listener),
  // @effect-diagnostics-next-line globalTimers:off - This watchdog must fire even if the Effect runtime is stuck in finalization.
  scheduleDeadline: (callback, delayMs) => setTimeout(callback, delayMs),
  cancelDeadline: (deadline) => clearTimeout(deadline),
  exit: (code) => process.exit(code),
  warn: (message) => process.stderr.write(`${message}\n`),
};

/**
 * Gives Effect finalizers a short grace period after the first termination
 * signal, then guarantees that the host process exits. A second signal skips
 * the remaining grace period.
 */
export function installProcessShutdownWatchdog<Deadline>(
  options: ProcessShutdownWatchdogOptions = {},
  host: ProcessShutdownWatchdogHost<Deadline> = liveHost as unknown as ProcessShutdownWatchdogHost<Deadline>,
) {
  const timeoutMs = options.timeoutMs ?? PROCESS_SHUTDOWN_TIMEOUT_MS;
  let firstSignal: ShutdownSignal | undefined;
  let deadline: Deadline | undefined;
  let disposed = false;
  let forced = false;

  const cancelDeadline = () => {
    if (deadline === undefined) return;
    host.cancelDeadline(deadline);
    deadline = undefined;
  };

  const forceExit = (reason: string) => {
    if (forced || firstSignal === undefined) return;
    forced = true;
    cancelDeadline();
    host.warn(reason);
    host.exit(exitCodeForSignal(firstSignal));
  };

  const handleSignal = (signal: ShutdownSignal) => {
    if (disposed) return;
    if (firstSignal !== undefined) {
      forceExit(`Received ${signal} during shutdown; forcing exit.`);
      return;
    }

    firstSignal = signal;
    host.warn(
      `Received ${signal}; allowing ${timeoutMs}ms for graceful shutdown. Send another signal to force exit.`,
    );
    deadline = host.scheduleDeadline(
      () => forceExit(`Graceful shutdown exceeded ${timeoutMs}ms; forcing exit.`),
      timeoutMs,
    );
  };

  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  host.addSignalListener("SIGINT", onSigint);
  host.addSignalListener("SIGTERM", onSigterm);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelDeadline();
      host.removeSignalListener("SIGINT", onSigint);
      host.removeSignalListener("SIGTERM", onSigterm);
    },
  };
}
