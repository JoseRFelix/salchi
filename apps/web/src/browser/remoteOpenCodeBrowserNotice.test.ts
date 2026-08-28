import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type UnifiedSettings,
} from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../types";
import {
  getRemoteOpenCodeBrowserNotice,
  REMOTE_OPENCODE_BROWSER_NOTICE,
} from "./remoteOpenCodeBrowserNotice";

const OPENCODE = ProviderDriverKind.make("opencode");
const CODEX = ProviderDriverKind.make("codex");

function thread(input?: {
  readonly driver?: typeof OPENCODE | typeof CODEX;
  readonly instanceId?: string;
}): Pick<Thread, "modelSelection" | "session"> {
  const instanceId = ProviderInstanceId.make(input?.instanceId ?? "opencode");
  return {
    modelSelection: { instanceId, model: "openai/gpt-5" },
    session: {
      provider: input?.driver ?? OPENCODE,
      providerInstanceId: instanceId,
      status: "ready",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      orchestrationStatus: "ready",
    },
  };
}

function settings(overrides: Partial<UnifiedSettings> = {}): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...overrides,
  };
}

describe("getRemoteOpenCodeBrowserNotice", () => {
  it("reports the legacy remote OpenCode configuration", () => {
    expect(
      getRemoteOpenCodeBrowserNotice({
        settings: settings({
          providers: {
            ...DEFAULT_UNIFIED_SETTINGS.providers,
            opencode: {
              ...DEFAULT_UNIFIED_SETTINGS.providers.opencode,
              serverUrl: "https://opencode.example.test",
            },
          },
        }),
        thread: thread(),
      }),
    ).toBe(REMOTE_OPENCODE_BROWSER_NOTICE);
  });

  it("reads a custom OpenCode instance without falling back to legacy settings", () => {
    const remoteInstanceId = ProviderInstanceId.make("opencode_remote");
    const localInstanceId = ProviderInstanceId.make("opencode_local");
    const remoteSettings = settings({
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        opencode: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.opencode,
          serverUrl: "https://legacy.example.test",
        },
      },
      providerInstances: {
        [remoteInstanceId]: {
          driver: OPENCODE,
          config: { serverUrl: "https://remote.example.test" },
        },
        [localInstanceId]: { driver: OPENCODE, config: {} },
      },
    });

    expect(
      getRemoteOpenCodeBrowserNotice({
        settings: remoteSettings,
        thread: thread({ instanceId: remoteInstanceId }),
      }),
    ).toBe(REMOTE_OPENCODE_BROWSER_NOTICE);
    expect(
      getRemoteOpenCodeBrowserNotice({
        settings: remoteSettings,
        thread: thread({ instanceId: localInstanceId }),
      }),
    ).toBeNull();
  });

  it("stays hidden when access is disabled, OpenCode is local, or the provider differs", () => {
    expect(
      getRemoteOpenCodeBrowserNotice({
        settings: settings({
          browserAgentAccessEnabled: false,
          providers: {
            ...DEFAULT_UNIFIED_SETTINGS.providers,
            opencode: {
              ...DEFAULT_UNIFIED_SETTINGS.providers.opencode,
              serverUrl: "https://opencode.example.test",
            },
          },
        }),
        thread: thread(),
      }),
    ).toBeNull();
    expect(getRemoteOpenCodeBrowserNotice({ settings: settings(), thread: thread() })).toBeNull();
    expect(
      getRemoteOpenCodeBrowserNotice({
        settings: settings({
          providers: {
            ...DEFAULT_UNIFIED_SETTINGS.providers,
            opencode: {
              ...DEFAULT_UNIFIED_SETTINGS.providers.opencode,
              serverUrl: "https://opencode.example.test",
            },
          },
        }),
        thread: thread({ driver: CODEX, instanceId: "codex" }),
      }),
    ).toBeNull();
  });
});
