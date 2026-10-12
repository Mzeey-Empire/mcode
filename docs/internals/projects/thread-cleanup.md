# Completed-thread worktree cleanup

How Mcode deletes finished threads and their worktrees, and how failures recover.

## Lifecycle

1. `thread.complete` writes `user_completed_at` and `scheduled_deletion_at`
   (default retention: 3 days). The thread stays reopenable until cleanup claims it.
2. `CleanupWorker` polls every 5s. `enqueueExpiredCompleted` flips eligible
   threads to `cleanup_state = 'queued'` and inserts a `kind = 'retention'` row
   into `cleanup_jobs` in one transaction.
3. Each job runs under a mutation reservation plus the per-repo git lock:
   provider teardown first (5s session wait, `claude.exe` descendant kill, 1.5s
   Windows handle settle), then `SandboxWorktreeCleanupPolicy.decide()`, then
   `GitWorktreeService.removeWorktree`.
4. Success hard-deletes thread rows and the job, broadcasts `thread.deleted`,
   and hard-deletes the workspace when its last job finishes.

## Removal order inside `removeWorktree`

- `git worktree remove <path> --force --force` (30s).
- If the directory survives, `WorktreeDirectoryRemover` runs the platform-native
  command in a bounded child process: `rm -rf --` on POSIX, `rmdir /s /q` via
  `cmd.exe` on Windows (paths containing `%`, `"`, CR, or LF use a Node `fs.rm`
  child instead, because cmd expands `%VAR%` even inside quotes). Bounded at
  120s; a clean exit while the directory remains is still a failure.
- `git worktree prune`, best-effort empty-parent removal (a stuck empty parent
  never fails the job once the worktree itself is gone), then `git branch -D`.
- A worktree that is already gone counts as success.

## Retain vs remove

The policy may retain the checkout (`outside-sandbox`, `primary-branch`,
`default-branch-unknown`, `current-branch-unknown`, shared by a live thread).
Retain means "keep the directory"; the thread row is still hard-deleted.

## Failure and recovery

- A thrown error records `last_error`, bumps `attempts`, and backs off
  `2^(attempts+1)` seconds. Counters persist across restarts.
- At attempt 5 the job row is deleted and the thread parks in `blocked` with
  `Cleanup failed after 5 attempts. Last error: <tail>`. `thread.retryCleanup`
  requeues it atomically.
- On startup `reconcileOnStartup` first requeues every exhausted job
  (`attempts >= 5`), so a crash or a fixed bug does not strand directories.
  Orphaned job rows whose thread is already gone are deleted on the next poll.
  It then reconciles soft-deleted workspaces: missing jobs are re-enqueued and
  finished workspaces are hard-deleted.
