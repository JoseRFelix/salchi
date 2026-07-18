import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerSupportsActiveTurnSteering } from "./providerTurnCapabilities";

describe("providerSupportsActiveTurnSteering", () => {
  it.each(["codex", "claudeAgent", "opencode"])("enables %s", (driver) => {
    expect(providerSupportsActiveTurnSteering(ProviderDriverKind.make(driver))).toBe(true);
  });

  it.each(["cursor", "grok"])("keeps %s disabled", (driver) => {
    expect(providerSupportsActiveTurnSteering(ProviderDriverKind.make(driver))).toBe(false);
  });
});
