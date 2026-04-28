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

`listPendingPermissions` and `getThreadTasks` are intended to be non-blocking refreshes. The current handlers in `threadStore.loadMessages()` short-circuit when the response is empty (lines 332, 346), which already covers the common chat-only case. The remaining gap is the cache-hit refresh path: when these RPCs resolve with non-empty data, the handler always builds a new array (`pending.map((p) => ({ ...p, settled: false }))`) and `set()`s it. Under `MessageList`'s `useShallow` selector on `permissionsByThread[id]`, even logically-unchanged data produces new element identities and forces a re-render.

## Goals

- Skip `listSnapshots` for threads with no file changes.
- Stop `listPendingPermissions` and `getThreadTasks` resolution from re-rendering `MessageList` when the resolved data is logically unchanged.
- Preserve correct snapshot loading for threads that do have file changes.
- Preserve pending-permission and task display.

## Non-goals

- Removing `listPendingPermissions` or `getThreadTasks` RPCs entirely.
- Splitting `useThreadStore`.
- Changes to message pagination, diff lazy loading, or CI polling.
- Anything covered by sibling issues #331, #332, #334, #335, #336.

## Approach

Two coordinated changes:

1. **Schema-backed gate for `listSnapshots`** — add a derived `has_file_changes` column on `threads`, maintained when a snapshot insert lands. The frontend skips the snapshots RPC when the flag is `false`.
2. **Equality-guarded `set()` for non-blocking RPCs** — in `loadMessages`'s permission and task resolution handlers, short-circuit `set()` when the incoming data is shallow-equal to current state.

## Server changes

### Schema migration

Add `has_file_changes INTEGER NOT NULL DEFAULT 0` to the `threads` table (SQLite represents booleans as 0/1).

- New migration under `apps/server/src/store/migrations/`.
- `up()`:
  1. `ALTER TABLE threads ADD COLUMN has_file_changes INTEGER NOT NULL DEFAULT 0`.
  2. Backfill: `UPDATE threads SET has_file_changes = 1 WHERE id IN (SELECT DISTINCT thread_id FROM turn_snapshots WHERE json_array_length(files_changed) > 0)`.
- `down()` drops the column.
- Register in `loadMigrations()` in `apps/server/src/store/database.ts`.
- The `turn_snapshots(thread_id)` index already exists (migration 007) so the backfill query is indexed.

### Maintenance write — call site

Snapshot inserts happen in `AgentService.persistTurn` (or whichever method calls `turnSnapshotRepo.create()` at `apps/server/src/services/agent-service.ts:1219`). The maintenance write must be wired here, not in `SnapshotService` (which only does git tree operations and has no DB access).

Two options:

- **Option A (recommended): wrap insert + flag update in a transaction at the call site.** Use `db.transaction(() => { ... })` from better-sqlite3 (synchronous closure; the snapshot insert and the flag update both run inside it). The transaction wraps:
  1. `turnSnapshotRepo.create({ ... })`.
  2. If `filesChanged.length > 0`: `UPDATE threads SET has_file_changes = 1 WHERE id = ? AND has_file_changes = 0` (idempotent — no row write when already true).
- **Option B: move the flag update into `TurnSnapshotRepo.create()`.** Simpler call site but the repo gains cross-table responsibility, which breaks the per-table boundary used elsewhere.

A executes on the same DB connection as the existing insert, has no observable impact on the agent-service contract, and isolates the cross-table concern at the orchestrating service. The implementation plan should pick A unless it discovers a structural reason otherwise.

The flag is one-way: once set, it stays set. Snapshot deletion (e.g., `deleteExpired`) does not reset it — out of scope for this slice; deletion is a maintenance job and stale-true is harmless (just causes a redundant `listSnapshots` for that thread on next switch, which is the pre-fix behavior).

### Repository read path

`apps/server/src/repositories/thread-repo.ts` has a single `rowToThread` row mapper at line 42, used by all read queries (`findById`, `listByWorkspace`, etc.). One change to the mapper covers every read site. The mapper coerces SQLite `0/1` to JavaScript `boolean`.

### Contract update

`packages/contracts/src/models/thread.ts` — add the field to `ThreadSchema`. Use `.default(false)` so a server response from a pre-migration build (theoretical edge: dev environments mid-deploy) still parses cleanly:

```ts
has_file_changes: z.boolean().default(false),
```

No new RPC. The flag rides on existing `listThreads`, `createThread`, and per-thread payloads.

## Client changes

### Gate `listSnapshots` in `threadStore.loadMessages()`

Cache-miss path (currently `apps/web/src/stores/threadStore.ts:414-547`):

- Read `has_file_changes` from the active thread record in `useWorkspaceStore.threads` (looked up by `threadId`).
- If `false`: skip the `listSnapshots` IIFE entirely. Inline the cache-populate call with empty `persistedFilesChanged: {}` and `null` `latestTurnWithChanges`, using the existing captured locals (`capturedMessages`, `capturedCounts`, `capturedOldest`, `capturedHasMore`).
- If `true`: existing path runs unchanged.

Cache-hit path (lines 305-359): unchanged. Already does not call `listSnapshots`. Push events and #331's invalidation handle freshness.

If the workspace store does not yet carry the thread record at the moment `loadMessages` runs (race during initial workspace load), fall back to the existing path that calls `listSnapshots`. This preserves correctness when the flag is unknown.

### Equality guard for non-blocking RPC resolutions

In both the cache-hit refresh handlers (lines 329-358) and the cache-miss handlers (lines 436-465):

**`listPendingPermissions` resolution:**

- Compare the **already-mapped** pending list (`pending.map((p) => ({ ...p, settled: false }))`) against the existing `state.permissionsByThread[threadId]`. Do not compare the raw RPC response — the existing state has the `settled: false` field added, so a raw-vs-mapped compare is always unequal.
- The compare uses a shallow per-element check across the keys that `MessageList` / `buildVolatileItems` actually project. Before implementation, grep `apps/web/src/components/chat/MessageList.tsx` and `buildVolatileItems` for the exact field reads on permission objects and pin the key list to that surface.
- If equal: skip `set()`.
- If different: `set()` as today.

**`getThreadTasks` resolution:**

- Already guarded by `&& !useTaskStore.getState().tasksByThread[threadId]?.length`. This avoids overwriting when the user has live tasks. Extend it to also skip `setTasks()` when the incoming tasks shallow-equal the current store entry (covers the cache-hit refresh case where tasks were hydrated then re-fetched).

A small `shallowEqualBy<T>(a, b, keys)` helper lives near the store or in `apps/web/src/lib/`. The helper is a few lines; do not pull in `lodash`.

### `MessageList` selectors — verification only

`MessageList` already uses fine-grained per-field selectors with `useShallow` for object/array returns (`apps/web/src/components/chat/MessageList.tsx:152-189`). No selector changes are required. The implementation plan should verify (not assume) that no descendant of `MessageList` reads `useThreadStore` or `useTaskStore` with a coarse selector that would defeat the equality guard.

The `loadEpochByThread` field is a render-affecting bump used by message-loading paths; the planner should confirm that whichever component reads it (likely the cache-hit branch in `MessageList` or its parent `ChatView`) keeps doing so.

## Data flow on thread switch (after change)

```
loadMessages(threadId)
  cache hit  -> restore from snapshot, fire listPendingPermissions + getThreadTasks (refresh).
                listSnapshots NOT called.
                Permission/task resolutions only set() when data actually changed.
  cache miss -> getMessages -> set messages + counts.
                if thread.has_file_changes: listSnapshots -> set persistedFilesChanged + cache-populate.
                else:                       cache-populate inline (empty file-change state).
                fire listPendingPermissions + getThreadTasks.
                Resolutions only set() when data actually changed.
```

## Testing

### Unit / integration

- `apps/server/src/repositories/__tests__/thread-repo.test.ts` — backfill correctness:
  - Thread with snapshot containing files → `has_file_changes = 1`.
  - Thread with snapshots whose `files_changed` is empty → `0`.
  - Thread with no snapshots → `0`.
  - Row mapper coerces `0/1` to boolean.
- `apps/server/src/services/__tests__/agent-service.test.ts` (or co-located turn-persist test) — flag maintenance:
  - Calling `persistTurn` with non-empty `filesChanged` flips the flag.
  - Calling with empty `filesChanged` leaves the flag unchanged.
  - The transaction rolls back both writes if one fails (assert flag stays `0` when insert is forced to throw).
  - The update is idempotent (already-true thread is not rewritten — verify via `db.changes`).
- `apps/web/src/__tests__/threadStore.test.ts` (extend existing) — `loadMessages`:
  - Thread with `has_file_changes = false` does not call `listSnapshots`.
  - Thread with `has_file_changes = true` calls `listSnapshots` once.
  - Permission resolution with shallow-equal data does not call `set()` (assert via store-subscriber render counter or `vi.spyOn(state, 'set')`).
  - Permission resolution with new data does call `set()`.

### Manual verification (PR checklist)

- Open thread A (chat-only). Switch to thread B (chat-only). Network panel shows zero `listSnapshots` frames.
- Open thread C (has file changes). `listSnapshots` fires once. Cumulative diff panel populates.
- In a previously chat-only thread, run a tool call that edits a file. Confirm `has_file_changes` flips. Subsequent switch loads snapshots.
- Switch between two threads that both have pending permissions. Use React DevTools profiler to confirm `MessageList` does not re-render on the second visit's permission refresh when the data is unchanged.

### E2E

Out of scope for this slice. No user-visible flow changes.

## Risks

- **Backfill cost on large installs.** Backfill runs once at migration time. Indexed via existing `turn_snapshots(thread_id)`. Acceptable for typical install sizes.
- **Transaction wrapping in `agent-service`.** Introducing `db.transaction(...)` around the snapshot insert is the first transactional write at this call site. The implementation plan must verify no async work happens inside the closure (better-sqlite3 transactions are synchronous-only) — `filesChanged` is already computed before the closure, so the closure can stay sync.
- **Stale flag on snapshot deletion.** Out of scope (deletion is a maintenance job; stale-true causes one redundant snapshot fetch per deleted-clean thread).
- **Rollback.** `down()` drops the column. A rollback paired with code revert is required, otherwise a client built against the new contract reads `undefined` and (with `.default(false)`) treats every thread as having no file changes — visible diff features break silently. Document in PR.
- **Pre-migration server / new client.** With `.default(false)`, an unmigrated server returns rows without the field; clients treat all threads as no-file-changes and skip snapshot loads. Diff badges disappear. Mitigated by lockstep deploy.
- **Cross-client flag propagation.** Today the flag is read from `useWorkspaceStore.threads`, populated by `listThreads`. If the WS push channel `thread.updated` (or equivalent) does not already include the full thread row, a second connected client may keep `has_file_changes = false` cached after the first client flips it server-side. Out of scope for this slice (single-client is the common case), but flag during implementation and consider including the field in any push payload that already carries thread updates.

## Files touched

```
packages/contracts/src/models/thread.ts                    # add has_file_changes field
apps/server/src/store/migrations/<NNNN>-thread-has-file-changes.ts  # new
apps/server/src/store/database.ts                          # register migration
apps/server/src/repositories/thread-repo.ts                # row mapper, queries (single rowToThread mapper)
apps/server/src/services/agent-service.ts                  # transaction wrap + flag update at line 1219
apps/server/src/repositories/__tests__/thread-repo.test.ts # backfill + mapper tests
apps/server/src/services/__tests__/agent-service.test.ts   # flag-flip tests (or co-located)
apps/web/src/stores/threadStore.ts                         # gate listSnapshots, equality guards
apps/web/src/lib/shallowEqualBy.ts                         # tiny equality helper (new, ~10 lines)
apps/web/src/__tests__/threadStore.test.ts                 # gating + equality-guard tests
```

`MessageList.tsx` is not in the touched list — its selectors are already correct, only verification is needed during implementation.

## Acceptance criteria (from issue #333)

- [ ] `listSnapshots` is not called for threads with zero file changes.
- [ ] Non-blocking RPCs (`listPendingPermissions`, `getThreadTasks`) do not cause visible re-renders of the message list when their resolved data is logically unchanged.
- [ ] Threads that do have file changes still load snapshots correctly.
- [ ] No regression in pending permissions or task display.
