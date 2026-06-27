import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, type ReactNode } from "react";
import { CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH } from "../codeHighlighting";
import { useSelectedSyntaxTheme, type SyntaxThemeName } from "../syntaxThemes";

function DiffWorkerThemeSync({ themeName }: { themeName: SyntaxThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    const current = workerPool.getDiffRenderOptions();
    if (current.theme === themeName) {
      return;
    }

    void workerPool
      .setRenderOptions({
        ...current,
        theme: themeName,
      })
      .catch(() => undefined);
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const selectedSyntaxTheme = useSelectedSyntaxTheme();
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: selectedSyntaxTheme.themeName,
        tokenizeMaxLineLength: CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH,
      }}
    >
      <DiffWorkerThemeSync themeName={selectedSyntaxTheme.themeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}
