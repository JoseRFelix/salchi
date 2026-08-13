import { afterEach, describe, expect, it } from "vitest";

import {
  COMPOSER_DRAFT_INDEXED_DB_SOFT_LIMIT_BYTES,
  createComposerDraftPersistStorage,
  type ComposerDraftPersistStorage,
} from "../composerDraftIndexedDbStorage";

interface TestPersistedState {
  readonly draftsByThreadKey: Record<
    string,
    {
      readonly prompt: string;
      readonly attachments: ReadonlyArray<{
        readonly type: "image";
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly sizeBytes: number;
        readonly dataUrl: string;
      }>;
    }
  >;
}

const storages: Array<{
  readonly name: string;
  readonly storage: ComposerDraftPersistStorage<TestPersistedState>;
}> = [];
let testStorageId = 0;

function nextStorageName(prefix: string): string {
  testStorageId += 1;
  return `${prefix}-${testStorageId}`;
}

afterEach(async () => {
  await Promise.all(
    storages.splice(0).map(async ({ name, storage }) => {
      storage.removeItem(name);
      await storage.flush();
    }),
  );
});

function makeStorage(name: string, softLimitBytes?: number) {
  const storage = createComposerDraftPersistStorage<TestPersistedState>({
    debounceMs: 60_000,
    ...(softLimitBytes === undefined ? {} : { softLimitBytes }),
  });
  storages.push({ name, storage });
  return storage;
}

describe("composer draft IndexedDB storage", () => {
  it("defers writes and round-trips attachment blobs outside localStorage", async () => {
    const name = nextStorageName("composer-indexed-db");
    const threadKey = "environment:thread";
    const storage = makeStorage(name);
    const payload = btoa("persist me");
    const dataUrl = `data:image/png;base64,${payload}`;

    storage.setItem(name, {
      version: 1,
      state: {
        draftsByThreadKey: {
          [threadKey]: {
            prompt: "hello",
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 10,
                dataUrl,
              },
            ],
          },
        },
      },
    });

    expect(localStorage.getItem(name)).toBeNull();
    await expect(storage.flush()).resolves.toBe(true);
    expect(localStorage.getItem(name)).toBeNull();

    const restored = await makeStorage(name).getItem(name);
    expect(restored?.state.draftsByThreadKey[threadKey]?.prompt).toBe("hello");
    expect(restored?.state.draftsByThreadKey[threadKey]?.attachments[0]?.dataUrl).toBe(dataUrl);
    await expect(
      storage.hasPersistedAttachments(name, threadKey, ["attachment-1", "missing"]),
    ).resolves.toEqual(new Set(["attachment-1"]));

    await expect(storage.readDiagnostics()).resolves.toEqual({
      backend: "indexeddb",
      referencedAttachmentBytes: 10,
      softLimitBytes: COMPOSER_DRAFT_INDEXED_DB_SOFT_LIMIT_BYTES,
      overSoftLimit: false,
    });
  });

  it("prunes an unreferenced attachment when the draft is updated", async () => {
    const name = nextStorageName("composer-indexed-db-prune");
    const threadKey = "environment:thread";
    const storage = makeStorage(name);
    storage.setItem(name, {
      state: {
        draftsByThreadKey: {
          [threadKey]: {
            prompt: "with attachment",
            attachments: [
              {
                type: "image",
                id: "attachment-to-prune",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: "data:image/png;base64,AQIDBA==",
              },
            ],
          },
        },
      },
    });
    await storage.flush();

    storage.setItem(name, {
      state: {
        draftsByThreadKey: {
          [threadKey]: {
            prompt: "attachment removed",
            attachments: [],
          },
        },
      },
    });
    await storage.flush();

    await expect(
      storage.hasPersistedAttachments(name, threadKey, ["attachment-to-prune"]),
    ).resolves.toEqual(new Set());
  });

  it("evicts the oldest attachment blobs when the soft bound is exceeded", async () => {
    const name = nextStorageName("composer-indexed-db-bounded");
    const threadKey = "environment:bounded-thread";
    const storage = makeStorage(name, 5);
    storage.setItem(name, {
      state: {
        draftsByThreadKey: {
          [threadKey]: {
            prompt: "old attachment",
            attachments: [
              {
                type: "image",
                id: "old",
                name: "old.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: "data:image/png;base64,AQIDBA==",
              },
            ],
          },
        },
      },
    });
    await storage.flush();

    storage.setItem(name, {
      state: {
        draftsByThreadKey: {
          [threadKey]: {
            prompt: "new attachment",
            attachments: [
              {
                type: "image",
                id: "old",
                name: "old.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: "data:image/png;base64,AQIDBA==",
              },
              {
                type: "image",
                id: "new",
                name: "new.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: "data:image/png;base64,BQYHCA==",
              },
            ],
          },
        },
      },
    });
    await storage.flush();

    await expect(storage.hasPersistedAttachments(name, threadKey, ["old", "new"])).resolves.toEqual(
      new Set(["new"]),
    );
    await expect(storage.readDiagnostics()).resolves.toMatchObject({
      referencedAttachmentBytes: 4,
      softLimitBytes: 5,
      overSoftLimit: false,
    });
  });
});
