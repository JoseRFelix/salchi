import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  preparePushNotifications,
  reconcileCurrentPushSubscription,
  sendTestPushNotification,
} from "./notifications";

const registerPushSubscription = vi.hoisted(() => vi.fn());
const sendTestPushNotificationRpc = vi.hoisted(() => vi.fn());
const registerServiceWorker = vi.hoisted(() => vi.fn());
const getPushConfig = vi.hoisted(() => vi.fn());

vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    server: {
      getPushConfig,
      registerPushSubscription,
      sendTestPushNotification: sendTestPushNotificationRpc,
    },
  }),
}));

const subscriptionJson = {
  endpoint: "https://push.example.test/subscription",
  expirationTime: null,
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-key",
  },
} as const;

function makePushSubscription(): PushSubscription {
  return {
    endpoint: subscriptionJson.endpoint,
    expirationTime: subscriptionJson.expirationTime,
    toJSON: () => subscriptionJson,
  } as unknown as PushSubscription;
}

function installBrowserPushEnvironment(subscription: PushSubscription | null): void {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
    },
  } as unknown as ServiceWorkerRegistration;
  registerServiceWorker.mockResolvedValue(registration);

  vi.stubGlobal("window", {
    atob: globalThis.atob,
    isSecureContext: true,
    PushManager: function PushManager() {},
    Notification: function Notification() {},
  });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      register: registerServiceWorker,
    },
    userAgent: "Salchi push reconciliation test",
  });
}

describe("push subscription reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-registers an existing browser subscription for the current server session", async () => {
    installBrowserPushEnvironment(makePushSubscription());
    registerPushSubscription.mockResolvedValue({
      subscribed: true,
      endpoint: subscriptionJson.endpoint,
    });

    await expect(reconcileCurrentPushSubscription()).resolves.toEqual(subscriptionJson);

    expect(registerPushSubscription).toHaveBeenCalledWith({
      subscription: subscriptionJson,
      userAgent: "Salchi push reconciliation test",
    });
    expect(registerServiceWorker).not.toHaveBeenCalled();
  });

  it("does not register anything when the browser has no subscription", async () => {
    installBrowserPushEnvironment(null);

    await expect(reconcileCurrentPushSubscription()).resolves.toBeNull();

    expect(registerPushSubscription).not.toHaveBeenCalled();
  });

  it("repairs stale session ownership before sending a test notification", async () => {
    installBrowserPushEnvironment(makePushSubscription());
    registerPushSubscription.mockResolvedValue({
      subscribed: true,
      endpoint: subscriptionJson.endpoint,
    });
    sendTestPushNotificationRpc.mockResolvedValue({ sentCount: 1, failedCount: 0 });

    await expect(sendTestPushNotification()).resolves.toEqual({
      sentCount: 1,
      failedCount: 0,
    });

    expect(registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(sendTestPushNotificationRpc).toHaveBeenCalledWith({
      endpoint: subscriptionJson.endpoint,
    });
    expect(registerPushSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      sendTestPushNotificationRpc.mock.invocationCallOrder[0]!,
    );
  });
});

describe("push notification preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepares the service worker and VAPID key before prompting", async () => {
    installBrowserPushEnvironment(null);
    getPushConfig.mockResolvedValue({
      supported: true,
      publicVapidKey: "AQID",
    });

    const prepared = await preparePushNotifications();

    expect(registerServiceWorker).toHaveBeenCalledWith("/salchi-service-worker.js", {
      updateViaCache: "none",
    });
    expect([...prepared.applicationServerKey]).toEqual([1, 2, 3]);
  });

  it("does not offer setup when the server has no push configuration", async () => {
    installBrowserPushEnvironment(null);
    getPushConfig.mockResolvedValue({
      supported: false,
      publicVapidKey: null,
    });

    await expect(preparePushNotifications()).rejects.toThrow(
      "Push notifications are not available on this server.",
    );
  });
});
