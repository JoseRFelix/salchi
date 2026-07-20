import { EnvironmentId, type EnvironmentId as EnvironmentIdValue } from "@salchi/contracts";

import { randomUUID } from "./lib/utils";

const DICTATION_DATABASE_NAME = "salchi-retained-dictation-recordings";
const DICTATION_DATABASE_VERSION = 1;
const DICTATION_STORE_NAME = "recordings";

export const RETAINED_DICTATION_RECORDING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface RetainedDictationRecording {
  readonly id: string;
  readonly ownerKey: string;
  readonly environmentId: EnvironmentIdValue;
  readonly audio: Blob;
  readonly normalizedAudio: Blob | null;
  readonly createdAt: number;
}

type RetainedDictationRecordingListener = (recording: RetainedDictationRecording | null) => void;

const recordingsByOwnerKey = new Map<string, RetainedDictationRecording>();
const listenersByOwnerKey = new Map<string, Set<RetainedDictationRecordingListener>>();
const ownerOperationTails = new Map<string, Promise<void>>();

let databasePromise: Promise<IDBDatabase | null> | null = null;
let cleanupStarted = false;
let fallbackRecordingId = 0;

function isExpired(recording: RetainedDictationRecording, now = Date.now()): boolean {
  return now - recording.createdAt > RETAINED_DICTATION_RECORDING_MAX_AGE_MS;
}

function decodeStoredRecording(value: unknown): RetainedDictationRecording | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.ownerKey !== "string" ||
    candidate.ownerKey.length === 0 ||
    typeof candidate.environmentId !== "string" ||
    candidate.environmentId.length === 0 ||
    !(candidate.audio instanceof Blob) ||
    (candidate.normalizedAudio !== null && !(candidate.normalizedAudio instanceof Blob)) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }

  return {
    id: candidate.id,
    ownerKey: candidate.ownerKey,
    environmentId: EnvironmentId.make(candidate.environmentId),
    audio: candidate.audio,
    normalizedAudio: candidate.normalizedAudio,
    createdAt: candidate.createdAt,
  };
}

function notifyOwner(ownerKey: string): void {
  const recording = recordingsByOwnerKey.get(ownerKey) ?? null;
  for (const listener of listenersByOwnerKey.get(ownerKey) ?? []) {
    listener(recording);
  }
}

function publishRecording(recording: RetainedDictationRecording): void {
  recordingsByOwnerKey.set(recording.ownerKey, recording);
  notifyOwner(recording.ownerKey);
}

function removePublishedRecording(ownerKey: string, expectedRecordingId?: string): boolean {
  const current = recordingsByOwnerKey.get(ownerKey);
  if (!current || (expectedRecordingId !== undefined && current.id !== expectedRecordingId)) {
    return false;
  }
  recordingsByOwnerKey.delete(ownerKey);
  notifyOwner(ownerKey);
  return true;
}

function enqueueOwnerOperation<A>(ownerKey: string, operation: () => Promise<A>): Promise<A> {
  const previous = ownerOperationTails.get(ownerKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  ownerOperationTails.set(ownerKey, tail);
  void tail.then(() => {
    if (ownerOperationTails.get(ownerKey) === tail) ownerOperationTails.delete(ownerKey);
  });
  return result;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

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
      request = indexedDB.open(DICTATION_DATABASE_NAME, DICTATION_DATABASE_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DICTATION_STORE_NAME)) {
        database.createObjectStore(DICTATION_STORE_NAME, { keyPath: "ownerKey" });
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        database.close();
        if (databasePromise === opening) databasePromise = null;
      });
      finish(database);
    });
    request.addEventListener("error", () => finish(null));
    request.addEventListener("blocked", () => finish(null));
  });
  databasePromise = opening;
  void opening.then((database) => {
    if (database === null && databasePromise === opening) databasePromise = null;
  });
  return opening;
}

async function writeStoredRecording(recording: RetainedDictationRecording): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  return new Promise<boolean>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(DICTATION_STORE_NAME, "readwrite");
      transaction.objectStore(DICTATION_STORE_NAME).put(recording);
    } catch {
      resolve(false);
      return;
    }
    transaction.addEventListener("complete", () => resolve(true), { once: true });
    transaction.addEventListener("abort", () => resolve(false), { once: true });
    transaction.addEventListener("error", () => resolve(false), { once: true });
  });
}

async function readStoredRecording(ownerKey: string): Promise<RetainedDictationRecording | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise<RetainedDictationRecording | null>((resolve) => {
    let request: IDBRequest<unknown>;
    try {
      request = database
        .transaction(DICTATION_STORE_NAME, "readonly")
        .objectStore(DICTATION_STORE_NAME)
        .get(ownerKey);
    } catch {
      resolve(null);
      return;
    }
    request.addEventListener("success", () => resolve(decodeStoredRecording(request.result)), {
      once: true,
    });
    request.addEventListener("error", () => resolve(null), { once: true });
  });
}

async function deleteStoredRecording(
  ownerKey: string,
  expectedRecordingId?: string,
): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  return new Promise<boolean>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(DICTATION_STORE_NAME, "readwrite");
      const store = transaction.objectStore(DICTATION_STORE_NAME);
      if (expectedRecordingId === undefined) {
        store.delete(ownerKey);
      } else {
        const request = store.get(ownerKey);
        request.addEventListener(
          "success",
          () => {
            const stored = decodeStoredRecording(request.result);
            if (stored?.id === expectedRecordingId) store.delete(ownerKey);
          },
          { once: true },
        );
      }
    } catch {
      resolve(false);
      return;
    }
    transaction.addEventListener("complete", () => resolve(true), { once: true });
    transaction.addEventListener("abort", () => resolve(false), { once: true });
    transaction.addEventListener("error", () => resolve(false), { once: true });
  });
}

async function deleteExpiredStoredRecordings(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;

  await new Promise<void>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(DICTATION_STORE_NAME, "readwrite");
      const request = transaction.objectStore(DICTATION_STORE_NAME).openCursor();
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) return;
        const recording = decodeStoredRecording(cursor.value);
        if (!recording || isExpired(recording)) cursor.delete();
        cursor.continue();
      });
    } catch {
      resolve();
      return;
    }
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => resolve(), { once: true });
    transaction.addEventListener("error", () => resolve(), { once: true });
  });
}

function startExpiredRecordingCleanup(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  void deleteExpiredStoredRecordings();
}

export function createDictationRecordingOwnerKey(
  owner:
    | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
    | { readonly kind: "draft"; readonly draftId: string },
): string {
  return owner.kind === "thread"
    ? JSON.stringify([owner.kind, owner.environmentId, owner.threadId])
    : JSON.stringify([owner.kind, owner.draftId]);
}

export function createRetainedDictationRecordingId(): string {
  if (typeof crypto !== "undefined") return randomUUID();
  fallbackRecordingId += 1;
  return `dictation-${Date.now().toString(36)}-${fallbackRecordingId.toString(36)}`;
}

export function subscribeRetainedDictationRecording(
  ownerKey: string,
  listener: RetainedDictationRecordingListener,
): () => void {
  const listeners = listenersByOwnerKey.get(ownerKey) ?? new Set();
  listeners.add(listener);
  listenersByOwnerKey.set(ownerKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByOwnerKey.delete(ownerKey);
  };
}

export async function retainDictationRecording(
  recording: RetainedDictationRecording,
): Promise<boolean> {
  publishRecording(recording);
  startExpiredRecordingCleanup();
  return enqueueOwnerOperation(recording.ownerKey, () => writeStoredRecording(recording));
}

export async function loadRetainedDictationRecording(
  ownerKey: string,
): Promise<RetainedDictationRecording | null> {
  startExpiredRecordingCleanup();
  await ownerOperationTails.get(ownerKey)?.catch(() => undefined);

  const inMemory = recordingsByOwnerKey.get(ownerKey);
  if (inMemory) {
    if (!isExpired(inMemory)) return inMemory;
    removePublishedRecording(ownerKey, inMemory.id);
    void enqueueOwnerOperation(ownerKey, () => deleteStoredRecording(ownerKey, inMemory.id));
    return null;
  }

  const stored = await readStoredRecording(ownerKey);
  const newerInMemory = recordingsByOwnerKey.get(ownerKey);
  if (newerInMemory) return newerInMemory;
  if (!stored) return null;
  if (isExpired(stored)) {
    void enqueueOwnerOperation(ownerKey, () => deleteStoredRecording(ownerKey, stored.id));
    return null;
  }
  publishRecording(stored);
  return stored;
}

export async function discardRetainedDictationRecording(
  ownerKey: string,
  expectedRecordingId?: string,
): Promise<boolean> {
  removePublishedRecording(ownerKey, expectedRecordingId);
  return enqueueOwnerOperation(ownerKey, () =>
    deleteStoredRecording(ownerKey, expectedRecordingId),
  );
}

export function clearRetainedDictationRecordingMemoryForTests(): void {
  recordingsByOwnerKey.clear();
}

export async function resetRetainedDictationRecordingStoreForTests(): Promise<void> {
  recordingsByOwnerKey.clear();
  for (const ownerKey of listenersByOwnerKey.keys()) notifyOwner(ownerKey);
  await Promise.all(ownerOperationTails.values());
  ownerOperationTails.clear();
  cleanupStarted = false;
  fallbackRecordingId = 0;

  const database = await databasePromise;
  database?.close();
  databasePromise = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DICTATION_DATABASE_NAME);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => resolve(), { once: true });
    request.addEventListener("blocked", () => resolve(), { once: true });
  });
}
