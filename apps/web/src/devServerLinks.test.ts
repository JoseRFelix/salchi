import { ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  canCurrentBrowserReachDevServerUrl,
  detectDevServerLinksFromTerminalEvents,
  detectDevServerLinksFromTerminalSnapshots,
  detectDevServerLinksFromText,
  mergeDevServerLinks,
  probeDevServerReachable,
  resolveDevServerReachabilityHostname,
  rewriteDevServerLinksForTailscale,
} from "./devServerLinks";
import type { TerminalEventEntry } from "./terminalStateStore";

const THREAD_ID = ThreadId.make("thread-dev-server-links");

function terminalOutputEntry(id: number, data: string): TerminalEventEntry {
  return {
    id,
    event: {
      type: "output",
      threadId: THREAD_ID,
      terminalId: "default",
      createdAt: "2026-06-17T00:00:00.000Z",
      data,
    },
  };
}

function terminalStartedEntry(id: number, history: string): TerminalEventEntry {
  const event: Extract<TerminalEvent, { type: "started" }> = {
    type: "started",
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-06-17T00:00:00.000Z",
    snapshot: {
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo/app",
      worktreePath: null,
      status: "running",
      pid: 123,
      history,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-06-17T00:00:00.000Z",
    },
  };
  return { id, event };
}

function terminalRestartedEntry(id: number, history: string): TerminalEventEntry {
  const event: Extract<TerminalEvent, { type: "restarted" }> = {
    type: "restarted",
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-06-17T00:00:00.000Z",
    snapshot: {
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo/app",
      worktreePath: null,
      status: "running",
      pid: 123,
      history,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-06-17T00:00:00.000Z",
    },
  };
  return { id, event };
}

function terminalActivityEntry(id: number, hasRunningSubprocess: boolean): TerminalEventEntry {
  return {
    id,
    event: {
      type: "activity",
      threadId: THREAD_ID,
      terminalId: "default",
      createdAt: "2026-06-17T00:00:00.000Z",
      hasRunningSubprocess,
    },
  };
}

function terminalClearedEntry(id: number): TerminalEventEntry {
  return {
    id,
    event: {
      type: "cleared",
      threadId: THREAD_ID,
      terminalId: "default",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
  };
}

describe("detectDevServerLinksFromText", () => {
  it("detects and labels Vite local and network dev server URLs", () => {
    expect(
      detectDevServerLinksFromText(
        [
          "VITE v7.0.0 ready in 140 ms",
          "Local:   http://localhost:5173/",
          "Network: http://192.168.1.44:5173/",
        ].join("\n"),
      ),
    ).toEqual([
      {
        url: "http://192.168.1.44:5173/",
        displayUrl: "http://192.168.1.44:5173",
        label: "Network 192.168.1.44:5173",
        host: "192.168.1.44:5173",
        port: "5173",
      },
      {
        url: "http://localhost:5173/",
        displayUrl: "http://localhost:5173",
        label: "Local localhost:5173",
        host: "localhost:5173",
        port: "5173",
      },
    ]);
  });

  it("detects standalone local dev server URLs", () => {
    expect(detectDevServerLinksFromText("http://127.0.0.1:3000")).toEqual([
      {
        url: "http://127.0.0.1:3000/",
        displayUrl: "http://127.0.0.1:3000",
        label: "Local 127.0.0.1:3000",
        host: "127.0.0.1:3000",
        port: "3000",
      },
    ]);
  });

  it("detects Vite URLs when ANSI styling splits the URL text", () => {
    expect(
      detectDevServerLinksFromText(
        [
          "\u001b[34m\u001b[1mVITE+\u001b[22m v0.1.24\u001b[39m",
          "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
          "  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: \u001b[36mhttp://100.82.150.82:\u001b[1m5173\u001b[22m/\u001b[39m",
        ].join("\n"),
      ),
    ).toEqual([
      {
        url: "http://100.82.150.82:5173/",
        displayUrl: "http://100.82.150.82:5173",
        label: "Network 100.82.150.82:5173",
        host: "100.82.150.82:5173",
        port: "5173",
      },
      {
        url: "http://localhost:5173/",
        displayUrl: "http://localhost:5173",
        label: "Local localhost:5173",
        host: "localhost:5173",
        port: "5173",
      },
    ]);
  });

  it("ignores external URLs and local service URLs without dev server context", () => {
    expect(
      detectDevServerLinksFromText(
        [
          "Docs: https://example.com:8443/docs",
          "Trace exporter http://localhost:4318/v1/traces",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("canCurrentBrowserReachDevServerUrl", () => {
  it("allows loopback dev server URLs only when the browser is also on loopback", () => {
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "localhost",
        url: "http://localhost:5173/",
      }),
    ).toBe(true);
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "127.0.0.1",
        url: "http://127.0.0.1:5173/",
      }),
    ).toBe(true);
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "100.82.150.82",
        url: "http://localhost:5173/",
      }),
    ).toBe(false);
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "192.168.1.50",
        url: "http://127.0.0.1:5173/",
      }),
    ).toBe(false);
  });

  it("allows a routable dev server URL when it matches the browser's own host", () => {
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "100.82.150.82",
        url: "http://100.82.150.82:5173/",
      }),
    ).toBe(true);
    // Same host, different port is still reachable.
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "100.82.150.82",
        url: "http://100.82.150.82:4173/",
      }),
    ).toBe(true);
  });

  it("allows Tailscale (100.x) dev servers from a MagicDNS or tailnet browser", () => {
    // The UI is served via a MagicDNS name; the dev server prints its raw 100.x
    // IP. The phone is on the tailnet, so the 100.x address is reachable.
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "macbook.tail1234.ts.net",
        url: "http://100.82.150.82:5173/",
      }),
    ).toBe(true);
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "100.99.1.2",
        url: "http://100.82.150.82:5173/",
      }),
    ).toBe(true);
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "100.99.1.2",
        url: "http://macbook.tail1234.ts.net:5173/",
      }),
    ).toBe(true);
  });

  it("rejects server-only interfaces the remote browser cannot reach", () => {
    // A phone on Tailscale cannot reach the server's Docker/LAN interfaces or
    // localhost even though the server can connect to them locally.
    for (const url of [
      "http://172.17.0.1:5173/",
      "http://172.20.0.1:5173/",
      "http://10.0.0.220:5173/",
      "http://localhost:5173/",
    ]) {
      expect(
        canCurrentBrowserReachDevServerUrl({ browserHostname: "macbook.tail1234.ts.net", url }),
      ).toBe(false);
    }
    // Different LAN address than the browser's own is also not confirmable.
    expect(
      canCurrentBrowserReachDevServerUrl({
        browserHostname: "192.168.1.50",
        url: "http://192.168.1.44:5173/",
      }),
    ).toBe(false);
  });
});

describe("rewriteDevServerLinksForTailscale", () => {
  it("replaces loopback dev server links with Tailscale IP and MagicDNS links", () => {
    const links = detectDevServerLinksFromText("Local: http://localhost:5173/app?debug=1");

    expect(
      rewriteDevServerLinksForTailscale(links, {
        environmentHttpBaseUrl: "https://macbook.tail1234.ts.net/",
        advertisedEndpoints: [
          {
            id: "tailscale-ip:http://100.82.150.82:3773",
            httpBaseUrl: "http://100.82.150.82:3773/",
          },
          {
            id: "tailscale-magicdns:https://macbook.tail1234.ts.net/",
            httpBaseUrl: "https://macbook.tail1234.ts.net/",
          },
        ],
      }),
    ).toEqual([
      {
        url: "http://100.82.150.82:5173/app?debug=1",
        displayUrl: "http://100.82.150.82:5173/app?debug=1",
        label: "Tailscale IP 100.82.150.82:5173",
        host: "100.82.150.82:5173",
        port: "5173",
      },
      {
        url: "http://macbook.tail1234.ts.net:5173/app?debug=1",
        displayUrl: "http://macbook.tail1234.ts.net:5173/app?debug=1",
        label: "MagicDNS macbook.tail1234.ts.net:5173",
        host: "macbook.tail1234.ts.net:5173",
        port: "5173",
      },
    ]);
  });

  it("keeps existing Tailscale links and does not duplicate rewritten localhost links", () => {
    const links = detectDevServerLinksFromText(
      ["Network: http://100.82.150.82:5173/", "Local: http://localhost:5173/"].join("\n"),
    );

    expect(
      rewriteDevServerLinksForTailscale(links, {
        browserHostname: "macbook.tail1234.ts.net",
        advertisedEndpoints: [
          {
            id: "tailscale-ip:http://100.82.150.82:3773",
            httpBaseUrl: "http://100.82.150.82:3773/",
          },
          {
            id: "tailscale-magicdns:https://macbook.tail1234.ts.net/",
            httpBaseUrl: "https://macbook.tail1234.ts.net/",
          },
        ],
      }).map((link) => link.url),
    ).toEqual(["http://100.82.150.82:5173/", "http://macbook.tail1234.ts.net:5173/"]);
  });

  it("leaves loopback links unchanged outside a Tailscale server context", () => {
    const links = detectDevServerLinksFromText("Local: http://localhost:5173/");

    expect(
      rewriteDevServerLinksForTailscale(links, {
        environmentHttpBaseUrl: "http://localhost:3773/",
      }),
    ).toEqual(links);
  });

  it("uses a Tailscale host as the reachability route hint when available", () => {
    expect(
      resolveDevServerReachabilityHostname({
        browserHostname: "app.t3.codes",
        environmentHttpBaseUrl: "https://macbook.tail1234.ts.net/",
        advertisedEndpoints: [
          {
            id: "tailscale-ip:http://100.82.150.82:3773",
            httpBaseUrl: "http://100.82.150.82:3773/",
          },
        ],
      }),
    ).toBe("100.82.150.82");
  });
});

describe("probeDevServerReachable", () => {
  it("skips the probe for loopback URLs from a remote browser host", async () => {
    const probe = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true);

    await expect(
      probeDevServerReachable("http://localhost:5173/", {
        browserHostname: "100.82.150.82",
        probe,
      }),
    ).resolves.toBe(false);

    expect(probe).not.toHaveBeenCalled();
  });

  it("delegates to the injected probe when the browser can route to the URL", async () => {
    const probe = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true);

    await expect(
      probeDevServerReachable("http://100.82.150.82:5173/", {
        browserHostname: "100.82.150.82",
        probe,
      }),
    ).resolves.toBe(true);

    expect(probe).toHaveBeenCalledWith("http://100.82.150.82:5173/");
  });

  it("treats a probe that resolves false as unreachable", async () => {
    const probe = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(false);

    await expect(
      probeDevServerReachable("http://100.82.150.82:5173/", {
        browserHostname: "100.82.150.82",
        probe,
      }),
    ).resolves.toBe(false);

    expect(probe).toHaveBeenCalledWith("http://100.82.150.82:5173/");
  });

  it("treats a rejected probe as unreachable", async () => {
    const probe = vi
      .fn<(url: string) => Promise<boolean>>()
      .mockRejectedValue(new Error("rpc failed"));

    await expect(
      probeDevServerReachable("http://100.82.150.82:5173/", {
        browserHostname: "100.82.150.82",
        probe,
      }),
    ).resolves.toBe(false);

    expect(probe).toHaveBeenCalledWith("http://100.82.150.82:5173/");
  });
});

describe("detectDevServerLinksFromTerminalEvents", () => {
  it("reads start snapshots, output events, and deduplicates repeated URLs", () => {
    expect(
      detectDevServerLinksFromTerminalEvents([
        terminalStartedEntry(1, "Local: http://localhost:5173/"),
        terminalOutputEntry(2, "Local: http://localhost:5173/"),
        terminalOutputEntry(3, "started server on http://localhost:3000"),
      ]),
    ).toEqual([
      {
        url: "http://localhost:3000/",
        displayUrl: "http://localhost:3000",
        label: "Local localhost:3000",
        host: "localhost:3000",
        port: "3000",
      },
      {
        url: "http://localhost:5173/",
        displayUrl: "http://localhost:5173",
        label: "Local localhost:5173",
        host: "localhost:5173",
        port: "5173",
      },
    ]);
  });

  it("drops stale URLs after terminal clear", () => {
    expect(
      detectDevServerLinksFromTerminalEvents([
        terminalOutputEntry(1, "Local: http://localhost:5173/"),
        terminalClearedEntry(2),
      ]),
    ).toEqual([]);
  });

  it("uses the current subprocess segment after activity stops and starts again", () => {
    expect(
      detectDevServerLinksFromTerminalEvents([
        terminalOutputEntry(1, "Local: http://localhost:5173/"),
        terminalActivityEntry(2, false),
        terminalOutputEntry(3, "Local: http://localhost:4173/"),
      ]),
    ).toEqual([
      {
        url: "http://localhost:4173/",
        displayUrl: "http://localhost:4173",
        label: "Local localhost:4173",
        host: "localhost:4173",
        port: "4173",
      },
    ]);
  });

  it("replaces previous output with restarted terminal history", () => {
    expect(
      detectDevServerLinksFromTerminalEvents([
        terminalOutputEntry(1, "Local: http://localhost:5173/"),
        terminalRestartedEntry(2, "Local: http://localhost:3000/"),
      ]),
    ).toEqual([
      {
        url: "http://localhost:3000/",
        displayUrl: "http://localhost:3000",
        label: "Local localhost:3000",
        host: "localhost:3000",
        port: "3000",
      },
    ]);
  });
});

describe("detectDevServerLinksFromTerminalSnapshots", () => {
  it("reads dev server URLs from cached terminal history snapshots", () => {
    expect(
      detectDevServerLinksFromTerminalSnapshots([
        {
          threadId: THREAD_ID,
          terminalId: "default",
          cwd: "/repo/app",
          worktreePath: null,
          status: "running",
          pid: 123,
          history: "VITE ready\nLocal: http://localhost:5173/\n",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-06-17T00:00:00.000Z",
        },
      ]),
    ).toEqual([
      {
        url: "http://localhost:5173/",
        displayUrl: "http://localhost:5173",
        label: "Local localhost:5173",
        host: "localhost:5173",
        port: "5173",
      },
    ]);
  });

  it("ignores non-running terminal snapshots", () => {
    expect(
      detectDevServerLinksFromTerminalSnapshots([
        {
          threadId: THREAD_ID,
          terminalId: "default",
          cwd: "/repo/app",
          worktreePath: null,
          status: "exited",
          pid: null,
          history: "VITE ready\nLocal: http://localhost:5173/\n",
          exitCode: 0,
          exitSignal: null,
          updatedAt: "2026-06-17T00:00:00.000Z",
        },
      ]),
    ).toEqual([]);
  });

  it("keeps the first occurrence when merging live and snapshot links", () => {
    const liveLink = detectDevServerLinksFromText("Local: http://localhost:5173/")[0]!;
    const snapshotLink = detectDevServerLinksFromText("Network: http://localhost:5173/")[0]!;

    expect(mergeDevServerLinks([liveLink, snapshotLink])).toEqual([liveLink]);
  });
});
