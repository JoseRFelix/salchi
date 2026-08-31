import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  CURRENT_CLIENT_SETTINGS_VERSION,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings defaults", () => {
  it("keeps the task and plan sidebar closed until the user opens it", () => {
    expect(DEFAULT_CLIENT_SETTINGS.clientSettingsVersion).toBe(CURRENT_CLIENT_SETTINGS_VERSION);
    expect(DEFAULT_CLIENT_SETTINGS.autoOpenPlanSidebar).toBe(false);
    const legacySettings = decodeClientSettings({});
    expect(legacySettings.clientSettingsVersion).toBe(0);
    expect(legacySettings.autoOpenPlanSidebar).toBe(false);
  });

  it("defaults inbox lifecycle automation to t3code's policy", () => {
    expect(DEFAULT_CLIENT_SETTINGS.sidebarAutoSettleAfterDays).toBe(3);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarAutoSettleOnMerge).toBe(true);
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadUnpin).toBe(false);

    const decoded = decodeClientSettings({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnMerge: false,
      confirmThreadUnpin: true,
    });
    expect(decoded.sidebarAutoSettleAfterDays).toBeNull();
    expect(decoded.sidebarAutoSettleOnMerge).toBe(false);
    expect(decoded.confirmThreadUnpin).toBe(true);
  });

  it("accepts only whole-day auto-settle windows from 1 through 90", () => {
    for (const value of [1, 3, 90]) {
      expect(
        decodeClientSettings({ sidebarAutoSettleAfterDays: value }).sidebarAutoSettleAfterDays,
      ).toBe(value);
    }
    for (const value of [0, 3.5, 91]) {
      expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    }
  });

  it("defaults to Project view and preserves an explicit Inbox choice", () => {
    expect(DEFAULT_CLIENT_SETTINGS.sidebarNavigationMode).toBe("project");
    expect(DEFAULT_CLIENT_SETTINGS.hasSeenInboxIntroduction).toBe(false);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarProjectSortOrder).toBe("updated_at");
    expect(DEFAULT_CLIENT_SETTINGS.sidebarThreadPreviewCount).toBe(6);

    const decoded = decodeClientSettings({
      hasSeenInboxIntroduction: true,
      sidebarNavigationMode: "inbox",
      sidebarProjectSortOrder: "manual",
      sidebarThreadPreviewCount: 8,
    });
    expect(decoded.sidebarNavigationMode).toBe("inbox");
    expect(decoded.hasSeenInboxIntroduction).toBe(true);
    expect(decoded.sidebarProjectSortOrder).toBe("manual");
    expect(decoded.sidebarThreadPreviewCount).toBe(8);

    expect(() => decodeClientSettings({ sidebarNavigationMode: "global" })).toThrow();
    expect(() => decodeClientSettings({ sidebarThreadPreviewCount: 0 })).toThrow();
    expect(() => decodeClientSettings({ sidebarThreadPreviewCount: 16 })).toThrow();
  });

  it("accepts every project order and rejects unknown values", () => {
    for (const sidebarProjectSortOrder of ["updated_at", "created_at", "manual"] as const) {
      expect(decodeClientSettings({ sidebarProjectSortOrder }).sidebarProjectSortOrder).toBe(
        sidebarProjectSortOrder,
      );
    }
    expect(() => decodeClientSettings({ sidebarProjectSortOrder: "alphabetical" })).toThrow();
  });
});

describe("ServerSettings.transcriptionModel", () => {
  it("defaults legacy settings to the small English model", () => {
    expect(decodeServerSettings({}).transcriptionModel).toBe("small.en");
  });

  it("accepts supported model sizes and rejects unknown models", () => {
    expect(decodeServerSettings({ transcriptionModel: "small.en" }).transcriptionModel).toBe(
      "small.en",
    );
    expect(decodeServerSettingsPatch({ transcriptionModel: "tiny.en" }).transcriptionModel).toBe(
      "tiny.en",
    );
    expect(() => decodeServerSettingsPatch({ transcriptionModel: "large-v3" })).toThrow();
  });
});

describe("ServerSettings.textGenerationModelSelection", () => {
  it("defaults thread and Git text generation to GPT-5.6 Luna", () => {
    expect(decodeServerSettings({}).textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
  });
});
