import {
  attachEnvironmentDescriptor,
  createKnownEnvironment,
  type KnownEnvironment,
} from "@salchi/client-runtime";
import {
  ExecutionEnvironmentDescriptor as ExecutionEnvironmentDescriptorSchema,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@salchi/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { BootstrapHttpError, retryTransientBootstrap } from "./auth";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from "./target";

const SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/salchi/environment";
const PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY = "salchi:primary-environment-descriptor:v1";
const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptorSchema);

interface PrimaryEnvironmentBootstrapState {
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly setDescriptor: (descriptor: ExecutionEnvironmentDescriptor | null) => void;
  readonly reset: () => void;
}

const usePrimaryEnvironmentBootstrapStore = create<PrimaryEnvironmentBootstrapState>()((set) => ({
  descriptor: null,
  setDescriptor: (descriptor) => set({ descriptor }),
  reset: () => set({ descriptor: null }),
}));

let primaryEnvironmentDescriptorPromise: Promise<ExecutionEnvironmentDescriptor> | null = null;

function browserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function primaryEnvironmentTargetKey(): string | null {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    return null;
  }

  return `${primaryTarget.source}:${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
}

function readPersistedPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  const targetKey = primaryEnvironmentTargetKey();
  const resolvedStorage = browserStorage();
  if (!targetKey || !resolvedStorage) {
    return null;
  }

  try {
    const raw = resolvedStorage.getItem(PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      targetKey?: unknown;
      descriptor?: unknown;
    };
    if (parsed.targetKey !== targetKey) {
      return null;
    }
    return decodeEnvironmentDescriptor(parsed.descriptor);
  } catch {
    return null;
  }
}

function writePersistedPrimaryEnvironmentDescriptor(
  descriptor: ExecutionEnvironmentDescriptor | null,
): void {
  const resolvedStorage = browserStorage();
  if (!resolvedStorage) {
    return;
  }

  if (!descriptor) {
    try {
      resolvedStorage.removeItem(PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY);
    } catch {
      // Ignore storage failures; the network bootstrap path remains authoritative.
    }
    return;
  }

  const targetKey = primaryEnvironmentTargetKey();
  if (!targetKey) {
    return;
  }

  try {
    resolvedStorage.setItem(
      PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY,
      JSON.stringify({
        targetKey,
        descriptor,
      }),
    );
  } catch {
    // Ignore quota/storage errors; this cache only optimizes startup.
  }
}

function createPrimaryKnownEnvironment(input: {
  readonly source: KnownEnvironment["source"];
  readonly target: KnownEnvironment["target"];
}): KnownEnvironment | null {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (!descriptor) {
    return null;
  }

  return attachEnvironmentDescriptor(
    createKnownEnvironment({
      id: descriptor.environmentId,
      label: descriptor.label,
      source: input.source,
      target: input.target,
    }),
    descriptor,
  );
}

async function fetchPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  return retryTransientBootstrap(async () => {
    const response = await fetch(
      resolvePrimaryEnvironmentHttpUrl(SERVER_ENVIRONMENT_DESCRIPTOR_PATH),
    );
    if (!response.ok) {
      throw new BootstrapHttpError({
        message: `Failed to load server environment descriptor (${response.status}).`,
        status: response.status,
      });
    }

    const descriptor = (await response.json()) as ExecutionEnvironmentDescriptor;
    writePrimaryEnvironmentDescriptor(descriptor);
    return descriptor;
  });
}

export function readPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  const descriptor = usePrimaryEnvironmentBootstrapStore.getState().descriptor;
  if (descriptor) {
    return descriptor;
  }

  const persistedDescriptor = readPersistedPrimaryEnvironmentDescriptor();
  if (!persistedDescriptor) {
    return null;
  }

  usePrimaryEnvironmentBootstrapStore.getState().setDescriptor(persistedDescriptor);
  return persistedDescriptor;
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return usePrimaryEnvironmentBootstrapStore((state) => state.descriptor?.environmentId ?? null);
}

export function writePrimaryEnvironmentDescriptor(
  descriptor: ExecutionEnvironmentDescriptor | null,
): void {
  writePersistedPrimaryEnvironmentDescriptor(descriptor);
  usePrimaryEnvironmentBootstrapStore.getState().setDescriptor(descriptor);
}

export function getPrimaryKnownEnvironment(): KnownEnvironment | null {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    return null;
  }

  return createPrimaryKnownEnvironment({
    source: primaryTarget.source,
    target: primaryTarget.target,
  });
}

export function resolveInitialPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (descriptor) {
    return Promise.resolve(descriptor);
  }

  if (primaryEnvironmentDescriptorPromise) {
    return primaryEnvironmentDescriptorPromise;
  }

  const nextPromise = fetchPrimaryEnvironmentDescriptor();
  primaryEnvironmentDescriptorPromise = nextPromise;
  return nextPromise.finally(() => {
    if (primaryEnvironmentDescriptorPromise === nextPromise) {
      primaryEnvironmentDescriptorPromise = null;
    }
  });
}

export function __resetPrimaryEnvironmentBootstrapForTests(): void {
  primaryEnvironmentDescriptorPromise = null;
  writePersistedPrimaryEnvironmentDescriptor(null);
  usePrimaryEnvironmentBootstrapStore.getState().reset();
}

export const resetPrimaryEnvironmentDescriptorForTests = __resetPrimaryEnvironmentBootstrapForTests;

export const __resetPrimaryEnvironmentDescriptorBootstrapForTests =
  __resetPrimaryEnvironmentBootstrapForTests;
