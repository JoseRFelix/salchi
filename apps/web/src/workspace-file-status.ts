import type { VcsStatusResult, VcsWorkingTreeFileStatus } from "@salchi/contracts";

export type WorkspaceChangedFile = VcsStatusResult["workingTree"]["files"][number];

export interface WorkspaceEntryChangeDecoration {
  readonly status: VcsWorkingTreeFileStatus;
  readonly source: "file" | "directory";
  readonly descendantCount: number;
}

const STATUS_PRIORITY: Record<VcsWorkingTreeFileStatus, number> = {
  conflicted: 7,
  deleted: 6,
  modified: 5,
  renamed: 4,
  copied: 3,
  added: 2,
  untracked: 1,
};

export function workspaceStatusBadge(status: VcsWorkingTreeFileStatus): {
  readonly className: string;
  readonly label: string;
  readonly letter: string;
} {
  switch (status) {
    case "added":
      return { letter: "A", label: "added", className: "text-success" };
    case "copied":
      return { letter: "C", label: "copied", className: "text-warning-foreground" };
    case "conflicted":
      return { letter: "C", label: "conflicted", className: "text-destructive" };
    case "deleted":
      return { letter: "D", label: "deleted", className: "text-destructive" };
    case "modified":
      return { letter: "M", label: "modified", className: "text-warning-foreground" };
    case "renamed":
      return { letter: "R", label: "renamed", className: "text-warning-foreground" };
    case "untracked":
      return { letter: "U", label: "untracked", className: "text-success" };
  }
}

export function parentPathsOf(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];

  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

function strongerStatus(
  currentStatus: VcsWorkingTreeFileStatus,
  nextStatus: VcsWorkingTreeFileStatus,
): VcsWorkingTreeFileStatus {
  return STATUS_PRIORITY[nextStatus] > STATUS_PRIORITY[currentStatus] ? nextStatus : currentStatus;
}

export function buildWorkspaceChangeDecorations(
  files: ReadonlyArray<WorkspaceChangedFile>,
): ReadonlyMap<string, WorkspaceEntryChangeDecoration> {
  const decorationsByPath = new Map<string, WorkspaceEntryChangeDecoration>();

  for (const file of files) {
    for (const parentPath of parentPathsOf(file.path)) {
      const existingDecoration = decorationsByPath.get(parentPath);
      if (!existingDecoration || existingDecoration.source === "file") {
        decorationsByPath.set(parentPath, {
          source: "directory",
          status: file.status,
          descendantCount: 1,
        });
        continue;
      }

      decorationsByPath.set(parentPath, {
        source: "directory",
        status: strongerStatus(existingDecoration.status, file.status),
        descendantCount: existingDecoration.descendantCount + 1,
      });
    }
  }

  for (const file of files) {
    decorationsByPath.set(file.path, {
      source: "file",
      status: file.status,
      descendantCount: 1,
    });
  }

  return decorationsByPath;
}
