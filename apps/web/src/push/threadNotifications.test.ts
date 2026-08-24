import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId, ThreadId } from "@salchi/contracts";

import {
  clearTurnCompletionAlerts,
  closeThreadNotifications,
  closeTurnCompletionNotifications,
  countTurnCompletionNotificationThreads,
  getDisplayedTurnCompletionThreadCount,
  dropServiceWorkerUnreadCompletionEnvironments,
  requestServiceWorkerBadgeSync,
  requestServiceWorkerTurnCompletionNotificationClear,
  syncServiceWorkerUnreadCompletions,
} from "./notifications";

interface FakeNotification {
  readonly tag: unknown;
  readonly data: {
    readonly url: string;
    readonly completion?: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly completionId: string;
    };
  };
  closed: boolean;
  readonly close: () => void;
}

function makeNotification(
  tag: unknown,
  url = "/env-1/thread-1",
  completion?: FakeNotification["data"]["completion"],
): FakeNotification {
  const notification: FakeNotification = {
    tag,
    data: { url, ...(completion ? { completion } : {}) },
    closed: false,
    close: () => {
      notification.closed = true;
    },
  };
  return notification;
}

function installPushSupport(
  getRegistration: () => Promise<unknown>,
  ready?: Promise<unknown>,
): void {
  vi.stubGlobal("window", {
    isSecureContext: true,
    location: { origin: "https://salchi.example" },
    PushManager: function PushManager() {},
    Notification: function Notification() {},
  });
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration, ...(ready ? { ready } : {}) },
  });
}

function makeAcknowledgingPostMessage() {
  return vi.fn((message: { readonly requestId?: string }, ports?: MessagePort[]) => {
    ports?.[0]?.postMessage({
      requestId: message.requestId ?? null,
      ok: true,
      count: 0,
    });
  });
}

describe("countTurnCompletionNotificationThreads", () => {
  it("counts distinct completed-turn threads only", () => {
    expect(
      countTurnCompletionNotificationThreads([
        makeNotification("thread:thread-1:turn:turn-1"),
        makeNotification("thread:thread-1:turn:turn-2"),
        makeNotification("thread:thread-2:turn:event-1"),
        makeNotification("thread:thread-2:approval:activity-1"),
        makeNotification("thread:thread-3:input:activity-2"),
        makeNotification("thread:thread-4:turn:"),
        makeNotification("thread:thread-5:turn:turn-1:extra"),
        makeNotification("salchi"),
        makeNotification(2),
      ]),
    ).toBe(2);
  });
});

describe("closeThreadNotifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes only notifications whose environment and thread route match", async () => {
    const notifications = [
      makeNotification("thread:thread-1:turn:turn-1"),
      makeNotification("thread:thread-1:approval:activity-1"),
      makeNotification("thread:thread-2:turn:turn-1", "/env-1/thread-2"),
      makeNotification("salchi-other", "/"),
    ];
    installPushSupport(async () => ({
      getNotifications: async () => notifications,
    }));

    await closeThreadNotifications(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

    expect(notifications.map((notification) => notification.closed)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("is a no-op when there is no service worker registration", async () => {
    const getRegistration = vi.fn(async () => null);
    installPushSupport(getRegistration);

    await expect(
      closeThreadNotifications(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
    ).resolves.toBeUndefined();
    expect(getRegistration).toHaveBeenCalledTimes(1);
  });

  it("prefers structured environment scope over a conflicting legacy route", async () => {
    const notification = makeNotification("thread:thread-1:turn:turn-1", "/env-1/thread-1", {
      environmentId: "env-2",
      threadId: "thread-1",
      completionId: "turn-1",
    });
    installPushSupport(async () => ({
      getNotifications: async () => [notification],
    }));

    await closeThreadNotifications(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

    expect(notification.closed).toBe(false);
  });

  it("is a no-op when push is unsupported", async () => {
    const getRegistration = vi.fn(async () => null);
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    await expect(
      closeThreadNotifications(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
    ).resolves.toBeUndefined();
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("swallows errors from the service worker registration lookup", async () => {
    installPushSupport(async () => {
      throw new Error("registration lookup failed");
    });

    await expect(
      closeThreadNotifications(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
    ).resolves.toBeUndefined();
  });
});

describe("getDisplayedTurnCompletionThreadCount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the distinct completed-turn thread count from displayed notifications", async () => {
    installPushSupport(async () => ({
      getNotifications: async () => [
        makeNotification("thread:thread-1:turn:turn-1"),
        makeNotification("thread:thread-1:turn:turn-2"),
        makeNotification("thread:thread-2:turn:turn-1"),
        makeNotification("thread:thread-2:approval:activity-1"),
      ],
    }));

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBe(2);
  });

  it("returns null when displayed notifications cannot be inspected", async () => {
    installPushSupport(async () => null);

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBeNull();
  });

  it("falls back to the ready service worker registration on first launch", async () => {
    const readyRegistration = Promise.resolve({
      getNotifications: async () => [makeNotification("thread:thread-1:turn:turn-1")],
    });
    installPushSupport(async () => null, readyRegistration);

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBe(1);
  });

  it("falls back to the ready registration when direct registration lookup rejects", async () => {
    const readyRegistration = Promise.resolve({
      getNotifications: async () => [makeNotification("thread:thread-1:turn:turn-1")],
    });
    installPushSupport(async () => {
      throw new Error("registration lookup failed");
    }, readyRegistration);

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBe(1);
  });

  it("returns null when the ready service worker registration times out", async () => {
    vi.useFakeTimers();
    try {
      installPushSupport(
        async () => null,
        new Promise<never>(() => {
          // Intentionally never resolves.
        }),
      );

      const count = getDisplayedTurnCompletionThreadCount();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);

      await expect(count).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when the ready service worker registration rejects", async () => {
    let rejectReady!: (error: unknown) => void;
    const readyRegistration = new Promise<unknown>((_resolve, reject) => {
      rejectReady = reject;
    });
    installPushSupport(async () => null, readyRegistration);

    const count = getDisplayedTurnCompletionThreadCount();
    await Promise.resolve();
    rejectReady(new Error("ready failed"));

    await expect(count).resolves.toBeNull();
  });

  it("returns null when push support is unavailable", async () => {
    vi.stubGlobal("window", { isSecureContext: false });

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBeNull();
  });
});

describe("closeTurnCompletionNotifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes only completed-turn notifications across all threads", async () => {
    const notifications = [
      makeNotification("thread:thread-1:turn:turn-1"),
      makeNotification("thread:thread-1:approval:activity-1"),
      makeNotification("thread:thread-2:turn:turn-1"),
      makeNotification("salchi"),
    ];
    installPushSupport(async () => ({
      getNotifications: async () => notifications,
    }));

    await expect(closeTurnCompletionNotifications()).resolves.toBe(2);

    expect(notifications.map((notification) => notification.closed)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("returns null when completed-turn notifications cannot be inspected", async () => {
    installPushSupport(async () => null);

    await expect(closeTurnCompletionNotifications()).resolves.toBeNull();
  });
});

describe("requestServiceWorkerBadgeSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a sync request to the active service worker", async () => {
    const postMessage = makeAcknowledgingPostMessage();
    installPushSupport(async () => ({
      active: { postMessage },
    }));

    await expect(requestServiceWorkerBadgeSync()).resolves.toBe(true);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "salchi.sync-displayed-notification-badge",
        requestId: expect.any(String),
      }),
      [expect.anything()],
    );
  });

  it("uses an explicit registration without looking it up", async () => {
    const postMessage = makeAcknowledgingPostMessage();
    const getRegistration = vi.fn(async () => null);
    installPushSupport(getRegistration);

    await expect(
      requestServiceWorkerBadgeSync({
        active: { postMessage },
      } as unknown as ServiceWorkerRegistration),
    ).resolves.toBe(true);

    expect(getRegistration).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("returns false when no service worker can receive the request", async () => {
    installPushSupport(async () => ({}));

    await expect(requestServiceWorkerBadgeSync()).resolves.toBe(false);
  });
});

describe("completion ledger service-worker requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for acknowledgement of sequenced snapshots and removals", async () => {
    const postMessage = makeAcknowledgingPostMessage();
    installPushSupport(async () => ({ active: { postMessage } }));
    const environmentId = EnvironmentId.make("env-1");

    await expect(
      syncServiceWorkerUnreadCompletions(
        [
          {
            environmentId,
            sequence: 12,
            completions: [{ threadId: ThreadId.make("thread-1"), completionId: "turn-1" }],
          },
        ],
        [EnvironmentId.make("env-removed")],
      ),
    ).resolves.toBe(true);
    await expect(dropServiceWorkerUnreadCompletionEnvironments([environmentId])).resolves.toBe(
      true,
    );

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "salchi.sync-unread-completions",
        snapshots: [
          {
            environmentId,
            sequence: 12,
            completions: [{ threadId: "thread-1", completionId: "turn-1" }],
          },
        ],
        removedEnvironmentIds: ["env-removed"],
      }),
      [expect.anything()],
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "salchi.drop-unread-completion-environments",
        environmentIds: [environmentId],
      }),
      [expect.anything()],
    );
  });
});

describe("requestServiceWorkerTurnCompletionNotificationClear", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a clear request to the active service worker", async () => {
    const postMessage = vi.fn();
    installPushSupport(async () => ({
      active: { postMessage },
    }));

    await expect(requestServiceWorkerTurnCompletionNotificationClear()).resolves.toBe(true);

    expect(postMessage).toHaveBeenCalledWith({
      type: "salchi.clear-turn-completion-notifications",
    });
  });
});

describe("clearTurnCompletionAlerts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes page-visible completed-turn notifications and asks the worker to clear", async () => {
    const postMessage = vi.fn();
    const notifications = [
      makeNotification("thread:thread-1:turn:turn-1"),
      makeNotification("thread:thread-2:approval:activity-1"),
    ];
    installPushSupport(async () => ({
      active: { postMessage },
      getNotifications: async () => notifications,
    }));

    await expect(clearTurnCompletionAlerts()).resolves.toBeUndefined();

    expect(notifications.map((notification) => notification.closed)).toEqual([true, false]);
    expect(postMessage).toHaveBeenCalledWith({
      type: "salchi.clear-turn-completion-notifications",
    });
  });

  it("uses the ready service worker registration when the immediate registration is missing", async () => {
    const postMessage = vi.fn();
    const notifications = [makeNotification("thread:thread-1:turn:turn-1")];
    installPushSupport(
      async () => null,
      Promise.resolve({
        active: { postMessage },
        getNotifications: async () => notifications,
      }),
    );

    await expect(clearTurnCompletionAlerts()).resolves.toBeUndefined();

    expect(notifications[0]?.closed).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "salchi.clear-turn-completion-notifications",
    });
  });
});

describe("closeThreadNotifications input guards", () => {
  let originalNavigator: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  it("does nothing for an empty thread id", async () => {
    const getRegistration = vi.fn(async () => null);
    installPushSupport(getRegistration);

    await closeThreadNotifications(EnvironmentId.make("env-1"), "" as ThreadId);

    expect(getRegistration).not.toHaveBeenCalled();
  });
});
