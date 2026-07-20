import type { VcsStatusResult, VcsWorkingTreeFileStatus } from "@salchi/contracts";

export type SourceControlFile = VcsStatusResult["workingTree"]["files"][number];

export interface SourceControlTreeFileNode {
  readonly type: "file";
  /** Full repo-relative path, e.g. `src/routes/index.ts`. */
  readonly path: string;
  /** Display name (last path segment). */
  readonly name: string;
  readonly file: SourceControlFile;
}

export interface SourceControlTreeDirNode {
  readonly type: "dir";
  /** Full path of the directory, e.g. `src/routes`. */
  readonly path: string;
  /** Display name (last path segment). */
  readonly name: string;
  readonly children: SourceControlTreeNode[];
}

export type SourceControlTreeNode = SourceControlTreeFileNode | SourceControlTreeDirNode;
export type SourceControlTreeSection = "staged" | "unstaged";

export interface SourceControlVisibleTreeRow {
  readonly node: SourceControlTreeNode;
  readonly depth: number;
}

interface MutableDirNode {
  readonly type: "dir";
  path: string;
  name: string;
  readonly childDirs: Map<string, MutableDirNode>;
  readonly files: SourceControlTreeFileNode[];
}

function createDirNode(path: string, name: string): MutableDirNode {
  return { type: "dir", path, name, childDirs: new Map(), files: [] };
}

export function sourceControlFileName(path: string): string {
  const normalized = path.replace(/[\\/]+$/g, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

function finalize(node: MutableDirNode): SourceControlTreeDirNode {
  const dirs = [...node.childDirs.values()]
    .map(finalize)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const files = node.files.toSorted((a, b) => a.name.localeCompare(b.name));
  return {
    type: "dir",
    path: node.path,
    name: node.name,
    // VS Code shows directories before files within a folder.
    children: [...dirs, ...files],
  };
}

/**
 * Build a nested folder/file tree out of the flat working-tree file list so the
 * Source Control panel can render it like VS Code's "tree" view.
 */
export function buildSourceControlTree(
  files: ReadonlyArray<SourceControlFile>,
): SourceControlTreeNode[] {
  const root = createDirNode("", "");

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      continue;
    }

    let current = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const dirPath = current.path ? `${current.path}/${segment}` : segment;
      let next = current.childDirs.get(segment);
      if (!next) {
        next = createDirNode(dirPath, segment);
        current.childDirs.set(segment, next);
      }
      current = next;
    }

    const name = sourceControlFileName(file.path);
    current.files.push({ type: "file", path: file.path, name, file });
  }

  return finalize(root).children;
}

function collectVisibleTreeRows(input: {
  readonly section: SourceControlTreeSection;
  readonly node: SourceControlTreeNode;
  readonly depth: number;
  readonly collapsedDirs: ReadonlySet<string>;
  readonly rows: SourceControlVisibleTreeRow[];
}): void {
  input.rows.push({ node: input.node, depth: input.depth });

  if (input.node.type === "file") {
    return;
  }

  if (input.collapsedDirs.has(`${input.section}:${input.node.path}`)) {
    return;
  }

  for (const child of input.node.children) {
    collectVisibleTreeRows({
      section: input.section,
      node: child,
      depth: input.depth + 1,
      collapsedDirs: input.collapsedDirs,
      rows: input.rows,
    });
  }
}

export function flattenSourceControlTreeRows(input: {
  readonly tree: ReadonlyArray<SourceControlTreeNode>;
  readonly section: SourceControlTreeSection;
  readonly collapsedDirs: ReadonlySet<string>;
}): SourceControlVisibleTreeRow[] {
  const rows: SourceControlVisibleTreeRow[] = [];
  for (const node of input.tree) {
    collectVisibleTreeRows({
      section: input.section,
      node,
      depth: 0,
      collapsedDirs: input.collapsedDirs,
      rows,
    });
  }
  return rows;
}

/** Collect every file path beneath a tree node (itself if it is a file). */
export function collectFilePaths(node: SourceControlTreeNode): string[] {
  if (node.type === "file") {
    return [node.path];
  }
  return node.children.flatMap(collectFilePaths);
}

export interface SourceControlStatusBadge {
  readonly letter: string;
  readonly label: string;
  /** Tailwind text-color class. */
  readonly className: string;
}

const STATUS_BADGES: Record<VcsWorkingTreeFileStatus, SourceControlStatusBadge> = {
  modified: { letter: "M", label: "Modified", className: "text-amber-500" },
  added: { letter: "A", label: "Added", className: "text-emerald-500" },
  deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
  renamed: { letter: "R", label: "Renamed", className: "text-sky-500" },
  copied: { letter: "C", label: "Copied", className: "text-sky-500" },
  untracked: { letter: "U", label: "Untracked", className: "text-emerald-500" },
  conflicted: { letter: "!", label: "Conflicted", className: "text-destructive" },
};

export function statusBadge(status: VcsWorkingTreeFileStatus): SourceControlStatusBadge {
  return STATUS_BADGES[status];
}
