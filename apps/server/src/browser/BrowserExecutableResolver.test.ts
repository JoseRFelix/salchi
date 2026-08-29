import { BrowserUnavailable } from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

import {
  makeBrowserResolutionCandidates,
  resolveBrowserExecutable,
} from "./BrowserExecutableResolver.ts";

const isBrowserUnavailable = Schema.is(BrowserUnavailable);

class BrowserResolverTestError extends Data.TaggedError("BrowserResolverTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

it.effect("resolves browser executables in environment, setting, channel, then managed order", () =>
  Effect.gen(function* () {
    const attempted: string[] = [];
    const candidates = makeBrowserResolutionCandidates({
      environmentPath: "/env/chrome",
      settingPath: "/setting/chrome",
      channels: ["chrome", "chromium"],
      managedPath: "/managed/chromium",
    });
    const result = yield* resolveBrowserExecutable({
      candidates,
      launch: (candidate) =>
        Effect.sync(() => {
          attempted.push(`${candidate.source}:${candidate.resolution}`);
        }).pipe(
          Effect.andThen(
            candidate.resolution === "chrome"
              ? Effect.succeed("launched")
              : Effect.fail("not installed"),
          ),
        ),
    });

    assert.deepEqual(attempted, [
      "environment:/env/chrome",
      "setting:/setting/chrome",
      "channel:chrome",
    ]);
    assert.equal(result.value, "launched");
    assert.equal(result.candidate.resolution, "chrome");
  }),
);

it.effect("reports every failed executable resolution attempt", () =>
  Effect.gen(function* () {
    const candidates = makeBrowserResolutionCandidates({
      environmentPath: "/env/chrome",
      settingPath: "/setting/chrome",
      channels: ["chrome", "chromium"],
      managedPath: "/managed/chromium",
    });
    const exit = yield* resolveBrowserExecutable({
      candidates,
      launch: (candidate) => Effect.fail(`failed ${candidate.resolution}`),
    }).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isSuccess(exit)) return;
    const error = yield* Effect.flip(Effect.failCause(exit.cause));
    assert.isTrue(isBrowserUnavailable(error));
    if (!isBrowserUnavailable(error)) return;
    assert.deepEqual(
      error.attempts.map((attempt) => `${attempt.source}:${attempt.resolution}`),
      [
        "environment:/env/chrome",
        "setting:/setting/chrome",
        "channel:chrome",
        "channel:chromium",
        "managed:/managed/chromium",
      ],
    );
    assert.include(error.message, "/env/chrome");
    assert.include(error.message, "chromium");
    assert.equal(error.reason, "launch-failed");
  }),
);

it.effect("uses a managed install only after every system channel fails", () =>
  Effect.gen(function* () {
    const attempted: string[] = [];
    const result = yield* resolveBrowserExecutable({
      candidates: makeBrowserResolutionCandidates({
        channels: ["chrome", "chromium"],
        managedPath: "/salchi/browsers/chromium",
      }),
      launch: (candidate) =>
        Effect.sync(() => attempted.push(`${candidate.source}:${candidate.resolution}`)).pipe(
          Effect.andThen(
            candidate.source === "managed"
              ? Effect.succeed("managed browser")
              : Effect.fail("not installed"),
          ),
        ),
    });
    assert.deepEqual(attempted, [
      "channel:chrome",
      "channel:chromium",
      "managed:/salchi/browsers/chromium",
    ]);
    assert.equal(result.candidate.source, "managed");
  }),
);

it.effect("reports missing Linux libraries with the copy-paste dependency command", () =>
  Effect.gen(function* () {
    const exit = yield* resolveBrowserExecutable({
      candidates: makeBrowserResolutionCandidates({ channels: ["chromium"] }),
      launch: () =>
        Effect.fail(
          new BrowserResolverTestError({
            message: "browserType.launch failed",
            cause: new BrowserResolverTestError({
              message: `Host system is missing dependencies to run browsers.
Alternatively, use apt:
    sudo apt-get install libasound2\\
        libcups2`,
            }),
          }),
        ),
    }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isSuccess(exit)) return;
    const error = yield* Effect.flip(Effect.failCause(exit.cause));
    assert.isTrue(isBrowserUnavailable(error));
    if (!isBrowserUnavailable(error)) return;
    assert.equal(error.reason, "missing-libraries");
    assert.equal(error.dependencyCommand, "sudo apt-get install libasound2 libcups2");
  }),
);
