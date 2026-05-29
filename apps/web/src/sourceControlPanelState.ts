import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { markRightPanelUsed } from "./rightPanelGesture";

interface SourceControlPanelState {
  open: boolean;
  /**
   * Draft commit message, persisted across panel open/close so the user does
   * not lose what they typed when they hop between panels.
   */
  commitMessage: string;
  setOpen: (open: boolean) => void;
  setCommitMessage: (commitMessage: string) => void;
}

const useSourceControlPanelStore = create<SourceControlPanelState>((set) => ({
  open: false,
  commitMessage: "",
  setOpen: (open) => set({ open }),
  setCommitMessage: (commitMessage) => set({ commitMessage }),
}));

export function openSourceControlPanel(): void {
  markRightPanelUsed("source-control");
  useSourceControlPanelStore.getState().setOpen(true);
}

export function closeSourceControlPanel(): void {
  useSourceControlPanelStore.getState().setOpen(false);
}

export function useSourceControlPanelState() {
  return useSourceControlPanelStore(
    useShallow((state) => ({
      open: state.open,
      commitMessage: state.commitMessage,
    })),
  );
}

export function useSetSourceControlCommitMessage() {
  return useSourceControlPanelStore((state) => state.setCommitMessage);
}
