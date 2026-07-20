import type { EnvironmentId } from "@salchi/contracts";
import { isSafeImageFileName } from "@salchi/shared/imageMime";
import { isSafeVideoFileName } from "@salchi/shared/videoMime";

import { resolveEnvironmentHttpUrl } from "./environments/runtime";

export const WORKSPACE_IMAGE_ROUTE_PATH = "/api/workspace-image";
export const WORKSPACE_GIT_IMAGE_ROUTE_PATH = "/api/workspace-git-image";
export const WORKSPACE_VIDEO_ROUTE_PATH = "/api/workspace-video";
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{7,64}$/i;

export type WorkspaceMediaPreviewKind = "image" | "video";

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return isSafeImageFileName(path);
}

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return isSafeVideoFileName(path);
}

export function resolveWorkspaceMediaPreviewKind(path: string): WorkspaceMediaPreviewKind | null {
  if (isWorkspaceImagePreviewPath(path)) {
    return "image";
  }
  if (isWorkspaceVideoPreviewPath(path)) {
    return "video";
  }
  return null;
}

export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return resolveWorkspaceMediaPreviewKind(path) !== null;
}

export function resolveWorkspaceImagePreviewUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): string | null {
  if (!isWorkspaceImagePreviewPath(input.relativePath)) {
    return null;
  }
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: WORKSPACE_IMAGE_ROUTE_PATH,
      searchParams: {
        cwd: input.cwd,
        relativePath: input.relativePath,
      },
    });
  } catch {
    return null;
  }
}

export function resolveWorkspaceVideoPreviewUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): string | null {
  if (!isWorkspaceVideoPreviewPath(input.relativePath)) {
    return null;
  }
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: WORKSPACE_VIDEO_ROUTE_PATH,
      searchParams: {
        cwd: input.cwd,
        relativePath: input.relativePath,
      },
    });
  } catch {
    return null;
  }
}

export function resolveWorkspaceMediaPreviewUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): { kind: WorkspaceMediaPreviewKind; url: string } | null {
  const kind = resolveWorkspaceMediaPreviewKind(input.relativePath);
  if (!kind) {
    return null;
  }
  const url =
    kind === "image"
      ? resolveWorkspaceImagePreviewUrl(input)
      : resolveWorkspaceVideoPreviewUrl(input);
  return url ? { kind, url } : null;
}

export function resolveWorkspaceGitImagePreviewUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  objectId: string | undefined;
}): string | null {
  const objectId = input.objectId?.trim();
  if (
    !isWorkspaceImagePreviewPath(input.relativePath) ||
    !objectId ||
    !GIT_OBJECT_ID_PATTERN.test(objectId) ||
    /^0+$/.test(objectId)
  ) {
    return null;
  }
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: WORKSPACE_GIT_IMAGE_ROUTE_PATH,
      searchParams: {
        cwd: input.cwd,
        relativePath: input.relativePath,
        objectId,
      },
    });
  } catch {
    return null;
  }
}
