import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationNavigationTarget } from "./push/notificationNavigation";
import {
  clearPersistedStartupThreadTarget,
  clearPersistedStartupThreadTargetForEnvironment,
  clearPersistedStartupThreadTargetForTests,
  consumeStartupThreadRestoreTarget,
  isStartupBootstrapThreadStale,
  primeStartupThreadRestore,
  readPersistedStartupThreadTarget,
  resetStartupThreadRestoreForTests,
  resolveStartupRestoreTarget,
  STARTUP_THREAD_TARGET_STORAGE_KEY,
  STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS,
  shouldNavigateToStartupBootstrapThread,
  writePersistedStartupThreadTarget,
} from "./startupNavigation";

const BOOTSTRAP_THREAD_ID = ThreadId.make("thread-startup");
const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("env-2");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");
const NOW = Date.parse("2026-03-04T12:00:00.000Z");
const NOTIFICATION_THREAD_TARGET: NotificationNavigationTarget = {
  kind: "thread",
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
};

function visitedAt(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function threadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

describe("shouldNavigateToStartupBootstrapThread", () => {
  it("opens the bootstrap thread from the browser base route", () => {
    expect(
      shouldNavigateToStartupBootstrapThread({
        pathname: "/",
        bootstrapThreadId: BOOTSTRAP_THREAD_ID,
        handledBootstrapThreadId: null,
        lastNotificationNavigationTarget: null,
      }),
    ).toBe(true);
  });

  it("does not override a notification navigation target", () => {
    expect(
      shouldNavigateToStartupBootstrapThread({
        pathname: "/",
        bootstrapThreadId: BOOTSTRAP_THREAD_ID,
        handledBootstrapThreadId: null,
        lastNotificationNavigationTarget: NOTIFICATION_THREAD_TARGET,
      }),
    ).toBe(false);
  });

  it("does not override an explicit route", () => {
    expect(
      shouldNavigateToStartupBootstrapThread({
        pathname: "/env-1/thread-1",
        bootstrapThreadId: BOOTSTRAP_THREAD_ID,
        handledBootstrapThreadId: null,
        lastNotificationNavigationTarget: null,
      }),
    ).toBe(false);
  });

  it("does not repeat a handled bootstrap thread", () => {
    expect(
      shouldNavigateToStartupBootstrapThread({
        pathname: "/",
        bootstrapThreadId: BOOTSTRAP_THREAD_ID,
        handledBootstrapThreadId: BOOTSTRAP_THREAD_ID,
        lastNotificationNavigationTarget: null,
      }),
    ).toBe(false);
  });
});

describe("resolveStartupRestoreTarget", () => {
  it("prefers the dedicated persisted target", () => {
    expect(
      resolveStartupRestoreTarget({
        persistedTarget: {
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
        },
        threadLastVisitedAtById: {
          [threadKey(OTHER_ENVIRONMENT_ID, OTHER_THREAD_ID)]: visitedAt(-60 * 1000),
        },
      }),
    ).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
  });

  it("returns the most recently visited scoped thread", () => {
    expect(
      resolveStartupRestoreTarget({
        threadLastVisitedAtById: {
          [threadKey(ENVIRONMENT_ID, THREAD_ID)]: visitedAt(-10 * 60 * 1000),
          [threadKey(OTHER_ENVIRONMENT_ID, OTHER_THREAD_ID)]: visitedAt(-60 * 1000),
        },
      }),
    ).toEqual({
      environmentId: OTHER_ENVIRONMENT_ID,
      threadId: OTHER_THREAD_ID,
    });
  });

  it("restores a real visit even when it is older than the server bootstrap stale window", () => {
    expect(
      resolveStartupRestoreTarget({
        threadLastVisitedAtById: {
          [threadKey(ENVIRONMENT_ID, THREAD_ID)]: visitedAt(
            -STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS - 1,
          ),
        },
      }),
    ).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
  });

  it("skips a malformed newest key and restores the newest valid target", () => {
    expect(
      resolveStartupRestoreTarget({
        threadLastVisitedAtById: {
          "not-scoped": visitedAt(-60 * 1000),
          [threadKey(ENVIRONMENT_ID, THREAD_ID)]: "not-a-date",
          [threadKey(OTHER_ENVIRONMENT_ID, OTHER_THREAD_ID)]: visitedAt(-2 * 60 * 1000),
        },
      }),
    ).toEqual({
      environmentId: OTHER_ENVIRONMENT_ID,
      threadId: OTHER_THREAD_ID,
    });
  });

  it("skips malformed timestamps", () => {
    expect(
      resolveStartupRestoreTarget({
        threadLastVisitedAtById: {
          [threadKey(ENVIRONMENT_ID, THREAD_ID)]: "not-a-date",
          [threadKey(OTHER_ENVIRONMENT_ID, OTHER_THREAD_ID)]: visitedAt(-2 * 60 * 1000),
        },
      }),
    ).toEqual({
      environmentId: OTHER_ENVIRONMENT_ID,
      threadId: OTHER_THREAD_ID,
    });
  });

  it("returns null when all entries are malformed", () => {
    expect(
      resolveStartupRestoreTarget({
        threadLastVisitedAtById: {
          "not-scoped": visitedAt(-60 * 1000),
          [threadKey(ENVIRONMENT_ID, THREAD_ID)]: "not-a-date",
        },
      }),
    ).toBeNull();
  });

  it("returns null for an empty visit map", () => {
    expect(
      resolveStartupRestoreTarget({
        threadLastVisitedAtById: {},
      }),
    ).toBeNull();
  });

  it("keeps an explicit target even when it has no cached visit entry", () => {
    expect(
      resolveStartupRestoreTarget({
        persistedTarget: {
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
        },
        threadLastVisitedAtById: {
          [threadKey(OTHER_ENVIRONMENT_ID, OTHER_THREAD_ID)]: visitedAt(-60 * 1000),
        },
      }),
    ).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
  });
});

describe("startup thread restore priming", () => {
  afterEach(() => {
    resetStartupThreadRestoreForTests();
  });

  it("consumes a primed base-route target once", () => {
    primeStartupThreadRestore({
      pathname: "/",
      threadLastVisitedAtById: {
        [threadKey(ENVIRONMENT_ID, THREAD_ID)]: visitedAt(-60 * 1000),
      },
    });

    expect(consumeStartupThreadRestoreTarget({ lastNotificationNavigationTarget: null })).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
    expect(
      consumeStartupThreadRestoreTarget({ lastNotificationNavigationTarget: null }),
    ).toBeNull();
  });

  it("does not prime non-base launches", () => {
    primeStartupThreadRestore({
      pathname: "/env-1/thread-1",
      threadLastVisitedAtById: {
        [threadKey(ENVIRONMENT_ID, THREAD_ID)]: visitedAt(-60 * 1000),
      },
    });

    expect(
      consumeStartupThreadRestoreTarget({ lastNotificationNavigationTarget: null }),
    ).toBeNull();
  });

  it("suppresses and clears the target when a notification target exists", () => {
    primeStartupThreadRestore({
      pathname: "/",
      threadLastVisitedAtById: {
        [threadKey(ENVIRONMENT_ID, THREAD_ID)]: visitedAt(-60 * 1000),
      },
    });

    expect(
      consumeStartupThreadRestoreTarget({
        lastNotificationNavigationTarget: NOTIFICATION_THREAD_TARGET,
      }),
    ).toBeNull();
    expect(
      consumeStartupThreadRestoreTarget({ lastNotificationNavigationTarget: null }),
    ).toBeNull();
  });
});

describe("persisted startup thread target", () => {
  const values = new Map<string, string>();
  const localStorageStub: Storage = {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", { localStorage: localStorageStub });
  });

  afterEach(() => {
    clearPersistedStartupThreadTargetForTests();
    vi.unstubAllGlobals();
  });

  it("roundtrips a dedicated startup thread target", () => {
    const target = {
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    };

    writePersistedStartupThreadTarget(target);

    expect(readPersistedStartupThreadTarget()).toEqual(target);
    expect(localStorageStub.getItem(STARTUP_THREAD_TARGET_STORAGE_KEY)).not.toBeNull();
  });

  it("ignores malformed persisted targets", () => {
    localStorageStub.setItem(
      STARTUP_THREAD_TARGET_STORAGE_KEY,
      JSON.stringify({ version: 1, target: { environmentId: ENVIRONMENT_ID } }),
    );

    expect(readPersistedStartupThreadTarget()).toBeNull();
  });

  it("clears only the matching stale target", () => {
    const target = {
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    };
    writePersistedStartupThreadTarget(target);

    clearPersistedStartupThreadTarget({
      environmentId: OTHER_ENVIRONMENT_ID,
      threadId: OTHER_THREAD_ID,
    });
    expect(readPersistedStartupThreadTarget()).toEqual(target);

    clearPersistedStartupThreadTarget(target);
    expect(readPersistedStartupThreadTarget()).toBeNull();
  });

  it("clears the target when its saved environment is removed", () => {
    writePersistedStartupThreadTarget({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });

    clearPersistedStartupThreadTargetForEnvironment(OTHER_ENVIRONMENT_ID);
    expect(readPersistedStartupThreadTarget()).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });

    clearPersistedStartupThreadTargetForEnvironment(ENVIRONMENT_ID);
    expect(readPersistedStartupThreadTarget()).toBeNull();
  });
});

describe("isStartupBootstrapThreadStale", () => {
  const activityAt = "2026-03-04T12:00:00.000Z";
  const activityMs = Date.parse(activityAt);

  it("keeps a bootstrap thread that was active 7h59m ago", () => {
    expect(
      isStartupBootstrapThreadStale({
        activityAt,
        now: activityMs + STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS - 60 * 1000,
      }),
    ).toBe(false);
  });

  it("skips a bootstrap thread that was active 8h01m ago", () => {
    expect(
      isStartupBootstrapThreadStale({
        activityAt,
        now: activityMs + STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS + 60 * 1000,
      }),
    ).toBe(true);
  });

  it("keeps current behavior when activity time is unknown", () => {
    expect(
      isStartupBootstrapThreadStale({
        activityAt: null,
        now: activityMs + STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS + 60 * 1000,
      }),
    ).toBe(false);
  });

  it("keeps current behavior when activity time cannot be parsed", () => {
    expect(
      isStartupBootstrapThreadStale({
        activityAt: "not-a-date",
        now: activityMs + STARTUP_BOOTSTRAP_THREAD_STALE_AFTER_MS + 60 * 1000,
      }),
    ).toBe(false);
  });
});
