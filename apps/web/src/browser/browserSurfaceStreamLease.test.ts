import { EnvironmentId, ThreadId } from "@salchi/contracts";
import { describe, expect, it, vi } from "vitest";

import type { BrowserStreamConnectionOptions } from "./browserStreamConnection";
import type { BrowserStreamSubscriber } from "./browserStreamPool";
import {
  createBrowserSurfaceStreamLease,
  resolveBrowserViewportSurface,
} from "./browserSurfaceStreamLease";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread-a");

describe("browser surface stream lease", () => {
  it.each([
    [{ documentVisible: true, panelVisible: false, pipPhase: "hidden" as const }, null],
    [{ documentVisible: true, panelVisible: false, pipPhase: "visible" as const }, "pip"],
    [{ documentVisible: true, panelVisible: false, pipPhase: "lingering" as const }, "pip"],
    [{ documentVisible: true, panelVisible: false, pipPhase: "fading" as const }, "pip"],
    [{ documentVisible: true, panelVisible: true, pipPhase: "visible" as const }, "panel"],
    [{ documentVisible: false, panelVisible: true, pipPhase: "visible" as const }, null],
  ])("maps visibility %o to the one owning surface", (input, expected) => {
    expect(resolveBrowserViewportSurface(input)).toBe(expected);
  });

  it("acquires only while visible and transfers PiP-panel ownership without reacquiring", () => {
    const acquired: BrowserStreamSubscriber[] = [];
    const dispose = vi.fn();
    const lease = createBrowserSurfaceStreamLease({
      environmentId,
      threadId,
      acquire: (subscriber) => {
        acquired.push(subscriber);
        return { dispose, sendInput: () => true };
      },
    });

    expect(lease.snapshot()).toEqual({ connected: false, surface: null });
    lease.setSurface("pip");
    expect(acquired).toHaveLength(1);
    lease.setSurface("panel");
    expect(acquired).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    lease.setSurface("pip");
    expect(acquired).toHaveLength(1);
    lease.setSurface(null);
    expect(dispose).toHaveBeenCalledOnce();

    lease.setSurface("panel");
    expect(acquired).toHaveLength(2);
    lease.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("releases immediately on close, panel hide, thread-switch disposal, and PiP socket drop", () => {
    let subscriber: BrowserStreamSubscriber | undefined;
    const dispose = vi.fn();
    const onPipSocketDrop = vi.fn();
    const lease = createBrowserSurfaceStreamLease({
      environmentId,
      threadId,
      acquire: (nextSubscriber) => {
        subscriber = nextSubscriber;
        return { dispose, sendInput: () => true };
      },
      onPipSocketDrop,
    });

    lease.setSurface("pip");
    // Lingering uses the same `pip` surface; an abrupt socket close must still
    // release rather than letting the connection manager retry invisibly.
    subscriber?.onConnectionState?.("closed");
    expect(lease.snapshot()).toEqual({ connected: false, surface: null });
    expect(dispose).toHaveBeenCalledOnce();
    expect(onPipSocketDrop).toHaveBeenCalledOnce();

    lease.setSurface("panel");
    lease.setSurface(null);
    expect(dispose).toHaveBeenCalledTimes(2);

    lease.setSurface("pip");
    lease.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("routes frames only to the active surface and input only through the panel", () => {
    let subscriber: BrowserStreamConnectionOptions | BrowserStreamSubscriber | undefined;
    const sendInput = vi.fn(() => true);
    const panelFrame = vi.fn();
    const pipFrame = vi.fn();
    const lease = createBrowserSurfaceStreamLease({
      environmentId,
      threadId,
      acquire: (nextSubscriber) => {
        subscriber = nextSubscriber;
        return { dispose: vi.fn(), sendInput };
      },
    });
    lease.attach("panel", { onFrame: panelFrame });
    lease.attach("pip", { onFrame: pipFrame });

    lease.setSurface("pip");
    subscriber?.onFrame?.({
      targetId: "tab",
      seq: 1,
      width: 800,
      height: 600,
      jpegBytes: new Uint8Array([0xff, 0xd8]),
      receivedAt: 0,
    });
    expect(pipFrame).toHaveBeenCalledOnce();
    expect(panelFrame).not.toHaveBeenCalled();
    expect(lease.sendInput("tab", { _tag: "InsertText", text: "x" })).toBe(false);

    lease.setSurface("panel");
    expect(lease.sendInput("tab", { _tag: "InsertText", text: "x" })).toBe(true);
    expect(sendInput).toHaveBeenCalledOnce();
  });
});
