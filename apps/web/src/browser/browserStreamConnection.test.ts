import { EnvironmentId, ThreadId } from "@salchi/contracts";
import {
  decodeBrowserStreamInput,
  encodeBrowserStreamFrame,
  encodeBrowserStreamMeta,
} from "@salchi/shared/browserStreamProtocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserStreamAuthorizationError,
  createBrowserStreamConnection,
} from "./browserStreamConnection";

vi.mock("../environments/runtime", () => ({
  fetchEnvironmentHttp: vi.fn(),
  resolveEnvironmentHttpUrl: ({ pathname }: { readonly pathname: string }) =>
    `https://salchi.example.test${pathname}`,
}));

const environmentId = EnvironmentId.make("environment-stream-test");
const threadId = ThreadId.make("thread-stream-test");

class FakeVisibilityTarget {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Array<ArrayBufferView | ArrayBuffer | Blob | string> = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  });
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: Event) => void,
    _options?: AddEventListenerOptions,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receive(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.emit("message", { data: copy.buffer } as MessageEvent<ArrayBuffer>);
  }

  fail(): void {
    this.readyState = 3;
    this.emit("error");
  }

  private emit(type: string, event?: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event ?? new Event(type));
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createBrowserStreamConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a ticketed raw socket for META, raw JPEG frames, and INPUT", async () => {
    const sockets: FakeSocket[] = [];
    const events: unknown[] = [];
    const frames: unknown[] = [];
    let now = 42;
    const connection = createBrowserStreamConnection({
      environmentId,
      threadId,
      issueTicket: async () => "short-lived-ticket",
      createSocket: (url) => {
        expect(url).toBe(
          "wss://salchi.example.test/browser-stream/thread-stream-test?ticket=short-lived-ticket",
        );
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      visibilityTarget: new FakeVisibilityTarget(),
      onEvent: (event) => events.push(event),
      onFrame: (frame) => frames.push(frame),
      now: () => now,
    });
    await flushPromises();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(
      encodeBrowserStreamMeta({
        _tag: "Tabs",
        threadId,
        tabs: [
          {
            targetId: "target-1",
            title: "Example",
            url: "https://example.com",
            active: true,
          },
        ],
      }),
    );
    socket.receive(encodeBrowserStreamMeta({ threadId, agentActive: true }));
    now = 55;
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    socket.receive(
      encodeBrowserStreamFrame({ seq: 7, width: 800, height: 600, tabIndexHint: 0, jpegBytes }),
    );

    expect(events).toEqual([
      expect.objectContaining({ _tag: "Tabs" }),
      { threadId, agentActive: true },
    ]);
    expect(frames).toEqual([
      {
        targetId: "target-1",
        seq: 7,
        width: 800,
        height: 600,
        jpegBytes,
        receivedAt: 55,
      },
    ]);
    expect(
      connection.sendInput("target-1", {
        _tag: "PointerDown",
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
      }),
    ).toBe(true);
    expect(decodeBrowserStreamInput(socket.sent[0] as Uint8Array)).toEqual({
      targetId: "target-1",
      event: {
        _tag: "PointerDown",
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
      },
    });

    connection.dispose();
    expect(socket.close).toHaveBeenCalledWith(1000, "Browser panel hidden");
  });

  it("backs off after failure and reconnects immediately on visibility regain", async () => {
    const visibility = new FakeVisibilityTarget();
    const sockets: FakeSocket[] = [];
    const timers: Array<{ readonly callback: () => void; readonly delay: number }> = [];
    const connection = createBrowserStreamConnection({
      environmentId,
      threadId,
      issueTicket: async () => `ticket-${sockets.length.toString()}`,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      visibilityTarget: visibility,
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: vi.fn(),
      onEvent: vi.fn(),
      onFrame: vi.fn(),
    });
    await flushPromises();
    sockets[0]!.fail();
    expect(timers[0]?.delay).toBe(1_000);

    visibility.setVisibility("hidden");
    visibility.setVisibility("visible");
    await flushPromises();
    expect(sockets).toHaveLength(2);

    connection.dispose();
  });

  it("does not retry a ticket authorization failure", async () => {
    const denied = vi.fn();
    const timers: unknown[] = [];
    const connection = createBrowserStreamConnection({
      environmentId,
      threadId,
      issueTicket: async () => {
        throw new BrowserStreamAuthorizationError();
      },
      createSocket: () => new FakeSocket(),
      visibilityTarget: new FakeVisibilityTarget(),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return 1;
      },
      onAuthorizationDenied: denied,
      onEvent: vi.fn(),
      onFrame: vi.fn(),
    });
    await flushPromises();

    expect(denied).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(0);
    connection.dispose();
  });
});
