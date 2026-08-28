import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type UnifiedSettings,
} from "@salchi/contracts";

import type { Thread } from "../types";

export const REMOTE_OPENCODE_BROWSER_NOTICE =
  "Agent browser control unavailable for remote OpenCode";

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const DEFAULT_OPENCODE_INSTANCE = defaultInstanceIdForDriver(OPENCODE_DRIVER);

function configuredServerUrl(config: unknown): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>).serverUrl;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Remote OpenCode owns its process and configuration, so Salchi cannot add
 * the per-session browser MCP registration used by locally spawned OpenCode.
 */
export function getRemoteOpenCodeBrowserNotice(input: {
  readonly settings: Pick<
    UnifiedSettings,
    "browserAgentAccessEnabled" | "providerInstances" | "providers"
  >;
  readonly thread: Pick<Thread, "modelSelection" | "session"> | null | undefined;
}): string | null {
  if (!input.settings.browserAgentAccessEnabled || input.thread == null) return null;

  const instanceId =
    input.thread.session?.providerInstanceId ?? input.thread.modelSelection.instanceId;
  const explicitInstance = input.settings.providerInstances[instanceId];
  const driver =
    input.thread.session?.provider ??
    explicitInstance?.driver ??
    (instanceId === DEFAULT_OPENCODE_INSTANCE ? OPENCODE_DRIVER : undefined);
  if (driver !== OPENCODE_DRIVER) return null;

  const serverUrl =
    explicitInstance === undefined
      ? instanceId === DEFAULT_OPENCODE_INSTANCE
        ? input.settings.providers.opencode.serverUrl.trim()
        : ""
      : configuredServerUrl(explicitInstance.config);
  return serverUrl.length > 0 ? REMOTE_OPENCODE_BROWSER_NOTICE : null;
}
