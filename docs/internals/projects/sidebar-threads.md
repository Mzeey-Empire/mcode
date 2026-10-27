# Sidebar threads

The sidebar is derived on the client from a full thread index. The server owns
four facts the sidebar reads: activity time, linked pull requests, completion,
and the auto-complete pause. It knows nothing about layout. This page records
why each piece sits where it does and the traps a change can fall into.

## Activity time

`threads.last_activity_at` is the sort key and the Older clock. `updated_at`
cannot do that job. It moves on token usage, settings, PR polls, completion and
reopen, so rows sorted by it would jump whenever metadata changed.

- Only turn admission and turn settle advance it, through
  [`advanceThreadActivity`](../../../apps/server/src/features/thread-control/persistence/thread-activity.ts).
  The update only moves forward, so a late or replayed settle cannot move a
  thread back. Do not call it from metadata writes, PR observations,
  completion or reopen. A PR state change is deliberately not activity.
- The `thread.activity` push hangs off the write, not off `ThreadRepo`. Turn
  outcomes are written by canonical writers in the database writer worker,
  which bypass the repo. The worker holds each advance until its transaction
  commits, then reports it to the main thread, which publishes the push
  ([`application-database-writer.ts`](../../../apps/server/src/runtime/persistence/sqlite/application-database-writer.ts)).
  An activity write outside the writer gets no push.
- The read side returns the latest of `last_activity_at`,
  `last_turn_ended_at` and `created_at`
  ([`thread-store.ts`](../../../apps/server/src/features/thread-control/persistence/thread-store.ts)).
  The column needs no backfill, and rows written by an older build that shares
  the database still sort sensibly.

## The thread index

The web holds every thread in `workspaceStore`. `thread.listAll` loads them on
startup and reconnect. The `thread.created`, `thread.activity`,
`thread.lifecycleChanged` and `thread.pullRequests` pushes keep them current.
The Completed count, the flat Threads view and Older each need every thread,
so do not reintroduce per-project or capped loading.

A new thread fact the sidebar reads needs a push. Without one the sidebar shows
it stale until the next reconnect.

## Linked pull requests

A thread can link several PRs. The `thread_pull_requests` table holds them, and
[`PullRequestLinkFunnel`](../../../apps/server/src/features/pull-requests/links/pull-request-link-funnel.ts)
is the only writer. When several writers set one PR column, one skipped the
linking path and another never broadcast, so clients drifted. A
`no-restricted-imports` rule in [`.oxlintrc.json`](../../../.oxlintrc.json)
rejects imports of the write operations or the table outside the funnel. Every
source of PR state calls `observe` and does nothing else.

- Merged is sticky. A late poll that still reads open cannot move a PR back
  from `merged`, so auto-complete never sees a thread flicker.
- The funnel mirrors the ranked primary PR into the legacy `pr_number` and
  `pr_status` columns. Stable and nightly share one database
  ([ADR 0030](../../adr/0030-shared-database-with-ledger-guard-and-compatibility-floor.md)),
  and older builds read those columns. Remove the mirror only when no
  supported build reads them.
- A PR known only from the legacy column reads as `unresolved`. Its state is
  unknown, so it never counts as merged.
- Branch discovery keeps only PRs whose head repository is the checkout's
  origin. A fork's PR from a branch with the same name would otherwise link
  to the wrong thread.
- Moving the checkout to another branch clears the links.
- [`rankPullRequests` and `pullRequestsSettledMerged`](../../../packages/contracts/src/models/thread-pull-request.ts)
  live in contracts so the server's auto-complete and the web chip agree on
  order and on what "all merged" means.

## Completion is held by the server

`thread.complete` takes an optional `holdMs`, clamped to 5 seconds.
[`CompletionHolds`](../../../apps/server/src/features/thread-control/lifecycle/completion-holds.ts)
keeps the pending completion in memory and resolves the RPC when the hold ends.
The client sends at click, so a refusal or a failed request shows during the
hold.

- Undo is `thread.reopen`. During the hold it cancels the entry, and the
  waiting `thread.complete` resolves with the `cancelled` refusal. After commit
  it reopens. The client calls the same method either way.
- Turn admission also cancels a hold, so a message sent during the hold keeps
  the thread active.
- The commit order is fixed. Take the mutation reservation, recheck that the
  thread is completable, persist, publish `thread.lifecycleChanged`, then
  release resources
  ([`thread-completion-service.ts`](../../../apps/server/src/features/thread-control/lifecycle/thread-completion-service.ts)).
  Releasing first would tear down a session the user can still keep. A release
  failure after commit blocks retention cleanup and is reported. It does not
  undo the completion.
- Refusals are values, not errors. The four are `running`, `approval-pending`,
  `busy` and `cancelled`.
- A crash during the hold persists nothing. The thread stays active, and other
  clients never saw the hold.
- The web releases thread resources only on the server-confirmed transition
  from active to completed (`isConfirmedCompletion` in
  [`workspaceStore.ts`](../../../apps/web/src/features/projects/state/workspaceStore.ts)).
  A snapshot or replayed push that already carries `user_completed_at`
  releases nothing.

## Auto-complete and the reopen pause

[`ThreadAutoCompleteService`](../../../apps/server/src/features/thread-control/lifecycle/thread-auto-complete.ts)
completes a thread when every linked PR is merged, the thread is active, and
nothing on it needs the user. The rule is strict. An empty PR list never
completes, and a closed, unmerged PR blocks it until the user completes the
thread by hand. Unknown attention also blocks it.

- The thread's `auto_complete_on_merge` override wins over the global
  `thread.completion.completeOnPrMerge` setting. Null inherits.
- Evaluation is level-triggered. Each hint re-reads the current facts, and
  startup or turning the global setting on sweeps every thread. Every input of
  `autoCompleteDecision` has a trigger that calls `evaluate`, and a test fails
  when an input is added without one. Add the trigger with the input.
- Reopen sets `auto_complete_paused_at`. Without it, a reopened thread whose
  PRs are all merged would complete again at once. The pause leaves the
  override alone, so the menu switch still shows the user's preference.
  Activity, a PR state change in the funnel, and an override write each clear
  it. Repeated snapshots and metadata writes do not.
- Automatic completions carry `completedBy: "auto"` on the lifecycle push.
  The Undo line uses it to offer Undo for completions the user did not make
  on this client.

## The sidebar model

[`deriveSidebarModel`](../../../apps/web/src/features/projects/sidebar/sidebar-model.ts)
is pure. It maps the thread index, pending completions, UI state, settings and
`now` to the rows. Row caps, Older and the Completed count all come from it.
Components render its items and never filter or sort.

- Older is computed on the client from `thread.olderAfterDays`. A thread
  enters Older on the clock, never because the user opened it. Opening a
  long-idle thread can clear "needs you", so the model records in a session
  map when each thread stopped needing the user and starts the Older clock
  from the later of that time and its activity. After a restart the map is
  empty and the thread is placed without animation.
- The model returns `nextBoundaryAt`, the next moment a thread crosses into
  Older. One timeout serves it. Do not add polling.
- Pointer entry freezes the clock and the sort keys. Deferred reordering is a
  frozen input, not a second code path.
- Only push events animate. `classifyCause` in
  [`use-sidebar-model.ts`](../../../apps/web/src/features/projects/sidebar/use-sidebar-model.ts)
  marks hydration and reconnect as `snapshot` through `threadSnapshotEpoch`,
  and
  [`planTransitions`](../../../apps/web/src/features/projects/sidebar/sidebar-motion.ts)
  plans no flights or reorder slides for it. A new bulk load of threads must
  bump the epoch, or every reconnect animates every changed row.
