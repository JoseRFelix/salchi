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

type RegisteredContentKind = "browser" | "plan";

const registrations: Record<RegisteredContentKind, RightPanelContentRegistration> = {
  browser: EMPTY_REGISTRATION,
  plan: EMPTY_REGISTRATION,
};
const listeners = new Set<() => void>();

function publishRegistration(
  kind: RegisteredContentKind,
  registration: RightPanelContentRegistration,
): void {
  if (registrations[kind] === registration) {
    return;
  }
  registrations[kind] = registration;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPlanSnapshot(): RightPanelContentRegistration {
  return registrations.plan;
}

function getBrowserSnapshot(): RightPanelContentRegistration {
  return registrations.browser;
}

export function usePlanRightPanelContent(): RightPanelContentRegistration {
  return useSyncExternalStore(subscribe, getPlanSnapshot, () => EMPTY_REGISTRATION);
}

export function useBrowserRightPanelContent(): RightPanelContentRegistration {
  return useSyncExternalStore(subscribe, getBrowserSnapshot, () => EMPTY_REGISTRATION);
}

export function useRegisterPlanRightPanelContent(
  registration: RightPanelContentRegistration,
): void {
  useLayoutEffect(() => {
    publishRegistration("plan", registration);
    return () => {
      if (registrations.plan === registration) {
        publishRegistration("plan", EMPTY_REGISTRATION);
      }
    };
  }, [registration]);
}

export function useRegisterBrowserRightPanelContent(
  registration: RightPanelContentRegistration,
): void {
  useLayoutEffect(() => {
    publishRegistration("browser", registration);
    return () => {
      if (registrations.browser === registration) {
        publishRegistration("browser", EMPTY_REGISTRATION);
      }
    };
  }, [registration]);
}

export function __resetRightPanelContentRegistryForTests(): void {
  publishRegistration("browser", EMPTY_REGISTRATION);
  publishRegistration("plan", EMPTY_REGISTRATION);
}
