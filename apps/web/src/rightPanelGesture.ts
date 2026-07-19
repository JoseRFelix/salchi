import { useEffect } from "react";

export type RightPanelKind = "diff" | "file" | "plan" | "source-control";

export interface RightPanelRegistration {
  readonly close?: () => void;
  readonly open: () => void;
}

const registeredPanels = new Map<RightPanelKind, RightPanelRegistration>();
let lastUsedRightPanel: RightPanelKind = "file";
const WORKSPACE_PANEL_KINDS = new Set<RightPanelKind>(["diff", "file", "source-control"]);

function shareWorkspacePanelStack(left: RightPanelKind, right: RightPanelKind): boolean {
  return WORKSPACE_PANEL_KINDS.has(left) && WORKSPACE_PANEL_KINDS.has(right);
}

export function markRightPanelUsed(kind: RightPanelKind): void {
  lastUsedRightPanel = kind;
}

export function openRightPanel(kind: RightPanelKind): boolean {
  const registration = registeredPanels.get(kind);
  if (!registration) {
    return false;
  }

  markRightPanelUsed(kind);
  const invokedCloseCallbacks = new Set<() => void>();
  for (const [registeredKind, registeredPanel] of registeredPanels) {
    const close = registeredPanel.close;
    if (
      registeredKind !== kind &&
      !shareWorkspacePanelStack(kind, registeredKind) &&
      close &&
      !invokedCloseCallbacks.has(close)
    ) {
      invokedCloseCallbacks.add(close);
      close();
    }
  }
  registration.open();
  return true;
}

export function openLastUsedRightPanel(): boolean {
  if (openRightPanel(lastUsedRightPanel)) {
    return true;
  }

  return openRightPanel("file") || openRightPanel("diff") || openRightPanel("plan");
}

export function useRegisterRightPanel({
  close,
  enabled = true,
  kind,
  open,
}: {
  readonly close?: () => void;
  readonly enabled?: boolean;
  readonly kind: RightPanelKind;
  readonly open: () => void;
}) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    registeredPanels.set(kind, close ? { close, open } : { open });
    return () => {
      const registration = registeredPanels.get(kind);
      if (registration?.open === open) {
        registeredPanels.delete(kind);
      }
    };
  }, [close, enabled, kind, open]);
}

export function __registerRightPanelForTests(
  kind: RightPanelKind,
  registration: RightPanelRegistration,
): () => void {
  registeredPanels.set(kind, registration);
  return () => {
    const currentRegistration = registeredPanels.get(kind);
    if (currentRegistration === registration) {
      registeredPanels.delete(kind);
    }
  };
}

export function __resetRightPanelGestureStateForTests(): void {
  registeredPanels.clear();
  lastUsedRightPanel = "file";
}
