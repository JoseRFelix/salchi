export const MIME_TYPE_BY_VIDEO_EXTENSION: Record<string, string> = {
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

export const SAFE_VIDEO_FILE_EXTENSIONS = new Set(Object.keys(MIME_TYPE_BY_VIDEO_EXTENSION));

export function videoExtensionFromFileName(fileName: string): string | null {
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName.trim());
  const extension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  return SAFE_VIDEO_FILE_EXTENSIONS.has(extension) ? extension : null;
}

export function videoMimeTypeFromFileName(fileName: string): string | null {
  const extension = videoExtensionFromFileName(fileName);
  if (!extension) {
    return null;
  }
  return Object.hasOwn(MIME_TYPE_BY_VIDEO_EXTENSION, extension)
    ? (MIME_TYPE_BY_VIDEO_EXTENSION[extension] ?? null)
    : null;
}

export function isSafeVideoFileName(fileName: string): boolean {
  return videoMimeTypeFromFileName(fileName) !== null;
}
