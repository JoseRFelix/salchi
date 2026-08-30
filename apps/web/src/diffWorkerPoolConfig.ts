export type DiffWorkerPoolProfile = "memory-constrained" | "standard";

export interface DiffWorkerPoolConfig {
  readonly poolSize: number;
  readonly totalASTLRUCacheSize: number;
}

const DEFAULT_HARDWARE_CONCURRENCY = 4;

function normalizeHardwareConcurrency(hardwareConcurrency: number | undefined): number {
  if (!Number.isFinite(hardwareConcurrency) || !hardwareConcurrency || hardwareConcurrency < 1) {
    return DEFAULT_HARDWARE_CONCURRENCY;
  }
  return Math.max(1, Math.floor(hardwareConcurrency));
}

export function resolveDiffWorkerPoolConfig(
  profile: DiffWorkerPoolProfile,
  hardwareConcurrency: number | undefined,
): DiffWorkerPoolConfig {
  if (profile === "memory-constrained") {
    return {
      poolSize: 1,
      // This cache is entry-count based rather than byte bounded. A single
      // highlighted diff AST can be large, so mobile WebKit keeps no completed
      // ASTs after they have been delivered to the mounted renderer.
      totalASTLRUCacheSize: 0,
    };
  }

  const cores = normalizeHardwareConcurrency(hardwareConcurrency);
  return {
    poolSize: Math.max(2, Math.min(6, Math.floor(cores / 2))),
    totalASTLRUCacheSize: 240,
  };
}
