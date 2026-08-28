import { BrowserUnavailable } from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  makeBrowserResolutionCandidates,
  resolveBrowserExecutable,
} from "./BrowserExecutableResolver.ts";

const isBrowserUnavailable = Schema.is(BrowserUnavailable);

it.effect("resolves browser executables in environment, setting, then channel order", () =>
  Effect.gen(function* () {
    const attempted: string[] = [];
    const candidates = makeBrowserResolutionCandidates({
      environmentPath: "/env/chrome",
      settingPath: "/setting/chrome",
      channels: ["chrome", "chromium"],
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
      ["environment:/env/chrome", "setting:/setting/chrome", "channel:chrome", "channel:chromium"],
    );
    assert.include(error.message, "/env/chrome");
    assert.include(error.message, "chromium");
  }),
);
