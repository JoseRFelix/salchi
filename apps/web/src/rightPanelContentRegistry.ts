import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

import type { DiffPanelMode } from "./components/DiffPanelShell";

export interface RightPanelContentRegistration {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly render: (mode: Extract<DiffPanelMode, "sheet" | "sidebar">) => ReactNode;
}

const EMPTY_REGISTRATION: RightPanelContentRegistration = {
  open: false,
  onClose: () => undefined,
  render: () => null,
};

let planRegistration = EMPTY_REGISTRATION;
const listeners = new Set<() => void>();

function publishPlanRegistration(registration: RightPanelContentRegistration): void {
  if (planRegistration === registration) {
    return;
  }
  planRegistration = registration;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RightPanelContentRegistration {
  return planRegistration;
}

export function usePlanRightPanelContent(): RightPanelContentRegistration {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_REGISTRATION);
}

export function useRegisterPlanRightPanelContent(
  registration: RightPanelContentRegistration,
): void {
  useLayoutEffect(() => {
    publishPlanRegistration(registration);
    return () => {
      if (planRegistration === registration) {
        publishPlanRegistration(EMPTY_REGISTRATION);
      }
    };
  }, [registration]);
}

export function __resetRightPanelContentRegistryForTests(): void {
  publishPlanRegistration(EMPTY_REGISTRATION);
}
