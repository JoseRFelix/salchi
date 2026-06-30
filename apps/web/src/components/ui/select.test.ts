import { describe, expect, it } from "vitest";
import { resolveSelectCollisionPadding } from "./select";

describe("resolveSelectCollisionPadding", () => {
  it("adds safe-area insets to Base UI's default collision padding", () => {
    expect(
      resolveSelectCollisionPadding(undefined, {
        top: 47,
        right: 0,
        bottom: 34,
        left: 0,
      }),
    ).toEqual({
      top: 52,
      right: 5,
      bottom: 39,
      left: 5,
    });
  });

  it("adds safe-area insets to numeric collision padding", () => {
    expect(
      resolveSelectCollisionPadding(8, {
        top: 47,
        right: 2,
        bottom: 34,
        left: 3,
      }),
    ).toEqual({
      top: 55,
      right: 10,
      bottom: 42,
      left: 11,
    });
  });

  it("preserves per-side collision padding before adding safe-area insets", () => {
    expect(
      resolveSelectCollisionPadding(
        { top: 12, bottom: 2 },
        {
          top: 47,
          right: 3,
          bottom: 34,
          left: 0,
        },
      ),
    ).toEqual({
      top: 59,
      right: 3,
      bottom: 36,
      left: 0,
    });
  });
});
