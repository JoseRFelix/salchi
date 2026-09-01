import { describe, expect, it, vi } from "vitest";

import { createLatestFrameRenderer, type AnimationFrameScheduler } from "./latestFrameRenderer";

interface TestFrame {
  readonly seq: number;
}

interface TestDecodedFrame {
  readonly seq: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const scheduler: AnimationFrameScheduler = {
    requestAnimationFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      callbacks.delete(handle);
    },
  };

  return {
    scheduler,
    flush: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0);
    },
    pendingCount: () => callbacks.size,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createLatestFrameRenderer", () => {
  it("replaces stale pending frames instead of queueing them", async () => {
    const scheduler = createScheduler();
    const decodes = new Map<number, ReturnType<typeof deferred<TestDecodedFrame>>>();
    const decode = vi.fn((frame: TestFrame) => {
      const result = deferred<TestDecodedFrame>();
      decodes.set(frame.seq, result);
      return result.promise;
    });
    const render = vi.fn();
    const disposeDecoded = vi.fn();
    const renderer = createLatestFrameRenderer({
      decode,
      render,
      disposeDecoded,
      scheduler: scheduler.scheduler,
    });

    renderer.push({ seq: 1 });
    renderer.push({ seq: 2 });
    renderer.push({ seq: 3 });
    expect(decode.mock.calls.map(([frame]) => frame.seq)).toEqual([1]);

    decodes.get(1)!.resolve({ seq: 1 });
    await flushPromises();

    expect(disposeDecoded).toHaveBeenCalledWith({ seq: 1 });
    expect(decode.mock.calls.map(([frame]) => frame.seq)).toEqual([1, 3]);
    expect(decode.mock.calls.some(([frame]) => frame.seq === 2)).toBe(false);

    decodes.get(3)!.resolve({ seq: 3 });
    await flushPromises();
    expect(scheduler.pendingCount()).toBe(1);
    expect(render).not.toHaveBeenCalled();

    scheduler.flush();
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith({ seq: 3 }, { seq: 3 });

    renderer.dispose();
    expect(disposeDecoded).toHaveBeenCalledWith({ seq: 3 });
  });

  it("closes a decode that resolves after disposal and never renders it", async () => {
    const scheduler = createScheduler();
    const pendingDecode = deferred<TestDecodedFrame>();
    const disposeDecoded = vi.fn();
    const render = vi.fn();
    const renderer = createLatestFrameRenderer<TestFrame, TestDecodedFrame>({
      decode: () => pendingDecode.promise,
      render,
      disposeDecoded,
      scheduler: scheduler.scheduler,
    });

    renderer.push({ seq: 1 });
    renderer.dispose();
    pendingDecode.resolve({ seq: 1 });
    await flushPromises();
    scheduler.flush();

    expect(disposeDecoded).toHaveBeenCalledWith({ seq: 1 });
    expect(render).not.toHaveBeenCalled();
  });
});
