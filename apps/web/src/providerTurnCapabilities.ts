import type { ProviderDriverKind } from "@t3tools/contracts";

const ACTIVE_TURN_STEERING_DRIVERS = new Set(["codex", "claudeAgent", "opencode"]);

export function providerSupportsActiveTurnSteering(
  driver: ProviderDriverKind | null | undefined,
): boolean {
  return driver !== null && driver !== undefined && ACTIVE_TURN_STEERING_DRIVERS.has(driver);
}
