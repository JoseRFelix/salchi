import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __registerRightPanelForTests,
  __resetRightPanelGestureStateForTests,
  markRightPanelUsed,
  openLastUsedRightPanel,
  openRightPanel,
} from "./rightPanelGesture";

describe("rightPanelGesture", () => {
  afterEach(() => {
    __resetRightPanelGestureStateForTests();
  });

  it("opens the file panel on the initial right-panel open gesture", () => {
    const openFile = vi.fn();
    const openDiff = vi.fn();

    __registerRightPanelForTests("file", { open: openFile });
    __registerRightPanelForTests("diff", { open: openDiff });

    expect(openLastUsedRightPanel()).toBe(true);
    expect(openFile).toHaveBeenCalledOnce();
    expect(openDiff).not.toHaveBeenCalled();
  });

  it("reopens diff after explicit diff use", () => {
    const openFile = vi.fn();
    const openDiff = vi.fn();

    __registerRightPanelForTests("file", { open: openFile });
    __registerRightPanelForTests("diff", { open: openDiff });
    markRightPanelUsed("diff");

    expect(openLastUsedRightPanel()).toBe(true);
    expect(openDiff).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("keeps workspace stack registrations open while closing non-stack panels", () => {
    const closeFile = vi.fn();
    const closeDiff = vi.fn();
    const closePlan = vi.fn();
    const openSourceControl = vi.fn();

    __registerRightPanelForTests("file", { close: closeFile, open: vi.fn() });
    __registerRightPanelForTests("diff", { close: closeDiff, open: vi.fn() });
    __registerRightPanelForTests("plan", { close: closePlan, open: vi.fn() });
    __registerRightPanelForTests("source-control", { open: openSourceControl });

    expect(openRightPanel("source-control")).toBe(true);
    expect(openSourceControl).toHaveBeenCalledOnce();
    expect(closeFile).not.toHaveBeenCalled();
    expect(closeDiff).not.toHaveBeenCalled();
    expect(closePlan).toHaveBeenCalledOnce();
  });

  it("closes a shared workspace stack only once when opening another panel", () => {
    const closeWorkspaceStack = vi.fn();

    __registerRightPanelForTests("diff", { close: closeWorkspaceStack, open: vi.fn() });
    __registerRightPanelForTests("file", { close: closeWorkspaceStack, open: vi.fn() });
    __registerRightPanelForTests("source-control", {
      close: closeWorkspaceStack,
      open: vi.fn(),
    });
    __registerRightPanelForTests("plan", { open: vi.fn() });

    expect(openRightPanel("plan")).toBe(true);
    expect(closeWorkspaceStack).toHaveBeenCalledOnce();
  });
});
