import Mime from "@effect/platform-node/Mime";
import {
  MIME_TYPE_BY_VIDEO_EXTENSION,
  SAFE_VIDEO_FILE_EXTENSIONS,
  videoExtensionFromFileName as sharedVideoExtensionFromFileName,
} from "@t3tools/shared/videoMime";

export { MIME_TYPE_BY_VIDEO_EXTENSION, SAFE_VIDEO_FILE_EXTENSIONS };

export function videoExtensionFromFileName(fileName: string): string | null {
  return sharedVideoExtensionFromFileName(fileName);
}

export function videoMimeTypeFromFileName(fileName: string): string | null {
  const extension = videoExtensionFromFileName(fileName);
  if (!extension) {
    return null;
  }
  if (Object.hasOwn(MIME_TYPE_BY_VIDEO_EXTENSION, extension)) {
    return MIME_TYPE_BY_VIDEO_EXTENSION[extension] ?? null;
  }
  const inferred = Mime.getType(fileName);
  return inferred?.startsWith("video/") ? inferred : null;
}

export function isSafeVideoFileName(fileName: string): boolean {
  return videoMimeTypeFromFileName(fileName) !== null;
}
