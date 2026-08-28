import { ThreadId } from "@salchi/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vitest";

import {
  logCleanupCauseUnlessInterrupted,
  runThreadDeletionCleanup,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });

  it("includes provider-log removal in ordered thread deletion cleanup", async () => {
    const operations = await Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* Ref.make<Array<string>>([]);
        const record = (operation: string) =>
          Ref.update(observed, (items) => [...items, operation]);
        yield* runThreadDeletionCleanup({
          stopProviderSession: record("provider"),
          closeThreadTerminals: record("terminals"),
          stopThreadBrowser: record("browser"),
          deleteTurnFileSnapshots: record("snapshots"),
          deleteProviderEventLogs: record("provider-logs"),
        });
        return yield* Ref.get(observed);
      }),
    );

    expect(operations).toEqual(["provider", "terminals", "browser", "snapshots", "provider-logs"]);
  });
});
