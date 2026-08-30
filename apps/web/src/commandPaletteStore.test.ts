import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPaletteStore } from "./commandPaletteStore";

describe("commandPaletteStore open intents", () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ open: false, openIntent: null });
  });

  it("opens directly into the new-thread project picker", () => {
    useCommandPaletteStore.getState().openNewThreadIn();

    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      openIntent: { kind: "new-thread-in", requestId: 1 },
    });
  });

  it("clears a pending intent when the palette closes", () => {
    useCommandPaletteStore.getState().openNewThreadIn();
    useCommandPaletteStore.getState().setOpen(false);

    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: false,
      openIntent: null,
    });
  });
});
