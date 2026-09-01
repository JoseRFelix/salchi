import type { EnvironmentId, VcsStatusResult } from "@salchi/contracts";
import { useEffect, useMemo } from "react";

import type { InboxChangeRequestObservedThread } from "../../inboxChangeRequestState";
import { useGitStatus } from "../../lib/gitStatusState";

export function InboxChangeRequestObserver(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly threadKey: string;
  readonly branch: string | null;
  readonly onObservation: (
    threads: readonly InboxChangeRequestObservedThread[],
    gitStatus: VcsStatusResult,
  ) => void;
}) {
  // This component intentionally lives beside a virtualized row. Mounting the
  // row retains its target; scrolling it out releases the target again.
  const gitStatus = useGitStatus({
    environmentId: props.environmentId,
    cwd: props.branch === null ? null : props.cwd,
  });
  const observedThreads = useMemo(
    () =>
      props.branch === null
        ? []
        : ([
            { threadKey: props.threadKey, branch: props.branch },
          ] satisfies readonly InboxChangeRequestObservedThread[]),
    [props.branch, props.threadKey],
  );

  useEffect(() => {
    if (gitStatus.data !== null && observedThreads.length > 0) {
      props.onObservation(observedThreads, gitStatus.data);
    }
  }, [gitStatus.data, observedThreads, props.onObservation]);

  return null;
}
