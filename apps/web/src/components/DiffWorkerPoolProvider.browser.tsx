import { useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { useEffect, useReducer } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

function WorkerPoolProbe() {
  const workerPool = useWorkerPool();
  const [, reportStatsChange] = useReducer((version: number) => version + 1, 0);

  useEffect(() => workerPool?.subscribeToStatChanges(reportStatsChange), [workerPool]);

  const stats = workerPool?.getStats();
  const caches = workerPool?.inspectCaches();
  return (
    <output
      data-diff-cache-limit={caches?.diffCache.limit ?? -1}
      data-file-cache-limit={caches?.fileCache.limit ?? -1}
      data-manager-state={stats?.managerState ?? "missing"}
      data-total-workers={stats?.totalWorkers ?? -1}
      data-testid="worker-pool-probe"
    />
  );
}

it("uses cacheless mobile storage and terminates the pool when the PWA backgrounds", async () => {
  const terminateSpy = vi.spyOn(WorkerPoolManager.prototype, "terminate");
  const screen = await render(
    <DiffWorkerPoolProvider profile="memory-constrained">
      <WorkerPoolProbe />
    </DiffWorkerPoolProvider>,
  );

  try {
    const probe = screen.getByTestId("worker-pool-probe");
    expect(probe.element().dataset.diffCacheLimit).toBe("0");
    expect(probe.element().dataset.fileCacheLimit).toBe("0");

    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => {
      expect(terminateSpy).toHaveBeenCalledOnce();
    });
  } finally {
    await screen.unmount();
    terminateSpy.mockRestore();
  }
});
