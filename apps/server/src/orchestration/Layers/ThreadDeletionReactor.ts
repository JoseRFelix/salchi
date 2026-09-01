import type { OrchestrationEvent } from "@salchi/contracts";
import { makeDrainableWorker } from "@salchi/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  browserProfileRoot,
  deleteBrowserProfileForThread,
} from "../../browser/BrowserProfiles.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { TurnFileSnapshotsLive } from "../../persistence/Layers/TurnFileSnapshots.ts";
import { TurnFileSnapshots } from "../../persistence/Services/TurnFileSnapshots.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { BrowserSessionManager } from "../../browser/Services/BrowserSessionManager.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export function runThreadDeletionCleanup<
  StopError,
  TerminalError,
  BrowserError,
  BrowserProfileError,
  SnapshotError,
  LogError,
>(input: {
  readonly stopProviderSession: Effect.Effect<void, StopError>;
  readonly closeThreadTerminals: Effect.Effect<void, TerminalError>;
  readonly stopThreadBrowser: Effect.Effect<void, BrowserError>;
  readonly deleteThreadBrowserProfile: Effect.Effect<void, BrowserProfileError>;
  readonly deleteTurnFileSnapshots: Effect.Effect<void, SnapshotError>;
  readonly deleteProviderEventLogs: Effect.Effect<void, LogError>;
}): Effect.Effect<
  void,
  StopError | TerminalError | BrowserError | BrowserProfileError | SnapshotError | LogError
> {
  return Effect.gen(function* () {
    yield* input.stopProviderSession;
    yield* input.closeThreadTerminals;
    yield* input.stopThreadBrowser;
    yield* input.deleteThreadBrowserProfile;
    yield* input.deleteTurnFileSnapshots;
    yield* input.deleteProviderEventLogs;
  });
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerEventLoggers = yield* ProviderEventLoggers;
  const terminalManager = yield* TerminalManager;
  const browserSessionManager = yield* BrowserSessionManager;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const turnFileSnapshots = yield* TurnFileSnapshots;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const stopThreadBrowser = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: browserSessionManager.stop(threadId).pipe(Effect.asVoid),
      message: "thread deletion cleanup skipped browser stop",
      threadId,
    });

  const deleteThreadBrowserProfile = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: deleteBrowserProfileForThread({
        profileRoot: browserProfileRoot(config.baseDir, path),
        threadId,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      message: "thread deletion cleanup skipped browser profile deletion",
      threadId,
    });

  const deleteTurnFileSnapshots = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: turnFileSnapshots.deleteByThread({ threadId }),
      message: "thread deletion cleanup skipped turn file snapshots",
      threadId,
    });

  const deleteProviderEventLogs = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerEventLoggers.deleteThreadLogs(threadId),
      message: "thread deletion cleanup skipped provider diagnostics",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* runThreadDeletionCleanup({
      stopProviderSession: stopProviderSession(threadId),
      closeThreadTerminals: closeThreadTerminals(threadId),
      stopThreadBrowser: stopThreadBrowser(threadId),
      deleteThreadBrowserProfile: deleteThreadBrowserProfile(threadId),
      deleteTurnFileSnapshots: deleteTurnFileSnapshots(threadId),
      deleteProviderEventLogs: deleteProviderEventLogs(threadId),
    });
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make).pipe(
  Layer.provide(TurnFileSnapshotsLive),
);
