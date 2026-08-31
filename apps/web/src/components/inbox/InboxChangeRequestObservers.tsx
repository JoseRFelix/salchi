import type { VcsStatusResult } from "@salchi/contracts";
import { useEffect } from "react";

import type {
  InboxChangeRequestObservationGroup,
  InboxChangeRequestObservedThread,
} from "../../inboxChangeRequestState";
import { useGitStatus } from "../../lib/gitStatusState";

function InboxChangeRequestTargetObserver(props: {
  readonly group: InboxChangeRequestObservationGroup;
  readonly onObservation: (
    threads: readonly InboxChangeRequestObservedThread[],
    gitStatus: VcsStatusResult,
  ) => void;
}) {
  const gitStatus = useGitStatus({
    environmentId: props.group.environmentId,
    cwd: props.group.cwd,
  });

  useEffect(() => {
    if (gitStatus.data !== null) {
      props.onObservation(props.group.threads, gitStatus.data);
    }
  }, [gitStatus.data, props.group.threads, props.onObservation]);

  return null;
}

export function InboxChangeRequestObservers(props: {
  readonly groups: readonly InboxChangeRequestObservationGroup[];
  readonly onObservation: (
    threads: readonly InboxChangeRequestObservedThread[],
    gitStatus: VcsStatusResult,
  ) => void;
}) {
  return props.groups.map((group) => (
    <InboxChangeRequestTargetObserver
      key={group.key}
      group={group}
      onObservation={props.onObservation}
    />
  ));
}
