import { scopedThreadKey } from "@salchi/client-runtime";
import type { ScopedThreadRef } from "@salchi/contracts";
import { create } from "zustand";
import type { LocalDispatchSnapshot } from "./components/ChatView.logic";

type LocalDispatchUpdater = (current: LocalDispatchSnapshot | null) => LocalDispatchSnapshot | null;

interface LocalDispatchStore {
  localDispatchByThreadKey: Record<string, LocalDispatchSnapshot>;
  updateLocalDispatchByThreadKey: (threadKey: string, updater: LocalDispatchUpdater) => void;
  clearLocalDispatchByThreadKey: (threadKey: string) => void;
  clearLocalDispatch: (threadRef: ScopedThreadRef) => void;
}

export const useLocalDispatchStore = create<LocalDispatchStore>((set) => ({
  localDispatchByThreadKey: {},

  updateLocalDispatchByThreadKey: (threadKey, updater) => {
    set((state) => {
      const current = state.localDispatchByThreadKey[threadKey] ?? null;
      const next = updater(current);
      if (next === current) {
        return state;
      }

      const nextByThreadKey = { ...state.localDispatchByThreadKey };
      if (next === null) {
        delete nextByThreadKey[threadKey];
      } else {
        nextByThreadKey[threadKey] = next;
      }
      return { localDispatchByThreadKey: nextByThreadKey };
    });
  },

  clearLocalDispatchByThreadKey: (threadKey) => {
    set((state) => {
      if (!(threadKey in state.localDispatchByThreadKey)) {
        return state;
      }
      const nextByThreadKey = { ...state.localDispatchByThreadKey };
      delete nextByThreadKey[threadKey];
      return { localDispatchByThreadKey: nextByThreadKey };
    });
  },

  clearLocalDispatch: (threadRef) => {
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      if (!(threadKey in state.localDispatchByThreadKey)) {
        return state;
      }
      const nextByThreadKey = { ...state.localDispatchByThreadKey };
      delete nextByThreadKey[threadKey];
      return { localDispatchByThreadKey: nextByThreadKey };
    });
  },
}));
