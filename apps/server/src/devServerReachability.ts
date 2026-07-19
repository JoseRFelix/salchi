import * as net from "node:net";

export interface ProbeTarget {
  /** Host to open the TCP connection against (already normalized for connect). */
  readonly host: string;
  readonly port: number;
}

export interface ProbeDevServerUrlOptions {
  readonly timeoutMs?: number;
  /** Injectable connector for tests. Defaults to a real `net` TCP connect. */
  readonly connect?: (target: ProbeTarget, timeoutMs: number) => Promise<boolean>;
}

export const DEFAULT_DEV_SERVER_PROBE_TIMEOUT_MS = 1_500;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function parseIpv4Octets(hostname: string): readonly number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Allow only loopback, RFC1918, CGNAT (100.64/10) and local dev hostnames.
 * Link-local (`169.254.0.0/16` — cloud metadata) and every public host are
 * rejected so this probe cannot be turned into an SSRF / metadata oracle.
 */
function isAllowedProbeIpv4(octets: readonly number[]): boolean {
  const [first = 0, second = 0] = octets;
  if (first === 127 || first === 10) return true;
  if (first === 0) return true; // 0.0.0.0 — normalized to loopback before connect
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

function isAllowedProbeHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    host === "host.docker.internal" ||
    host.endsWith(".local")
  ) {
    return true;
  }
  const octets = parseIpv4Octets(host);
  return octets !== null && isAllowedProbeIpv4(octets);
}

/**
 * Validate and normalize a dev-server URL into a TCP connect target, or return
 * `null` when the URL is malformed, uses a non-web scheme, targets a host
 * outside the local/private allowlist, or lacks a usable port.
 */
export function resolveProbeTarget(url: string): ProbeTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:"
  ) {
    return null;
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (hostname.length === 0 || !isAllowedProbeHostname(hostname)) {
    return null;
  }

  const isSecureProtocol = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const portText = parsed.port.length > 0 ? parsed.port : isSecureProtocol ? "443" : "80";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  // Wildcard bind addresses are not connectable; dial loopback instead.
  const connectHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "::1" : hostname;

  return { host: connectHost, port };
}

function connectTcp(target: ProbeTarget, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    const socket = net.createConnection({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Probe whether a dev-server URL is currently accepting TCP connections.
 *
 * This performs a raw TCP connect only — no request is sent and no response is
 * read — so the sole observable result is the returned `reachable` boolean.
 * Disallowed/invalid hosts resolve to `false` without any connection attempt.
 */
export async function probeDevServerUrl(
  url: string,
  options: ProbeDevServerUrlOptions = {},
): Promise<boolean> {
  const target = resolveProbeTarget(url);
  if (!target) {
    return false;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEV_SERVER_PROBE_TIMEOUT_MS;
  const connect = options.connect ?? connectTcp;
  return connect(target, timeoutMs);
}
