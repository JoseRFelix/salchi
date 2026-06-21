import type { ChatAttachment } from "../../types";
import { cn } from "../../lib/utils";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ExternalLinkIcon, FileTextIcon } from "lucide-react";

interface MessageAttachmentsProps {
  attachments: ReadonlyArray<ChatAttachment>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  className?: string | undefined;
}

function formatAttachmentSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }
  if (sizeBytes < 1024) {
    return `${Math.round(sizeBytes)} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MessageImageGridOnly({
  images,
  onImageExpand,
  className,
}: {
  images: ReadonlyArray<Extract<ChatAttachment, { type: "image" }>>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  className?: string | undefined;
}) {
  if (images.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid max-w-[420px] grid-cols-2 gap-2",
        images.length === 1 ? "grid-cols-1" : null,
        className,
      )}
    >
      {images.map((image) => (
        <div
          key={image.id}
          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(images, image.id);
                if (!preview) return;
                onImageExpand(preview);
              }}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                className="block h-auto max-h-[220px] w-full object-cover"
                loading="lazy"
              />
            </button>
          ) : (
            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
              {image.name}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MessageImageAttachment({
  image,
  images,
  onImageExpand,
}: {
  image: Extract<ChatAttachment, { type: "image" }>;
  images: ReadonlyArray<Extract<ChatAttachment, { type: "image" }>>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  return (
    <div className="max-w-[420px] overflow-hidden rounded-lg border border-border/80 bg-background/70">
      {image.previewUrl ? (
        <button
          type="button"
          className="h-full w-full cursor-zoom-in"
          aria-label={`Preview ${image.name}`}
          onClick={() => {
            const preview = buildExpandedImagePreview(images, image.id);
            if (!preview) return;
            onImageExpand(preview);
          }}
        >
          <img
            src={image.previewUrl}
            alt={image.name}
            className="block h-auto max-h-[220px] w-full object-cover"
            loading="lazy"
          />
        </button>
      ) : (
        <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
          {image.name}
        </div>
      )}
    </div>
  );
}

function MessagePdfAttachment({
  attachment,
}: {
  attachment: Extract<ChatAttachment, { type: "pdf" }>;
}) {
  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-lg border border-border/80 bg-background/70">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{attachment.name}</div>
          <div className="text-[11px] text-muted-foreground">
            PDF - {formatAttachmentSize(attachment.sizeBytes)}
          </div>
        </div>
        {attachment.previewUrl ? (
          <a
            href={attachment.previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Open ${attachment.name}`}
          >
            <ExternalLinkIcon className="size-4" aria-hidden />
          </a>
        ) : null}
      </div>
      {attachment.previewUrl ? (
        <iframe
          src={attachment.previewUrl}
          title={attachment.name}
          loading="lazy"
          sandbox="allow-scripts allow-downloads"
          className="block h-[420px] max-h-[60vh] min-h-[280px] w-full border-t border-border/70 bg-background"
        />
      ) : (
        <div className="border-t border-border/70 px-3 py-4 text-xs text-muted-foreground">
          Preview unavailable.
        </div>
      )}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  onImageExpand,
  className,
}: MessageAttachmentsProps) {
  if (attachments.length === 0) {
    return null;
  }

  const images = attachments.filter(
    (attachment): attachment is Extract<ChatAttachment, { type: "image" }> =>
      attachment.type === "image",
  );
  if (images.length === attachments.length) {
    return (
      <MessageImageGridOnly images={images} onImageExpand={onImageExpand} className={className} />
    );
  }

  return (
    <div className={cn("flex max-w-[560px] flex-col gap-2", className)}>
      {attachments.map((attachment) =>
        attachment.type === "pdf" ? (
          <MessagePdfAttachment key={attachment.id} attachment={attachment} />
        ) : (
          <MessageImageAttachment
            key={attachment.id}
            image={attachment}
            images={images}
            onImageExpand={onImageExpand}
          />
        ),
      )}
    </div>
  );
}

export function MessageImageGrid({
  images,
  onImageExpand,
  className,
}: {
  images: ReadonlyArray<ChatAttachment>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  className?: string | undefined;
}) {
  return (
    <MessageAttachments attachments={images} onImageExpand={onImageExpand} className={className} />
  );
}
