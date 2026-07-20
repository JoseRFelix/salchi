import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { ChildProcessSpawner } from "effect/unstable/process";

export interface TerminateChildProcessOptions {
  readonly gracefulTimeout?: Duration.Input;
  readonly forceTimeout?: Duration.Input;
}

const DEFAULT_GRACEFUL_TIMEOUT = "2 seconds";
const DEFAULT_FORCE_TIMEOUT = "2 seconds";

const signalAndWait = (
  child: ChildProcessSpawner.ChildProcessHandle,
  signal: "SIGTERM" | "SIGKILL",
  timeout: Duration.Input,
) =>
  child.kill({ killSignal: signal }).pipe(
    Effect.interruptible,
    Effect.exit,
    Effect.timeoutOption(timeout),
    Effect.map(
      Option.match({
        onNone: () => false,
        onSome: Exit.isSuccess,
      }),
    ),
  );

/**
 * Terminates a scoped child without trusting the platform spawner's finalizer
 * to bound its wait for the process exit event.
 */
export const terminateChildProcess = Effect.fn("childProcess.terminate")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  options?: TerminateChildProcessOptions,
) {
  const running = yield* child.isRunning.pipe(Effect.catchCause(() => Effect.succeed(true)));
  if (!running) return;

  const terminated = yield* signalAndWait(
    child,
    "SIGTERM",
    options?.gracefulTimeout ?? DEFAULT_GRACEFUL_TIMEOUT,
  );
  if (terminated) return;

  const killed = yield* signalAndWait(
    child,
    "SIGKILL",
    options?.forceTimeout ?? DEFAULT_FORCE_TIMEOUT,
  );
  if (!killed) {
    // The platform spawner's later scope finalizer skips unreferenced handles.
    yield* child.unref.pipe(Effect.ignore);
  }
});
