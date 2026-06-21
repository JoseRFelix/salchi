import { pathToFileURL } from "node:url";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";

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

export function toAcpAttachmentResourceLink(
  attachment: ChatAttachment,
  path: string,
): EffectAcpSchema.ContentBlock {
  const reference = toProviderAttachmentReference(attachment, path);
  return {
    type: "resource_link",
    uri: reference.fileUrl,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.sizeBytes,
  } satisfies EffectAcpSchema.ContentBlock;
}

export function buildAcpAttachmentPromptParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly provider: string;
  readonly method: string;
}): Effect.Effect<EffectAcpSchema.ContentBlock[], ProviderAdapterRequestError> {
  return Effect.forEach(input.attachments ?? [], (attachment) =>
    Effect.gen(function* () {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: input.provider,
          method: input.method,
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      if (attachment.type === "pdf") {
        return toAcpAttachmentResourceLink(attachment, attachmentPath);
      }
      const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: input.provider,
              method: input.method,
              detail: cause.message,
              cause,
            }),
        ),
      );
      return {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      } satisfies EffectAcpSchema.ContentBlock;
    }),
  );
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
