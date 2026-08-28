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

  it("opens the diff panel on the initial right-panel open gesture", () => {
    const openFile = vi.fn();
    const openDiff = vi.fn();

    __registerRightPanelForTests("file", { open: openFile });
    __registerRightPanelForTests("diff", { open: openDiff });

    expect(openLastUsedRightPanel()).toBe(true);
    expect(openDiff).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("reopens the file panel after explicit file use", () => {
    const openFile = vi.fn();
    const openDiff = vi.fn();

    __registerRightPanelForTests("file", { open: openFile });
    __registerRightPanelForTests("diff", { open: openDiff });
    markRightPanelUsed("file");

    expect(openLastUsedRightPanel()).toBe(true);
    expect(openFile).toHaveBeenCalledOnce();
    expect(openDiff).not.toHaveBeenCalled();
  });

  it("falls back from an unavailable remembered panel to diff before file", () => {
    const openFile = vi.fn();
    const openDiff = vi.fn();

    __registerRightPanelForTests("file", { open: openFile });
    __registerRightPanelForTests("diff", { open: openDiff });
    markRightPanelUsed("plan");

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

  it("treats the browser as an exclusive right-panel view", () => {
    const closeWorkspaceStack = vi.fn();
    const closePlan = vi.fn();
    const openBrowser = vi.fn();

    __registerRightPanelForTests("diff", { close: closeWorkspaceStack, open: vi.fn() });
    __registerRightPanelForTests("file", { close: closeWorkspaceStack, open: vi.fn() });
    __registerRightPanelForTests("source-control", {
      close: closeWorkspaceStack,
      open: vi.fn(),
    });
    __registerRightPanelForTests("plan", { close: closePlan, open: vi.fn() });
    __registerRightPanelForTests("browser", { open: openBrowser });

    expect(openRightPanel("browser")).toBe(true);
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(closeWorkspaceStack).toHaveBeenCalledOnce();
    expect(closePlan).toHaveBeenCalledOnce();
  });
});
