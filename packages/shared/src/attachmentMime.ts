export const PDF_MIME_TYPE = "application/pdf";
export type SupportedAttachmentType = "image" | "pdf";

export function isPdfMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.trim().toLowerCase() === PDF_MIME_TYPE;
}

export function isPdfFileName(name: string | null | undefined): boolean {
  return /\.pdf$/i.test(name?.trim() ?? "");
}

export function inferSupportedAttachmentType(input: {
  readonly type?: string | null | undefined;
  readonly name?: string | null | undefined;
}): SupportedAttachmentType | null {
  const mimeType = input.type?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (isPdfMimeType(mimeType) || isPdfFileName(input.name)) {
    return "pdf";
  }
  return null;
}

export function normalizeAttachmentMimeType(input: {
  readonly type?: string | null | undefined;
  readonly name?: string | null | undefined;
}): string {
  const type = input.type?.trim().toLowerCase() ?? "";
  if (type.length > 0) {
    return type;
  }
  if (isPdfFileName(input.name)) {
    return PDF_MIME_TYPE;
  }
  return type;
}
