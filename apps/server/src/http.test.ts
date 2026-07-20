import { describe, expect, it } from "vitest";

import {
  cacheControlForStaticPath,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  resolveWorkspaceMediaByteRange,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("static cache control", () => {
  it("marks hashed asset build outputs as immutable", () => {
    expect(cacheControlForStaticPath("assets/index-abc123.js")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("requires revalidation for unhashed static outputs", () => {
    expect(cacheControlForStaticPath("index.html")).toBe("no-cache");
    expect(cacheControlForStaticPath("salchi-service-worker.js")).toBe("no-cache");
    expect(cacheControlForStaticPath("salchi-push-service-worker.js")).toBe("no-cache");
    expect(cacheControlForStaticPath("manifest.webmanifest")).toBe("no-cache");
  });

  it("does not treat assetsy as the assets directory", () => {
    expect(cacheControlForStaticPath("assetsy/file.js")).toBe("no-cache");
  });
});

describe("workspace media byte ranges", () => {
  it("uses the full file when no range is requested", () => {
    expect(resolveWorkspaceMediaByteRange(undefined, 100)).toEqual({ kind: "full" });
  });

  it("resolves open-ended byte ranges", () => {
    expect(resolveWorkspaceMediaByteRange("bytes=10-", 100)).toEqual({
      kind: "partial",
      start: 10,
      end: 99,
      contentLength: 90,
    });
  });

  it("resolves bounded byte ranges", () => {
    expect(resolveWorkspaceMediaByteRange("bytes=10-19", 100)).toEqual({
      kind: "partial",
      start: 10,
      end: 19,
      contentLength: 10,
    });
  });

  it("resolves suffix byte ranges", () => {
    expect(resolveWorkspaceMediaByteRange("bytes=-25", 100)).toEqual({
      kind: "partial",
      start: 75,
      end: 99,
      contentLength: 25,
    });
  });

  it("rejects unsupported or unsatisfiable byte ranges", () => {
    expect(resolveWorkspaceMediaByteRange("bytes=0-0", 0)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveWorkspaceMediaByteRange("bytes=-0", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveWorkspaceMediaByteRange("items=0-10", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveWorkspaceMediaByteRange("bytes=120-130", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveWorkspaceMediaByteRange("bytes=30-20", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveWorkspaceMediaByteRange("bytes=0-10,20-30", 100)).toEqual({
      kind: "unsatisfiable",
    });
  });
});
