# Skip Redundant RPCs on Thread Switch

**Date:** 2026-04-28
**Issue:** [#333](https://github.com/anthropics/mcode/issues/333)
**Parent epic:** [#330](https://github.com/anthropics/mcode/issues/330)
**Depends on:** [#331](https://github.com/anthropics/mcode/issues/331) (merged)

## Problem

Thread switching fires four RPCs after the message load:

- `getMessages` — primary load (cached by #331)
- `listPendingPermissions`
- `getThreadTasks`
- `listSnapshots`

`listSnapshots` runs for every thread, including chat-only threads with zero file changes. It triggers a `set()` that updates `persistedFilesChanged` and `latestTurnWithChanges`, which `MessageList` consumes — so even an empty result re-renders the message list.

The two non-blocking RPCs (`listPendingPermissions`, `getThreadTasks`) also resolve into store updates that fan out to `MessageList` subscribers, causing further re-renders that have nothing to do with the message content.

## Goals

- Skip `listSnapshots` for threads with no file changes.
- Stop `listPendingPermissions` and `getThreadTasks` resolution from re-rendering `MessageList`.
- Preserve correct snapshot loading for threads that do have file changes.
- Preserve pending-permission and task display.

## Non-goals

- Removing `listPendingPermissions` or `getThreadTasks` RPCs entirely.
- Splitting `useThreadStore`.
- Changes to message pagination, diff lazy loading, or CI polling.
- Anything covered by sibling issues #331, #332, #334, #335, #336.

## Approach

Two coordinated changes:

1. **Schema-backed gate for `listSnapshots`** — add a derived `has_file_changes` column on `threads`, maintained by `SnapshotService`. The frontend skips the snapshots RPC when the flag is `false`.
2. **Selector tightening for `MessageList`** — narrow the component's subscriptions so `permissionsByThread` and task-store updates do not trigger re-renders.

## Server changes

### Schema migration

Add `has_file_changes BOOLEAN NOT NULL DEFAULT 0` to the `threads` table.

- New migration under `apps/server/src/store/migrations/`.
- `up()`:
  1. `ALTER TABLE threads ADD COLUMN has_file_changes INTEGER NOT NULL DEFAULT 0`.
  2. Backfill: `UPDATE threads SET has_file_changes = 1 WHERE id IN (SELECT DISTINCT thread_id FROM turn_snapshots WHERE json_array_length(files_changed) > 0)`.
  3. Verify the existing `turn_snapshots(thread_id)` index covers the backfill query; add it if missing.
- `down()` drops the column.
- Register in `loadMigrations()` in `apps/server/src/store/database.ts`.

### Maintenance write

`SnapshotService.create()` (or whichever service owns the snapshot insert path) flips the flag when a non-empty snapshot lands:

- After creating a snapshot with `filesChanged.length > 0`, run `UPDATE threads SET has_file_changes = 1 WHERE id = ? AND has_file_changes = 0`.
- Both writes execute inside a single transaction so a partial failure rolls both back.

### Contract update

`packages/contracts/src/models/thread.ts` — add `has_file_changes: z.boolean()` to `ThreadSchema`. The `ThreadRepo` row mapper coerces SQLite `0/1` to `boolean`.

No new RPC. The flag rides on existing `listThreads` and per-thread payloads.

## Client changes

### Gate `listSnapshots` in `threadStore.loadMessages()`

Cache-miss path (currently lines 414-547):

- Read `has_file_changes` from the active thread record in `workspaceStore.threads` (looked up via `currentThreadId`).
- If `false`: skip the `listSnapshots` IIFE entirely. Inline the cache-populate call with empty `persistedFilesChanged: {}` and `latestTurnWithChanges: null`.
- If `true`: existing path runs unchanged.

Cache-hit path (lines 305-359): unchanged. Already does not call `listSnapshots`. Push events and #331's invalidation handle freshness.

### Tighten `MessageList` selectors

Audit the `useThreadStore(...)` calls in `MessageList` and any descendant whose render influences the list. They should subscribe only to fields the message rendering actually needs:

- `messages`
- `streamingByThread[currentThreadId]`
- `toolCallsByThread[currentThreadId]`
- `persistedFilesChanged`
- `latestTurnWithChanges`
- `loading`
- whichever streaming-preview / running-thread fields are read today

They should NOT subscribe to:

- `permissionsByThread`
- whole-store selectors

For object/array selector returns, wrap with `useShallow`. Single-field primitive selectors do not need `useShallow`.

`getThreadTasks` writes to `useTaskStore` (a separate store), so it does not affect `useThreadStore` subscribers. Apply the same selector hygiene to any `MessageList`-adjacent component that reads from `useTaskStore`.

## Data flow on thread switch (after change)

```
loadMessages(threadId)
  cache hit  -> restore from snapshot, fire listPendingPermissions + getThreadTasks (refresh).
                listSnapshots NOT called. MessageList does not re-render on permission/task resolution.
  cache miss -> getMessages -> set messages + counts.
                if thread.has_file_changes: listSnapshots -> set persistedFilesChanged + cache-populate.
                else:                       cache-populate inline (empty file-change state).
                fire listPendingPermissions + getThreadTasks. MessageList does not re-render on resolution.
```

## Testing

### Unit / integration

- `apps/server/src/repositories/__tests__/thread-repo.test.ts` — backfill correctness:
  - Thread with snapshot containing files → `has_file_changes = 1`.
  - Thread with snapshots whose `files_changed` is empty → `0`.
  - Thread with no snapshots → `0`.
- `apps/server/src/services/__tests__/snapshot-service.test.ts` — flag maintenance:
  - Creating a snapshot with non-empty `filesChanged` flips the flag.
  - Creating an empty snapshot leaves the flag unchanged.
  - The update is idempotent (already-true thread is not rewritten).
- `apps/web/src/__tests__/threadStore.test.ts` (extend existing) — `loadMessages`:
  - Thread with `has_file_changes = false` does not call `listSnapshots`.
  - Thread with `has_file_changes = true` calls `listSnapshots` once.
- `apps/web/src/__tests__/MessageList.rerender.test.tsx` (new):
  - Render `MessageList` against a store with a known thread.
  - Dispatch a `permissionsByThread` update.
  - Assert the component does not re-render (render-counter ref or wrapped `vi.fn()`).

### Manual verification (PR checklist)

- Open thread A (chat-only). Switch to thread B (chat-only). Network panel shows zero `listSnapshots` frames.
- Open thread C (has file changes). `listSnapshots` fires once. Cumulative diff panel populates.
- In a previously chat-only thread, run a tool call that edits a file. Confirm `has_file_changes` flips. Subsequent switch loads snapshots.

### E2E

Out of scope for this slice. No user-visible flow changes.

## Risks

- **Backfill cost on large installs.** Backfill runs once at migration time. Indexed on `thread_id`. Acceptable for typical install sizes; verify the index exists during migration.
- **Stale flag.** If the maintenance write fails silently, a thread could have file-changing snapshots but `has_file_changes = 0`, hiding diffs. Mitigated by the shared transaction.
- **Rollback.** `down()` drops the column. A rollback paired with code revert is required, otherwise client validation fails.

## Files touched

```
packages/contracts/src/models/thread.ts                    # add has_file_changes field
apps/server/src/store/migrations/<NNNN>-thread-has-file-changes.ts  # new
apps/server/src/store/database.ts                          # register migration
apps/server/src/repositories/thread-repo.ts                # row mapper, queries
apps/server/src/services/snapshot-service.ts               # flip flag on create
apps/server/src/repositories/__tests__/thread-repo.test.ts # backfill tests
apps/server/src/services/__tests__/snapshot-service.test.ts # flag-flip tests
apps/web/src/stores/threadStore.ts                         # gate listSnapshots
apps/web/src/stores/workspaceStore.ts                      # surface has_file_changes (typing only)
apps/web/src/components/chat/MessageList.tsx               # tighten selectors
apps/web/src/__tests__/threadStore.test.ts                 # gating tests
apps/web/src/__tests__/MessageList.rerender.test.tsx       # new
```

## Acceptance criteria (from issue #333)

- [ ] `listSnapshots` is not called for threads with zero file changes.
- [ ] Non-blocking RPCs (`listPendingPermissions`, `getThreadTasks`) do not cause visible re-renders of the message list.
- [ ] Threads that do have file changes still load snapshots correctly.
- [ ] No regression in pending permissions or task display.
