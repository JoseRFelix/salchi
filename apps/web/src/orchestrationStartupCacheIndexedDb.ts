import type { EnvironmentId } from "@salchi/contracts";

const DATABASE_NAME = "salchi-orchestration-startup-cache";
const DATABASE_VERSION = 2;
const ENVIRONMENT_STORE_NAME = "environments";
const ENVIRONMENT_UPDATED_AT_INDEX_NAME = "updatedAt";
const ENTRY_VERSION = 1;

export const ORCHESTRATION_STARTUP_CACHE_INDEXED_DB_SOFT_LIMIT_BYTES = 512 * 1024 * 1024;
const STORAGE_PRESSURE_FRACTION = 0.8;
const PRESSURE_PRUNE_MIN_INTERVAL_MS = 60_000;

export interface IndexedDbCachedEnvironmentStateEntry {
  readonly environmentId: EnvironmentId;
  readonly updatedAt: string;
  readonly state: unknown;
  /**
   * The shell is stored independently from conversation detail so detail-only writes cannot
   * replace a previously complete sidebar snapshot.
   */
  readonly shellRevision?: string | null;
  readonly shellUpdatedAt?: string | null;
  readonly shellState?: unknown;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;
let operationTail: Promise<void> = Promise.resolve();
let lastPressurePruneAtMs = Number.NEGATIVE_INFINITY;
let pressurePruneScheduled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEntry(value: unknown): IndexedDbCachedEnvironmentStateEntry | null {
  if (
    !isRecord(value) ||
    value.version !== ENTRY_VERSION ||
    typeof value.environmentId !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.state)
  ) {
    return null;
  }
  const hasExplicitShellRevision = Object.prototype.hasOwnProperty.call(value, "shellRevision");
  return {
    environmentId: value.environmentId as EnvironmentId,
    updatedAt: value.updatedAt,
    state: value.state,
    // Version-one entries predate the independent shell fields. Their state was produced by the
    // same write as updatedAt, so it is a safe migration source when the local record matches it.
    shellRevision: hasExplicitShellRevision
      ? typeof value.shellRevision === "string"
        ? value.shellRevision
        : null
      : value.updatedAt,
    shellUpdatedAt: hasExplicitShellRevision
      ? typeof value.shellUpdatedAt === "string"
        ? value.shellUpdatedAt
        : null
      : value.updatedAt,
    shellState: hasExplicitShellRevision
      ? isRecord(value.shellState)
        ? value.shellState
        : undefined
      : value.state,
  };
}

function enqueueOperation<A>(operation: () => Promise<A>): Promise<A> {
  const result = operationTail.catch(() => undefined).then(operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
      const store = database.objectStoreNames.contains(ENVIRONMENT_STORE_NAME)
        ? request.transaction!.objectStore(ENVIRONMENT_STORE_NAME)
        : database.createObjectStore(ENVIRONMENT_STORE_NAME, { keyPath: "environmentId" });
      if (!store.indexNames.contains(ENVIRONMENT_UPDATED_AT_INDEX_NAME)) {
        store.createIndex(ENVIRONMENT_UPDATED_AT_INDEX_NAME, "updatedAt", { unique: false });
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

async function readEntries(): Promise<readonly IndexedDbCachedEnvironmentStateEntry[]> {
  const database = await openDatabase();
  if (!database) {
    return [];
  }

  return new Promise<readonly IndexedDbCachedEnvironmentStateEntry[]>((resolve) => {
    let transaction: IDBTransaction;
    let values: unknown[] = [];
    try {
      transaction = database.transaction(ENVIRONMENT_STORE_NAME, "readonly");
      const request = transaction.objectStore(ENVIRONMENT_STORE_NAME).getAll();
      request.addEventListener(
        "success",
        () => {
          values = request.result as unknown[];
        },
        { once: true },
      );
    } catch {
      resolve([]);
      return;
    }
    transaction.addEventListener(
      "complete",
      () => {
        resolve(
          values
            .flatMap((value) => {
              const entry = decodeEntry(value);
              return entry ? [entry] : [];
            })
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        );
      },
      { once: true },
    );
    transaction.addEventListener("abort", () => resolve([]), { once: true });
    transaction.addEventListener("error", () => resolve([]), { once: true });
  });
}

async function writeEntry(entry: IndexedDbCachedEnvironmentStateEntry): Promise<boolean> {
  const database = await openDatabase();
  if (!database) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(ENVIRONMENT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(ENVIRONMENT_STORE_NAME);
      const existingRequest = store.get(entry.environmentId);
      existingRequest.addEventListener(
        "success",
        () => {
          const existing = decodeEntry(existingRequest.result);
          if (!existing || existing.updatedAt <= entry.updatedAt) {
            const hasIncomingShell =
              typeof entry.shellRevision === "string" && isRecord(entry.shellState);
            const shellRevision = hasIncomingShell
              ? entry.shellRevision
              : (existing?.shellRevision ?? null);
            const shellUpdatedAt = hasIncomingShell
              ? (entry.shellUpdatedAt ?? entry.updatedAt)
              : (existing?.shellUpdatedAt ?? null);
            const shellState = hasIncomingShell
              ? entry.shellState
              : isRecord(existing?.shellState)
                ? existing.shellState
                : null;
            store.put({
              version: ENTRY_VERSION,
              environmentId: entry.environmentId,
              updatedAt: entry.updatedAt,
              state: entry.state,
              shellRevision,
              shellUpdatedAt,
              ...(isRecord(shellState) ? { shellState } : {}),
            });
          }
        },
        { once: true },
      );
    } catch {
      resolve(false);
      return;
    }
    transaction.addEventListener("complete", () => resolve(true), { once: true });
    transaction.addEventListener("abort", () => resolve(false), { once: true });
    transaction.addEventListener("error", () => resolve(false), { once: true });
  });
}

async function pruneOldestEnvironmentUnderStoragePressure(
  protectedEnvironmentId: EnvironmentId,
): Promise<void> {
  const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
  if (!estimate?.usage || !estimate.quota) {
    return;
  }
  const pressureLimit = Math.min(
    ORCHESTRATION_STARTUP_CACHE_INDEXED_DB_SOFT_LIMIT_BYTES,
    estimate.quota * STORAGE_PRESSURE_FRACTION,
  );
  if (estimate.usage <= pressureLimit) {
    return;
  }

  const database = await openDatabase();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(ENVIRONMENT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(ENVIRONMENT_STORE_NAME);
      const request = store.index(ENVIRONMENT_UPDATED_AT_INDEX_NAME).openCursor();
      request.addEventListener(
        "success",
        () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          if (cursor.primaryKey === protectedEnvironmentId) {
            cursor.continue();
            return;
          }
          cursor.delete();
        },
        { once: false },
      );
    } catch {
      resolve();
      return;
    }
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => resolve(), { once: true });
    transaction.addEventListener("error", () => resolve(), { once: true });
  });
}

function scheduleStoragePressurePrune(protectedEnvironmentId: EnvironmentId): void {
  const nowMs = Date.now();
  if (pressurePruneScheduled || nowMs - lastPressurePruneAtMs < PRESSURE_PRUNE_MIN_INTERVAL_MS) {
    return;
  }
  pressurePruneScheduled = true;
  const run = () => {
    pressurePruneScheduled = false;
    lastPressurePruneAtMs = Date.now();
    void enqueueOperation(() => pruneOldestEnvironmentUnderStoragePressure(protectedEnvironmentId));
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 5_000 });
  } else {
    setTimeout(run, 0);
  }
}

async function removeEntry(environmentId: EnvironmentId): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    return;
  }

  await new Promise<void>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(ENVIRONMENT_STORE_NAME, "readwrite");
      transaction.objectStore(ENVIRONMENT_STORE_NAME).delete(environmentId);
    } catch {
      resolve();
      return;
    }
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => resolve(), { once: true });
    transaction.addEventListener("error", () => resolve(), { once: true });
  });
}

async function clearEntries(): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    return;
  }

  await new Promise<void>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(ENVIRONMENT_STORE_NAME, "readwrite");
      transaction.objectStore(ENVIRONMENT_STORE_NAME).clear();
    } catch {
      resolve();
      return;
    }
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => resolve(), { once: true });
    transaction.addEventListener("error", () => resolve(), { once: true });
  });
}

export function writeIndexedDbCachedEnvironmentState(
  entry: IndexedDbCachedEnvironmentStateEntry,
): Promise<boolean> {
  return enqueueOperation(() => writeEntry(entry)).then((persisted) => {
    if (persisted) {
      scheduleStoragePressurePrune(entry.environmentId);
    }
    return persisted;
  });
}

export function readIndexedDbCachedEnvironmentStateEntries(): Promise<
  readonly IndexedDbCachedEnvironmentStateEntry[]
> {
  return enqueueOperation(readEntries);
}

export function removeIndexedDbCachedEnvironmentState(environmentId: EnvironmentId): Promise<void> {
  return enqueueOperation(() => removeEntry(environmentId));
}

export function clearIndexedDbCachedEnvironmentStates(): Promise<void> {
  return enqueueOperation(clearEntries);
}
