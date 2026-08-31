import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          seen_completion_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          parentThreadId: null,
          createdByThreadId: null,
          subagentKind: null,
          subagentNickname: null,
          subagentRole: null,
          hiddenFromThreadList: false,
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          seenCompletionTurnId: asTurnId("turn-1"),
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          pinOrderKey: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          queuedTurns: [],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              attribution: "unattributed",
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.equal(shellSnapshot.completionAttentionSequence, 6);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          parentThreadId: null,
          createdByThreadId: null,
          subagentKind: null,
          subagentNickname: null,
          subagentRole: null,
          hiddenFromThreadList: false,
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          seenCompletionTurnId: asTurnId("turn-1"),
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          pinOrderKey: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }
    }),
  );

  it.effect("includes repaired queued-dispatch messages in detail snapshot order", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-reconnect-queued',
          'Reconnect queued project',
          '/tmp/reconnect-queued',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-reconnect-queued',
          'project-reconnect-queued',
          'Reconnect queued thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-05-01T00:05:00.000Z',
          0,
          0,
          0,
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:05:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-before-dispatch',
            'thread-reconnect-queued',
            NULL,
            'assistant',
            'before dispatch',
            '[]',
            0,
            '2026-05-01T00:02:00.000Z',
            '2026-05-01T00:02:00.000Z'
          ),
          (
            'message-queued-dispatch',
            'thread-reconnect-queued',
            NULL,
            'user',
            'queued dispatch',
            '[]',
            0,
            '2026-05-01T00:05:00.000Z',
            '2026-05-01T00:05:00.000Z'
          ),
          (
            'message-after-dispatch',
            'thread-reconnect-queued',
            NULL,
            'assistant',
            'after dispatch',
            '[]',
            0,
            '2026-05-01T00:06:00.000Z',
            '2026-05-01T00:06:00.000Z'
          )
      `;

      const detail = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-reconnect-queued"),
      );

      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        assert.deepEqual(
          detail.value.thread.messages.map((message) => message.id),
          [
            asMessageId("message-before-dispatch"),
            asMessageId("message-queued-dispatch"),
            asMessageId("message-after-dispatch"),
          ],
        );
        assert.equal(
          detail.value.thread.messages.find(
            (message) => message.id === asMessageId("message-queued-dispatch"),
          )?.createdAt,
          "2026-05-01T00:05:00.000Z",
        );
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:20.000Z',
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const newestUserMessageThreadId =
          yield* snapshotQuery.getMostRecentActiveThreadIdByProjectId(
            asProjectId("project-active"),
          );
        assert.equal(newestUserMessageThreadId._tag, "Some");
        if (newestUserMessageThreadId._tag === "Some") {
          assert.equal(newestUserMessageThreadId.value, ThreadId.make("thread-first"));
        }

        yield* sql`
          UPDATE projection_threads
          SET updated_at = '2026-03-01T00:00:25.000Z'
          WHERE thread_id = 'thread-second'
        `;

        const newestUpdatedThreadId = yield* snapshotQuery.getMostRecentActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(newestUpdatedThreadId._tag, "Some");
        if (newestUpdatedThreadId._tag === "Some") {
          assert.equal(newestUpdatedThreadId.value, ThreadId.make("thread-second"));
        }

        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            latest_turn_id,
            latest_user_message_at,
            hidden_from_thread_list,
            created_at,
            updated_at,
            archived_at,
            deleted_at
          )
          VALUES (
            'thread-hidden',
            'project-active',
            'Hidden Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:40.000Z',
            1,
            '2026-03-01T00:00:30.000Z',
            '2026-03-01T00:00:35.000Z',
            NULL,
            NULL
          )
        `;

        const visibleThreadId = yield* snapshotQuery.getMostRecentActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(visibleThreadId._tag, "Some");
        if (visibleThreadId._tag === "Some") {
          assert.equal(visibleThreadId.value, ThreadId.make("thread-second"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              attribution: "unattributed",
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              attribution: "unattributed",
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("paginates thread detail snapshots by collection cursors", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-page',
          'Project Page',
          '/tmp/project-page',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-page',
          'project-page',
          'Thread Page',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-5',
          '2026-04-03T00:00:05.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:05.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          ('message-1', 'thread-page', 'turn-1', 'user', 'message 1', 0, '2026-04-03T00:00:01.000Z', '2026-04-03T00:00:01.000Z'),
          ('message-2', 'thread-page', 'turn-2', 'user', 'message 2', 0, '2026-04-03T00:00:02.000Z', '2026-04-03T00:00:02.000Z'),
          ('message-3', 'thread-page', 'turn-3', 'user', 'message 3', 0, '2026-04-03T00:00:03.000Z', '2026-04-03T00:00:03.000Z'),
          ('message-4', 'thread-page', 'turn-4', 'user', 'message 4', 0, '2026-04-03T00:00:04.000Z', '2026-04-03T00:00:04.000Z'),
          ('message-5', 'thread-page', 'turn-5', 'user', 'message 5', 0, '2026-04-03T00:00:05.000Z', '2026-04-03T00:00:05.000Z')
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES
          ('plan-1', 'thread-page', 'turn-1', 'plan 1', NULL, NULL, '2026-04-03T00:00:01.000Z', '2026-04-03T00:00:01.000Z'),
          ('plan-2', 'thread-page', 'turn-2', 'plan 2', NULL, NULL, '2026-04-03T00:00:02.000Z', '2026-04-03T00:00:02.000Z'),
          ('plan-3', 'thread-page', 'turn-3', 'plan 3', NULL, NULL, '2026-04-03T00:00:03.000Z', '2026-04-03T00:00:03.000Z'),
          ('plan-4', 'thread-page', 'turn-4', 'plan 4', NULL, NULL, '2026-04-03T00:00:04.000Z', '2026-04-03T00:00:04.000Z'),
          ('plan-5', 'thread-page', 'turn-5', 'plan 5', NULL, NULL, '2026-04-03T00:00:05.000Z', '2026-04-03T00:00:05.000Z')
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          ('activity-1', 'thread-page', 'turn-1', 'info', 'runtime.note', 'activity 1', '{}', 1, '2026-04-03T00:00:01.000Z'),
          ('activity-2', 'thread-page', 'turn-2', 'info', 'runtime.note', 'activity 2', '{}', 2, '2026-04-03T00:00:02.000Z'),
          ('activity-3', 'thread-page', 'turn-3', 'info', 'runtime.note', 'activity 3', '{}', 3, '2026-04-03T00:00:03.000Z'),
          ('activity-4', 'thread-page', 'turn-4', 'info', 'runtime.note', 'activity 4', '{}', 4, '2026-04-03T00:00:04.000Z'),
          ('activity-5', 'thread-page', 'turn-5', 'info', 'runtime.note', 'activity 5', '{}', 5, '2026-04-03T00:00:05.000Z')
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          ('thread-page', 'turn-1', 'message-1', NULL, NULL, NULL, 'completed', '2026-04-03T00:00:01.000Z', '2026-04-03T00:00:01.000Z', '2026-04-03T00:00:01.000Z', 1, 'checkpoint-1', 'ready', '[]'),
          ('thread-page', 'turn-2', 'message-2', NULL, NULL, NULL, 'completed', '2026-04-03T00:00:02.000Z', '2026-04-03T00:00:02.000Z', '2026-04-03T00:00:02.000Z', 2, 'checkpoint-2', 'ready', '[]'),
          ('thread-page', 'turn-3', 'message-3', NULL, NULL, NULL, 'completed', '2026-04-03T00:00:03.000Z', '2026-04-03T00:00:03.000Z', '2026-04-03T00:00:03.000Z', 3, 'checkpoint-3', 'ready', '[]'),
          ('thread-page', 'turn-4', 'message-4', NULL, NULL, NULL, 'completed', '2026-04-03T00:00:04.000Z', '2026-04-03T00:00:04.000Z', '2026-04-03T00:00:04.000Z', 4, 'checkpoint-4', 'ready', '[]'),
          ('thread-page', 'turn-5', 'message-5', NULL, NULL, NULL, 'completed', '2026-04-03T00:00:05.000Z', '2026-04-03T00:00:05.000Z', '2026-04-03T00:00:05.000Z', 5, 'checkpoint-5', 'ready', '[]')
      `;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-page"),
        {
          limits: {
            messages: 2,
            proposedPlans: 2,
            activities: 2,
            checkpoints: 2,
          },
        },
      );

      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag === "Some") {
        assert.deepEqual(
          firstPage.value.thread.messages.map((message) => message.id),
          [asMessageId("message-4"), asMessageId("message-5")],
        );
        assert.deepEqual(
          firstPage.value.thread.proposedPlans.map((plan) => plan.id),
          ["plan-4", "plan-5"],
        );
        assert.deepEqual(
          firstPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-4"), asEventId("activity-5")],
        );
        assert.deepEqual(
          firstPage.value.thread.checkpoints.map((checkpoint) => checkpoint.turnId),
          [asTurnId("turn-4"), asTurnId("turn-5")],
        );
        assert.equal(firstPage.value.pageInfo.messages.hasMoreBefore, true);
        assert.deepEqual(firstPage.value.pageInfo.messages.startCursor, {
          id: "message-4",
          createdAt: "2026-04-03T00:00:04.000Z",
        });
        assert.deepEqual(firstPage.value.pageInfo.activities.startCursor, {
          id: "activity-4",
          createdAt: "2026-04-03T00:00:04.000Z",
          sequence: 4,
        });
        assert.deepEqual(firstPage.value.pageInfo.checkpoints.startCursor, {
          id: "turn-4",
          createdAt: "2026-04-03T00:00:04.000Z",
          checkpointTurnCount: 4,
        });
      }

      const firstPageInfo = firstPage._tag === "Some" ? firstPage.value.pageInfo : null;
      assert.notEqual(firstPageInfo, null);

      const activityOnlyOlderPage = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-page"),
        {
          before: {
            activities: firstPageInfo!.activities.startCursor!,
          },
          limits: {
            messages: 2,
            proposedPlans: 2,
            activities: 2,
            checkpoints: 2,
          },
        },
      );

      assert.equal(activityOnlyOlderPage._tag, "Some");
      if (activityOnlyOlderPage._tag === "Some") {
        assert.deepEqual(activityOnlyOlderPage.value.thread.messages, []);
        assert.deepEqual(activityOnlyOlderPage.value.thread.proposedPlans, []);
        assert.deepEqual(activityOnlyOlderPage.value.thread.checkpoints, []);
        assert.deepEqual(
          activityOnlyOlderPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-2"), asEventId("activity-3")],
        );
        assert.equal(activityOnlyOlderPage.value.pageInfo.messages.hasMoreBefore, false);
        assert.equal(activityOnlyOlderPage.value.pageInfo.messages.startCursor, null);
        assert.equal(activityOnlyOlderPage.value.pageInfo.proposedPlans.hasMoreBefore, false);
        assert.equal(activityOnlyOlderPage.value.pageInfo.proposedPlans.startCursor, null);
        assert.equal(activityOnlyOlderPage.value.pageInfo.checkpoints.hasMoreBefore, false);
        assert.equal(activityOnlyOlderPage.value.pageInfo.checkpoints.startCursor, null);
      }

      const secondPage = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-page"),
        {
          before: {
            messages: firstPageInfo!.messages.startCursor!,
            proposedPlans: firstPageInfo!.proposedPlans.startCursor!,
            activities: firstPageInfo!.activities.startCursor!,
            checkpoints: firstPageInfo!.checkpoints.startCursor!,
          },
          limits: {
            messages: 2,
            proposedPlans: 2,
            activities: 2,
            checkpoints: 2,
          },
        },
      );

      assert.equal(secondPage._tag, "Some");
      if (secondPage._tag === "Some") {
        assert.deepEqual(
          secondPage.value.thread.messages.map((message) => message.id),
          [asMessageId("message-2"), asMessageId("message-3")],
        );
        assert.deepEqual(
          secondPage.value.thread.proposedPlans.map((plan) => plan.id),
          ["plan-2", "plan-3"],
        );
        assert.deepEqual(
          secondPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-2"), asEventId("activity-3")],
        );
        assert.deepEqual(
          secondPage.value.thread.checkpoints.map((checkpoint) => checkpoint.turnId),
          [asTurnId("turn-2"), asTurnId("turn-3")],
        );
        assert.equal(secondPage.value.pageInfo.messages.hasMoreBefore, true);
        assert.deepEqual(secondPage.value.pageInfo.messages.startCursor, {
          id: "message-2",
          createdAt: "2026-04-03T00:00:02.000Z",
        });
      }

      const secondPageInfo = secondPage._tag === "Some" ? secondPage.value.pageInfo : null;
      assert.notEqual(secondPageInfo, null);

      const finalPage = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-page"),
        {
          before: {
            messages: secondPageInfo!.messages.startCursor!,
            proposedPlans: secondPageInfo!.proposedPlans.startCursor!,
            activities: secondPageInfo!.activities.startCursor!,
            checkpoints: secondPageInfo!.checkpoints.startCursor!,
          },
          limits: {
            messages: 2,
            proposedPlans: 2,
            activities: 2,
            checkpoints: 2,
          },
        },
      );

      assert.equal(finalPage._tag, "Some");
      if (finalPage._tag === "Some") {
        assert.deepEqual(
          finalPage.value.thread.messages.map((message) => message.id),
          [asMessageId("message-1")],
        );
        assert.deepEqual(
          finalPage.value.thread.proposedPlans.map((plan) => plan.id),
          ["plan-1"],
        );
        assert.deepEqual(
          finalPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-1")],
        );
        assert.deepEqual(
          finalPage.value.thread.checkpoints.map((checkpoint) => checkpoint.turnId),
          [asTurnId("turn-1")],
        );
        assert.equal(finalPage.value.pageInfo.messages.hasMoreBefore, false);
        assert.equal(finalPage.value.pageInfo.proposedPlans.hasMoreBefore, false);
        assert.equal(finalPage.value.pageInfo.activities.hasMoreBefore, false);
        assert.equal(finalPage.value.pageInfo.checkpoints.hasMoreBefore, false);
      }
    }),
  );

  it.effect(
    "progresses older detail cursors through duplicate timestamps and mixed activity sequences",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_proposed_plans`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-cursor-edge',
          'Project Cursor Edge',
          '/tmp/project-cursor-edge',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-04T00:00:00.000Z',
          '2026-04-04T00:00:00.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-cursor-edge',
          'project-cursor-edge',
          'Thread Cursor Edge',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-04-04T00:00:10.000Z',
          0,
          0,
          0,
          '2026-04-04T00:00:00.000Z',
          '2026-04-04T00:00:10.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          ('message-a', 'thread-cursor-edge', NULL, 'user', 'message a', 0, '2026-04-04T00:00:10.000Z', '2026-04-04T00:00:10.000Z'),
          ('message-b', 'thread-cursor-edge', NULL, 'user', 'message b', 0, '2026-04-04T00:00:10.000Z', '2026-04-04T00:00:10.000Z'),
          ('message-c', 'thread-cursor-edge', NULL, 'user', 'message c', 0, '2026-04-04T00:00:10.000Z', '2026-04-04T00:00:10.000Z')
      `;

        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          ('activity-null-old', 'thread-cursor-edge', NULL, 'info', 'runtime.note', 'null old', '{}', NULL, '2026-04-04T00:00:01.000Z'),
          ('activity-null-new', 'thread-cursor-edge', NULL, 'info', 'runtime.note', 'null new', '{}', NULL, '2026-04-04T00:00:02.000Z'),
          ('activity-seq-1', 'thread-cursor-edge', NULL, 'info', 'runtime.note', 'seq 1', '{}', 1, '2026-04-04T00:00:03.000Z'),
          ('activity-seq-2', 'thread-cursor-edge', NULL, 'info', 'runtime.note', 'seq 2', '{}', 2, '2026-04-04T00:00:04.000Z')
      `;

        const firstPage = yield* snapshotQuery.getThreadDetailSnapshotById(
          ThreadId.make("thread-cursor-edge"),
          {
            limits: {
              messages: 1,
              activities: 1,
            },
          },
        );
        assert.equal(firstPage._tag, "Some");
        if (firstPage._tag !== "Some") {
          return;
        }
        assert.deepEqual(
          firstPage.value.thread.messages.map((message) => message.id),
          [asMessageId("message-c")],
        );
        assert.deepEqual(
          firstPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-seq-2")],
        );

        const secondPage = yield* snapshotQuery.getThreadDetailSnapshotById(
          ThreadId.make("thread-cursor-edge"),
          {
            before: {
              messages: firstPage.value.pageInfo.messages.startCursor!,
              activities: firstPage.value.pageInfo.activities.startCursor!,
            },
            limits: {
              messages: 1,
              activities: 1,
            },
          },
        );
        assert.equal(secondPage._tag, "Some");
        if (secondPage._tag !== "Some") {
          return;
        }
        assert.deepEqual(
          secondPage.value.thread.messages.map((message) => message.id),
          [asMessageId("message-b")],
        );
        assert.deepEqual(
          secondPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-seq-1")],
        );

        const thirdPage = yield* snapshotQuery.getThreadDetailSnapshotById(
          ThreadId.make("thread-cursor-edge"),
          {
            before: {
              messages: secondPage.value.pageInfo.messages.startCursor!,
              activities: secondPage.value.pageInfo.activities.startCursor!,
            },
            limits: {
              messages: 1,
              activities: 1,
            },
          },
        );
        assert.equal(thirdPage._tag, "Some");
        if (thirdPage._tag !== "Some") {
          return;
        }
        assert.deepEqual(
          thirdPage.value.thread.messages.map((message) => message.id),
          [asMessageId("message-a")],
        );
        assert.deepEqual(
          thirdPage.value.thread.activities.map((activity) => activity.id),
          [asEventId("activity-null-new")],
        );

        const finalPage = yield* snapshotQuery.getThreadDetailSnapshotById(
          ThreadId.make("thread-cursor-edge"),
          {
            before: {
              messages: thirdPage.value.pageInfo.messages.startCursor!,
              activities: thirdPage.value.pageInfo.activities.startCursor!,
            },
            limits: {
              messages: 1,
              activities: 1,
            },
          },
        );
        assert.equal(finalPage._tag, "Some");
        if (finalPage._tag === "Some") {
          assert.deepEqual(finalPage.value.thread.messages, []);
          assert.deepEqual(
            finalPage.value.thread.activities.map((activity) => activity.id),
            [asEventId("activity-null-old")],
          );
          assert.equal(finalPage.value.pageInfo.messages.hasMoreBefore, false);
        }
      }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("ProjectionSnapshotQuery coalesces concurrent shell snapshot loads", () =>
  Effect.gen(function* () {
    const resolverEntered = yield* Deferred.make<void>();
    const releaseResolver = yield* Deferred.make<void>();
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.gen(function* () {
              resolveCalls.push(cwd);
              yield* Deferred.succeed(resolverEntered, undefined).pipe(Effect.ignore);
              yield* Deferred.await(releaseResolver);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-concurrent',
          'Concurrent Project',
          '/tmp/concurrent-root',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          NULL
        )
      `;

      const firstFiber = yield* snapshotQuery.getShellSnapshot().pipe(Effect.forkScoped);
      yield* Deferred.await(resolverEntered);
      const secondFiber = yield* snapshotQuery.getShellSnapshot().pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseResolver, undefined);

      const [firstSnapshot, secondSnapshot] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);

      assert.deepStrictEqual(resolveCalls, ["/tmp/concurrent-root"]);
      assert.equal(firstSnapshot.projects.length, 1);
      assert.equal(secondSnapshot.projects.length, 1);
      assert.deepStrictEqual(firstSnapshot.projects, secondSnapshot.projects);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("ProjectionSnapshotQuery retries a coalesced waiter when the owner is interrupted", () =>
  Effect.gen(function* () {
    const firstResolverEntered = yield* Deferred.make<void>();
    const secondResolverEntered = yield* Deferred.make<void>();
    const releaseSecondResolver = yield* Deferred.make<void>();
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.gen(function* () {
              const callNumber = resolveCalls.push(cwd);
              if (callNumber === 1) {
                yield* Deferred.succeed(firstResolverEntered, undefined).pipe(Effect.ignore);
                return yield* Effect.never;
              }

              yield* Deferred.succeed(secondResolverEntered, undefined).pipe(Effect.ignore);
              yield* Deferred.await(releaseSecondResolver);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-interrupt',
          'Interrupted Project',
          '/tmp/interrupted-root',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      const firstFiber = yield* snapshotQuery.getShellSnapshot().pipe(Effect.forkScoped);
      yield* Deferred.await(firstResolverEntered);
      const secondFiber = yield* snapshotQuery.getShellSnapshot().pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(firstFiber);

      yield* Deferred.await(secondResolverEntered).pipe(Effect.timeout("1 second"));
      yield* Deferred.succeed(releaseSecondResolver, undefined).pipe(Effect.ignore);
      const secondSnapshot = yield* Fiber.join(secondFiber).pipe(Effect.timeout("1 second"));

      assert.deepStrictEqual(resolveCalls, ["/tmp/interrupted-root", "/tmp/interrupted-root"]);
      assert.equal(secondSnapshot.projects.length, 1);
      assert.equal(secondSnapshot.projects[0]?.id, asProjectId("project-interrupt"));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("ProjectionSnapshotQuery clears a coalesced shell snapshot load after owner defect", () =>
  Effect.gen(function* () {
    const resolverEntered = yield* Deferred.make<void>();
    const releaseResolver = yield* Deferred.make<void>();
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.gen(function* () {
              const callNumber = resolveCalls.push(cwd);
              if (callNumber === 1) {
                yield* Deferred.succeed(resolverEntered, undefined).pipe(Effect.ignore);
                yield* Deferred.await(releaseResolver);
                return yield* Effect.die(new Error("repository identity resolver failed"));
              }

              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-defect',
          'Defect Project',
          '/tmp/defect-root',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-07T00:00:00.000Z',
          '2026-04-07T00:00:01.000Z',
          NULL
        )
      `;

      const firstFiber = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(resolverEntered);
      const secondFiber = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseResolver, undefined).pipe(Effect.ignore);

      const [firstExit, secondExit] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);

      assert.equal(Exit.hasDies(firstExit), true);
      assert.equal(Exit.hasDies(secondExit), true);

      const freshSnapshot = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(Effect.timeout("1 second"));

      assert.deepStrictEqual(resolveCalls, ["/tmp/defect-root", "/tmp/defect-root"]);
      assert.equal(freshSnapshot.projects.length, 1);
      assert.equal(freshSnapshot.projects[0]?.id, asProjectId("project-defect"));
    }).pipe(Effect.provide(layer));
  }),
);
