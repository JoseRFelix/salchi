import { describe, expect, it } from "vitest";

import { resolveDiffWorkerPoolConfig } from "./diffWorkerPoolConfig";

describe("resolveDiffWorkerPoolConfig", () => {
  it("uses one cacheless worker for every memory-constrained device", () => {
    expect(resolveDiffWorkerPoolConfig("memory-constrained", 1)).toEqual({
      poolSize: 1,
      totalASTLRUCacheSize: 0,
    });
    expect(resolveDiffWorkerPoolConfig("memory-constrained", 32)).toEqual({
      poolSize: 1,
      totalASTLRUCacheSize: 0,
    });
  });

  it("preserves bounded parallel highlighting for standard layouts", () => {
    expect(resolveDiffWorkerPoolConfig("standard", 1)).toEqual({
      poolSize: 2,
      totalASTLRUCacheSize: 240,
    });
    expect(resolveDiffWorkerPoolConfig("standard", 8)).toEqual({
      poolSize: 4,
      totalASTLRUCacheSize: 240,
    });
    expect(resolveDiffWorkerPoolConfig("standard", 32)).toEqual({
      poolSize: 6,
      totalASTLRUCacheSize: 240,
    });
  });

  it("falls back safely when hardware concurrency is unavailable", () => {
    expect(resolveDiffWorkerPoolConfig("standard", undefined)).toEqual({
      poolSize: 2,
      totalASTLRUCacheSize: 240,
    });
    expect(resolveDiffWorkerPoolConfig("standard", Number.NaN)).toEqual({
      poolSize: 2,
      totalASTLRUCacheSize: 240,
    });
  });
});
