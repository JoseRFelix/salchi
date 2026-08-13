import type { PersistStorage, StorageValue } from "zustand/middleware";

const DATABASE_NAME = "salchi-composer-drafts";
const DATABASE_VERSION = 1;
const STATE_STORE_NAME = "states";
const ATTACHMENT_STORE_NAME = "attachments";
const ATTACHMENT_STORAGE_NAME_INDEX = "storageName";
const ATTACHMENT_REFERENCE_KEY = "__salchiBlobKey";

export const COMPOSER_DRAFT_INDEXED_DB_SOFT_LIMIT_BYTES = 512 * 1024 * 1024;

interface StoredStateRecord {
  readonly name: string;
  readonly value: StorageValue<unknown>;
  readonly updatedAtMs: number;
  readonly attachmentFingerprint: string;
  readonly referencedAttachmentBytes: number;
}

interface StoredAttachmentRecord {
  readonly blobKey: string;
  readonly storageName: string;
  readonly signature: string;
  readonly blob: Blob;
  readonly updatedAtMs: number;
}

interface AttachmentWrite {
  readonly record: StoredAttachmentRecord;
}

interface SplitStorageValue<S> {
  readonly value: StorageValue<S>;
  readonly writes: readonly AttachmentWrite[];
  readonly referencedBlobKeys: ReadonlySet<string>;
  readonly attachmentFingerprint: string;
  readonly referencedAttachmentBytes: number;
}

export interface ComposerDraftStorageDiagnostics {
  readonly backend: "indexeddb" | "localstorage" | "memory";
  readonly referencedAttachmentBytes: number;
  readonly softLimitBytes: number;
  readonly overSoftLimit: boolean;
}

export interface ComposerDraftPersistStorage<S> extends PersistStorage<S, void> {
  readonly flush: () => Promise<boolean>;
  readonly hasPersistedAttachments: (
    name: string,
    threadKey: string,
    attachmentIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  readonly readDiagnostics: () => Promise<ComposerDraftStorageDiagnostics>;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localStorageTarget(): Storage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) {
    return databasePromise;
  }
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }

  let opening!: Promise<IDBDatabase | null>;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STATE_STORE_NAME)) {
        database.createObjectStore(STATE_STORE_NAME, { keyPath: "name" });
      }
      if (!database.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
        const attachments = database.createObjectStore(ATTACHMENT_STORE_NAME, {
          keyPath: "blobKey",
        });
        attachments.createIndex(ATTACHMENT_STORAGE_NAME_INDEX, "storageName", { unique: false });
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        database.close();
        if (databasePromise === opening) {
          databasePromise = null;
        }
      });
      finish(database);
    });
    request.addEventListener("error", () => finish(null));
    request.addEventListener("blocked", () => finish(null));
  });

  databasePromise = opening;
  void opening.then((database) => {
    if (database === null && databasePromise === opening) {
      databasePromise = null;
    }
  });
  return opening;
}

function readRequest<A>(request: IDBRequest<A>): Promise<A | undefined> {
  return new Promise((resolve) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => resolve(undefined), { once: true });
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    transaction.addEventListener("complete", () => resolve(true), { once: true });
    transaction.addEventListener("abort", () => resolve(false), { once: true });
    transaction.addEventListener("error", () => resolve(false), { once: true });
  });
}

function encodeBlobKey(storageName: string, threadKey: string, attachmentId: string): string {
  return `${encodeURIComponent(storageName)}:${encodeURIComponent(threadKey)}:${encodeURIComponent(attachmentId)}`;
}

function attachmentSignature(attachment: Record<string, unknown>, dataUrl: string): string {
  return [
    String(attachment.id ?? ""),
    String(attachment.type ?? "image"),
    String(attachment.mimeType ?? ""),
    String(attachment.sizeBytes ?? ""),
    String(attachment.name ?? ""),
    dataUrl.length.toString(36),
    dataUrl.slice(-32),
  ].join("\u0000");
}

function dataUrlToBlob(dataUrl: string, fallbackMimeType: string): Blob | null {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    return null;
  }
  const header = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeType = header.split(";", 1)[0] || fallbackMimeType;

  try {
    if (!header.includes(";base64")) {
      return new Blob([decodeURIComponent(payload)], { type: mimeType });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  if (typeof FileReader === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => resolve(typeof reader.result === "string" ? reader.result : null),
      { once: true },
    );
    reader.addEventListener("error", () => resolve(null), { once: true });
    reader.addEventListener("abort", () => resolve(null), { once: true });
    reader.readAsDataURL(blob);
  });
}

function readDraftEntries(value: StorageValue<unknown>): Record<string, unknown> | null {
  if (!isRecord(value.state) || !isRecord(value.state.draftsByThreadKey)) {
    return null;
  }
  return value.state.draftsByThreadKey;
}

function splitAttachmentsFromStorageValue<S>(input: {
  readonly name: string;
  readonly value: StorageValue<S>;
  readonly knownAttachmentSignatures: ReadonlyMap<string, string>;
}): SplitStorageValue<S> {
  const rawValue = input.value as StorageValue<unknown>;
  const drafts = readDraftEntries(rawValue);
  if (!drafts) {
    return {
      value: input.value,
      writes: [],
      referencedBlobKeys: new Set(),
      attachmentFingerprint: "",
      referencedAttachmentBytes: 0,
    };
  }

  const nextDrafts: Record<string, unknown> = { ...drafts };
  const writes: AttachmentWrite[] = [];
  const referencedBlobKeys = new Set<string>();
  let referencedAttachmentBytes = 0;

  for (const [threadKey, rawDraft] of Object.entries(drafts)) {
    if (!isRecord(rawDraft) || !Array.isArray(rawDraft.attachments)) {
      continue;
    }
    const attachments = rawDraft.attachments.flatMap((rawAttachment) => {
      if (!isRecord(rawAttachment) || typeof rawAttachment.id !== "string") {
        return [];
      }
      const blobKey = encodeBlobKey(input.name, threadKey, rawAttachment.id);
      const dataUrl = typeof rawAttachment.dataUrl === "string" ? rawAttachment.dataUrl : null;
      const existingBlobKey =
        typeof rawAttachment[ATTACHMENT_REFERENCE_KEY] === "string"
          ? rawAttachment[ATTACHMENT_REFERENCE_KEY]
          : blobKey;
      referencedBlobKeys.add(existingBlobKey);
      const sizeBytes =
        typeof rawAttachment.sizeBytes === "number" && Number.isFinite(rawAttachment.sizeBytes)
          ? Math.max(0, rawAttachment.sizeBytes)
          : 0;
      referencedAttachmentBytes += sizeBytes;

      if (dataUrl) {
        const signature = attachmentSignature(rawAttachment, dataUrl);
        if (input.knownAttachmentSignatures.get(blobKey) !== signature) {
          const blob = dataUrlToBlob(
            dataUrl,
            typeof rawAttachment.mimeType === "string" ? rawAttachment.mimeType : "",
          );
          if (blob) {
            writes.push({
              record: {
                blobKey,
                storageName: input.name,
                signature,
                blob,
                updatedAtMs: Date.now(),
              },
            });
          }
        }
      }

      const { dataUrl: _dataUrl, ...metadata } = rawAttachment;
      return [{ ...metadata, [ATTACHMENT_REFERENCE_KEY]: existingBlobKey }];
    });
    nextDrafts[threadKey] = { ...rawDraft, attachments };
  }

  const nextState = {
    ...(rawValue.state as Record<string, unknown>),
    draftsByThreadKey: nextDrafts,
  };
  const attachmentFingerprint = [...referencedBlobKeys].toSorted().join("\n");
  return {
    value: { ...rawValue, state: nextState } as StorageValue<S>,
    writes,
    referencedBlobKeys,
    attachmentFingerprint,
    referencedAttachmentBytes,
  };
}

async function hydrateAttachmentsInStorageValue<S>(
  value: StorageValue<S>,
  attachments: readonly StoredAttachmentRecord[],
): Promise<StorageValue<S>> {
  const rawValue = value as StorageValue<unknown>;
  const drafts = readDraftEntries(rawValue);
  if (!drafts) {
    return value;
  }

  const attachmentByKey = new Map(
    attachments.map((attachment) => [attachment.blobKey, attachment]),
  );
  const dataUrlByKey = new Map<string, string>();
  await Promise.all(
    attachments.map(async (attachment) => {
      const dataUrl = await blobToDataUrl(attachment.blob);
      if (dataUrl) {
        dataUrlByKey.set(attachment.blobKey, dataUrl);
      }
    }),
  );

  const nextDrafts: Record<string, unknown> = { ...drafts };
  for (const [threadKey, rawDraft] of Object.entries(drafts)) {
    if (!isRecord(rawDraft) || !Array.isArray(rawDraft.attachments)) {
      continue;
    }
    const hydratedAttachments = rawDraft.attachments.flatMap((rawAttachment) => {
      if (!isRecord(rawAttachment)) {
        return [];
      }
      const blobKey =
        typeof rawAttachment[ATTACHMENT_REFERENCE_KEY] === "string"
          ? rawAttachment[ATTACHMENT_REFERENCE_KEY]
          : "";
      const attachment = attachmentByKey.get(blobKey);
      const dataUrl = dataUrlByKey.get(blobKey);
      if (!attachment || !dataUrl) {
        return [];
      }
      const { [ATTACHMENT_REFERENCE_KEY]: _blobKey, ...metadata } = rawAttachment;
      return [{ ...metadata, dataUrl }];
    });
    nextDrafts[threadKey] = { ...rawDraft, attachments: hydratedAttachments };
  }

  return {
    ...rawValue,
    state: { ...(rawValue.state as Record<string, unknown>), draftsByThreadKey: nextDrafts },
  } as StorageValue<S>;
}

function readLegacyStorageValue<S>(name: string): StorageValue<S> | null {
  const storage = localStorageTarget();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(name);
    return raw ? (JSON.parse(raw) as StorageValue<S>) : null;
  } catch {
    return null;
  }
}

function writeLegacyStorageValue<S>(name: string, value: StorageValue<S>): boolean {
  const storage = localStorageTarget();
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

async function readIndexedDbValue<S>(name: string): Promise<{
  readonly value: StorageValue<S> | null;
  readonly stateRecord: StoredStateRecord | null;
  readonly attachments: readonly StoredAttachmentRecord[];
}> {
  const database = await openDatabase();
  if (!database) {
    return { value: null, stateRecord: null, attachments: [] };
  }

  try {
    const transaction = database.transaction([STATE_STORE_NAME, ATTACHMENT_STORE_NAME], "readonly");
    const stateRequest = transaction.objectStore(STATE_STORE_NAME).get(name);
    const attachmentRequest = transaction
      .objectStore(ATTACHMENT_STORE_NAME)
      .index(ATTACHMENT_STORAGE_NAME_INDEX)
      .getAll(name);
    const [rawState, rawAttachments] = await Promise.all([
      readRequest(stateRequest),
      readRequest(attachmentRequest),
    ]);
    const stateRecord =
      isRecord(rawState) && isRecord(rawState.value)
        ? (rawState as unknown as StoredStateRecord)
        : null;
    const attachments = Array.isArray(rawAttachments)
      ? (rawAttachments as StoredAttachmentRecord[]).filter(
          (attachment) => attachment.storageName === name && attachment.blob instanceof Blob,
        )
      : [];
    if (!stateRecord) {
      return { value: null, stateRecord: null, attachments };
    }
    return {
      value: await hydrateAttachmentsInStorageValue(
        stateRecord.value as StorageValue<S>,
        attachments,
      ),
      stateRecord,
      attachments,
    };
  } catch {
    return { value: null, stateRecord: null, attachments: [] };
  }
}

export function createComposerDraftPersistStorage<S>(
  options: {
    readonly debounceMs?: number;
    readonly softLimitBytes?: number;
  } = {},
): ComposerDraftPersistStorage<S> {
  const debounceMs = Math.max(0, options.debounceMs ?? 300);
  const softLimitBytes = Math.max(
    0,
    options.softLimitBytes ?? COMPOSER_DRAFT_INDEXED_DB_SOFT_LIMIT_BYTES,
  );
  const knownAttachmentSignatures = new Map<string, string>();
  let lastAttachmentFingerprint = "";
  let lastReferencedAttachmentBytes = 0;
  let lastBackend: ComposerDraftStorageDiagnostics["backend"] =
    typeof indexedDB === "undefined"
      ? localStorageTarget()
        ? "localstorage"
        : "memory"
      : "indexeddb";
  let memoryValue: { readonly name: string; readonly value: StorageValue<S> } | null = null;
  let pending: { readonly name: string; readonly value: StorageValue<S> } | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let operationTail: Promise<boolean> = Promise.resolve(true);

  const writeIndexedDb = async (name: string, value: StorageValue<S>): Promise<boolean> => {
    const database = await openDatabase();
    if (!database) {
      lastBackend = localStorageTarget() ? "localstorage" : "memory";
      if (writeLegacyStorageValue(name, value)) {
        return true;
      }
      memoryValue = { name, value };
      return true;
    }

    lastBackend = "indexeddb";
    const split = splitAttachmentsFromStorageValue({
      name,
      value,
      knownAttachmentSignatures,
    });
    const attachmentSetChanged = split.attachmentFingerprint !== lastAttachmentFingerprint;
    const incomingBlobKeys = new Set(split.writes.map((write) => write.record.blobKey));
    let persistedAttachmentBytes = split.referencedAttachmentBytes;
    const removedBlobKeys = new Set<string>();

    let transaction: IDBTransaction;
    try {
      transaction = database.transaction([STATE_STORE_NAME, ATTACHMENT_STORE_NAME], "readwrite");
      const stateStore = transaction.objectStore(STATE_STORE_NAME);
      const stateRecord = {
        name,
        value: split.value,
        updatedAtMs: Date.now(),
        attachmentFingerprint: split.attachmentFingerprint,
        referencedAttachmentBytes: split.referencedAttachmentBytes,
      } satisfies StoredStateRecord;
      stateStore.put(stateRecord);
      const attachmentStore = transaction.objectStore(ATTACHMENT_STORE_NAME);
      for (const write of split.writes) {
        attachmentStore.put(write.record);
      }
      if (attachmentSetChanged || split.referencedAttachmentBytes > softLimitBytes) {
        const attachmentsRequest = attachmentStore
          .index(ATTACHMENT_STORAGE_NAME_INDEX)
          .getAll(name);
        attachmentsRequest.addEventListener(
          "success",
          () => {
            const referencedAttachments = (attachmentsRequest.result as StoredAttachmentRecord[])
              .filter((attachment) => {
                if (!split.referencedBlobKeys.has(attachment.blobKey)) {
                  attachmentStore.delete(attachment.blobKey);
                  removedBlobKeys.add(attachment.blobKey);
                  return false;
                }
                return attachment.blob instanceof Blob;
              })
              .toSorted((left, right) => {
                const leftIsIncoming = incomingBlobKeys.has(left.blobKey);
                const rightIsIncoming = incomingBlobKeys.has(right.blobKey);
                return (
                  Number(leftIsIncoming) - Number(rightIsIncoming) ||
                  left.updatedAtMs - right.updatedAtMs ||
                  left.blobKey.localeCompare(right.blobKey)
                );
              });
            persistedAttachmentBytes = referencedAttachments.reduce(
              (total, attachment) => total + attachment.blob.size,
              0,
            );
            for (const attachment of referencedAttachments) {
              if (persistedAttachmentBytes <= softLimitBytes) {
                break;
              }
              attachmentStore.delete(attachment.blobKey);
              removedBlobKeys.add(attachment.blobKey);
              persistedAttachmentBytes -= attachment.blob.size;
            }
            stateStore.put({
              ...stateRecord,
              referencedAttachmentBytes: persistedAttachmentBytes,
            } satisfies StoredStateRecord);
          },
          { once: true },
        );
      }
    } catch {
      return false;
    }

    const persisted = await waitForTransaction(transaction);
    if (!persisted) {
      return false;
    }
    for (const write of split.writes) {
      knownAttachmentSignatures.set(write.record.blobKey, write.record.signature);
    }
    for (const blobKey of knownAttachmentSignatures.keys()) {
      if (!split.referencedBlobKeys.has(blobKey) || removedBlobKeys.has(blobKey)) {
        knownAttachmentSignatures.delete(blobKey);
      }
    }
    lastAttachmentFingerprint = split.attachmentFingerprint;
    lastReferencedAttachmentBytes = persistedAttachmentBytes;
    try {
      localStorageTarget()?.removeItem(name);
    } catch {
      // IndexedDB is authoritative after this point; legacy cleanup is best effort.
    }
    return true;
  };

  const flush = (): Promise<boolean> => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    const next = pending;
    pending = null;
    if (!next) {
      return operationTail;
    }
    operationTail = operationTail
      .catch(() => false)
      .then(() => writeIndexedDb(next.name, next.value));
    return operationTail;
  };

  const schedule = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      void flush();
    }, debounceMs);
  };

  return {
    getItem: async (name) => {
      const indexedDb = await readIndexedDbValue<S>(name);
      if (indexedDb.value) {
        lastBackend = "indexeddb";
        lastAttachmentFingerprint = indexedDb.stateRecord?.attachmentFingerprint ?? "";
        lastReferencedAttachmentBytes = indexedDb.attachments.reduce(
          (total, attachment) => total + attachment.blob.size,
          0,
        );
        knownAttachmentSignatures.clear();
        for (const attachment of indexedDb.attachments) {
          knownAttachmentSignatures.set(attachment.blobKey, attachment.signature);
        }
        return indexedDb.value;
      }
      const legacy = readLegacyStorageValue<S>(name);
      if (legacy) {
        lastBackend = "localstorage";
        return legacy;
      }
      return memoryValue?.name === name ? memoryValue.value : null;
    },
    setItem: (name, value) => {
      pending = { name, value };
      schedule();
    },
    removeItem: (name) => {
      if (pending?.name === name) {
        pending = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      operationTail = operationTail
        .catch(() => false)
        .then(async () => {
          const database = await openDatabase();
          if (!database) {
            try {
              localStorageTarget()?.removeItem(name);
            } catch {
              // Best effort in privacy-restricted browser contexts.
            }
            if (memoryValue?.name === name) {
              memoryValue = null;
            }
            return true;
          }
          try {
            const transaction = database.transaction(
              [STATE_STORE_NAME, ATTACHMENT_STORE_NAME],
              "readwrite",
            );
            transaction.objectStore(STATE_STORE_NAME).delete(name);
            const attachmentStore = transaction.objectStore(ATTACHMENT_STORE_NAME);
            const keysRequest = attachmentStore
              .index(ATTACHMENT_STORAGE_NAME_INDEX)
              .getAllKeys(name);
            keysRequest.addEventListener(
              "success",
              () => {
                for (const key of keysRequest.result) {
                  attachmentStore.delete(key);
                }
              },
              { once: true },
            );
            return await waitForTransaction(transaction);
          } catch {
            return false;
          }
        });
    },
    flush,
    hasPersistedAttachments: async (name, threadKey, attachmentIds) => {
      await flush();
      const database = await openDatabase();
      if (!database) {
        const legacy = readLegacyStorageValue<unknown>(name);
        const drafts = legacy ? readDraftEntries(legacy) : null;
        const draft = drafts?.[threadKey];
        const persistedIds =
          isRecord(draft) && Array.isArray(draft.attachments)
            ? new Set(
                draft.attachments.flatMap((attachment) =>
                  isRecord(attachment) &&
                  typeof attachment.id === "string" &&
                  typeof attachment.dataUrl === "string" &&
                  attachment.dataUrl.startsWith("data:")
                    ? [attachment.id]
                    : [],
                ),
              )
            : new Set<string>();
        return new Set(attachmentIds.filter((attachmentId) => persistedIds.has(attachmentId)));
      }
      try {
        const transaction = database.transaction(ATTACHMENT_STORE_NAME, "readonly");
        const store = transaction.objectStore(ATTACHMENT_STORE_NAME);
        const results = await Promise.all(
          attachmentIds.map(async (attachmentId) => {
            const record = await readRequest(
              store.get(encodeBlobKey(name, threadKey, attachmentId)),
            );
            return record ? attachmentId : null;
          }),
        );
        return new Set(results.flatMap((attachmentId) => (attachmentId ? [attachmentId] : [])));
      } catch {
        return new Set<string>();
      }
    },
    readDiagnostics: async () => {
      await flush();
      return {
        backend: lastBackend,
        referencedAttachmentBytes: lastReferencedAttachmentBytes,
        softLimitBytes,
        overSoftLimit: lastReferencedAttachmentBytes > softLimitBytes,
      };
    },
  };
}
