import {
  BrowserOperationError,
  ThreadNotFound,
  type BrowserRpcError,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface BrowserThreadLookup<E> {
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, E>;
}

export function isBrowserRootThread(thread: OrchestrationThreadShell): boolean {
  return thread.parentThreadId === null && thread.createdByThreadId === null;
}

/**
 * Browser ownership follows both materialized-child (`parentThreadId`) and
 * provider-created virtual-session (`createdByThreadId`) relationships. The
 * first ancestor with neither relationship owns the browser session/profile.
 */
export function resolveBrowserRootThreadId<E>(
  lookup: BrowserThreadLookup<E>,
  requestedThreadId: ThreadId,
): Effect.Effect<ThreadId, BrowserRpcError> {
  return Effect.gen(function* () {
    let currentThreadId = requestedThreadId;
    const visited = new Set<string>();

    while (true) {
      if (visited.has(currentThreadId)) {
        return yield* new BrowserOperationError({
          threadId: requestedThreadId,
          message: `Browser thread ancestry contains a cycle at ${currentThreadId}.`,
        });
      }
      visited.add(currentThreadId);

      const thread = yield* lookup.getThreadShellById(currentThreadId).pipe(
        Effect.mapError(
          (cause) =>
            new BrowserOperationError({
              threadId: requestedThreadId,
              message: `Failed to resolve the root browser thread for ${requestedThreadId}.`,
              cause,
            }),
        ),
      );
      if (Option.isNone(thread)) {
        return yield* new ThreadNotFound({
          threadId: requestedThreadId,
          message: `Thread ${requestedThreadId} was not found.`,
        });
      }

      const ownerThreadId = thread.value.parentThreadId ?? thread.value.createdByThreadId ?? null;
      if (ownerThreadId === null) return thread.value.id;
      currentThreadId = ownerThreadId;
    }
  });
}
