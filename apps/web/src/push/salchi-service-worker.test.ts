// @effect-diagnostics nodeBuiltinImport:off - Service worker tests execute browser worker assets in a Node VM.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://salchi.example";
const TARGET_URL = `${ORIGIN}/env-1/thread-1`;
const HOME_URL = `${ORIGIN}/`;
const CROSS_ORIGIN_URL = "https://elsewhere.example/env-1/thread-1";
const DEFAULT_NOTIFICATION_TITLE = "Salchi";

interface MockClientState {
  readonly id: string;
  readonly url: string;
  readonly controlled: boolean;
  readonly focusCalls: number;
  readonly navigateCalls: string[];
  readonly postMessageCalls: Array<{
    readonly type: string;
    readonly url: string;
    readonly openedAt: number;
  }>;
  readonly diagnosticMessageCalls: Array<{
    readonly type: string;
    readonly url: string;
    readonly openedAt: number;
    readonly reason: string;
    readonly data: unknown;
  }>;
}

interface ServiceWorkerTestHarness {
  readonly context: vm.Context;
  readonly openWindowCalls: string[];
  readonly matchAllCalls: Array<{
    readonly type?: string;
    readonly includeUncontrolled?: boolean;
  }>;
  readonly operationLog: string[];
  readonly getClients: () => MockClientState[];
  readonly getBroadcastMessages: () => Array<{
    readonly name: string;
    readonly message: unknown;
  }>;
  readonly getBroadcastCloseCalls: () => string[];
  readonly getDirectDiagnostics: () => Array<{
    readonly ts: number;
    readonly kind: string;
    readonly reason: string;
    readonly data: unknown;
  }>;
  readonly getPendingClickWrites: () => Array<{
    readonly cacheName: string;
    readonly requestUrl: string;
    readonly value: unknown;
  }>;
  readonly getBadgeSetCalls: () => number[];
  readonly getBadgeClearCallCount: () => number;
  readonly getDisplayedNotificationCount: () => number;
  readonly closeAllDisplayedNotificationsWithoutEvent: () => void;
  readonly dispatchActivate: () => Promise<void>;
  readonly dispatchMessage: (payload: unknown) => Promise<void>;
  readonly dispatchPush: (payload: unknown) => Promise<void>;
  readonly dispatchNotificationClick: (index?: number) => Promise<void>;
  readonly dispatchNotificationClose: (index?: number) => Promise<void>;
  readonly removeAppBadgeSupport: () => void;
  readonly setGetNotificationsResult: (result: "success" | "throw") => void;
  readonly addClient: (options: {
    readonly ackNotificationClick?: boolean;
    readonly url: string;
    readonly controlled?: boolean;
    readonly focusResult?: "self" | "throw";
    readonly focused?: boolean;
    readonly visibilityState?: "hidden" | "visible";
    readonly navigateResult?: "self" | "null" | "throw";
    readonly postMessageResult?: "success" | "throw";
  }) => void;
  readonly setOpenWindowResult: (
    result: "undefined" | "client-at-url" | "client-at-home" | "throw",
  ) => void;
  readonly removeBroadcastChannel: () => void;
}

function createServiceWorkerTestHarness(): ServiceWorkerTestHarness {
  const openWindowCalls: string[] = [];
  const matchAllCalls: Array<{
    type?: string;
    includeUncontrolled?: boolean;
  }> = [];
  const operationLog: string[] = [];
  const broadcastMessages: Array<{
    name: string;
    message: unknown;
  }> = [];
  const broadcastCloseCalls: string[] = [];
  const directDiagnostics: Array<{
    ts: number;
    kind: string;
    reason: string;
    data: unknown;
  }> = [];
  const pendingClickWrites: Array<{
    cacheName: string;
    requestUrl: string;
    value: unknown;
  }> = [];
  const badgeSetCalls: number[] = [];
  let badgeClearCallCount = 0;
  const eventListeners: Record<string, Array<(event: unknown) => void>> = {};
  const dispatchWorkerMessage = (payload: unknown) => {
    const waitUntilPromises: Array<Promise<unknown>> = [];
    const event = {
      data: payload,
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(Promise.resolve(promise));
      },
    };
    for (const listener of eventListeners.message ?? []) {
      listener(event);
    }
  };
  const displayedNotifications: Array<
    Record<string, unknown> & {
      __closed: boolean;
      close: () => void;
    }
  > = [];
  let openWindowResult: "undefined" | "client-at-url" | "client-at-home" | "throw" = "undefined";
  let getNotificationsResult: "success" | "throw" = "success";
  let nextClientId = 1;
  const makeClient = (options: {
    readonly ackNotificationClick?: boolean;
    readonly url: string;
    readonly controlled?: boolean;
    readonly focusResult?: "self" | "throw";
    readonly focused?: boolean;
    readonly visibilityState?: "hidden" | "visible";
    readonly navigateResult?: "self" | "null" | "throw";
    readonly postMessageResult?: "success" | "throw";
  }) => {
    const client: Record<string, unknown> = {
      id: `client-${nextClientId++}`,
      url: options.url,
      __controlled: options.controlled ?? true,
      focused: options.focused === true,
      visibilityState: options.visibilityState ?? "visible",
      focusCalls: 0,
      navigateCalls: [],
      postMessageCalls: [],
    };
    client.focus = async () => {
      operationLog.push("focus");
      client.focusCalls = Number(client.focusCalls ?? 0) + 1;
      if (options.focusResult === "throw") {
        throw new Error("focus failed");
      }
      return client;
    };
    if (options.navigateResult !== undefined) {
      client.navigate = async (url: string) => {
        operationLog.push("navigate");
        (client.navigateCalls as string[]).push(url);
        if (options.navigateResult === "throw") {
          throw new Error("navigate failed");
        }
        if (options.navigateResult === "null") {
          return null;
        }
        client.url = url;
        return client;
      };
    }
    client.postMessage = (message: unknown) => {
      if (options.postMessageResult === "throw") {
        throw new Error("postMessage failed");
      }
      (client.postMessageCalls as unknown[]).push(message);
      if (
        options.ackNotificationClick !== false &&
        typeof message === "object" &&
        message !== null &&
        (message as { readonly type?: unknown }).type === "salchi.notification-click" &&
        typeof (message as { readonly url?: unknown }).url === "string" &&
        typeof (message as { readonly openedAt?: unknown }).openedAt === "number" &&
        Number.isFinite((message as { readonly openedAt?: unknown }).openedAt)
      ) {
        dispatchWorkerMessage({
          type: "salchi.notification-click-ack",
          url: (message as { readonly url: string }).url,
          openedAt: (message as { readonly openedAt: number }).openedAt,
        });
      }
    };
    return client;
  };
  class MockBroadcastChannel {
    readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    postMessage(message: unknown) {
      operationLog.push("broadcast");
      broadcastMessages.push({
        name: this.name,
        message,
      });
    }

    close() {
      operationLog.push("broadcast-close");
      broadcastCloseCalls.push(this.name);
    }
  }
  const makeNotification = (title: string, options: Record<string, unknown>) => {
    const notification: Record<string, unknown> & {
      __closed: boolean;
      close: () => void;
    } = {
      ...options,
      title,
      __closed: false,
      close: () => {
        operationLog.push("notification-close");
        notification.__closed = true;
      },
    };
    return notification;
  };

  const context: Record<string, unknown> = {
    Request,
    Response,
    URL,
    fetch: async (_url: URL, init?: { readonly body?: string }) => {
      operationLog.push("diagnostic");
      const body = JSON.parse(init?.body ?? "[]") as Array<{
        ts: number;
        kind: string;
        reason: string;
        data: unknown;
      }>;
      directDiagnostics.push(...body);
      return new Response(null, { status: 204 });
    },
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    console,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    __windowClients: [] as Array<Record<string, unknown>>,
    self: {
      location: { origin: ORIGIN, href: `${ORIGIN}/` },
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        (eventListeners[type] ??= []).push(listener);
      }),
      removeEventListener: vi.fn(),
      skipWaiting: vi.fn(),
      navigator: {
        setAppBadge: async (count?: number) => {
          operationLog.push("setAppBadge");
          badgeSetCalls.push(Number(count));
        },
        clearAppBadge: async () => {
          operationLog.push("clearAppBadge");
          badgeClearCallCount += 1;
        },
      },
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => {
          operationLog.push("showNotification");
          const notification = makeNotification(title, options);
          const tag = typeof notification.tag === "string" ? notification.tag : null;
          const existingIndex = tag
            ? displayedNotifications.findIndex(
                (candidate) => candidate.__closed !== true && candidate.tag === tag,
              )
            : -1;
          if (existingIndex >= 0) {
            displayedNotifications.splice(existingIndex, 1, notification);
            return;
          }
          displayedNotifications.push(notification);
        },
        getNotifications: async () => {
          operationLog.push("getNotifications");
          if (getNotificationsResult === "throw") {
            throw new Error("getNotifications failed");
          }
          return displayedNotifications.filter((notification) => notification.__closed !== true);
        },
      },
      clients: {
        matchAll: async (options?: {
          readonly type?: string;
          readonly includeUncontrolled?: boolean;
        }) => {
          operationLog.push("matchAll");
          matchAllCalls.push(options ?? {});
          const clients = context.__windowClients as Array<Record<string, unknown>>;
          if (options?.includeUncontrolled === true) {
            return clients;
          }
          return clients.filter((client) => client.__controlled === true);
        },
        openWindow: async (url: string) => {
          operationLog.push("openWindow");
          openWindowCalls.push(url);
          if (openWindowResult === "throw") {
            throw new Error("openWindow failed");
          }
          if (openWindowResult === "undefined") {
            return undefined;
          }
          const client = makeClient({
            url: openWindowResult === "client-at-home" ? HOME_URL : url,
          });
          (context.__windowClients as Array<Record<string, unknown>>).push(client);
          return client;
        },
      },
      caches: {
        open: async (cacheName: string) => ({
          put: async (request: Request, response: Response) => {
            operationLog.push("persist");
            pendingClickWrites.push({
              cacheName,
              requestUrl: request.url,
              value: await response.json(),
            });
          },
        }),
      },
      BroadcastChannel: MockBroadcastChannel,
    },
  };

  const serviceWorkerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../public/salchi-push-service-worker.js",
  );
  const source = readFileSync(serviceWorkerPath, "utf8");

  vm.createContext(context);
  vm.runInContext(
    `${source}
this.__salchiServiceWorkerTestExports = {
  notificationTitle,
  openNotificationUrl,
};`,
    context,
  );

  return {
    context,
    openWindowCalls,
    matchAllCalls,
    operationLog,
    getClients: () =>
      (context.__windowClients as Array<Record<string, unknown>>).map((client) => {
        const messages =
          (client.postMessageCalls as Array<Record<string, unknown>> | undefined) ?? [];
        return {
          id: String(client.id),
          url: String(client.url),
          controlled: client.__controlled === true,
          focusCalls: Number(client.focusCalls ?? 0),
          navigateCalls: (client.navigateCalls as string[] | undefined) ?? [],
          postMessageCalls: messages.filter(
            (message) => message.type === "salchi.notification-click",
          ) as MockClientState["postMessageCalls"],
          diagnosticMessageCalls: messages.filter(
            (message) => message.type === "salchi.notification-click-diagnostic",
          ) as MockClientState["diagnosticMessageCalls"],
        };
      }),
    getBroadcastMessages: () => broadcastMessages,
    getBroadcastCloseCalls: () => broadcastCloseCalls,
    getDirectDiagnostics: () => directDiagnostics,
    getPendingClickWrites: () => pendingClickWrites,
    getBadgeSetCalls: () => badgeSetCalls,
    getBadgeClearCallCount: () => badgeClearCallCount,
    getDisplayedNotificationCount: () =>
      displayedNotifications.filter((notification) => notification.__closed !== true).length,
    closeAllDisplayedNotificationsWithoutEvent: () => {
      for (const notification of displayedNotifications) {
        if (notification.__closed !== true) {
          notification.close();
        }
      }
    },
    dispatchActivate: async () => {
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.activate ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchMessage: async (payload) => {
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        data: payload,
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.message ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchPush: async (payload) => {
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        data: {
          json: () => payload,
        },
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.push ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchNotificationClick: async (index = 0) => {
      const notification = displayedNotifications.filter(
        (candidate) => candidate.__closed !== true,
      )[index];
      if (!notification) {
        throw new Error(`No displayed notification at index ${index}`);
      }
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        notification,
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.notificationclick ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchNotificationClose: async (index = 0) => {
      const notification = displayedNotifications.filter(
        (candidate) => candidate.__closed !== true,
      )[index];
      if (!notification) {
        throw new Error(`No displayed notification at index ${index}`);
      }
      // The browser removes the notification before dispatching notificationclose.
      notification.close();
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        notification,
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.notificationclose ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    addClient: (options) => {
      (context.__windowClients as Array<Record<string, unknown>>).push(makeClient(options));
    },
    setOpenWindowResult: (result) => {
      openWindowResult = result;
    },
    setGetNotificationsResult: (result) => {
      getNotificationsResult = result;
    },
    removeBroadcastChannel: () => {
      delete (context.self as Record<string, unknown>).BroadcastChannel;
    },
    removeAppBadgeSupport: () => {
      (context.self as Record<string, unknown>).navigator = {};
    },
  };
}

async function openNotificationUrl(harness: ServiceWorkerTestHarness, url: string): Promise<void> {
  await vm.runInContext(
    `__salchiServiceWorkerTestExports.openNotificationUrl(${JSON.stringify(url)})`,
    harness.context,
  );
}

function notificationTitle(harness: ServiceWorkerTestHarness, rawTitle: unknown): string {
  return String(
    vm.runInContext(
      `__salchiServiceWorkerTestExports.notificationTitle(${JSON.stringify(rawTitle)})`,
      harness.context,
    ),
  );
}

describe("salchi-service-worker app badge", () => {
  let harness: ServiceWorkerTestHarness;

  beforeEach(() => {
    harness = createServiceWorkerTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("counts distinct threads with completed turns after pushes", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(2);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("does not badge approval or user-input request notifications", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:approval:activity-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-1:input:activity-2",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(2);
    expect(harness.getBadgeSetCalls()).toEqual([]);
  });

  it("does not badge notifications with the default tag", async () => {
    await harness.dispatchPush({ url: TARGET_URL });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([]);
  });

  it("counts a single thread once when multiple turns complete", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-2",
      url: TARGET_URL,
    });

    expect(harness.getBadgeSetCalls()).toEqual([1, 1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("closes prior notifications for a thread when a new turn completes", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:approval:activity-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1]);
  });

  it("shows the pushed notification before querying or closing older notifications", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:approval:activity-1",
      url: TARGET_URL,
    });
    const operationStart = harness.operationLog.length;

    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    const operations = harness.operationLog.slice(operationStart);
    expect(operations.indexOf("showNotification")).toBeLessThan(
      operations.indexOf("getNotifications"),
    );
    expect(operations.indexOf("showNotification")).toBeLessThan(
      operations.indexOf("notification-close"),
    );
  });

  it("keeps the pushed notification when notification maintenance fails", async () => {
    harness.setGetNotificationsResult("throw");

    await expect(
      harness.dispatchPush({
        title: "Completed task",
        body: "The task completed successfully.",
        tag: "thread:thread-1:turn:turn-1",
        url: TARGET_URL,
      }),
    ).resolves.toBeUndefined();

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.operationLog[0]).toBe("showNotification");
  });

  it("records notification display directly after Chrome accepts it", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDirectDiagnostics()).toEqual([
      {
        ts: expect.any(Number),
        kind: "push-service-worker",
        reason: "notification-shown",
        data: {
          display: { mode: "full" },
          tag: "thread:thread-1:turn:turn-1",
          url: TARGET_URL,
        },
      },
    ]);
    expect(harness.operationLog.indexOf("showNotification")).toBeLessThan(
      harness.operationLog.indexOf("diagnostic"),
    );
  });

  it("syncs push badge writes even while a visible same-origin page is open", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      visibilityState: "visible",
    });

    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("clears all completed-turn notifications when a notification is clicked", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    await harness.dispatchNotificationClick(0);

    expect(harness.getDisplayedNotificationCount()).toBe(0);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("resyncs the badge when a notification is dismissed", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    await harness.dispatchNotificationClose(0);

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2, 1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("resyncs dismissal while a visible same-origin page is open", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    harness.addClient({
      url: HOME_URL,
      focused: true,
      visibilityState: "visible",
    });

    await harness.dispatchNotificationClose(0);

    expect(harness.getBadgeSetCalls()).toEqual([1]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("does nothing when app badge support is unavailable", async () => {
    harness.removeAppBadgeSupport();

    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("clears completed-turn notifications when the page requests alert clearing", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    await harness.dispatchMessage({ type: "salchi.clear-turn-completion-notifications" });

    expect(harness.getDisplayedNotificationCount()).toBe(0);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("clears a stale badge when the page requests a badge sync after notifications disappeared", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    harness.closeAllDisplayedNotificationsWithoutEvent();

    await harness.dispatchMessage({ type: "salchi.sync-displayed-notification-badge" });

    expect(harness.getDisplayedNotificationCount()).toBe(0);
    expect(harness.getBadgeSetCalls()).toEqual([1]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("syncs the displayed-notification badge on activation", async () => {
    await harness.dispatchActivate();

    expect(harness.getBadgeSetCalls()).toEqual([]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });
});

describe("salchi-service-worker notification click navigation", () => {
  let harness: ServiceWorkerTestHarness;

  beforeEach(() => {
    harness = createServiceWorkerTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("strips the app source suffix from notification titles", () => {
    expect(notificationTitle(harness, "Investigate deploy from Salchi")).toBe("Investigate deploy");
    expect(notificationTitle(harness, "Investigate deploy")).toBe("Investigate deploy");
    expect(notificationTitle(harness, "from Salchi")).toBe(DEFAULT_NOTIFICATION_TITLE);
  });

  it("opens a new window with the full URL when no same-origin client exists", async () => {
    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("performs the window interaction before broadcast and persistence work", async () => {
    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.getBroadcastMessages()).toEqual([
      {
        name: "salchi-notification-click",
        message: {
          type: "salchi.notification-click",
          url: TARGET_URL,
          openedAt: expect.any(Number),
        },
      },
    ]);
    expect(harness.getBroadcastCloseCalls()).toEqual(["salchi-notification-click"]);
    expect(harness.operationLog.indexOf("openWindow")).toBeLessThan(
      harness.operationLog.indexOf("diagnostic"),
    );
    expect(harness.operationLog.indexOf("diagnostic")).toBeLessThan(
      harness.operationLog.indexOf("broadcast"),
    );
    expect(harness.operationLog.indexOf("broadcast")).toBeLessThan(
      harness.operationLog.indexOf("persist"),
    );
    expect(harness.matchAllCalls).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(harness.getDirectDiagnostics()).toEqual([
      {
        ts: expect.any(Number),
        kind: "notification-click-service-worker-direct",
        reason: "window-interaction-complete",
        data: {
          client: null,
          url: TARGET_URL,
        },
      },
    ]);
  });

  it("broadcasts the notification click when an existing client handles the click", async () => {
    harness.addClient({ url: TARGET_URL, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.getBroadcastMessages()).toEqual([
      {
        name: "salchi-notification-click",
        message: {
          type: "salchi.notification-click",
          url: TARGET_URL,
          openedAt: expect.any(Number),
        },
      },
    ]);
    expect(harness.getBroadcastCloseCalls()).toEqual(["salchi-notification-click"]);
  });

  it("continues notification click handling when BroadcastChannel is unavailable", async () => {
    harness.removeBroadcastChannel();

    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.getBroadcastMessages()).toEqual([]);
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("posts the notification click to the client returned by openWindow", async () => {
    harness.setOpenWindowResult("client-at-home");

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
    expect(client?.url).toBe(HOME_URL);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
  });

  it("persists the notification click after the window interaction", async () => {
    harness.addClient({ url: TARGET_URL, focused: true, navigateResult: "self" });

    await openNotificationUrl(harness, TARGET_URL);

    const [write] = harness.getPendingClickWrites();
    expect(write).toMatchObject({
      cacheName: "salchi-notification-click-v1",
      requestUrl: `${ORIGIN}/__salchi-notification-click/pending`,
      value: {
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    });
    expect(harness.operationLog.indexOf("focus")).toBeLessThan(
      harness.operationLog.indexOf("persist"),
    );
  });

  it("ignores cross-origin clients when deciding whether the app is open", async () => {
    harness.addClient({ url: CROSS_ORIGIN_URL, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(0);
    expect(client?.postMessageCalls).toEqual([]);
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("focuses an exact-url client without navigating", async () => {
    harness.addClient({ url: TARGET_URL, focused: true, navigateResult: "self" });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("treats trailing-slash variants as an exact-url match", async () => {
    harness.addClient({ url: `${TARGET_URL}/`, focused: true, navigateResult: "self" });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.postMessageCalls).toHaveLength(1);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and posts to a controlled client without navigating when the page acks", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("does not wait for an acknowledgement or navigate after focusing", async () => {
    harness.addClient({
      ackNotificationClick: false,
      url: HOME_URL,
      focused: true,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("uses one focus interaction for a target client that does not acknowledge", async () => {
    harness.addClient({
      ackNotificationClick: false,
      url: TARGET_URL,
      focused: true,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(TARGET_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toHaveLength(1);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses an uncontrolled same-origin client and lets the page route the click", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses a hidden same-origin client without opening a new window", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      visibilityState: "hidden",
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and posts without opening a new window when navigate is unavailable", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("does not call client navigation when the page router can handle the click", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
      navigateResult: "null",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("does not invoke a throwing client navigation method", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
      navigateResult: "throw",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("does not spend a second interaction token when focus throws", async () => {
    harness.setOpenWindowResult("client-at-url");
    harness.addClient({
      url: TARGET_URL,
      focused: true,
      focusResult: "throw",
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(client?.diagnosticMessageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "client-selected",
          data: expect.objectContaining({
            candidateCount: 1,
            selectionReason: "exact-url",
          }),
        }),
        expect.objectContaining({
          reason: "client-focus",
          data: expect.objectContaining({
            outcome: "rejected",
            error: {
              name: "Error",
              message: "focus failed",
            },
          }),
        }),
      ]),
    );
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("does not open a fallback when focus and postMessage both reject", async () => {
    harness.setOpenWindowResult("client-at-url");
    harness.addClient({
      url: TARGET_URL,
      focusResult: "throw",
      postMessageResult: "throw",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("selects the exact target URL before a focused same-origin client", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      navigateResult: "self",
    });
    harness.addClient({
      url: TARGET_URL,
      focused: false,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [homeClient, targetClient] = harness.getClients();
    expect(homeClient?.focusCalls).toBe(0);
    expect(homeClient?.postMessageCalls).toEqual([]);
    expect(targetClient?.focusCalls).toBe(1);
    expect(targetClient?.navigateCalls).toEqual([]);
    expect(targetClient?.postMessageCalls).toEqual([
      {
        type: "salchi.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });
});
