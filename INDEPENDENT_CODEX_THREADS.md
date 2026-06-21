# Independent Codex-Created Threads

## Status

Pending. Not part of the current subagent materialization fix.

## Problem

Codex can be asked to create separate top-level work threads that continue independently. These are not the same as spawned subagents. Subagents are nested under a parent thread and are orchestrated by that parent. Independent threads should appear as ordinary root sidebar threads.

## Distinction

| Concept                          | Sidebar Shape       | Provider Runtime                               | Salchi Relationship                              |
| -------------------------------- | ------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Codex spawned subagent           | Nested under parent | Child native thread in same Codex session tree | `parentThreadId` set                             |
| Independent Codex-created thread | Root thread         | Separate provider session/runtime              | `parentThreadId: null`, optional provenance link |

## Current Gap

Salchi has first-class nested subagent child threads, but no provider/runtime API for an agent to create independent top-level Salchi threads and start/resume them as separate provider sessions.

## Future Requirements

- Provider-neutral command/event for agent-created root threads.
- Provenance fields such as `createdByThreadId` or `originThreadId`.
- Separate provider session binding per independent thread.
- Sidebar root rendering, not nested rendering.
- Ability for the originating thread to link to the created thread.
- Clear UX copy distinguishing "Subagent" from "Created thread".

## Acceptance Criteria

- A parent Codex turn can create a new top-level Salchi thread.
- The new thread appears in the sidebar root list.
- It can run, resume, stop, and route turns independently.
- The source thread shows a link/activity to the created thread.
