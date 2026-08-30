import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { CommandDialog } from "./ui/command";

const LazyCommandPaletteDialog = lazy(async () => {
  const module = await import("./CommandPalette");
  return { default: module.CommandPaletteDialog };
});

export function CommandPaletteBoundary({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const keybindings = useServerKeybindings();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    return () => {
      setOpen(false);
    };
  }, [setOpen]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={open} onOpenChange={setOpen}>
        {children}
        {open ? (
          <Suspense fallback={null}>
            <LazyCommandPaletteDialog />
          </Suspense>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
