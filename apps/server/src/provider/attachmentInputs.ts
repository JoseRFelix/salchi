import { pathToFileURL } from "node:url";

import type { ChatAttachment } from "@t3tools/contracts";

export interface ProviderAttachmentReference {
  readonly attachment: ChatAttachment;
  readonly path: string;
  readonly fileUrl: string;
}

export function toProviderAttachmentReference(
  attachment: ChatAttachment,
  path: string,
): ProviderAttachmentReference {
  return {
    attachment,
    path,
    fileUrl: pathToFileURL(path).href,
  };
}

export function formatPdfAttachmentReferenceText(
  references: ReadonlyArray<ProviderAttachmentReference>,
): string | null {
  const pdfReferences = references.filter((reference) => reference.attachment.type === "pdf");
  if (pdfReferences.length === 0) {
    return null;
  }

  const lines = pdfReferences.map(
    ({ attachment, path }) =>
      `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${path}`,
  );
  return [
    "Attached PDF files are available at these local paths:",
    ...lines,
    "Use these paths if you need to inspect the PDFs.",
  ].join("\n");
}
