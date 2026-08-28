import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isBrowserRootThread, resolveBrowserRootThreadId } from "./BrowserThreadRoot.ts";

function thread(
  id: string,
  relationships: {
    readonly parentThreadId?: string | null;
    readonly createdByThreadId?: string | null;
  } = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("browser-root-test-project"),
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-default"),
      model: "test-model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    parentThreadId:
      relationships.parentThreadId === undefined
        ? null
        : relationships.parentThreadId === null
          ? null
          : ThreadId.make(relationships.parentThreadId),
    createdByThreadId:
      relationships.createdByThreadId === undefined
        ? null
        : relationships.createdByThreadId === null
          ? null
          : ThreadId.make(relationships.createdByThreadId),
    subagentKind: null,
    subagentNickname: null,
    subagentRole: null,
    hiddenFromThreadList: false,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

it.effect("resolves materialized and virtual provider sessions to one root thread", () => {
  const root = thread("root");
  const virtual = thread("codex-tool:exec-1", { createdByThreadId: "root" });
  const child = thread("codex-child-1", { parentThreadId: "codex-tool:exec-1" });
  const threads = new Map([root, virtual, child].map((value) => [value.id, value]));

  return Effect.gen(function* () {
    const resolved = yield* resolveBrowserRootThreadId(
      {
        getThreadShellById: (threadId) =>
          Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
      },
      child.id,
    );

    assert.equal(resolved, root.id);
    assert.isTrue(isBrowserRootThread(root));
    assert.isFalse(isBrowserRootThread(virtual));
    assert.isFalse(isBrowserRootThread(child));
  });
});

it.effect("rejects missing and cyclic browser ancestry", () => {
  const first = thread("cycle-a", { parentThreadId: "cycle-b" });
  const second = thread("cycle-b", { createdByThreadId: "cycle-a" });
  const threads = new Map([first, second].map((value) => [value.id, value]));
  const lookup = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
  };

  return Effect.gen(function* () {
    const missing = yield* Effect.flip(
      resolveBrowserRootThreadId(lookup, ThreadId.make("missing")),
    );
    assert.equal(missing._tag, "ThreadNotFound");

    const cyclic = yield* Effect.flip(resolveBrowserRootThreadId(lookup, first.id));
    assert.equal(cyclic._tag, "BrowserOperationError");
  });
});
