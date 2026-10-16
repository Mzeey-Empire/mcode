# Project environment commands

Project actions run named commands in a checkout. Actions marked **Run on
startup** prepare a worktree before its first provider turn. The server owns command resolution, approval,
process lifetime, and retained results. Provider turns use a separate lifecycle.

## Configuration scope and command approval

The selected storage mode determines one source of configuration. In system
mode, all checkouts of a Project use `projects/<workspace-id>/environment.json`
under Mcode's local data directory. In shared mode, each Thread reads
`.mcode/environment.json` from its own checkout. A worktree does not fall back
to the main checkout's shared file. This lets a branch change its commands
without silently running commands from another checkout.

Changing storage mode selects the document at that location. It does not merge
or copy documents. The [environment service](../../../apps/server/src/features/projects/environment/workspace-environment-service.ts)
owns that choice, [checkout path resolution](../../../apps/server/src/features/projects/environment/workspace-environment-service.ts),
validation, and revision-checked atomic saves.

Shared files can arrive through repository changes, so a shared command needs
approval for its resolved launch. Approval is scoped to the Project and command
identity, `action:<id>`. Its
[fingerprint](../../../apps/server/src/features/projects/environment/workspace-environment-service.ts)
also includes the operating system, the terminal executable, and the script
and arguments with normalized line endings. Approval does not authorize every
command in a checkout. Identical launch facts can reuse a Project approval
across checkouts.

Approval re-resolves the current document and terminal command before it saves
the fingerprint. If the reviewed fingerprint no longer matches, approval fails
as stale. Starting a command also resolves current configuration. For Actions,
the [terminal backend](../../../apps/server/src/features/terminal/backends/terminal-backend.ts#L73)
checks the expected executable and arguments again before spawn. A changed
terminal profile therefore cannot execute under an approval for an older
launch. The [Action resolution](../../../apps/server/src/features/projects/environment/project-action-resolution.ts)
and [launch failure handling](../../../apps/server/src/features/projects/environment/project-action-service.ts)
return renewed approval work when that mismatch requires another review.

## The Setup gate is separate from its attempts

Automatic Setup holds the first prompt for any worktree thread, managed or attached, before the
provider starts. The [automatic Setup store](../../../apps/server/src/features/projects/environment/workspace-environment-automatic-store.ts)
atomically saves the visible user message, the queued submission, and a blocked
gate. The [environment service](../../../apps/server/src/features/projects/environment/workspace-environment-service.ts)
starts Setup only after that admission commits.

Branched starts continue another thread and skip Setup before admission, so
their first turn dispatches without entering the gate. Other starts check for
a non-deleted sibling at the same normalized worktree path. A sibling with a
running or finalizing turn, a running Setup attempt, or a nonterminal startup
whose Setup passed or that reached the agent phase makes Setup skip with
`thread-running-here` and releases the gate as not required. A passed sibling
counts because its startup stays in the setup phase until its first turn claims
the agent. The environment
service serializes this check and command launch per path so simultaneous
starts cannot both launch Setup. A sibling still at or before Setup with no
automatic attempt or a queued attempt waits for its own decision and does not
make the first start skip. A sibling blocked on a failed or interrupted Setup
does not count either, so the new start runs Setup instead of trusting a
checkout that never finished setting up.
Path comparison normalizes separators and trailing slashes, and ignores case
on Windows.

The gate answers whether queued prompts may start. An attempt freezes the
ordered startup action ids and SHA-256 hashes of their resolved scripts.
The setup step owns this list and its run ids; the attempt stores no duplicate
script, output or exit result. The runner commits the attempt and the step's
action projection in the same transaction.

[StartupActionRunner](../../../apps/server/src/features/projects/environment/startup-action-runner.ts)
uses the normal Action service and real action terminals. Only a current run's
exit code 0 advances the sequence. A detected, reachable port proves only that
some process accepts connections, so it never releases Setup. A long-running
server holds the gate until it exits or the user chooses **Skip setup**.
No startup actions releases the gate as not required.

The first failure stops the sequence, records `failedActionId` on the attempt
and the exit code on the setup step, and blocks with `SETUP_FAILED`. A launch
error, including terminal capacity, also blocks. The terminal remains open in
its shell phase. Retry freezes the current document and restarts the failed
action in its existing terminal. Earlier exit-zero actions are skipped only
when their script hashes still match. A script changed after freezing requires
Retry instead of silently executing under the old hash.

Shared actions without approval wait in their terminal and block the trail
with `SETUP_APPROVAL_REQUIRED`. Approve the run's fingerprint, then start the
action; either the trail or the terminal card uses this same sequence.
Approval alone does not start a command.

The trail tail is a bounded plain-text projection of command-phase bytes,
decoded by the terminal plain-text decoder. It excludes the synthesized
terminal echo and interactive shell output. Each started action contributes
one `$ <first script line>` entry. Coalesced transcript batches write at most
four times per second plus the exit flush, retaining at most 32 entries and
16 KB. The terminal remains the full output view; cursor redraws can repeat
lines in the trail.

Gate release and provider dispatch remain separate commits. The queue drain
claims a released submission durably before dispatch and acknowledges the
claim only after the dispatcher accepts it. It waits for that provider turn
to complete before claiming the next released prompt. Failed dispatch claims
are not replayed automatically because the provider may already have accepted
them.

On restart, unfinished attempts and action runs become interrupted.
Reconciliation drains committed gate releases but never replays a startup
command. Retry creates a new attempt.

## Legacy configuration upgrades

[upgradeEnvironmentDocument](../../../apps/server/src/features/projects/environment/workspace-environment-upgrade.ts)
runs on every read in both storage modes, including worktree-local shared
files. A legacy `setup` command becomes the first action, named `setup` and
marked `runOnStartup`. Its id gains a numeric suffix if necessary. Reading
never rewrites the source file; the next Save writes the upgraded document.

The approval identity changes from `setup` to `action:setup`, or its suffixed
id. The migration deletes obsolete `setup` approval rows, so shared commands
ask once after upgrade. This prevents silently granting the new action an old
command's permission.

The document and startup record share the eight-action limit because each
startup action retains a terminal record. The document byte cap is 512 KB so
eight 32 KB platform scripts fit with their metadata. Per-script and
per-command limits still apply.

## Cancellation keeps terminal shells

Skip setup releases queued turns and detaches the sequence, leaving its
running command alone. It does not mark that command successful.

`thread.startup.cancel` records cancellation intent, stops startup command
phases and waits for any admitted launch, then discards pending turns and
clears the gate. Terminals retain their interactive shells. The cancelled
prompt remains in the transcript and cannot replay through Continue or Retry.

Thread and Project deletion block new starts before teardown. The startup
runner stops its owned commands, while Action teardown closes owned terminal
records. There is no separate manual Setup executor or recovery shell.

## Actions retain results beyond process exit

An Action owns an attachable terminal record in the Thread's checkout. Its
command runs through the Project profile's noninteractive launch, then a fresh
interactive shell opens in the same record and folder. Stop interrupts the
command and leaves that shell open. Restart creates a new run in the same
terminal. Closing the terminal interrupts a command still running and clears
the run's terminal identity.

The [Action service](../../../apps/server/src/features/projects/environment/project-action-service.ts)
reserves one slot per Thread and Action before resolution. Starting an Action
whose terminal is already open returns its retained run. Pending approval,
running and exited terminals all count toward the eight-record scope limit.

A run waiting for approval has a terminal but no process. The client shows the
approval card over that terminal and, on Run, approves the fingerprint then
starts the Action. Starting creates a new run with a later `createdAt` on the
same terminal, never a status change on the awaiting run. The client's
retained-run store depends on this and rejects a same-run move to `running`.
Closing the terminal while it waits interrupts the run. The client passes the
approved `runId` as `expectedRunId`, and the server refuses with
`WORKSPACE_ENVIRONMENT_RUN_CLOSED` instead of opening a fresh terminal when that
run is no longer waiting on an open one. Without it, a tab closed while Run was
in flight would be replaced by a new terminal running the approved command.

The terminal replay includes a synthesized command echo and both processes'
output and is the output record for the Action's terminal tab. Retained runs
store lifecycle metadata and confirmed port reachability. Command output only
publishes a run update when a port is confirmed or its reachability changes.

The initial running result must be saved before the service subscribes to
exit events. If retention fails after launch, the
[launch compensation](../../../apps/server/src/features/projects/environment/project-action-launch-compensation.ts)
stops the launched command and preserves the original failure. A cleanup
failure preserves both errors rather than reporting a successful start.

Process exit also has a persistence barrier. The
[run lifecycle](../../../apps/server/src/features/projects/environment/project-action-run-lifecycle.ts)
saves the final result before releasing the slot. If that save fails, the slot
remains pending finalization. Stop or Restart can retry the save, but another
Start cannot overtake it. Run identity checks ignore late exit events from a
replaced session.

Startup reaps stale terminals before it marks persisted running Action results
interrupted. During shutdown, [server composition](../../../apps/server/src/application/bootstrap/server-bootstrap.ts#L990)
disposes Actions and Setup before shutting down their terminal dependency. A
retained run result is evidence of the command lifecycle, not permission to
resume or replay the command.
