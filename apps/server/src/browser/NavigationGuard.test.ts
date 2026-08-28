import { describe, expect, it } from "vitest";

import { shouldBlockBrowserRequest } from "./NavigationGuard.ts";

describe("browser navigation guard", () => {
  it("blocks cloud instance metadata on every port", () => {
    expect(
      shouldBlockBrowserRequest({
        url: "http://169.254.169.254/latest/meta-data/",
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    ).toBe(true);
  });

  it("blocks the Google metadata hostname on every port", () => {
    expect(
      shouldBlockBrowserRequest({
        url: "http://metadata.google.internal:8080/computeMetadata/v1/",
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    ).toBe(true);
  });

  it("blocks the bracketed AWS IPv6 metadata address", () => {
    expect(
      shouldBlockBrowserRequest({
        url: "http://[fd00:ec2::254]/latest/meta-data/",
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    ).toBe(true);
  });

  it("blocks the Salchi listening endpoint including loopback aliases", () => {
    expect(
      shouldBlockBrowserRequest({
        url: "http://localhost:3773/api/auth/session",
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    ).toBe(true);
    expect(
      shouldBlockBrowserRequest({
        url: "http://127.0.0.1:3773/",
        serverHost: "0.0.0.0",
        serverPort: 3773,
      }),
    ).toBe(true);
  });

  it("allows unrelated hosts and other local ports", () => {
    expect(
      shouldBlockBrowserRequest({
        url: "https://example.com/",
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    ).toBe(false);
    expect(
      shouldBlockBrowserRequest({
        url: "http://127.0.0.1:3000/",
        serverHost: "127.0.0.1",
        serverPort: 3773,
      }),
    ).toBe(false);
  });
});
