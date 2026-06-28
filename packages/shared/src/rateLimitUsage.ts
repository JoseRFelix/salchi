const USED_PERCENT_FIELDS = [
  "usedPercentage",
  "used_percentage",
  "usedPercent",
  "used_percent",
  "usagePercentage",
  "usage_percentage",
  "usagePercent",
  "usage_percent",
  "percentUsed",
  "percent_used",
] as const;

const USED_FRACTION_FIELDS = [
  "utilization",
  "usedFraction",
  "used_fraction",
  "usageFraction",
  "usage_fraction",
] as const;

const REMAINING_PERCENT_FIELDS = [
  "remainingPercentage",
  "remaining_percentage",
  "remainingPercent",
  "remaining_percent",
  "percentRemaining",
  "percent_remaining",
] as const;

const REMAINING_FRACTION_FIELDS = ["remainingFraction", "remaining_fraction"] as const;
const LIMIT_FIELDS = ["limit", "quota", "maximum", "max"] as const;
const USED_VALUE_FIELDS = ["used", "usage", "consumed", "current"] as const;
const REMAINING_VALUE_FIELDS = ["remaining", "available"] as const;

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readFirstFiniteNumber(
  record: Record<string, unknown>,
  fieldNames: ReadonlyArray<string>,
): number | null {
  for (const fieldName of fieldNames) {
    const value = asFiniteNumber(record[fieldName]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampPercentLikeValue(value: number): number {
  return clampPercent(value >= 0 && value <= 1 ? value * 100 : value);
}

export function normalizeUsageWindowUsedPercent(record: Record<string, unknown>): number | null {
  const usedPercent = readFirstFiniteNumber(record, USED_PERCENT_FIELDS);
  if (usedPercent !== null) {
    return clampPercent(usedPercent);
  }

  const usedFraction = readFirstFiniteNumber(record, USED_FRACTION_FIELDS);
  if (usedFraction !== null) {
    return clampPercentLikeValue(usedFraction);
  }

  const remainingPercent = readFirstFiniteNumber(record, REMAINING_PERCENT_FIELDS);
  if (remainingPercent !== null) {
    return clampPercent(100 - remainingPercent);
  }

  const remainingFraction = readFirstFiniteNumber(record, REMAINING_FRACTION_FIELDS);
  if (remainingFraction !== null) {
    return clampPercent(100 - clampPercentLikeValue(remainingFraction));
  }

  const limit = readFirstFiniteNumber(record, LIMIT_FIELDS);
  if (limit === null || limit <= 0) {
    return null;
  }

  const used = readFirstFiniteNumber(record, USED_VALUE_FIELDS);
  if (used !== null) {
    return clampPercent((used / limit) * 100);
  }

  const remaining = readFirstFiniteNumber(record, REMAINING_VALUE_FIELDS);
  return remaining === null ? null : clampPercent(((limit - remaining) / limit) * 100);
}
