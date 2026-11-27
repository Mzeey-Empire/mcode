# 0036: Move a No project thread into a project

Status: Accepted

Date: 2026-11-26

## Context

A No project thread runs in a hidden workspace with its own folder
([ADR 0035](0035-no-project-thread-lives-in-a-hidden-workspace.md)). Issue
#2242 lets the user move such a thread into an existing project once the work
turns out to belong there. The thread's earlier turns wrote files in the old
folder, and its provider sessions point at that folder.

## Decision

`thread.moveToProject` moves one open No project thread into a project. The
thread runs in the project as a new Local thread there would: direct mode, on
the project's current branch, or `"main"` in a project that is not a git
repository. The move reserves the thread first, so a Running or
approval-waiting thread fails as busy and nothing changes. Placement,
retention, provider sessions, and the timeline marker change in one
transaction. See [`ThreadMoveService`](../../apps/server/src/features/thread-control/lifecycle/thread-move-service.ts)
and `ThreadStore.moveToProject` in
[`thread-store.ts`](../../apps/server/src/features/thread-control/persistence/thread-store.ts).

- **Only the chosen thread moves.** Its forks and delegated children stay in
  No project. They may still be working in the folder, and moving them would
  change their working folder under a running turn. A busy fork does not block
  the move.
- **The old folder is kept 7 days.** Once a thread has moved out, Mcode
  deletes the folder 7 days after the last thread leaves it, whether that
  thread moves out or is deleted. A folder no thread ever left is removed with
  its last thread, as before. The deadline is stored on the workspace row, so
  it holds across restarts. See
  [`WorkspaceStore`](../../apps/server/src/features/projects/persistence/workspace-store.ts).
- **The retention migration is a contract step.** Stable and nightly share one
  database ([ADR 0030](0030-shared-database-with-ledger-guard-and-compatibility-floor.md)).
  An older build's sweep checks only threads and startups, so it would delete
  a retained folder about 10 minutes after a move. The new columns are
  additive and would not raise the floor on their own, so
  [`migration-contract-steps.ts`](../../apps/server/src/runtime/persistence/sqlite/migration-contract-steps.ts)
  lists the migration with no breaking changes. Older builds then refuse the
  database instead of sweeping it.
- **The agent gets a hidden note.** When the old folder holds files, the
  first turn after the move tells the agent where they are and when Mcode
  deletes them. The note is in the payload Mcode sends to the provider, not
  in the stored user message or the timeline. The user decided the UI does
  not need to show what Mcode tells the agent. Mcode renders the text when it
  sends the turn, from the old workspace as it is then. If the folder later
  becomes a project or is gone, the note never names a stale path or date. The note stays pending until a turn that sent it completes, so a
  retried or recovered first turn still sends it.
- **No provider gets read access to the old folder.** Reads outside the
  project already follow the user's permission mode
  ([ADR 0034](0034-ask-me-gates-writes-network-and-outside-commands.md)).
  Cursor's file read used to return an empty file for a path outside its
  working folder. It now refuses the read, so the agent sees a refusal and
  copies files through its shell instead.
- **The next turn starts a fresh provider session.** The move deletes every
  provider session the thread has, for every provider. A resumed session would
  keep working in the old folder. Switching back later to a provider the thread
  used before also starts fresh in the project. The fresh turn carries the
  handoff v2 preamble that recovery uses
  ([ADR 0031](0031-handoff-v2-budgeted-transcript-selection.md)), so the
  agent keeps the conversation.
- **The timeline shows one line.** A persisted marker reads "Moved to
  **project** · Local", with nothing under it.

## Alternatives rejected

- **Move every thread that shares the folder.** This was the issue's first
  plan. A fork may be running in the folder, and the user picked one thread.
- **Link back to the old folder instead of moving it.** Decided for the
  planned New project target of #2242: the folder moves to its new location
  and becomes the project, because the user asked for a new project, and
  nothing links back.
- **Pre-grant providers read access to the old folder.** That would bypass Ask
  me for every read there.
- **Start the fresh session through a provider switch.** The switch path does
  nothing unless the provider changes. The move must also drop the stored
  sessions of every provider, not only the current one.
- **Show the note, or the old folder's files, in the timeline.** The user
  rejected both and kept the single marker line.
- **Send the note by replacing the prompt with a provider override.** The
  override drops the user's prompt with its plan and reply context.

## Consequences

- Stable and nightly cannot share a database across the retention migration
  until both ship it.
- In a git project, revert works from the first turn after the move. Earlier
  turns have no revert, because the old folder was not a repository.
- Open terminals keep running in the old folder. New terminals open in the
  project.
