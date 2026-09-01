import { ProjectId, ThreadId, ProviderInstanceId } from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        seenCompletionTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("round-trips synchronized inbox lifecycle fields", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-inbox-lifecycle");
      const unsettledAt = "2026-03-24T01:00:00.000Z";
      const snoozedAt = "2026-03-24T02:00:00.000Z";
      const snoozedUntil = "2026-03-25T09:00:00.000Z";
      const pinnedAt = "2026-03-24T03:00:00.000Z";

      yield* threads.upsert({
        threadId,
        projectId: ProjectId.make("project-inbox-lifecycle"),
        title: "Persisted inbox lifecycle",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        seenCompletionTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: pinnedAt,
        archivedAt: null,
        settledOverride: "active",
        settledAt: null,
        unsettledAt,
        snoozedUntil,
        snoozedAt,
        pinnedAt,
        pinOrderKey: "bd",
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
        readonly snoozedUntil: string | null;
        readonly snoozedAt: string | null;
        readonly pinnedAt: string | null;
        readonly pinOrderKey: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey"
        FROM projection_threads
        WHERE thread_id = 'thread-inbox-lifecycle'
      `;
      assert.deepStrictEqual(rows[0], {
        settledOverride: "active",
        settledAt: null,
        unsettledAt,
        snoozedUntil,
        snoozedAt,
        pinnedAt,
        pinOrderKey: "bd",
      });

      const persisted = Option.getOrNull(yield* threads.getById({ threadId }));
      assert.deepStrictEqual(
        persisted && {
          settledOverride: persisted.settledOverride,
          settledAt: persisted.settledAt,
          unsettledAt: persisted.unsettledAt,
          snoozedUntil: persisted.snoozedUntil,
          snoozedAt: persisted.snoozedAt,
          pinnedAt: persisted.pinnedAt,
          pinOrderKey: persisted.pinOrderKey,
        },
        {
          settledOverride: "active",
          settledAt: null,
          unsettledAt,
          snoozedUntil,
          snoozedAt,
          pinnedAt,
          pinOrderKey: "bd",
        },
      );
    }),
  );
});
