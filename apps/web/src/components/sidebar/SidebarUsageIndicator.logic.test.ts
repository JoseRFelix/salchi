import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import {
  deriveSidebarUsageProviderRows,
  getSidebarUsageBarPercent,
  getSidebarUsageDisplayPercent,
  getSidebarUsageSummary,
  type SidebarUsageWindow,
} from "./SidebarUsageIndicator.logic";

const FUTURE_RESET_SECONDS = 4_102_444_800;
const LATER_FUTURE_RESET_SECONDS = 4_102_704_000;

function makeRateLimitActivity(input: {
  readonly id: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: "account.rate-limits.updated",
    summary: "Usage limits updated",
    payload: input.payload,
    turnId: TurnId.make("turn-1"),
    createdAt: input.createdAt,
  };
}

function makeContextWindowActivity(input: {
  readonly id: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: input.payload,
    turnId: TurnId.make("turn-1"),
    createdAt: input.createdAt,
  };
}

describe("SidebarUsageIndicator.logic", () => {
  it("groups latest 5h and weekly rate-limit usage by Codex and Claude driver", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex_work"),
          driverKind: ProviderDriverKind.make("codex"),
        },
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-codex",
          title: "Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex_work"),
          activities: [
            makeRateLimitActivity({
              id: "activity-codex",
              createdAt: "2026-05-02T00:00:00.000Z",
              payload: {
                provider: "codex",
                providerInstanceId: "codex_work",
                rateLimits: {
                  rateLimits: {
                    primary: {
                      usedPercent: 42,
                      windowDurationMins: 300,
                      resetsAt: FUTURE_RESET_SECONDS,
                    },
                    secondary: {
                      usedPercent: 17,
                      windowDurationMins: 10_080,
                      resetsAt: LATER_FUTURE_RESET_SECONDS,
                    },
                  },
                },
              },
            }),
          ],
        },
        {
          id: "thread-claude",
          title: "Claude",
          modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
          activities: [
            makeRateLimitActivity({
              id: "activity-claude-five-hour",
              createdAt: "2026-05-03T00:00:00.000Z",
              payload: {
                provider: "claudeAgent",
                providerInstanceId: "claude_personal",
                rateLimits: {
                  type: "rate_limit_event",
                  rate_limit_info: {
                    status: "allowed_warning",
                    rateLimitType: "five_hour",
                    utilization: 0.75,
                    resetsAt: FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
            makeRateLimitActivity({
              id: "activity-claude-weekly",
              createdAt: "2026-05-03T00:01:00.000Z",
              payload: {
                provider: "claudeAgent",
                providerInstanceId: "claude_personal",
                rateLimits: {
                  type: "rate_limit_event",
                  rate_limit_info: {
                    status: "allowed",
                    rateLimitType: "seven_day_sonnet",
                    utilization: 22,
                    resetsAt: LATER_FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
          ],
        },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe("Codex");
    expect(rows[0]?.windows.fiveHour?.usedPercent).toBe(42);
    expect(rows[0]?.windows.fiveHour?.remainingPercent).toBe(58);
    expect(getSidebarUsageDisplayPercent(rows[0]?.windows.fiveHour ?? null)).toBe(58);
    expect(rows[0]?.windows.weekly?.usedPercent).toBe(17);
    expect(rows[0]?.windows.weekly?.remainingPercent).toBe(83);
    expect(rows[1]?.label).toBe("Claude");
    expect(rows[1]?.windows.fiveHour?.usedPercent).toBe(75);
    expect(rows[1]?.windows.fiveHour?.remainingPercent).toBe(25);
    expect(rows[1]?.windows.weekly?.usedPercent).toBe(22);
    expect(rows[1]?.windows.weekly?.remainingPercent).toBe(78);
    expect(getSidebarUsageSummary(rows)?.row.label).toBe("Claude");
    expect(getSidebarUsageSummary(rows)?.window.label).toBe("5h");
  });

  it("falls back to default driver instance ids when activity payload metadata is unavailable", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driverKind: ProviderDriverKind.make("codex"),
        },
      ],
      threads: [
        {
          id: "thread-codex",
          title: "Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex"),
          activities: [
            makeRateLimitActivity({
              id: "activity-codex",
              createdAt: "2026-05-01T00:00:00.000Z",
              payload: {
                rateLimits: {
                  primary: {
                    usedPercent: 12,
                    windowDurationMins: 300,
                  },
                },
              },
            }),
          ],
        },
      ],
    });

    expect(rows[0]?.windows.fiveHour?.usedPercent).toBe(12);
    expect(rows[0]?.windows.fiveHour?.remainingPercent).toBe(88);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.driverId).toBe("codex");
  });

  it("omits an uninstalled supported provider while keeping installed provider usage", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driverKind: ProviderDriverKind.make("codex"),
          installed: true,
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          installed: false,
        },
      ],
      threads: [
        {
          id: "thread-codex",
          title: "Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex"),
          activities: [
            makeRateLimitActivity({
              id: "activity-codex-installed",
              createdAt: "2026-05-01T00:00:00.000Z",
              payload: {
                provider: "codex",
                providerInstanceId: "codex",
                rateLimits: {
                  primary: {
                    usedPercent: 12,
                    windowDurationMins: 300,
                    resetsAt: FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
          ],
        },
        {
          id: "thread-claude",
          title: "Claude",
          modelSelectionInstanceId: ProviderInstanceId.make("claudeAgent"),
          activities: [
            makeRateLimitActivity({
              id: "activity-claude-uninstalled",
              createdAt: "2026-05-02T00:00:00.000Z",
              payload: {
                provider: "claudeAgent",
                providerInstanceId: "claudeAgent",
                rateLimits: {
                  primary: {
                    usedPercent: 91,
                    windowDurationMins: 300,
                    resetsAt: FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
          ],
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.driverId).toBe("codex");
    expect(rows[0]?.windows.fiveHour?.usedPercent).toBe(12);
  });

  it("ignores thread cost and context usage when no account limit data is available", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-claude-1",
          title: "First Claude thread",
          modelSelectionInstanceId: ProviderInstanceId.make("claudeAgent"),
          activities: [
            makeContextWindowActivity({
              id: "ctx-1",
              createdAt: "2026-05-13T00:00:00.000Z",
              payload: { usedTokens: 1000, costUsd: 0.42 },
            }),
            makeContextWindowActivity({
              id: "ctx-1-later",
              createdAt: "2026-05-13T01:00:00.000Z",
              payload: { usedTokens: 2000, costUsd: 1.18 },
            }),
          ],
        },
        {
          id: "thread-claude-2",
          title: "Second Claude thread",
          modelSelectionInstanceId: ProviderInstanceId.make("claudeAgent"),
          activities: [
            makeContextWindowActivity({
              id: "ctx-2",
              createdAt: "2026-05-13T02:00:00.000Z",
              payload: { usedTokens: 500, costUsd: 0.07 },
            }),
          ],
        },
      ],
    });

    const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
    expect(claudeRow?.windows.fiveHour).toBeNull();
    expect(claudeRow?.windows.weekly).toBeNull();
    expect(claudeRow?.updatedAt).toBeNull();
    expect(claudeRow?.threadId).toBeNull();
    expect(getSidebarUsageSummary(rows)).toBeNull();
  });

  it("does not substitute context usage for missing Claude account limits", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-claude-context",
          title: "Claude context",
          modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
          activities: [
            makeContextWindowActivity({
              id: "ctx-claude-context",
              createdAt: "2026-05-13T03:00:00.000Z",
              payload: { usedTokens: 50_000, maxTokens: 200_000 },
            }),
          ],
        },
      ],
    });

    const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
    expect(claudeRow?.windows.fiveHour).toBeNull();
    expect(claudeRow?.windows.weekly).toBeNull();
    expect(claudeRow?.updatedAt).toBeNull();
    expect(claudeRow?.threadId).toBeNull();
  });

  it("ignores expired Claude rate-limit windows without falling back to context", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-claude-expired",
          title: "Claude expired rate limit",
          modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
          activities: [
            makeRateLimitActivity({
              id: "activity-claude-expired",
              createdAt: "2026-05-13T00:00:00.000Z",
              payload: {
                provider: "claudeAgent",
                providerInstanceId: "claude_personal",
                rateLimits: {
                  type: "rate_limit_event",
                  rate_limit_info: {
                    status: "rejected",
                    rateLimitType: "five_hour",
                    resetsAt: 1_700_000_000,
                  },
                },
              },
            }),
            makeContextWindowActivity({
              id: "ctx-after-expired-limit",
              createdAt: "2026-05-13T00:01:00.000Z",
              payload: { usedTokens: 60_000, maxTokens: 200_000 },
            }),
          ],
        },
      ],
    });

    const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
    expect(claudeRow?.windows.fiveHour).toBeNull();
    expect(claudeRow?.windows.weekly).toBeNull();
    expect(claudeRow?.updatedAt).toBeNull();
    expect(claudeRow?.threadId).toBeNull();
  });

  it("keeps zero-percent Claude subscription utilization as account limit data", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-claude-zero",
          title: "Claude zero utilization",
          modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
          activities: [
            makeRateLimitActivity({
              id: "activity-claude-zero",
              createdAt: "2026-05-13T04:00:00.000Z",
              payload: {
                provider: "claudeAgent",
                providerInstanceId: "claude_personal",
                rateLimits: {
                  source: "claude.oauth.usage",
                  primary: {
                    usedPercent: 0,
                    windowDurationMins: 300,
                    resetsAt: FUTURE_RESET_SECONDS,
                  },
                  secondary: {
                    usedPercent: 0,
                    windowDurationMins: 10_080,
                    resetsAt: LATER_FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
          ],
        },
      ],
    });

    const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
    expect(claudeRow?.windows.fiveHour?.usedPercent).toBe(0);
    expect(claudeRow?.windows.fiveHour?.remainingPercent).toBe(100);
    expect(claudeRow?.windows.weekly?.usedPercent).toBe(0);
    expect(claudeRow?.threadId).toBe("thread-claude-zero");
  });

  describe("getSidebarUsageBarPercent", () => {
    function makeStatusOnlyWindow(input: {
      readonly status: string;
      readonly usedPercent?: number;
    }): SidebarUsageWindow {
      const usedPercent = input.usedPercent ?? null;
      return {
        id: "fiveHour",
        label: "5h",
        usedPercent,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        resetsAtMs: FUTURE_RESET_SECONDS * 1000,
        status: input.status,
        updatedAt: "2026-05-13T05:00:00.000Z",
      };
    }

    it('returns 100 for status-only "allowed" Claude 5h window without utilization', () => {
      const window = makeStatusOnlyWindow({ status: "allowed" });
      expect(getSidebarUsageBarPercent(window)).toBe(100);
      expect(getSidebarUsageDisplayPercent(window)).toBeNull();
    });

    it('returns 20 for status-only "allowed_warning" and 0 for status-only "rejected"', () => {
      expect(getSidebarUsageBarPercent(makeStatusOnlyWindow({ status: "allowed_warning" }))).toBe(
        20,
      );
      expect(getSidebarUsageBarPercent(makeStatusOnlyWindow({ status: "rejected" }))).toBe(0);
    });

    it("prefers numeric remainingPercent when both numeric and status are present", () => {
      const window = makeStatusOnlyWindow({ status: "allowed", usedPercent: 75 });
      expect(getSidebarUsageBarPercent(window)).toBe(25);
    });

    it("returns null when status is unknown and there is no numeric data", () => {
      const window = makeStatusOnlyWindow({ status: "unknown_status" });
      expect(getSidebarUsageBarPercent(window)).toBeNull();
      expect(getSidebarUsageDisplayPercent(window)).toBeNull();
    });
  });

  it("populates provider rows from account-level limits when no threads exist", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex_work"),
          driverKind: ProviderDriverKind.make("codex"),
        },
      ],
      threads: [],
      accountRateLimitsByInstanceId: {
        codex_work: {
          updatedAt: "2026-05-01T00:00:00.000Z",
          rateLimits: {
            rateLimits: {
              primary: {
                usedPercent: 33,
                windowDurationMins: 300,
                resetsAt: FUTURE_RESET_SECONDS,
              },
              secondary: {
                usedPercent: 11,
                windowDurationMins: 10_080,
                resetsAt: LATER_FUTURE_RESET_SECONDS,
              },
            },
          },
        },
      },
    });

    expect(rows[0]?.windows.fiveHour?.usedPercent).toBe(33);
    expect(rows[0]?.windows.weekly?.usedPercent).toBe(11);
    expect(rows[0]?.threadId).toBeNull();
  });

  it("populates Claude and Codex rows from account-level limits", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex_work"),
          driverKind: ProviderDriverKind.make("codex"),
        },
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [],
      accountRateLimitsByInstanceId: {
        codex_work: {
          updatedAt: "2026-05-01T00:00:00.000Z",
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: FUTURE_RESET_SECONDS },
          },
        },
        claude_personal: {
          updatedAt: "2026-05-01T00:00:00.000Z",
          rateLimits: {
            source: "claude.oauth.usage",
            primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: FUTURE_RESET_SECONDS },
            secondary: {
              usedPercent: 15,
              windowDurationMins: 10_080,
              resetsAt: LATER_FUTURE_RESET_SECONDS,
            },
          },
        },
      },
    });

    expect(rows[0]?.windows.fiveHour?.usedPercent).toBe(20);
    expect(rows[1]?.windows.fiveHour?.usedPercent).toBe(8);
    expect(rows[1]?.windows.weekly?.usedPercent).toBe(15);
  });

  it("prefers newer thread activity over older account-level limits", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-claude",
          title: "Claude",
          modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
          activities: [
            makeRateLimitActivity({
              id: "activity-thread",
              createdAt: "2026-05-20T00:00:00.000Z",
              payload: {
                provider: "claudeAgent",
                providerInstanceId: "claude_personal",
                rateLimits: {
                  source: "claude.oauth.usage",
                  primary: {
                    usedPercent: 55,
                    windowDurationMins: 300,
                    resetsAt: FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
          ],
        },
      ],
      accountRateLimitsByInstanceId: {
        claude_personal: {
          updatedAt: "2026-05-10T00:00:00.000Z",
          rateLimits: {
            source: "claude.oauth.usage",
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: FUTURE_RESET_SECONDS,
            },
          },
        },
      },
    });

    const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
    expect(claudeRow?.windows.fiveHour?.usedPercent).toBe(55);
    expect(claudeRow?.threadId).toBe("thread-claude");
  });

  it("omits usage rows when no supported provider drivers are installed", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driverKind: ProviderDriverKind.make("codex"),
          installed: false,
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          installed: false,
        },
      ],
      threads: [
        {
          id: "thread-codex",
          title: "Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex"),
          activities: [
            makeRateLimitActivity({
              id: "activity-codex-uninstalled",
              createdAt: "2026-05-01T00:00:00.000Z",
              payload: {
                provider: "codex",
                providerInstanceId: "codex",
                rateLimits: {
                  primary: {
                    usedPercent: 99,
                    windowDurationMins: 300,
                    resetsAt: FUTURE_RESET_SECONDS,
                  },
                },
              },
            }),
          ],
        },
      ],
      accountRateLimitsByInstanceId: {
        codex: {
          updatedAt: "2026-05-01T00:00:00.000Z",
          rateLimits: {
            primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: FUTURE_RESET_SECONDS },
          },
        },
      },
    });

    expect(rows).toEqual([]);
  });

  describe("deriveSidebarUsageProviderRows merge tightening", () => {
    const claudeProvider = {
      instanceId: ProviderInstanceId.make("claude_personal"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
    } as const;

    it("keeps precise OAuth usedPercent when a later status-only allowed SDK event arrives", () => {
      const rows = deriveSidebarUsageProviderRows({
        providerInstances: [claudeProvider],
        threads: [
          {
            id: "thread-claude-merge",
            title: "Claude merge",
            modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
            activities: [
              makeRateLimitActivity({
                id: "activity-claude-oauth",
                createdAt: "2026-05-13T05:00:00.000Z",
                payload: {
                  provider: "claudeAgent",
                  providerInstanceId: "claude_personal",
                  rateLimits: {
                    source: "claude.oauth.usage",
                    primary: {
                      usedPercent: 0,
                      windowDurationMins: 300,
                      resetsAt: FUTURE_RESET_SECONDS,
                    },
                  },
                },
              }),
              makeRateLimitActivity({
                id: "activity-claude-sdk-allowed",
                createdAt: "2026-05-13T06:00:00.000Z",
                payload: {
                  provider: "claudeAgent",
                  providerInstanceId: "claude_personal",
                  rateLimits: {
                    type: "rate_limit_event",
                    rate_limit_info: {
                      status: "allowed",
                      rateLimitType: "five_hour",
                      resetsAt: FUTURE_RESET_SECONDS,
                    },
                  },
                },
              }),
            ],
          },
        ],
      });

      const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
      expect(claudeRow?.windows.fiveHour?.usedPercent).toBe(0);
      expect(claudeRow?.windows.fiveHour?.remainingPercent).toBe(100);
      expect(getSidebarUsageBarPercent(claudeRow?.windows.fiveHour ?? null)).toBe(100);
    });

    it("does not let a later status-only rejected SDK event clobber a fresh precise OAuth reading", () => {
      const rows = deriveSidebarUsageProviderRows({
        providerInstances: [claudeProvider],
        threads: [
          {
            id: "thread-claude-rejected-merge",
            title: "Claude rejected merge",
            modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
            activities: [
              makeRateLimitActivity({
                id: "activity-claude-oauth-precise",
                createdAt: "2026-05-13T05:00:00.000Z",
                payload: {
                  provider: "claudeAgent",
                  providerInstanceId: "claude_personal",
                  rateLimits: {
                    source: "claude.oauth.usage",
                    primary: {
                      usedPercent: 5,
                      windowDurationMins: 300,
                      resetsAt: FUTURE_RESET_SECONDS,
                    },
                  },
                },
              }),
              makeRateLimitActivity({
                id: "activity-claude-sdk-rejected",
                createdAt: "2026-05-13T06:00:00.000Z",
                payload: {
                  provider: "claudeAgent",
                  providerInstanceId: "claude_personal",
                  rateLimits: {
                    type: "rate_limit_event",
                    rate_limit_info: {
                      status: "rejected",
                      rateLimitType: "five_hour",
                      resetsAt: FUTURE_RESET_SECONDS,
                    },
                  },
                },
              }),
            ],
          },
        ],
      });

      const claudeRow = rows.find((row) => row.driverId === "claudeAgent");
      expect(claudeRow?.windows.fiveHour?.usedPercent).toBe(5);
      expect(claudeRow?.windows.fiveHour?.remainingPercent).toBe(95);
      expect(getSidebarUsageBarPercent(claudeRow?.windows.fiveHour ?? null)).toBe(95);
    });
  });
});
