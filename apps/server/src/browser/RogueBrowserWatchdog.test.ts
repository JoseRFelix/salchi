import { ThreadId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import { findRogueBrowserProcesses } from "./RogueBrowserWatchdog.ts";

const threadA = ThreadId.make("thread-a");

describe("rogue browser ancestry matcher", () => {
  it("finds a top-level Chromium descended through an MCP child from a provider", () => {
    const matches = findRogueBrowserProcesses({
      profileRoot: "/home/alice/.salchi/userdata/browser-profiles",
      providerProcesses: [{ pid: 100, threadId: threadA }],
      processRows: [
        { pid: 100, ppid: 10, command: "codex app-server" },
        { pid: 110, ppid: 100, command: "node playwright-mcp" },
        {
          pid: 120,
          ppid: 110,
          command: "/opt/chromium/chrome --headless --user-data-dir=/tmp/pw-profile",
        },
        { pid: 121, ppid: 120, command: "/opt/chromium/chrome --type=renderer" },
      ],
    });

    expect(matches).toEqual([
      {
        command: "/opt/chromium/chrome --headless --user-data-dir=/tmp/pw-profile",
        pid: 120,
        providerPid: 100,
        threadId: threadA,
      },
    ]);
  });

  it("ignores Salchi-profile Chromium and unrelated browser processes", () => {
    const matches = findRogueBrowserProcesses({
      profileRoot: "/home/alice/.salchi/userdata/browser-profiles",
      providerProcesses: [{ pid: 100, threadId: threadA }],
      processRows: [
        { pid: 100, ppid: 10, command: "claude" },
        {
          pid: 120,
          ppid: 100,
          command:
            "/opt/chrome --user-data-dir='/home/alice/.salchi/userdata/browser-profiles/thread-a'",
        },
        { pid: 200, ppid: 10, command: "/opt/chrome --user-data-dir=/tmp/personal" },
      ],
    });

    expect(matches).toEqual([]);
  });

  it("does not cross missing parents, cycles, or another provider's ancestry", () => {
    const threadB = ThreadId.make("thread-b");
    const matches = findRogueBrowserProcesses({
      profileRoot: "/salchi/browser-profiles",
      providerProcesses: [
        { pid: 100, threadId: threadA },
        { pid: 300, threadId: threadB },
      ],
      processRows: [
        { pid: 100, ppid: 10, command: "codex app-server" },
        { pid: 300, ppid: 10, command: "grok agent stdio" },
        { pid: 310, ppid: 300, command: "/usr/bin/google-chrome --headless" },
        { pid: 400, ppid: 401, command: "/usr/bin/chromium --headless" },
        { pid: 401, ppid: 400, command: "cycle" },
        { pid: 500, ppid: 499, command: "/usr/bin/msedge --headless" },
      ],
    });

    expect(matches).toEqual([
      {
        command: "/usr/bin/google-chrome --headless",
        pid: 310,
        providerPid: 300,
        threadId: threadB,
      },
    ]);
  });
});
