import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { getRouter, PRODUCTION_ROUTE_PENDING_OPTIONS, resolveRoutePendingOptions } from "./router";

describe("getRouter", () => {
  it("keeps route preloading disabled outside production", () => {
    const router = getRouter(createMemoryHistory({ initialEntries: ["/environment/thread"] }));

    expect(router.options.defaultPreload).toBe(false);
    expect(resolveRoutePendingOptions(false)).toEqual({});
  });

  it("applies the pending shell options in production", () => {
    const options = resolveRoutePendingOptions(true);

    expect(options).toBe(PRODUCTION_ROUTE_PENDING_OPTIONS);
    expect(PRODUCTION_ROUTE_PENDING_OPTIONS.defaultPendingMs).toBe(0);
    expect(PRODUCTION_ROUTE_PENDING_OPTIONS.defaultPendingMinMs).toBe(0);
    expect(PRODUCTION_ROUTE_PENDING_OPTIONS.defaultPendingComponent()).toBeNull();
  });
});
