import { describe, expect, it } from "vitest";

import { normalizeUsageWindowUsedPercent, readFirstPresentValue } from "./rateLimitUsage.ts";

describe("normalizeUsageWindowUsedPercent", () => {
  it("normalizes explicit used percent aliases", () => {
    expect(normalizeUsageWindowUsedPercent({ usedPercentage: 88 })).toBe(88);
    expect(normalizeUsageWindowUsedPercent({ usage_percent: "101" })).toBe(100);
  });

  it("normalizes fraction aliases as percentages", () => {
    expect(normalizeUsageWindowUsedPercent({ utilization: 0.42 })).toBe(42);
    expect(normalizeUsageWindowUsedPercent({ usedFraction: "0.5" })).toBe(50);
  });

  it("derives used percentage from remaining capacity", () => {
    expect(normalizeUsageWindowUsedPercent({ remainingPercentage: 1 })).toBe(99);
    expect(normalizeUsageWindowUsedPercent({ remainingFraction: 0.12 })).toBe(88);
  });

  it("derives used percentage from quota fields", () => {
    expect(normalizeUsageWindowUsedPercent({ limit: 100, used: 64 })).toBe(64);
    expect(normalizeUsageWindowUsedPercent({ limit: 100, remaining: 12 })).toBe(88);
  });
});

describe("readFirstPresentValue", () => {
  it("skips null alias placeholders", () => {
    expect(
      readFirstPresentValue({ resets_at: null, resetsAt: "2026-06-28T12:00:00.000Z" }, [
        "resets_at",
        "resetsAt",
      ]),
    ).toBe("2026-06-28T12:00:00.000Z");
  });
});
