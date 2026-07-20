import type { ProviderInstanceId, ServerProvider } from "@salchi/contracts";

export const PROVIDER_UPDATE_LAUNCH_TIMEOUT_MS = 10_000;

type ProviderUpdateStateSnapshot = Pick<ServerProvider, "instanceId" | "updateState">;

export function hasProviderUpdateStateForInstance(
  providers: ReadonlyArray<ProviderUpdateStateSnapshot>,
  instanceId: ProviderInstanceId,
): boolean {
  return providers.some(
    (provider) => provider.instanceId === instanceId && provider.updateState !== undefined,
  );
}

export function haveAllProviderUpdateStatesForTargets(
  providers: ReadonlyArray<ProviderUpdateStateSnapshot>,
  providerInstanceIds: ReadonlySet<ProviderInstanceId>,
): boolean {
  for (const providerInstanceId of providerInstanceIds) {
    if (!hasProviderUpdateStateForInstance(providers, providerInstanceId)) {
      return false;
    }
  }
  return true;
}
