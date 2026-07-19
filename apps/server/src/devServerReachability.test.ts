import * as net from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  probeDevServerUrl,
  resolveProbeTarget,
  type ProbeTarget,
} from "./devServerReachability.ts";

describe("resolveProbeTarget", () => {
  it("accepts loopback and private dev hosts with their port", () => {
    expect(resolveProbeTarget("http://localhost:5173/")).toEqual({ host: "localhost", port: 5173 });
    expect(resolveProbeTarget("http://127.0.0.1:3000")).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(resolveProbeTarget("http://192.168.1.44:5173/")).toEqual({
      host: "192.168.1.44",
      port: 5173,
    });
    expect(resolveProbeTarget("http://100.82.150.82:5173/")).toEqual({
      host: "100.82.150.82",
      port: 5173,
    });
  });

  it("normalizes wildcard bind addresses to loopback", () => {
    expect(resolveProbeTarget("http://0.0.0.0:5173/")).toEqual({ host: "127.0.0.1", port: 5173 });
    expect(resolveProbeTarget("http://[::]:5173/")).toEqual({ host: "::1", port: 5173 });
  });

  it("defaults the port from the scheme when absent", () => {
    expect(resolveProbeTarget("https://localhost/")).toEqual({ host: "localhost", port: 443 });
    expect(resolveProbeTarget("http://localhost/")).toEqual({ host: "localhost", port: 80 });
    expect(resolveProbeTarget("wss://localhost/terminal")).toEqual({
      host: "localhost",
      port: 443,
    });
    expect(resolveProbeTarget("ws://localhost/terminal")).toEqual({
      host: "localhost",
      port: 80,
    });
  });

  it("accepts local WebSocket endpoints with explicit ports", () => {
    expect(resolveProbeTarget("ws://localhost:3001/terminal")).toEqual({
      host: "localhost",
      port: 3001,
    });
    expect(resolveProbeTarget("wss://100.82.150.82:3443/socket")).toEqual({
      host: "100.82.150.82",
      port: 3443,
    });
  });

  it("rejects public hosts, link-local metadata, and unsupported schemes", () => {
    expect(resolveProbeTarget("http://example.com:8080/")).toBeNull();
    expect(resolveProbeTarget("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(resolveProbeTarget("http://8.8.8.8:80/")).toBeNull();
    expect(resolveProbeTarget("ftp://localhost:5173/")).toBeNull();
    expect(resolveProbeTarget("file:///etc/passwd")).toBeNull();
    expect(resolveProbeTarget("not a url")).toBeNull();
  });

  it("rejects an out-of-range port", () => {
    expect(resolveProbeTarget("http://localhost:0/")).toBeNull();
  });
});

describe("probeDevServerUrl", () => {
  it("returns false without attempting a connection for a disallowed host", async () => {
    const connect = vi.fn<(target: ProbeTarget, timeoutMs: number) => Promise<boolean>>();

    await expect(probeDevServerUrl("http://169.254.169.254/", { connect })).resolves.toBe(false);
    await expect(probeDevServerUrl("http://example.com:5173/", { connect })).resolves.toBe(false);

    expect(connect).not.toHaveBeenCalled();
  });

  it("delegates allowed hosts to the connector", async () => {
    const connect = vi
      .fn<(target: ProbeTarget, timeoutMs: number) => Promise<boolean>>()
      .mockResolvedValue(true);

    await expect(
      probeDevServerUrl("http://localhost:5173/", { connect, timeoutMs: 50 }),
    ).resolves.toBe(true);

    expect(connect).toHaveBeenCalledWith({ host: "localhost", port: 5173 }, 50);
  });

  it("reports a listening port as reachable and a closed one as unreachable", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to resolve listening port"));
        }
      });
    });

    try {
      await expect(
        probeDevServerUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 500 }),
      ).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await expect(probeDevServerUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 500 })).resolves.toBe(
      false,
    );
  });
});
