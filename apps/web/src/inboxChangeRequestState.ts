import type { EnvironmentId, VcsStatusResult } from "@salchi/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  InboxChangeRequestSnapshots as InboxChangeRequestSnapshotsSchema,
  inboxChangeRequestSnapshotMatches,
  nextInboxChangeRequestSnapshot,
  type InboxChangeRequestSnapshot,
  type InboxChangeRequestSnapshots,
} from "./inboxChangeRequest";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY = "salchi:inbox-change-request-snapshots:v1";

export interface InboxChangeRequestObservedThread {
  readonly threadKey: string;
  readonly branch: string;
}

export interface InboxChangeRequestObservationBatch {
  readonly threads: readonly InboxChangeRequestObservedThread[];
  readonly gitStatus: VcsStatusResult;
  readonly observedAt: string;
}

export interface InboxChangeRequestObservationTarget extends InboxChangeRequestObservedThread {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export interface InboxChangeRequestObservationGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threads: readonly InboxChangeRequestObservedThread[];
}

const EMPTY_INBOX_CHANGE_REQUEST_SNAPSHOTS: InboxChangeRequestSnapshots = {};

export function groupInboxChangeRequestObservationTargets(
  targets: readonly InboxChangeRequestObservationTarget[],
): readonly InboxChangeRequestObservationGroup[] {
  const groups = new Map<
    string,
    {
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly threads: InboxChangeRequestObservedThread[];
    }
  >();
  for (const target of targets) {
    const key = JSON.stringify([target.environmentId, target.cwd]);
    const previous = groups.get(key);
    const thread = { threadKey: target.threadKey, branch: target.branch };
    if (previous) {
      previous.threads.push(thread);
    } else {
      groups.set(key, {
        key,
        environmentId: target.environmentId,
        cwd: target.cwd,
        threads: [thread],
      });
    }
  }
  return [...groups.values()];
}

export function compactInboxChangeRequestSnapshots(
  snapshots: InboxChangeRequestSnapshots,
): InboxChangeRequestSnapshots {
  const entries = Object.entries(snapshots).filter(([, snapshot]) => snapshot.pr !== null);
  return entries.length === Object.keys(snapshots).length ? snapshots : Object.fromEntries(entries);
}

export function mergeInboxChangeRequestObservationBatches(
  current: InboxChangeRequestSnapshots,
  batches: readonly InboxChangeRequestObservationBatch[],
): InboxChangeRequestSnapshots {
  let mutable: Record<string, InboxChangeRequestSnapshot> | null = null;
  const read = (threadKey: string) => (mutable ?? current)[threadKey];
  const writeable = () => (mutable ??= { ...current });

  const write = (threadKey: string, snapshot: InboxChangeRequestSnapshot | null) => {
    const previous = read(threadKey);
    if (snapshot === null) {
      if (previous === undefined) return;
      delete writeable()[threadKey];
      return;
    }
    if (inboxChangeRequestSnapshotMatches(previous, snapshot)) return;
    writeable()[threadKey] = snapshot;
  };

  for (const batch of batches) {
    for (const thread of batch.threads) {
      const previous = read(thread.threadKey) ?? null;
      const snapshot = nextInboxChangeRequestSnapshot({
        threadBranch: thread.branch,
        gitStatus: batch.gitStatus,
        previous,
        observedAt: batch.observedAt,
      });
      if (snapshot === previous) continue;
      write(thread.threadKey, snapshot);
    }
  }

  return mutable ?? current;
}

function readPersistedSnapshots(): InboxChangeRequestSnapshots {
  try {
    return compactInboxChangeRequestSnapshots(
      getLocalStorageItem(INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY, InboxChangeRequestSnapshotsSchema) ??
        EMPTY_INBOX_CHANGE_REQUEST_SNAPSHOTS,
    );
  } catch {
    return EMPTY_INBOX_CHANGE_REQUEST_SNAPSHOTS;
  }
}

/**
 * Owns the prototype PR cache above virtualized rows. Observations from every
 * git target in one commit are coalesced into one React update, then persisted
 * once after the burst instead of rewriting localStorage for every row mount.
 */
export function useInboxChangeRequestSnapshots(): {
  readonly snapshots: InboxChangeRequestSnapshots;
  readonly recordObservation: (
    threads: readonly InboxChangeRequestObservedThread[],
    gitStatus: VcsStatusResult,
  ) => void;
} {
  const [snapshots, setSnapshots] = useState(readPersistedSnapshots);
  const pendingBatchesRef = useRef<InboxChangeRequestObservationBatch[]>([]);
  const flushScheduledRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingBatchesRef.current = [];
    };
  }, []);

  const recordObservation = useCallback(
    (threads: readonly InboxChangeRequestObservedThread[], gitStatus: VcsStatusResult) => {
      if (threads.length === 0) return;
      pendingBatchesRef.current.push({
        threads,
        gitStatus,
        observedAt: new Date().toISOString(),
      });
      if (flushScheduledRef.current) return;
      flushScheduledRef.current = true;
      queueMicrotask(() => {
        flushScheduledRef.current = false;
        if (!mountedRef.current) return;
        const batches = pendingBatchesRef.current;
        pendingBatchesRef.current = [];
        setSnapshots((current) => mergeInboxChangeRequestObservationBatches(current, batches));
      });
    },
    [],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        setLocalStorageItem(
          INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY,
          snapshots,
          InboxChangeRequestSnapshotsSchema,
        );
      } catch (error) {
        console.error("[INBOX_CHANGE_REQUEST_SNAPSHOTS] persist failed", error);
      }
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [snapshots]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === INBOX_CHANGE_REQUEST_SNAPSHOTS_KEY) {
        setSnapshots(readPersistedSnapshots());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return { snapshots, recordObservation };
}
