import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type GitManagerServiceError,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@salchi/contracts";
import { mergeGitStatusParts } from "@salchi/shared/git";
import * as Cause from "effect/Cause";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

export interface GitStatusState {
  readonly targetKey?: string | null;
  readonly data: VcsStatusResult | null;
  readonly error: GitManagerServiceError | null;
  readonly cause: Cause.Cause<GitManagerServiceError> | null;
  readonly isPending: boolean;
}

type GitStatusClient = Pick<WsRpcClient["vcs"], "onStatus" | "refreshStatus">;
interface ResolvedGitStatusClient {
  readonly clientIdentity: string;
  readonly client: GitStatusClient;
}

interface WatchedGitStatus {
  refCount: number;
  unsubscribe: () => void;
}

export interface GitStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  targetKey: null,
  data: null,
  error: null,
  cause: null,
  isPending: false,
});

function initialGitStatusState(targetKey: string): GitStatusState {
  return {
    targetKey,
    data: null,
    error: null,
    cause: null,
    isPending: true,
  };
}

const EMPTY_GIT_STATUS_ATOM = Atom.make(EMPTY_GIT_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-status:null"),
);

const NOOP: () => void = () => undefined;
const watchedGitStatuses = new Map<string, WatchedGitStatus>();
const knownGitStatusKeys = new Set<string>();
const gitStatusRefreshInFlight = new Map<string, Promise<VcsStatusResult>>();
const gitStatusLastRefreshAtByKey = new Map<string, number>();
// Monotonic per-key request counter. Each refresh captures a token at start and
// only writes its result if it is still the latest, so an older in-flight
// refresh (e.g. started before a commit) cannot clobber newer data.
const gitStatusRefreshTokenByKey = new Map<string, number>();

const GIT_STATUS_REFRESH_DEBOUNCE_MS = 1_000;

const gitStatusStateAtom = Atom.family((key: string) => {
  knownGitStatusKeys.add(key);
  return Atom.make(initialGitStatusState(key)).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-status:${key}`),
  );
});

export function getGitStatusTargetKey(target: GitStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}`;
}

export function getGitStatusDataForTarget(
  state: GitStatusState,
  target: GitStatusTarget,
): VcsStatusResult | null {
  const targetKey = getGitStatusTargetKey(target);
  return targetKey !== null && state.targetKey === targetKey ? state.data : null;
}

function readResolvedGitStatusClient(target: GitStatusTarget): ResolvedGitStatusClient | null {
  if (target.environmentId === null) {
    return null;
  }
  const connection = readEnvironmentConnection(target.environmentId);
  return connection
    ? { clientIdentity: connection.environmentId, client: connection.client.vcs }
    : null;
}

export function getGitStatusSnapshot(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return appAtomRegistry.get(gitStatusStateAtom(targetKey));
}

export function watchGitStatus(target: GitStatusTarget, client?: GitStatusClient): () => void {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return NOOP;
  }

  const watched = watchedGitStatuses.get(targetKey);
  if (watched) {
    watched.refCount += 1;
    return () => unwatchGitStatus(targetKey);
  }

  watchedGitStatuses.set(targetKey, {
    refCount: 1,
    unsubscribe: subscribeToGitStatusTarget(targetKey, target, client),
  });

  return () => unwatchGitStatus(targetKey);
}

function writeGitStatus(targetKey: string, status: VcsStatusResult): void {
  appAtomRegistry.set(gitStatusStateAtom(targetKey), {
    targetKey,
    data: status,
    error: null,
    cause: null,
    isPending: false,
  });
}

function bumpGitStatusRefreshToken(targetKey: string): void {
  gitStatusRefreshTokenByKey.set(targetKey, (gitStatusRefreshTokenByKey.get(targetKey) ?? 0) + 1);
}

function remoteStatusPartFromStatus(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

export function applyGitStatusLocalUpdate(
  target: GitStatusTarget,
  local: VcsStatusLocalResult,
): VcsStatusResult | null {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return null;
  }

  const current = getGitStatusDataForTarget(getGitStatusSnapshot(target), target);
  const status = mergeGitStatusParts(local, current ? remoteStatusPartFromStatus(current) : null);
  // Mutation RPCs return a freshly read local status. Bump the token so an
  // older in-flight refresh started before the mutation cannot write stale
  // working-tree data after this authoritative local update.
  bumpGitStatusRefreshToken(targetKey);
  writeGitStatus(targetKey, status);
  return status;
}

export function refreshGitStatus(
  target: GitStatusTarget,
  options?: { client?: GitStatusClient; force?: boolean },
): Promise<VcsStatusResult | null> {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null || target.cwd === null) {
    return Promise.resolve(null);
  }

  const force = options?.force ?? false;
  const resolvedClient = options?.client ?? readResolvedGitStatusClient(target)?.client;
  if (!resolvedClient) {
    return Promise.resolve(getGitStatusDataForTarget(getGitStatusSnapshot(target), target));
  }

  if (!force) {
    const currentInFlight = gitStatusRefreshInFlight.get(targetKey);
    if (currentInFlight) {
      return currentInFlight;
    }

    const lastRequestedAt = gitStatusLastRefreshAtByKey.get(targetKey) ?? 0;
    if (Date.now() - lastRequestedAt < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
      return Promise.resolve(getGitStatusDataForTarget(getGitStatusSnapshot(target), target));
    }
  }

  gitStatusLastRefreshAtByKey.set(targetKey, Date.now());
  bumpGitStatusRefreshToken(targetKey);
  const requestToken = gitStatusRefreshTokenByKey.get(targetKey) ?? 0;
  const cwd = target.cwd;
  const refreshPromise = resolvedClient
    .refreshStatus({ cwd })
    .then((status) => {
      // Apply the authoritative status returned by the unary RPC immediately,
      // rather than waiting for the slower onStatus broadcast. Skip if a newer
      // refresh has since started, to avoid clobbering fresher data.
      if (gitStatusRefreshTokenByKey.get(targetKey) === requestToken) {
        writeGitStatus(targetKey, status);
      }
      return status;
    })
    .finally(() => {
      if (gitStatusRefreshInFlight.get(targetKey) === refreshPromise) {
        gitStatusRefreshInFlight.delete(targetKey);
      }
    });
  gitStatusRefreshInFlight.set(targetKey, refreshPromise);
  return refreshPromise;
}

export function resetGitStatusStateForTests(): void {
  for (const watched of watchedGitStatuses.values()) {
    watched.unsubscribe();
  }
  watchedGitStatuses.clear();
  gitStatusRefreshInFlight.clear();
  gitStatusLastRefreshAtByKey.clear();
  gitStatusRefreshTokenByKey.clear();

  for (const key of knownGitStatusKeys) {
    appAtomRegistry.set(gitStatusStateAtom(key), initialGitStatusState(key));
  }
  knownGitStatusKeys.clear();
}

export function useGitStatus(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  useEffect(
    () => watchGitStatus({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? gitStatusStateAtom(targetKey) : EMPTY_GIT_STATUS_ATOM,
  );
  if (targetKey === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return state.targetKey === targetKey ? state : initialGitStatusState(targetKey);
}

function unwatchGitStatus(targetKey: string): void {
  const watched = watchedGitStatuses.get(targetKey);
  if (!watched) {
    return;
  }

  watched.refCount -= 1;
  if (watched.refCount > 0) {
    return;
  }

  watched.unsubscribe();
  watchedGitStatuses.delete(targetKey);
}

function subscribeToGitStatusTarget(
  targetKey: string,
  target: GitStatusTarget,
  providedClient?: GitStatusClient,
): () => void {
  if (target.cwd === null) {
    return NOOP;
  }

  const cwd = target.cwd;
  let currentClientIdentity: string | null = null;
  let currentUnsubscribe = NOOP;

  const syncClientSubscription = () => {
    const resolved = providedClient
      ? {
          clientIdentity: `provided:${targetKey}`,
          client: providedClient,
        }
      : readResolvedGitStatusClient(target);

    if (!resolved) {
      if (currentClientIdentity !== null) {
        currentUnsubscribe();
        currentUnsubscribe = NOOP;
        currentClientIdentity = null;
      }
      markGitStatusPending(targetKey);
      return;
    }

    if (currentClientIdentity === resolved.clientIdentity) {
      return;
    }

    currentUnsubscribe();
    currentClientIdentity = resolved.clientIdentity;
    currentUnsubscribe = subscribeToGitStatus(targetKey, cwd, resolved.client);
  };

  const unsubscribeRegistry = providedClient
    ? NOOP
    : subscribeEnvironmentConnections(syncClientSubscription);
  syncClientSubscription();

  return () => {
    unsubscribeRegistry();
    currentUnsubscribe();
  };
}

function subscribeToGitStatus(targetKey: string, cwd: string, client: GitStatusClient): () => void {
  markGitStatusPending(targetKey);
  return client.onStatus(
    { cwd },
    (status: VcsStatusResult) => {
      appAtomRegistry.set(gitStatusStateAtom(targetKey), {
        targetKey,
        data: status,
        error: null,
        cause: null,
        isPending: false,
      });
    },
    {
      onResubscribe: () => {
        markGitStatusPending(targetKey);
      },
    },
  );
}

function markGitStatusPending(targetKey: string): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  const next =
    current.data === null
      ? initialGitStatusState(targetKey)
      : {
          ...current,
          error: null,
          cause: null,
          isPending: true,
        };

  if (
    current.targetKey === next.targetKey &&
    current.data === next.data &&
    current.error === next.error &&
    current.cause === next.cause &&
    current.isPending === next.isPending
  ) {
    return;
  }

  appAtomRegistry.set(atom, next);
}
