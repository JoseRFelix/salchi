export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-screen max-[760px]:min-w-0 max-[760px]:max-w-none wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

export type RightPanelSurfaceView = "diff" | "files";

export function resolveRightPanelSurfaceView(input: {
  readonly diffRouteOpen: boolean;
  readonly panelOpen: boolean;
  readonly panelView: "diff" | "explorer" | "preview" | "source-control";
}): RightPanelSurfaceView | null {
  if (input.panelOpen) {
    return input.panelView === "diff" ? "diff" : "files";
  }
  return input.diffRouteOpen ? "diff" : null;
}
