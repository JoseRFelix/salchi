import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, type ReactNode } from "react";
import { CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH } from "../codeHighlighting";
import { resolveDiffWorkerPoolConfig, type DiffWorkerPoolProfile } from "../diffWorkerPoolConfig";
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

function DiffWorkerMobileLifecycleRelease({ enabled }: { enabled: boolean }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!enabled || !workerPool) {
      return;
    }

    const releaseForBackground = () => {
      workerPool.terminate();
    };
    const releaseWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        releaseForBackground();
      }
    };

    document.addEventListener("visibilitychange", releaseWhenHidden);
    window.addEventListener("pagehide", releaseForBackground);
    return () => {
      document.removeEventListener("visibilitychange", releaseWhenHidden);
      window.removeEventListener("pagehide", releaseForBackground);
    };
  }, [enabled, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({
  children,
  profile = "standard",
}: {
  children?: ReactNode;
  profile?: DiffWorkerPoolProfile;
}) {
  const selectedSyntaxTheme = useSelectedSyntaxTheme();
  const workerPoolConfig = useMemo(
    () =>
      resolveDiffWorkerPoolConfig(
        profile,
        typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
      ),
    [profile],
  );

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        ...workerPoolConfig,
      }}
      highlighterOptions={{
        theme: selectedSyntaxTheme.themeName,
        tokenizeMaxLineLength: CODE_HIGHLIGHT_TOKENIZE_MAX_LINE_LENGTH,
      }}
    >
      <DiffWorkerThemeSync themeName={selectedSyntaxTheme.themeName} />
      <DiffWorkerMobileLifecycleRelease enabled={profile === "memory-constrained"} />
      {children}
    </WorkerPoolContextProvider>
  );
}
