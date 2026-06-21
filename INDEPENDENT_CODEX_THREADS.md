# Independent Provider-Created Threads

## Status

Implemented in the provider runtime path for Codex, Claude, Cursor, and Grok.

## Problem

Agents can be asked to create separate top-level work threads that continue independently. These are not the same as spawned subagents. Subagents are nested under a parent thread and are orchestrated by that parent. Independent threads should appear as ordinary root sidebar threads.

## Distinction

| Concept                             | Sidebar Shape       | Provider Runtime                          | Salchi Relationship                              |
| ----------------------------------- | ------------------- | ----------------------------------------- | ------------------------------------------------ |
| Provider spawned subagent           | Nested under parent | Child native thread in same provider tree | `parentThreadId` set                             |
| Independent provider-created thread | Root thread         | Separate provider session/runtime         | `parentThreadId: null`, optional provenance link |

## Implemented Path

Salchi now has a provider-neutral `thread.independent.created` runtime event. Ingestion materializes it as a root orchestration thread with `parentThreadId: null`, records `createdByThreadId` provenance, appends a source-thread activity, and can start the new thread with an initial prompt through the normal `thread.turn.start` path.

The provider-facing tool contract is defined in `apps/server/src/provider/IndependentThreadTool.ts`. It exports the canonical Salchi dynamic tool spec:

- namespace: `salchi`
- name: `create_thread`
- notification method: `salchi/thread/create`
- required args: `title`, `initialPrompt`
- optional args: `titleSeed`, `threadId`, `checkoutMode`, `branch`, `worktreePath`

Codex registers that tool through `thread/start.dynamicTools`, advertises it in collaboration developer instructions, and services it through `item/tool/call`. The Codex runtime maps successful calls to the shared `salchi/thread/create` notification, and the Codex adapter maps that notification to `thread.independent.created`.

Codex dynamic tools are thread-start scoped and persisted in the Codex thread metadata. After adding or changing this tool, test from a freshly-started Codex-backed Salchi thread; an older resumed Codex thread can correctly report that the tool is not exposed.

Claude registers the same tool as an in-process SDK MCP server named `salchi`, with `create_thread` always loaded. The tool callback emits `thread.independent.created` directly through the Claude adapter event stream.

Cursor and Grok share the ACP runtime. ACP accepts MCP server descriptors rather than in-process callbacks, so Salchi now passes a small stdio MCP server descriptor named `salchi` during `session/load` and `session/new`. The MCP server exposes `create_thread`, returns a structured Salchi result marker, and the ACP adapters map completed tool-call output containing that marker to `thread.independent.created`.

OpenCode does not currently have a wired structured tool-registration surface in this adapter path. Do not rely on prompt text alone for OpenCode; it needs a real callback/tool surface before it should advertise `create_thread`.

Checkout placement is explicit:

- omit `checkoutMode` or use `inherit` to reuse the source thread checkout
- use `checkoutMode: "local"` to start in the project workspace root (`worktreePath: null`)
- use `checkoutMode: "worktree"` with `worktreePath` to start in a specific dedicated worktree or checkout path
- include `branch` when known; use `null` when switching checkouts and the branch is unknown

Other providers should import the same shared tool contract when they have a structured tool declaration/callback surface. Adapters without such a surface should not merely prompt the model to call the tool; they need a real provider callback that can emit `thread.independent.created` or the shared `salchi/thread/create` notification.

## Requirements

- Provider-neutral event for agent-created root threads.
- Provenance field `createdByThreadId`.
- Separate provider session startup through ordinary turn dispatch.
- Sidebar root rendering, not nested rendering.
- Source-thread activity for the created thread.
- Clear distinction from subagent materialization.

## Acceptance Criteria

- A parent provider turn can create a new top-level Salchi thread.
- The new thread appears in the sidebar root list.
- It can run, resume, stop, and route turns independently.
- The source thread shows a link/activity to the created thread.

## Manual Test

1. Start the Salchi server and open a new Codex-, Claude-, Cursor-, or Grok-backed thread after this change.
2. Ask: `Start an independent thread titled "Read-only investigation" to inspect how thread projection works. Use checkoutMode "local".`
3. Confirm the agent calls the `salchi.create_thread` / `create_thread` dynamic tool instead of saying the tool is unavailable.
4. Confirm a new root sidebar thread appears, records the source-thread activity, and starts with the requested initial prompt.
