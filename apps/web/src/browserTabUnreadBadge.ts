const FAVICON_SELECTOR = 'link[rel~="icon"]';
const FAVICON_SIZE = 512;
const BADGE_COLOR = "#ef4444";
const BADGE_OUTLINE_COLOR = "#ffffff";
const unreadFaviconByHref = new Map<string, Promise<string | null>>();

interface FaviconLink {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

interface FaviconDocument {
  querySelector(selector: string): FaviconLink | null;
}

export interface BrowserTabUnreadBadgeEnvironment {
  readonly documentTarget?: FaviconDocument | null;
  readonly renderFavicon?: (sourceHref: string) => Promise<string | null>;
}

function readDocumentTarget(): FaviconDocument | null {
  return typeof document === "undefined" ? null : document;
}

/**
 * Draws the regular app favicon with a high-contrast unread dot in its lower-right corner.
 * A data URL avoids browser favicon caching when the unread state changes.
 */
export function renderUnreadThreadFavicon(sourceHref: string): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener(
      "load",
      () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = FAVICON_SIZE;
          canvas.height = FAVICON_SIZE;
          const context = canvas.getContext("2d");
          if (!context) {
            resolve(null);
            return;
          }

          context.drawImage(image, 0, 0, FAVICON_SIZE, FAVICON_SIZE);

          const badgeRadius = FAVICON_SIZE * 0.17;
          const outlineWidth = FAVICON_SIZE * 0.035;
          const edgeInset = FAVICON_SIZE * 0.025;
          const badgeCenter = FAVICON_SIZE - badgeRadius - outlineWidth - edgeInset;

          context.beginPath();
          context.arc(badgeCenter, badgeCenter, badgeRadius + outlineWidth, 0, Math.PI * 2);
          context.fillStyle = BADGE_OUTLINE_COLOR;
          context.fill();

          context.beginPath();
          context.arc(badgeCenter, badgeCenter, badgeRadius, 0, Math.PI * 2);
          context.fillStyle = BADGE_COLOR;
          context.fill();

          resolve(canvas.toDataURL("image/png"));
        } catch {
          // Favicon updates are best-effort. In particular, a future cross-origin
          // favicon must not surface a canvas security error to the application.
          resolve(null);
        }
      },
      { once: true },
    );
    image.addEventListener("error", () => resolve(null), { once: true });
    image.src = sourceHref;
  });
}

function renderCachedUnreadThreadFavicon(sourceHref: string): Promise<string | null> {
  const cached = unreadFaviconByHref.get(sourceHref);
  if (cached) {
    return cached;
  }
  const rendered = renderUnreadThreadFavicon(sourceHref);
  unreadFaviconByHref.set(sourceHref, rendered);
  return rendered;
}

/**
 * Applies the unread favicon badge and returns a disposer that restores the
 * original favicon. Async rendering is guarded so a stale load cannot overwrite
 * a newer favicon owner or reapply the badge after disposal.
 */
export function applyBrowserTabUnreadBadge(
  hasUnreadThreads: boolean,
  environment: BrowserTabUnreadBadgeEnvironment = {},
): () => void {
  if (!hasUnreadThreads) {
    return () => undefined;
  }

  const documentTarget = environment.documentTarget ?? readDocumentTarget();
  const favicon = documentTarget?.querySelector(FAVICON_SELECTOR) ?? null;
  const originalHref = favicon?.getAttribute("href") ?? null;
  if (!favicon || !originalHref) {
    return () => undefined;
  }

  const renderFavicon = environment.renderFavicon ?? renderCachedUnreadThreadFavicon;
  let disposed = false;
  let appliedHref: string | null = null;

  void renderFavicon(originalHref)
    .then((badgedHref) => {
      if (disposed || !badgedHref || favicon.getAttribute("href") !== originalHref) {
        return;
      }

      appliedHref = badgedHref;
      favicon.setAttribute("href", badgedHref);
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    if (appliedHref && favicon.getAttribute("href") === appliedHref) {
      favicon.setAttribute("href", originalHref);
    }
  };
}
