import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";

type ChatImageStatus = "loading" | "loaded" | "error";

interface StableChatImageProps {
  src: string;
  alt: string;
  className?: string | undefined;
  imageClassName?: string | undefined;
}

export function StableChatImage({ src, alt, className, imageClassName }: StableChatImageProps) {
  const [imageState, setImageState] = useState<{ src: string; status: ChatImageStatus }>({
    src,
    status: "loading",
  });
  const status = imageState.src === src ? imageState.status : "loading";

  return (
    <span
      className={cn(
        "relative block aspect-video w-full overflow-hidden rounded-lg border border-border/80 bg-muted/30",
        className,
      )}
      data-chat-image-state={status}
      aria-busy={status === "loading"}
    >
      {status === "loading" ? (
        <span
          className="absolute inset-0 animate-skeleton bg-muted [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--color-muted)_0_0/200%_100%_fixed] motion-reduce:animate-none dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]"
          data-slot="chat-image-skeleton"
          aria-hidden
        />
      ) : null}
      {status === "error" ? (
        <span
          className="absolute inset-0 flex items-center justify-center"
          data-slot="chat-image-error"
          role="img"
          aria-label={`Failed to load ${alt}`}
        >
          <span
            className="flex size-9 items-center justify-center text-muted-foreground"
            data-slot="chat-image-error-icon"
          >
            <TriangleAlertIcon className="size-4" aria-hidden />
          </span>
        </span>
      ) : null}
      <img
        key={src}
        src={src}
        alt={alt}
        aria-hidden={status !== "loaded"}
        className={cn(
          "absolute inset-0 block size-full object-contain transition-opacity duration-150",
          status === "loaded" ? "opacity-100" : "opacity-0",
          imageClassName,
        )}
        loading="lazy"
        onLoad={() => setImageState({ src, status: "loaded" })}
        onError={() => setImageState({ src, status: "error" })}
      />
    </span>
  );
}
