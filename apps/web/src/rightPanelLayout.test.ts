import { describe, expect, it } from "vitest";

import { resolveRightPanelSurfaceView } from "./rightPanelLayout";

describe("resolveRightPanelSurfaceView", () => {
  it("uses the active stack entry instead of opening discrete panels", () => {
    expect(
      resolveRightPanelSurfaceView({
        diffRouteOpen: true,
        panelOpen: true,
        panelView: "preview",
      }),
    ).toBe("files");
    expect(
      resolveRightPanelSurfaceView({
        diffRouteOpen: true,
        panelOpen: true,
        panelView: "diff",
      }),
    ).toBe("diff");
  });

  it("falls back to a deep-linked diff until the stack synchronizes", () => {
    expect(
      resolveRightPanelSurfaceView({
        diffRouteOpen: true,
        panelOpen: false,
        panelView: "preview",
      }),
    ).toBe("diff");
  });
});
