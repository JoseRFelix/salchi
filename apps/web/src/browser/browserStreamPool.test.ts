import { describe, expect, it, vi } from "vitest";
import { EnvironmentId, ThreadId } from "@salchi/contracts";

import type {
  BrowserStreamConnection,
  BrowserStreamConnectionOptions,
} from "./browserStreamConnection";
import { createBrowserStreamPool } from "./browserStreamPool";

describe("browser stream pool", () => {
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("thread-1");

  it("shares one raw connection and closes it after the final logical subscriber", () => {
    const connections: BrowserStreamConnectionOptions[] = [];
    const dispose = vi.fn();
    const pool = createBrowserStreamPool((options) => {
      connections.push(options);
      return { dispose, sendInput: () => true } satisfies BrowserStreamConnection;
    });

    const firstFrames = vi.fn();
    const secondFrames = vi.fn();
    const first = pool.acquire({
      environmentId,
      threadId,
      onFrame: firstFrames,
    });
    const second = pool.acquire({
      environmentId,
      threadId,
      onFrame: secondFrames,
    });

    expect(connections).toHaveLength(1);
    connections[0]?.onFrame({
      targetId: "tab-1",
      seq: 1,
      width: 800,
      height: 600,
      jpegBytes: new Uint8Array([0xff, 0xd8, 0xff]),
      receivedAt: 10,
    });
    expect(firstFrames).toHaveBeenCalledOnce();
    expect(secondFrames).toHaveBeenCalledOnce();

    first.dispose();
    expect(dispose).not.toHaveBeenCalled();
    second.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("replays the latest activity and frame without opening a second socket", () => {
    let options: BrowserStreamConnectionOptions | undefined;
    const pool = createBrowserStreamPool((nextOptions) => {
      options = nextOptions;
      return { dispose: vi.fn(), sendInput: () => true };
    });
    const first = pool.acquire({ environmentId, threadId });
    options?.onEvent({ threadId, agentActive: true });
    options?.onFrame({
      targetId: "tab-1",
      seq: 2,
      width: 800,
      height: 600,
      jpegBytes: new Uint8Array([0xff, 0xd8, 0xff]),
      receivedAt: 20,
    });

    const onEvent = vi.fn();
    const onFrame = vi.fn();
    const second = pool.acquire({
      environmentId,
      threadId,
      onEvent,
      onFrame,
    });

    expect(onEvent).toHaveBeenCalledWith({ threadId, agentActive: true });
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ seq: 2 }));
    first.dispose();
    second.dispose();
  });
});
