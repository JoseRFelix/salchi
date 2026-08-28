import { ThreadId, type BrowserViewportFrame } from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeLatestViewportMailbox } from "./LatestViewportMailbox.ts";

const threadId = ThreadId.make("viewport-mailbox-test");

function frame(seq: number): BrowserViewportFrame {
  return {
    _tag: "Frame",
    threadId,
    targetId: "target-1",
    dataBase64: `frame-${seq}`,
    width: 800,
    height: 600,
    seq,
    capturedAt: DateTime.makeUnsafe("2026-08-24T00:00:00.000Z"),
  };
}

it.effect("keeps only the latest screencast frame for a slow subscriber", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mailbox = yield* makeLatestViewportMailbox(threadId);
      for (let seq = 1; seq <= 100; seq += 1) mailbox.publishFrame(frame(seq));

      const frames = yield* mailbox.stream.pipe(
        Stream.filter((event): event is BrowserViewportFrame => event._tag === "Frame"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(frames.length, 1);
      assert.equal(frames[0]?.seq, 100);
      assert.equal(frames[0]?.dataBase64, "frame-100");
    }),
  ),
);

it.effect("does not replay a prior session frame after a stopped status", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mailbox = yield* makeLatestViewportMailbox(threadId);
      mailbox.publishFrame(frame(1));
      mailbox.publishStatus("stopped");

      const events = yield* mailbox.stream.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event._tag),
        ["Status", "Tabs"],
      );
    }),
  ),
);

it.effect("interrupts a mailbox subscription without leaving a waiting pull", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mailbox = yield* makeLatestViewportMailbox(threadId);
      const fiber = yield* mailbox.stream.pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const exit = fiber.pollUnsafe();
      assert.isDefined(exit);
      if (exit !== undefined) assert.isTrue(Exit.isFailure(exit));
    }),
  ),
);
