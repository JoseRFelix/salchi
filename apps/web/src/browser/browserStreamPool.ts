import type { BrowserInputEvent, EnvironmentId, ThreadId } from "@salchi/contracts";
import type { BrowserStreamMetaMessage } from "@salchi/shared/browserStreamProtocol";

import {
  createBrowserStreamConnection,
  type BrowserStreamConnection,
  type BrowserStreamConnectionOptions,
  type BrowserStreamConnectionState,
  type BrowserStreamViewportFrame,
} from "./browserStreamConnection";

export interface BrowserStreamSubscriber {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onConnectionState?: (state: BrowserStreamConnectionState) => void;
  readonly onEvent?: (event: BrowserStreamMetaMessage) => void;
  readonly onFrame?: (frame: BrowserStreamViewportFrame) => void;
  readonly onAuthorizationDenied?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface BrowserStreamSubscription {
  readonly dispose: () => void;
  readonly sendInput: (targetId: string, event: BrowserInputEvent) => boolean;
}

type BrowserStreamConnectionFactory = (
  options: BrowserStreamConnectionOptions,
) => BrowserStreamConnection;

interface PoolEntry {
  connection: BrowserStreamConnection | null;
  connectionState: BrowserStreamConnectionState;
  readonly environmentId: EnvironmentId;
  latestActivity: BrowserStreamMetaMessage | null;
  latestFrame: BrowserStreamViewportFrame | null;
  latestStatus: BrowserStreamMetaMessage | null;
  latestTabs: BrowserStreamMetaMessage | null;
  readonly subscribers: Map<number, BrowserStreamSubscriber>;
  readonly threadId: ThreadId;
}

function streamKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u0000${threadId}`;
}

export interface BrowserStreamPool {
  readonly acquire: (subscriber: BrowserStreamSubscriber) => BrowserStreamSubscription;
  readonly disposeAll: () => void;
}

export function createBrowserStreamPool(
  connect: BrowserStreamConnectionFactory = createBrowserStreamConnection,
): BrowserStreamPool {
  const entries = new Map<string, PoolEntry>();
  let nextSubscriberId = 0;

  const notify = <T>(
    entry: PoolEntry,
    select: (subscriber: BrowserStreamSubscriber) => ((value: T) => void) | undefined,
    value: T,
  ) => {
    for (const subscriber of entry.subscribers.values()) {
      select(subscriber)?.(value);
    }
  };

  const startConnection = (entry: PoolEntry) => {
    entry.connection = connect({
      environmentId: entry.environmentId,
      threadId: entry.threadId,
      onConnectionState: (state) => {
        entry.connectionState = state;
        notify(entry, (subscriber) => subscriber.onConnectionState, state);
      },
      onEvent: (event) => {
        if ("agentActive" in event) entry.latestActivity = event;
        else if (event._tag === "Status") entry.latestStatus = event;
        else entry.latestTabs = event;
        notify(entry, (subscriber) => subscriber.onEvent, event);
      },
      onFrame: (frame) => {
        entry.latestFrame = frame;
        notify(entry, (subscriber) => subscriber.onFrame, frame);
      },
      onAuthorizationDenied: () =>
        notify(entry, (subscriber) => subscriber.onAuthorizationDenied, undefined),
      onError: (error) => notify(entry, (subscriber) => subscriber.onError, error),
    });
  };

  const acquire = (subscriber: BrowserStreamSubscriber): BrowserStreamSubscription => {
    const key = streamKey(subscriber.environmentId, subscriber.threadId);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        connection: null,
        connectionState: "closed",
        environmentId: subscriber.environmentId,
        latestActivity: null,
        latestFrame: null,
        latestStatus: null,
        latestTabs: null,
        subscribers: new Map(),
        threadId: subscriber.threadId,
      };
      entries.set(key, entry);
    }

    const subscriberId = ++nextSubscriberId;
    entry.subscribers.set(subscriberId, subscriber);
    if (entry.connection === null) startConnection(entry);
    else subscriber.onConnectionState?.(entry.connectionState);
    if (entry.latestStatus !== null) subscriber.onEvent?.(entry.latestStatus);
    if (entry.latestTabs !== null) subscriber.onEvent?.(entry.latestTabs);
    if (entry.latestActivity !== null) subscriber.onEvent?.(entry.latestActivity);
    if (entry.latestFrame !== null) subscriber.onFrame?.(entry.latestFrame);

    let disposed = false;
    return {
      sendInput: (targetId, event) => entry?.connection?.sendInput(targetId, event) ?? false,
      dispose: () => {
        if (disposed || entry === undefined) return;
        disposed = true;
        entry.subscribers.delete(subscriberId);
        if (entry.subscribers.size > 0) return;
        entries.delete(key);
        entry.connection?.dispose();
        entry.connection = null;
      },
    };
  };

  return {
    acquire,
    disposeAll: () => {
      for (const entry of entries.values()) entry.connection?.dispose();
      entries.clear();
    },
  };
}

const browserStreamPool = createBrowserStreamPool();

export const acquireBrowserStream = browserStreamPool.acquire;

export function resetBrowserStreamPoolForTests(): void {
  browserStreamPool.disposeAll();
}
