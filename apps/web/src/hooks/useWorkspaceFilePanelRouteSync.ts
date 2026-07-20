import type { TurnId } from "@salchi/contracts";
import { useLayoutEffect } from "react";

import type { DiffRouteSource } from "../diffRouteSearch";
import {
  claimWorkspaceFilePanelOwner,
  releaseWorkspaceFilePanelOwner,
  syncWorkspaceDiffPanelRoute,
  type WorkspaceFilePanelOwnerKey,
} from "../workspaceFilePreview";

export function useWorkspaceFilePanelRouteSync(input: {
  ownerKey: WorkspaceFilePanelOwnerKey | null;
  diffOpen: boolean;
  diffSource?: DiffRouteSource;
  diffTurnId?: TurnId;
  diffFilePath?: string;
}): void {
  const { ownerKey, diffOpen, diffSource, diffTurnId, diffFilePath } = input;

  useLayoutEffect(() => {
    if (!ownerKey) {
      return;
    }
    claimWorkspaceFilePanelOwner(ownerKey);
    return () => {
      releaseWorkspaceFilePanelOwner(ownerKey);
    };
  }, [ownerKey]);

  useLayoutEffect(() => {
    if (!ownerKey) {
      return;
    }
    syncWorkspaceDiffPanelRoute(
      ownerKey,
      diffOpen
        ? {
            kind: "diff",
            ...(diffSource ? { diffSource } : {}),
            ...(diffTurnId ? { diffTurnId } : {}),
            ...(diffFilePath ? { diffFilePath } : {}),
          }
        : null,
    );
  }, [diffFilePath, diffOpen, diffSource, diffTurnId, ownerKey]);
}
