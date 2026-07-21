import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

export type ServerTerminalCommand = "open" | "pair" | "help";

export interface ServerTerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly isPaused?: () => boolean;
  readonly setRawMode?: (enabled: boolean) => unknown;
  readonly on: (event: string, listener: (...args: ReadonlyArray<unknown>) => void) => unknown;
  readonly off: (event: string, listener: (...args: ReadonlyArray<unknown>) => void) => unknown;
  readonly resume: () => unknown;
  readonly pause: () => unknown;
}

export interface ServerTerminalOutput {
  readonly isTTY?: boolean;
  readonly write: (text: string) => unknown;
}

export interface InteractiveServerTerminalActions<OpenE, OpenR, PairE, PairR> {
  readonly openBrowser: Effect.Effect<string, OpenE, OpenR>;
  readonly createPairingCode: Effect.Effect<string, PairE, PairR>;
}

export interface InteractiveServerTerminalOptions {
  readonly input?: ServerTerminalInput;
  readonly output?: ServerTerminalOutput;
  readonly interrupt?: () => void;
}

export const parseServerTerminalCommand = (input: string): ServerTerminalCommand | null => {
  switch (input.trim().toLowerCase()) {
    case "1":
    case "o":
      return "open";
    case "2":
    case "p":
      return "pair";
    case "h":
    case "?":
      return "help";
    default:
      return null;
  }
};

export const formatServerTerminalCommandMenu = (): string =>
  [
    "",
    "Server shortcuts (press a key; no Enter needed):",
    "  [o] Open Salchi in the browser",
    "  [p] Generate a new pairing code",
    "  [h] Show these shortcuts",
    "",
  ].join("\n");

const formatCommandError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return String(error);
};

const writeOutput = (output: ServerTerminalOutput, text: string) =>
  Effect.sync(() => {
    try {
      output.write(text);
    } catch {
      // A closed or redirected terminal must not affect the server runtime.
    }
  });

const executeCommand = <OpenE, OpenR, PairE, PairR>(
  command: ServerTerminalCommand,
  actions: InteractiveServerTerminalActions<OpenE, OpenR, PairE, PairR>,
  output: ServerTerminalOutput,
) => {
  if (command === "help") {
    return writeOutput(output, formatServerTerminalCommandMenu());
  }

  const runAction = <E, R>(action: Effect.Effect<string, E, R>) =>
    action.pipe(
      Effect.flatMap((message) =>
        writeOutput(output, message.endsWith("\n") ? message : `${message}\n`),
      ),
      Effect.catch((error) =>
        writeOutput(output, `Server command failed: ${formatCommandError(error)}\n`),
      ),
    );

  return command === "open" ? runAction(actions.openBrowser) : runAction(actions.createPairingCode);
};

/**
 * Installs a raw single-key command listener owned by the surrounding server
 * scope. It is intentionally disabled for redirected/non-interactive stdio or
 * terminal inputs that cannot be switched into raw mode.
 */
export const installInteractiveServerTerminal = <OpenE, OpenR, PairE, PairR>(
  actions: InteractiveServerTerminalActions<OpenE, OpenR, PairE, PairR>,
  options: InteractiveServerTerminalOptions = {},
): Effect.Effect<boolean, never, OpenR | PairR | Scope.Scope> =>
  Effect.gen(function* () {
    const input = options.input ?? (process.stdin as unknown as ServerTerminalInput);
    const output = options.output ?? (process.stdout as unknown as ServerTerminalOutput);
    if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) {
      return false;
    }

    const commands = yield* Queue.unbounded<ServerTerminalCommand | null>();
    const interrupt = options.interrupt ?? (() => process.kill(process.pid, "SIGINT"));

    const onData = (...args: ReadonlyArray<unknown>) => {
      for (const key of String(args[0] ?? "")) {
        if (key === "\u0003") {
          interrupt();
          continue;
        }
        const command = parseServerTerminalCommand(key);
        if (command !== null) {
          Queue.offerUnsafe(commands, command);
        }
      }
    };
    const onEnd = () => {
      Queue.offerUnsafe(commands, null);
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const wasPaused = input.isPaused?.() ?? false;
        const wasRaw = input.isRaw ?? false;
        input.setRawMode?.(true);
        input.on("data", onData);
        input.on("end", onEnd);
        input.resume();
        return { wasPaused, wasRaw };
      }),
      ({ wasPaused, wasRaw }) =>
        Effect.sync(() => {
          input.off("data", onData);
          input.off("end", onEnd);
          input.setRawMode?.(wasRaw);
          if (wasPaused) {
            input.pause();
          }
        }).pipe(Effect.andThen(Queue.shutdown(commands))),
    );

    yield* writeOutput(output, formatServerTerminalCommandMenu());
    yield* Effect.gen(function* () {
      while (true) {
        const command = yield* Queue.take(commands);
        if (command === null) {
          return;
        }
        yield* executeCommand(command, actions, output);
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }));

    return true;
  });
