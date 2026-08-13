import { EnvironmentId } from "@salchi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearIndexedDbCachedEnvironmentStates,
  readIndexedDbCachedEnvironmentStateEntries,
  removeIndexedDbCachedEnvironmentState,
  writeIndexedDbCachedEnvironmentState,
} from "../orchestrationStartupCacheIndexedDb";

beforeEach(async () => {
  await clearIndexedDbCachedEnvironmentStates();
});

afterEach(async () => {
  await clearIndexedDbCachedEnvironmentStates();
});

describe("orchestration startup cache IndexedDB persistence", () => {
  it("round-trips conversation detail larger than the local startup document budget", async () => {
    const environmentId = EnvironmentId.make("indexed-db-large-detail");
    const largePayload = "x".repeat(2_100_000);

    await expect(
      writeIndexedDbCachedEnvironmentState({
        environmentId,
        updatedAt: "2026-07-29T00:00:00.000Z",
        state: { largePayload },
      }),
    ).resolves.toBe(true);

    const entries = await readIndexedDbCachedEnvironmentStateEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      environmentId,
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    expect((entries[0]!.state as { largePayload?: string }).largePayload).toHaveLength(
      largePayload.length,
    );
  });

  it("does not scan and discard older environments on ordinary writes", async () => {
    const total = 10;
    for (let index = 0; index < total; index += 1) {
      await writeIndexedDbCachedEnvironmentState({
        environmentId: EnvironmentId.make(`indexed-db-environment-${index}`),
        updatedAt: new Date(Date.UTC(2026, 6, 29, 0, 0, index)).toISOString(),
        state: { index },
      });
    }

    const entries = await readIndexedDbCachedEnvironmentStateEntries();
    expect(entries).toHaveLength(total);
    expect(entries.map((entry) => entry.environmentId)).toEqual(
      Array.from({ length: total }, (_, index) =>
        EnvironmentId.make(`indexed-db-environment-${total - index - 1}`),
      ),
    );
  });

  it("serializes removal behind pending writes so deleted environments cannot reappear", async () => {
    const environmentId = EnvironmentId.make("indexed-db-remove-after-write");

    const write = writeIndexedDbCachedEnvironmentState({
      environmentId,
      updatedAt: "2026-07-29T00:00:00.000Z",
      state: { message: "must stay deleted" },
    });
    const remove = removeIndexedDbCachedEnvironmentState(environmentId);
    await Promise.all([write, remove]);

    await expect(readIndexedDbCachedEnvironmentStateEntries()).resolves.toEqual([]);
  });

  it("does not let a stale cross-tab-style write replace a newer durable entry", async () => {
    const environmentId = EnvironmentId.make("indexed-db-stale-write");
    await writeIndexedDbCachedEnvironmentState({
      environmentId,
      updatedAt: "2026-07-29T00:00:02.000Z",
      state: { message: "newer" },
    });
    await writeIndexedDbCachedEnvironmentState({
      environmentId,
      updatedAt: "2026-07-29T00:00:01.000Z",
      state: { message: "older" },
    });

    const entries = await readIndexedDbCachedEnvironmentStateEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toEqual({ message: "newer" });
  });

  it("keeps the complete sidebar shell when a newer detail-only write arrives", async () => {
    const environmentId = EnvironmentId.make("indexed-db-independent-shell");
    await writeIndexedDbCachedEnvironmentState({
      environmentId,
      updatedAt: "2026-07-29T00:00:01.000Z",
      state: { message: "initial detail" },
      shellRevision: "shell-revision-1",
      shellUpdatedAt: "2026-07-29T00:00:01.000Z",
      shellState: { threadIds: ["thread-1", "thread-2"] },
    });
    await writeIndexedDbCachedEnvironmentState({
      environmentId,
      updatedAt: "2026-07-29T00:00:02.000Z",
      state: { message: "newer detail" },
    });

    const entries = await readIndexedDbCachedEnvironmentStateEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      state: { message: "newer detail" },
      shellRevision: "shell-revision-1",
      shellUpdatedAt: "2026-07-29T00:00:01.000Z",
      shellState: { threadIds: ["thread-1", "thread-2"] },
    });
  });
});
