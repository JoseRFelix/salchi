import { describe, expect, it } from "vitest";

import { getFixedVirtualItemStyle, resolveFixedVirtualRange } from "./useSharedScrollVirtualizer";

describe("resolveFixedVirtualRange", () => {
  it("uses explicit inline edges instead of a percentage width for virtual rows", () => {
    expect(getFixedVirtualItemStyle(3, 30, "6px")).toEqual({
      position: "absolute",
      top: 90,
      insetInline: "6px",
      width: "auto",
    });
  });

  it("returns only viewport-adjacent rows with overscan", () => {
    expect(
      resolveFixedVirtualRange({
        itemCount: 700,
        itemStride: 30,
        viewportStart: 300,
        viewportSize: 300,
        overscan: 60,
      }),
    ).toEqual({ startIndex: 8, endIndex: 22 });
  });

  it("returns no rows for a list wholly below the viewport", () => {
    expect(
      resolveFixedVirtualRange({
        itemCount: 700,
        itemStride: 30,
        viewportStart: -1_000,
        viewportSize: 300,
        overscan: 60,
      }),
    ).toEqual({ startIndex: 0, endIndex: 0 });
  });

  it("clamps ranges at the end of the list", () => {
    expect(
      resolveFixedVirtualRange({
        itemCount: 10,
        itemStride: 30,
        viewportStart: 240,
        viewportSize: 300,
        overscan: 60,
      }),
    ).toEqual({ startIndex: 6, endIndex: 10 });
  });

  it("handles empty and invalid list geometry", () => {
    expect(
      resolveFixedVirtualRange({
        itemCount: 0,
        itemStride: 30,
        viewportStart: 0,
        viewportSize: 300,
        overscan: 60,
      }),
    ).toEqual({ startIndex: 0, endIndex: 0 });
    expect(
      resolveFixedVirtualRange({
        itemCount: 10,
        itemStride: 0,
        viewportStart: 0,
        viewportSize: 300,
        overscan: 60,
      }),
    ).toEqual({ startIndex: 0, endIndex: 0 });
  });
});
