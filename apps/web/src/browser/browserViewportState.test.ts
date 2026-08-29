import { ThreadId, type BrowserViewportEvent } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  browserUnavailableDetails,
  browserTabLabel,
  initialBrowserViewportState,
  reduceBrowserViewportState,
} from "./browserViewportState";

const THREAD_ID = ThreadId.make("thread-browser-state");

const tabsEvent = {
  _tag: "Tabs",
  threadId: THREAD_ID,
  tabs: [
    {
      targetId: "target-1",
      title: "Example",
      url: "https://example.com/",
      active: true,
    },
  ],
} satisfies BrowserViewportEvent;

const runningEvent = {
  _tag: "Status",
  threadId: THREAD_ID,
  status: "running",
} satisfies BrowserViewportEvent;

const frameEvent = {
  _tag: "Frame",
  threadId: THREAD_ID,
  targetId: "target-1",
  dataBase64: "frame-data",
  width: 800,
  height: 600,
  seq: 1,
  capturedAt: "2026-08-25T00:00:00.000Z" as never,
} satisfies BrowserViewportEvent;

describe("reduceBrowserViewportState", () => {
  it("converges when status, tabs, and frames arrive in any order", () => {
    const initial = initialBrowserViewportState(THREAD_ID);
    const tabsFirst = [tabsEvent, frameEvent, runningEvent].reduce(
      (state, event) => reduceBrowserViewportState(state, { type: "event", event }),
      initial,
    );
    const statusFirst = [runningEvent, frameEvent, tabsEvent].reduce(
      (state, event) => reduceBrowserViewportState(state, { type: "event", event }),
      initial,
    );

    expect(tabsFirst).toEqual(statusFirst);
    expect(tabsFirst).toMatchObject({
      status: "running",
      tabs: tabsEvent.tabs,
      authorization: "granted",
    });
  });

  it("preserves independently received data and reconciles optimistic tab state", () => {
    const withStatus = reduceBrowserViewportState(initialBrowserViewportState(THREAD_ID), {
      type: "event",
      event: runningEvent,
    });
    const optimistic = reduceBrowserViewportState(withStatus, {
      type: "activeTabRequested",
      targetId: "target-2",
    });
    const reconciled = reduceBrowserViewportState(optimistic, {
      type: "event",
      event: tabsEvent,
    });

    expect(reconciled.status).toBe("running");
    expect(reconciled.optimisticActiveTargetId).toBeNull();
    expect(reconciled.tabs).toEqual(tabsEvent.tabs);
  });

  it("ignores late events from a previous thread", () => {
    const currentThreadId = ThreadId.make("thread-current");
    const state = initialBrowserViewportState(currentThreadId);

    expect(reduceBrowserViewportState(state, { type: "event", event: runningEvent })).toBe(state);
  });

  it("recognizes an agent-triggered missing-browser snapshot without offering too early", () => {
    const stopped = reduceBrowserViewportState(initialBrowserViewportState(THREAD_ID), {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_ID,
        status: "stopped",
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
        installState: { status: "not-installed", variant: "headless-shell" },
      },
    });
    expect(stopped.unavailableReason).toBeNull();

    const unavailable = reduceBrowserViewportState(stopped, {
      type: "snapshot",
      snapshot: {
        threadId: THREAD_ID,
        status: "stopped",
        tabs: [],
        executable: null,
        viewport: { width: 800, height: 600 },
        installState: { status: "not-installed", variant: "headless-shell" },
        error: "No usable Chromium installation was found. Attempts: channel:chrome",
      },
    });
    expect(unavailable.unavailableReason).toBe("not-installed");
  });

  it("tracks streamed install progress without placing viewport frames in state", () => {
    const state = reduceBrowserViewportState(initialBrowserViewportState(THREAD_ID), {
      type: "installProgress",
      variant: "headless-shell",
      progress: {
        phase: "downloading",
        percent: 42,
        downloadedBytes: 42,
        totalBytes: 100,
      },
    });
    expect(state.installState).toEqual({
      status: "installing",
      variant: "headless-shell",
      progress: {
        phase: "downloading",
        percent: 42,
        downloadedBytes: 42,
        totalBytes: 100,
      },
    });
    expect(state).not.toHaveProperty("frame");
  });
});

describe("browserUnavailableDetails", () => {
  it("finds typed dependency failures through RPC wrapper causes", () => {
    expect(
      browserUnavailableDetails({
        cause: {
          _tag: "BrowserUnavailable",
          reason: "missing-libraries",
          message: "Chromium needs dependencies",
          dependencyCommand: "sudo apt-get install libcups2",
        },
      }),
    ).toEqual({
      reason: "missing-libraries",
      message: "Chromium needs dependencies",
      dependencyCommand: "sudo apt-get install libcups2",
    });
  });
});

describe("browserTabLabel", () => {
  it("labels a genuine blank page as a new tab", () => {
    expect(
      browserTabLabel({ targetId: "blank", title: "", url: "about:blank", active: true }),
    ).toBe("New tab");
  });
});
