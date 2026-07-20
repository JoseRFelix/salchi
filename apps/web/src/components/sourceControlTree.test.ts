import type { VcsStatusResult } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import { buildSourceControlTree, flattenSourceControlTreeRows } from "./sourceControlTree";

type SourceControlFile = VcsStatusResult["workingTree"]["files"][number];

function file(path: string): SourceControlFile {
  return {
    path,
    status: "modified",
    insertions: 1,
    deletions: 0,
  };
}

function rowPaths(rows: ReturnType<typeof flattenSourceControlTreeRows>): string[] {
  return rows.map((row) => `${row.depth}:${row.node.type}:${row.node.path}`);
}

describe("flattenSourceControlTreeRows", () => {
  it("includes expanded directory descendants", () => {
    const tree = buildSourceControlTree([
      file("src/App.tsx"),
      file("src/components/Button.tsx"),
      file("README.md"),
    ]);

    expect(
      rowPaths(
        flattenSourceControlTreeRows({
          tree,
          section: "unstaged",
          collapsedDirs: new Set(),
        }),
      ),
    ).toEqual([
      "0:dir:src",
      "1:dir:src/components",
      "2:file:src/components/Button.tsx",
      "1:file:src/App.tsx",
      "0:file:README.md",
    ]);
  });

  it("omits descendants below collapsed directories", () => {
    const tree = buildSourceControlTree([
      file("src/App.tsx"),
      file("src/components/Button.tsx"),
      file("README.md"),
    ]);

    expect(
      rowPaths(
        flattenSourceControlTreeRows({
          tree,
          section: "unstaged",
          collapsedDirs: new Set(["unstaged:src"]),
        }),
      ),
    ).toEqual(["0:dir:src", "0:file:README.md"]);
  });

  it("honors section-prefixed collapse keys", () => {
    const tree = buildSourceControlTree([file("src/App.tsx")]);

    expect(
      rowPaths(
        flattenSourceControlTreeRows({
          tree,
          section: "staged",
          collapsedDirs: new Set(["unstaged:src"]),
        }),
      ),
    ).toEqual(["0:dir:src", "1:file:src/App.tsx"]);

    expect(
      rowPaths(
        flattenSourceControlTreeRows({
          tree,
          section: "staged",
          collapsedDirs: new Set(["staged:src"]),
        }),
      ),
    ).toEqual(["0:dir:src"]);
  });
});
