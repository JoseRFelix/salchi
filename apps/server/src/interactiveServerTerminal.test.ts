import { EventEmitter } from "node:events";

import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  formatServerTerminalCommandMenu,
  installInteractiveServerTerminal,
  parseServerTerminalCommand,
  type ServerTerminalInput,
} from "./interactiveServerTerminal.ts";

class TestTerminalInput extends EventEmitter {
  readonly isTTY = true;
  paused = true;
  isRaw = false;

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
    return this;
  }

  resume() {
    this.paused = false;
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }

  isPaused() {
    return this.paused;
  }
}

const asTerminalInput = (input: TestTerminalInput): ServerTerminalInput =>
  input as unknown as ServerTerminalInput;

it("parses numbered and single-key server shortcuts", () => {
  expect(parseServerTerminalCommand("1")).toBe("open");
  expect(parseServerTerminalCommand("O")).toBe("open");
  expect(parseServerTerminalCommand("2")).toBe("pair");
  expect(parseServerTerminalCommand("p")).toBe("pair");
  expect(parseServerTerminalCommand("?")).toBe("help");
  expect(parseServerTerminalCommand("open")).toBeNull();
  expect(parseServerTerminalCommand("nope")).toBeNull();
  expect(formatServerTerminalCommandMenu()).toContain("Generate a new pairing code");
  expect(formatServerTerminalCommandMenu()).toContain("no Enter needed");
});

it.effect("runs open and pairing shortcuts immediately without Enter", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = new TestTerminalInput();
      const writes: Array<string> = [];
      const opened = yield* Deferred.make<void>();
      const paired = yield* Deferred.make<void>();

      const installed = yield* installInteractiveServerTerminal(
        {
          openBrowser: Deferred.succeed(opened, undefined).pipe(Effect.as("browser opened")),
          createPairingCode: Deferred.succeed(paired, undefined).pipe(
            Effect.as("pairing code generated"),
          ),
        },
        {
          input: asTerminalInput(input),
          output: {
            isTTY: true,
            write: (text) => writes.push(text),
          },
        },
      );

      assert.isTrue(installed);
      assert.isTrue(input.isRaw);
      input.emit("data", Buffer.from("o"));
      yield* Deferred.await(opened);
      input.emit("data", Buffer.from("p"));
      yield* Deferred.await(paired);
      yield* Effect.yieldNow;

      expect(writes.join("")).toContain("browser opened");
      expect(writes.join("")).toContain("pairing code generated");
    }),
  ),
);

it.effect("removes stdin listeners and restores pause state when its scope closes", () =>
  Effect.gen(function* () {
    const input = new TestTerminalInput();
    const scope = yield* Scope.make("sequential");

    yield* installInteractiveServerTerminal(
      {
        openBrowser: Effect.succeed("opened"),
        createPairingCode: Effect.succeed("paired"),
      },
      {
        input: asTerminalInput(input),
        output: { isTTY: true, write: () => undefined },
      },
    ).pipe(Scope.provide(scope));

    expect(input.listenerCount("data")).toBe(1);
    expect(input.listenerCount("end")).toBe(1);
    assert.isFalse(input.paused);
    assert.isTrue(input.isRaw);

    yield* Scope.close(scope, Exit.void);

    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    assert.isTrue(input.paused);
    assert.isFalse(input.isRaw);
  }),
);

it.effect("preserves a terminal that was already in raw mode", () =>
  Effect.gen(function* () {
    const input = new TestTerminalInput();
    input.isRaw = true;
    const scope = yield* Scope.make("sequential");

    yield* installInteractiveServerTerminal(
      {
        openBrowser: Effect.succeed("opened"),
        createPairingCode: Effect.succeed("paired"),
      },
      {
        input: asTerminalInput(input),
        output: { isTTY: true, write: () => undefined },
      },
    ).pipe(Scope.provide(scope));

    yield* Scope.close(scope, Exit.void);
    assert.isTrue(input.isRaw);
  }),
);

it.effect("forwards Ctrl+C while raw mode is active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = new TestTerminalInput();
      let interrupted = false;

      yield* installInteractiveServerTerminal(
        {
          openBrowser: Effect.succeed("opened"),
          createPairingCode: Effect.succeed("paired"),
        },
        {
          input: asTerminalInput(input),
          output: { isTTY: true, write: () => undefined },
          interrupt: () => {
            interrupted = true;
          },
        },
      );

      input.emit("data", Buffer.from("\u0003"));
      assert.isTrue(interrupted);
    }),
  ),
);

it.effect("does not install commands when stdio is non-interactive", () =>
  Effect.gen(function* () {
    const input = new TestTerminalInput();
    Object.defineProperty(input, "isTTY", { value: false });

    const installed = yield* installInteractiveServerTerminal(
      {
        openBrowser: Effect.succeed("opened"),
        createPairingCode: Effect.succeed("paired"),
      },
      {
        input: asTerminalInput(input),
        output: { isTTY: true, write: () => undefined },
      },
    );

    assert.isFalse(installed);
    expect(input.listenerCount("data")).toBe(0);
  }),
);

it.effect("does not install commands when raw mode is unavailable", () =>
  Effect.gen(function* () {
    const input = new TestTerminalInput();
    Object.defineProperty(input, "setRawMode", { value: undefined });

    const installed = yield* installInteractiveServerTerminal(
      {
        openBrowser: Effect.succeed("opened"),
        createPairingCode: Effect.succeed("paired"),
      },
      {
        input: asTerminalInput(input),
        output: { isTTY: true, write: () => undefined },
      },
    );

    assert.isFalse(installed);
    expect(input.listenerCount("data")).toBe(0);
  }),
);
