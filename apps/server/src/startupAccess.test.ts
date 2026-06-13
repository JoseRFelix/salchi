import { assert, expect, it } from "@effect/vitest";

import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
  expect(buildPairingUrl("https://desktop.tail.ts.net/", "PAIRCODE")).toBe(
    "https://desktop.tail.ts.net/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

it("buildPairingUrl replaces an existing pathname with /pair", () => {
  // A URL that already has a deep path should still land at /pair.
  expect(buildPairingUrl("http://192.168.1.42:3773/some/deep/path", "TOKEN")).toBe(
    "http://192.168.1.42:3773/pair#token=TOKEN",
  );
});

it("buildPairingUrl replaces an existing hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773/#old=hash", "NEWTOKEN")).toBe(
    "http://192.168.1.42:3773/pair#token=NEWTOKEN",
  );
});

it("buildPairingUrl does not carry forward query params other than stripping token", () => {
  const url = buildPairingUrl("http://192.168.1.42:3773/?foo=bar", "TK");
  // The query string from the original URL should still appear (only 'token' is deleted).
  // The important invariant is that 'token' is never in the search params.
  const parsed = new URL(url);
  expect(parsed.searchParams.has("token")).toBe(false);
  expect(parsed.pathname).toBe("/pair");
  expect(parsed.hash).toBe("#token=TK");
});

it("buildPairingUrl URL-encodes tokens with special characters", () => {
  const token = "abc def+ghi=jkl&mno";
  const result = buildPairingUrl("http://192.168.1.42:3773", token);
  const parsed = new URL(result);
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  expect(hashParams.get("token")).toBe(token);
});

it("resolveListeningPort returns the fallback when the address object has a non-numeric port", () => {
  expect(resolveListeningPort({ port: "not-a-number" }, 3773)).toBe(3773);
});

it("resolveListeningPort returns the fallback when the address is an object without a port key", () => {
  expect(resolveListeningPort({ host: "localhost" }, 3773)).toBe(3773);
});

it("resolveListeningPort returns the fallback when address is undefined", () => {
  expect(resolveListeningPort(undefined, 3773)).toBe(3773);
});

it("resolveHeadlessConnectionHost falls back to localhost when all network interfaces are internal", () => {
  const host = resolveHeadlessConnectionHost("0.0.0.0", {
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });
  expect(host).toBe("localhost");
});

it("resolveHeadlessConnectionHost prefers IPv4 over IPv6 external interfaces", () => {
  const host = resolveHeadlessConnectionHost("0.0.0.0", {
    eth0: [
      {
        address: "fe80::1",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "fe80::1/64",
      },
      {
        address: "10.0.0.5",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "10.0.0.5/24",
      },
    ],
  });
  expect(host).toBe("10.0.0.5");
});
