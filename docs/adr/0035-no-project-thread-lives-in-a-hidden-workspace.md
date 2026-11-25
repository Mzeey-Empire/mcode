# 0035: A No project thread lives in a hidden workspace

Status: Accepted

Date: 2026-11-25

## Context

Every thread belongs to a workspace. `threads.workspace_id` is NOT NULL with a
cascading foreign key, six other tables carry the same key, and every provider
turn needs a working directory. Epic #1814 lets a user start a thread without
picking a project, which the UI calls **No project**.

## Decision

A No project thread belongs to a hidden workspace row with
`kind = 'no_project'`. The row is named "No project", is not a git repository,
and owns its own folder at `<mcodeDir>/no-project/<workspaceId>/`. Forks,
delegated children and launched threads of that thread share the row and the
folder, as they share a project today.

- **Creating.** The client calls `workspace.createNoProject` with an id it
  generated, then starts the thread with the usual `agent.createAndSend` in
  direct mode. Each id is used once. Creation inserts the row before making
  the folder and rejects an existing row or folder for the id. It verifies
  the root and the thread's exact folder so links cannot redirect either path.
- **Listing.** `workspace.list` returns every row with its `kind`. The web keeps
  hidden rows in its workspace store, so every lookup by workspace id (labels,
  terminals, file actions, preview URLs, Browser profiles, the right panel)
  keeps working, and filters `kind = 'project'` only where it lists projects.
  Server listings that show projects to agents, such as workspace search, omit
  hidden rows. Add project refuses a folder under `<mcodeDir>/no-project/`.
- **Removing.** The managed folder lives as long as its row. The cleanup
  worker waits ten minutes and rechecks that no thread or startup can still
  use the workspace before deleting the row, then the folder. A thread-less
  failed or interrupted first send keeps its folder for up to seven days
  for a retry. Deleting the thread created by a successful retry immediately
  releases the folder for cleanup. Later sweeps remove leftover UUID-named
  folders and links under the managed root when no workspace row claims them
  by id or path.
- **Older builds.** An older build would list hidden rows as projects. The
  migration that adds `kind` is a contract step that raises the compatibility
  floor ([ADR 0030](0030-shared-database-with-ledger-guard-and-compatibility-floor.md))
  to itself, so a build without `kind` refuses the shared database instead.
- **Git.** The folder is not a repository, so the thread has no branch, worktree
  or revert ([ADR 0027](0027-turn-revert-restores-pre-turn-content.md)), and the
  UI hides git-only actions.

## Alternatives rejected

- **Nullable `threads.workspace_id`.** Needs a table-rebuild contract migration,
  changes to about 22 required `workspaceId` contract fields, copies of
  working-directory resolution in about eight files, and inner joins that would
  drop projectless rows without an error.
- **Filtering hidden rows out of `workspace.list`.** Every web lookup by
  workspace id would miss them: search would say "Unknown project", file and
  open-in actions would lose the folder, and Browser profile reconcile would
  delete their cookies and history on each reload.
- **Raising the floor only when the first No project thread is made.** Keeps
  older builds working for users who never use the feature, but adds a runtime
  floor write that ADR 0030 forbids. Migration 0106 set the precedent of raising
  the floor at migration time for a behavioural break.

## Spike evidence

Run on 2026-11-25 against this worktree's server with `workspace.createNoProject`
and `agent.createAndSend` in direct mode, prompting each provider to write a file
holding its working directory:

| Provider | Model | Result |
|---|---|---|
| Claude | `claude-haiku-5-5` | Wrote the file in the No project folder; it reported that folder as its working directory. |
| Codex | `gpt-6-luna` | Same. |
| Cursor | none | Not run: the Cursor CLI is not installed on the spike machine. Cursor resolves its working directory the same way as the others, which is an inference. |

`workspace.list` returned the row with `kind = 'no_project'`. The
cleanup integration tests cover retention purge, a fork keeping the shared
folder, orphaned directories and links, the grace period, retryable
pre-thread failures, and failed startups whose threads were deleted.

## Consequences

- Stable and nightly cannot share a database across this migration until both
  ship it.
- A closed No project thread follows normal retention; its folder goes with
  its last thread.
- The folder is the project root for slash commands, skills and hooks, so they
  work without a project.
- Code that lists projects must filter on `kind`. A new listing that forgets the
  filter shows "No project" as a project.
