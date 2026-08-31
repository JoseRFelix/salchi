import type { VcsStatusResult } from "@salchi/contracts";
import * as Schema from "effect/Schema";

import type { InboxChangeRequestSettleSource } from "./inboxLifecycle";

const InboxChangeRequestSnapshotPr = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  updatedAt: Schema.NullOr(Schema.String),
});

export const InboxChangeRequestSnapshot = Schema.Struct({
  branch: Schema.String,
  observedAt: Schema.String,
  pr: Schema.NullOr(InboxChangeRequestSnapshotPr),
});
export type InboxChangeRequestSnapshot = typeof InboxChangeRequestSnapshot.Type;

export const InboxChangeRequestSnapshots = Schema.Record(Schema.String, InboxChangeRequestSnapshot);
export type InboxChangeRequestSnapshots = typeof InboxChangeRequestSnapshots.Type;

/**
 * Records a branch-matched change request and otherwise preserves the last
 * trustworthy observation. A matching branch with no change request clears
 * the snapshot instead of persisting one "known empty" entry per thread.
 */
export function nextInboxChangeRequestSnapshot(input: {
  readonly threadBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly previous: InboxChangeRequestSnapshot | null;
  readonly observedAt: string;
}): InboxChangeRequestSnapshot | null {
  if (input.threadBranch == null) return null;
  if (input.gitStatus == null || input.gitStatus.refName !== input.threadBranch) {
    return input.previous?.branch === input.threadBranch ? input.previous : null;
  }
  const pr = input.gitStatus.pr;
  if (pr == null) return null;
  return {
    branch: input.threadBranch,
    observedAt: input.observedAt,
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      state: pr.state,
      updatedAt: pr.updatedAt ?? null,
    },
  };
}

export function inboxChangeRequestSettleSource(
  snapshot: InboxChangeRequestSnapshot | null | undefined,
): InboxChangeRequestSettleSource | null {
  return snapshot?.pr == null
    ? null
    : { state: snapshot.pr.state, updatedAt: snapshot.pr.updatedAt };
}

export function inboxChangeRequestSnapshotMatches(
  left: InboxChangeRequestSnapshot | null | undefined,
  right: InboxChangeRequestSnapshot,
): boolean {
  if (left == null || left.branch !== right.branch) return false;
  if (left.pr === null || right.pr === null) return left.pr === right.pr;
  return (
    left.pr.number === right.pr.number &&
    left.pr.title === right.pr.title &&
    left.pr.url === right.pr.url &&
    left.pr.baseRef === right.pr.baseRef &&
    left.pr.headRef === right.pr.headRef &&
    left.pr.state === right.pr.state &&
    left.pr.updatedAt === right.pr.updatedAt
  );
}

export function inboxThreadHasBranchMismatch(input: {
  readonly threadBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
}): boolean {
  return (
    input.threadBranch != null &&
    input.gitStatus?.refName != null &&
    input.gitStatus.refName !== input.threadBranch
  );
}
