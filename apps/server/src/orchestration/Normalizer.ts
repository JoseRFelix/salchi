import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_PDF_BYTES,
} from "@salchi/contracts";
import { PDF_MIME_TYPE } from "@salchi/shared/attachmentMime";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start" && command.type !== "thread.turn.queue") {
      return command as OrchestrationCommand;
    }

    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          const attachmentKind = attachment.type === "pdf" ? "PDF" : "Image";
          const normalizedMimeType = parsed?.mimeType.toLowerCase() ?? "";
          const isValidMime =
            attachment.type === "image"
              ? normalizedMimeType.startsWith("image/")
              : normalizedMimeType === PDF_MIME_TYPE;
          const maxBytes =
            attachment.type === "image"
              ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
              : PROVIDER_SEND_TURN_MAX_PDF_BYTES;
          if (!parsed || !isValidMime) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid ${attachmentKind.toLowerCase()} attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
            return yield* new OrchestrationDispatchCommandError({
              message: `${attachmentKind} attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(command.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment =
            attachment.type === "pdf"
              ? {
                  type: "pdf" as const,
                  id: attachmentId,
                  name: attachment.name,
                  mimeType: PDF_MIME_TYPE,
                  sizeBytes: bytes.byteLength,
                }
              : {
                  type: "image" as const,
                  id: attachmentId,
                  name: attachment.name,
                  mimeType: normalizedMimeType,
                  sizeBytes: bytes.byteLength,
                };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
