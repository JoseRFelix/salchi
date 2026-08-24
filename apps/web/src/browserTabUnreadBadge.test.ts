import { describe, expect, it, vi } from "vitest";

import { applyBrowserTabUnreadBadge } from "./browserTabUnreadBadge";

function createFaviconHarness(initialHref = "/salchi-pwa-512.png") {
  let href = initialHref;
  const favicon = {
    getAttribute: vi.fn((name: string) => (name === "href" ? href : null)),
    setAttribute: vi.fn((name: string, value: string) => {
      if (name === "href") href = value;
    }),
  };
  const documentTarget = {
    querySelector: vi.fn(() => favicon),
  };

  return {
    documentTarget,
    favicon,
    getHref: () => href,
    setHref: (value: string) => {
      href = value;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("applyBrowserTabUnreadBadge", () => {
  it("applies a rendered unread favicon and restores the original on cleanup", async () => {
    const harness = createFaviconHarness();
    const renderFavicon = vi.fn(async () => "data:image/png;base64,badged");

    const cleanup = applyBrowserTabUnreadBadge(true, {
      documentTarget: harness.documentTarget,
      renderFavicon,
    });
    await Promise.resolve();

    expect(renderFavicon).toHaveBeenCalledWith("/salchi-pwa-512.png");
    expect(harness.getHref()).toBe("data:image/png;base64,badged");

    cleanup();

    expect(harness.getHref()).toBe("/salchi-pwa-512.png");
  });

  it("leaves the favicon unchanged when there are no unread threads", async () => {
    const harness = createFaviconHarness();
    const renderFavicon = vi.fn(async () => "data:image/png;base64,badged");

    const cleanup = applyBrowserTabUnreadBadge(false, {
      documentTarget: harness.documentTarget,
      renderFavicon,
    });
    await Promise.resolve();
    cleanup();

    expect(renderFavicon).not.toHaveBeenCalled();
    expect(harness.getHref()).toBe("/salchi-pwa-512.png");
  });

  it("does not reapply a pending badge after cleanup", async () => {
    const harness = createFaviconHarness();
    const deferred = createDeferred<string | null>();

    const cleanup = applyBrowserTabUnreadBadge(true, {
      documentTarget: harness.documentTarget,
      renderFavicon: () => deferred.promise,
    });
    cleanup();
    deferred.resolve("data:image/png;base64,stale-badge");
    await deferred.promise;
    await Promise.resolve();

    expect(harness.getHref()).toBe("/salchi-pwa-512.png");
  });

  it("does not overwrite a favicon changed by another owner while rendering", async () => {
    const harness = createFaviconHarness();
    const deferred = createDeferred<string | null>();

    const cleanup = applyBrowserTabUnreadBadge(true, {
      documentTarget: harness.documentTarget,
      renderFavicon: () => deferred.promise,
    });
    harness.setHref("/replacement-icon.png");
    deferred.resolve("data:image/png;base64,stale-badge");
    await deferred.promise;
    await Promise.resolve();

    expect(harness.getHref()).toBe("/replacement-icon.png");
    cleanup();
    expect(harness.getHref()).toBe("/replacement-icon.png");
  });
});
