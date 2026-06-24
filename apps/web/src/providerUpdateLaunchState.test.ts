import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  hasProviderUpdateStateForInstance,
  haveAllProviderUpdateStatesForTargets,
} from "./providerUpdateLaunchState";

function provider(input: {
  readonly instanceId: string;
  readonly updateState?: ServerProvider["updateState"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.instanceId),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.updateState ? { updateState: input.updateState } : {}),
  };
}

const runningUpdateState = {
  status: "running",
  startedAt: "2026-06-24T00:00:01.000Z",
  finishedAt: null,
  message: "Updating provider.",
  output: null,
} satisfies ServerProvider["updateState"];

describe("provider update launch state", () => {
  it("detects streamed update state for one provider instance", () => {
    const providers = [provider({ instanceId: "codex", updateState: runningUpdateState })];

    expect(hasProviderUpdateStateForInstance(providers, ProviderInstanceId.make("codex"))).toBe(
      true,
    );
    expect(hasProviderUpdateStateForInstance(providers, ProviderInstanceId.make("claude"))).toBe(
      false,
    );
  });

  it("requires every targeted provider to stream update state before confirming a batch", () => {
    const providers = [
      provider({ instanceId: "codex", updateState: runningUpdateState }),
      provider({ instanceId: "claude" }),
    ];
    const targets = new Set([ProviderInstanceId.make("codex"), ProviderInstanceId.make("claude")]);

    expect(haveAllProviderUpdateStatesForTargets(providers, targets)).toBe(false);

    expect(
      haveAllProviderUpdateStatesForTargets(
        [provider({ instanceId: "codex", updateState: runningUpdateState })],
        new Set([ProviderInstanceId.make("codex")]),
      ),
    ).toBe(true);
  });
});
