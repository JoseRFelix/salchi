// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@salchi/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeCoordinatedEventNdjsonLoggers,
  makeEventNdjsonLogger,
  serializeProviderEvent,
} from "./EventNdjsonLogger.ts";

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.make("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.make("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = path.join(tempDir, "thread-1.log");
        const threadTwoPath = path.join(tempDir, "thread-2.log");
        assert.equal(fs.existsSync(threadOnePath), true);
        assert.equal(fs.existsSync(threadTwoPath), true);

        const first = parseLogLine(fs.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(fs.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-"));
        const basePath = path.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = path.join(tempDir, "_global.log");
          assert.equal(fs.existsSync(globalPath), true);
          const lines = fs
            .readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-"));
      const basePath = path.join(tempDir, "provider-canonical.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        const globalPath = path.join(tempDir, "_global.log");
        assert.equal(fs.existsSync(globalPath), true);
        const lines = fs
          .readFileSync(globalPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.payload).toSorted(), [
          '{"id":"evt-concurrent-1"}',
          '{"id":"evt-concurrent-2"}',
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxBytes: 120,
          maxFiles: 2,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        for (let index = 0; index < 10; index += 1) {
          yield* logger.write(
            {
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.make("thread-rotate"),
          );
        }
        yield* logger.close();

        const fileStem = "thread-rotate.log";
        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it("redacts secret keys and inline credentials and bounds large records", () => {
    const serialized = serializeProviderEvent(
      {
        password: "password-value-must-not-appear",
        nested: { apiKey: "api-key-must-not-appear" },
        output: "Authorization: Bearer bearer-value-must-not-appear " + "x".repeat(2_000),
      },
      { maxRecordBytes: 512, maxStringBytes: 128 },
    );

    assert.notEqual(serialized, undefined);
    assert.equal(serialized?.includes("password-value-must-not-appear"), false);
    assert.equal(serialized?.includes("api-key-must-not-appear"), false);
    assert.equal(serialized?.includes("bearer-value-must-not-appear"), false);
    assert.equal(serialized?.includes("[REDACTED]"), true);
    assert.equal(Buffer.byteLength(serialized ?? "") <= 512, true);
  });

  it.effect("coordinates native and canonical streams through one thread writer", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-"));
      try {
        const loggers = yield* makeCoordinatedEventNdjsonLoggers(path.join(tempDir, "events.log"), {
          batchWindowMs: 0,
          maxBytes: 256,
          maxFiles: 2,
        });
        assert.notEqual(loggers, undefined);
        if (!loggers) return;

        yield* Effect.all(
          Array.from({ length: 20 }, (_, index) =>
            index % 2 === 0
              ? loggers.native.write({ index, value: "n".repeat(20) }, ThreadId.make("shared"))
              : loggers.canonical.write({ index, value: "c".repeat(20) }, ThreadId.make("shared")),
          ),
          { concurrency: "unbounded" },
        );
        yield* loggers.canonical.close();

        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === "shared.log" || entry.startsWith("shared.log."));
        assert.equal(matchingFiles.length <= 3, true);
        const combined = matchingFiles
          .map((entry) => fs.readFileSync(path.join(tempDir, entry), "utf8"))
          .join("\n");
        assert.equal(combined.includes("NTIVE:"), true);
        assert.equal(combined.includes("CANON:"), true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("creates provider directories and files with private POSIX modes", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-mode-"));
      const tempDir = path.join(root, "provider");
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) return;
        yield* logger.write({ id: "private" }, ThreadId.make("private-thread"));
        yield* logger.close();

        assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(tempDir, "private-thread.log")).mode & 0o777, 0o600);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops queued writes and removes the log family when a thread is deleted", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-delete-"));
      try {
        const loggers = yield* makeCoordinatedEventNdjsonLoggers(path.join(tempDir, "events.log"), {
          batchWindowMs: 60_000,
        });
        assert.notEqual(loggers, undefined);
        if (!loggers) return;

        const threadId = ThreadId.make("delete-me");
        yield* loggers.canonical.write({ payload: "queued" }, threadId);
        yield* loggers.deleteThread(threadId);
        yield* loggers.canonical.close();

        assert.equal(fs.existsSync(path.join(tempDir, "delete-me.log")), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("enforces the global budget while diagnostics are being written", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "salchi-provider-log-budget-"));
      try {
        const loggers = yield* makeCoordinatedEventNdjsonLoggers(path.join(tempDir, "events.log"), {
          batchWindowMs: 0,
          maxBytes: 10_000,
          maxTotalBytes: 300,
          maxAgeMs: 60_000,
        });
        assert.notEqual(loggers, undefined);
        if (!loggers) return;

        for (let index = 0; index < 5; index += 1) {
          yield* loggers.canonical.write(
            { index, payload: "x".repeat(120) },
            ThreadId.make(`budget-${String(index)}`),
          );
        }
        yield* loggers.canonical.close();

        const totalBytes = fs
          .readdirSync(tempDir)
          .filter((entry) => entry.endsWith(".log") || /\.log\.\d+$/.test(entry))
          .reduce((total, entry) => total + fs.statSync(path.join(tempDir, entry)).size, 0);
        assert.equal(totalBytes <= 300, true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
