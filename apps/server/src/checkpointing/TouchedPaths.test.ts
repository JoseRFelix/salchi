import { describe, expect, it } from "vitest";

import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@salchi/contracts";
import type { ProviderRuntimeEvent } from "@salchi/contracts";

import { extractTouchedPathsFromRuntimeEvent, normalizeTouchedPath } from "./TouchedPaths.ts";

const baseEvent = {
  eventId: EventId.make("evt-1"),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("TouchedPaths", () => {
  it("extracts file-change paths from nested provider item data", () => {
    const event: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "item.completed",
      payload: {
        itemType: "file_change",
        data: {
          input: {
            file_path: "/tmp/workspace/src/app.ts",
            notebook_path: "/tmp/workspace/notebook.ipynb",
          },
          data: {
            locations: [{ path: "src/other.ts" }],
          },
        },
      },
    };

    expect(extractTouchedPathsFromRuntimeEvent(event)).toEqual([
      { path: "/tmp/workspace/src/app.ts", snapshotKind: "edit-snapshot" },
      { path: "/tmp/workspace/notebook.ipynb", snapshotKind: "edit-snapshot" },
      { path: "src/other.ts", snapshotKind: "edit-snapshot" },
    ]);
  });

  it("extracts approval request paths as edit snapshots", () => {
    const event: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "request.opened",
      payload: {
        requestType: "apply_patch_approval",
        args: {
          changes: [{ oldPath: "old.ts", newPath: "src/new.ts" }],
        },
      },
    };

    expect(extractTouchedPathsFromRuntimeEvent(event)).toEqual([
      { path: "src/new.ts", snapshotKind: "edit-snapshot" },
      { path: "old.ts", snapshotKind: "edit-snapshot" },
    ]);
  });

  it("extracts turn diff paths as path-only attribution", () => {
    const event: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "turn.diff.updated",
      payload: {
        unifiedDiff: [
          "diff --git a/src/a.ts b/src/a.ts",
          "index 1111111..2222222 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      },
    };

    expect(extractTouchedPathsFromRuntimeEvent(event)).toEqual([
      { path: "src/a.ts", snapshotKind: "path-only" },
    ]);
  });

  it("caps extracted paths per event", () => {
    const event: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "item.completed",
      payload: {
        itemType: "file_change",
        data: {
          locations: Array.from({ length: 60 }, (_, index) => ({
            path: `src/file-${String(index).padStart(2, "0")}.ts`,
          })),
        },
      },
    };

    const paths = extractTouchedPathsFromRuntimeEvent(event);
    expect(paths).toHaveLength(50);
    expect(paths[0]).toEqual({ path: "src/file-00.ts", snapshotKind: "edit-snapshot" });
    expect(paths[49]).toEqual({ path: "src/file-49.ts", snapshotKind: "edit-snapshot" });
  });

  it("normalizes paths relative to the workspace and rejects escapes", () => {
    expect(normalizeTouchedPath("/tmp/workspace/src/app.ts", "/tmp/workspace")).toBe("src/app.ts");
    expect(normalizeTouchedPath("./src/../README.md", "/tmp/workspace")).toBe("README.md");
    expect(normalizeTouchedPath("/tmp/outside/app.ts", "/tmp/workspace")).toBeNull();
    expect(normalizeTouchedPath("../outside.ts", "/tmp/workspace")).toBeNull();
  });
});
