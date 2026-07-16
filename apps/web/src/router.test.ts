import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { getRouter, PRODUCTION_ROUTE_PENDING_OPTIONS } from "./router";

describe("getRouter", () => {
  it("keeps the root shell renderable while a child route is pending", () => {
    const router = getRouter(createMemoryHistory({ initialEntries: ["/environment/thread"] }));

    expect(router.options.defaultPreload).toBe(false);
    expect(PRODUCTION_ROUTE_PENDING_OPTIONS.defaultPendingMs).toBe(0);
    expect(PRODUCTION_ROUTE_PENDING_OPTIONS.defaultPendingMinMs).toBe(0);
    expect(PRODUCTION_ROUTE_PENDING_OPTIONS.defaultPendingComponent()).toBeNull();
  });
});
