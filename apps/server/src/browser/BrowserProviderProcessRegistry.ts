import type { ThreadId } from "@salchi/contracts";

export interface BrowserProviderProcessRoot {
  readonly pid: number;
  readonly threadId: ThreadId;
}

interface RegisteredBrowserProviderProcess extends BrowserProviderProcessRoot {
  readonly registration: symbol;
}

const providerProcesses = new Map<number, RegisteredBrowserProviderProcess>();

/**
 * Registers the provider process that owns a thread. The returned disposer is
 * identity-safe so a late finalizer cannot remove a newer process that reused
 * the same PID.
 */
export function registerBrowserProviderProcess(input: BrowserProviderProcessRoot): () => void {
  if (!Number.isInteger(input.pid) || input.pid < 1) return () => {};
  const registration = Symbol("browser-provider-process");
  providerProcesses.set(input.pid, { ...input, registration });
  return () => {
    if (providerProcesses.get(input.pid)?.registration === registration) {
      providerProcesses.delete(input.pid);
    }
  };
}

export function listBrowserProviderProcesses(): ReadonlyArray<BrowserProviderProcessRoot> {
  return [...providerProcesses.values()].map(({ pid, threadId }) => ({ pid, threadId }));
}
