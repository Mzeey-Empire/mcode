# Project Sort Order and Draggable Sidebar

## Summary

Add persistent, user-controlled ordering to the sidebar project list and make projects drag-and-drop reorderable using `@dnd-kit`. The sidebar stops deriving order from `pinned`/`last_opened_at` and instead uses an explicit `sort_order` column that the user controls by dragging.

## Goals

1. **Stable order**: Opening a project no longer shifts its sidebar position.
2. **Manual reordering**: Users can drag projects up and down to arrange the sidebar.
3. **Seamless upgrade**: Existing users see the same order they had before the migration.
4. **Reusable pattern**: The infrastructure (column, transaction, store logic) is generic enough to extend to thread reordering later.

## Non-Goals

- Thread reordering (future follow-up)
- Changes to the Project Selector Landing page (pinned/recent cards remain timestamp-driven)
- Multi-select drag

---

## Data Model

### New Column

Add `sort_order INTEGER NOT NULL DEFAULT 0` to the `workspaces` table.

- Lower values appear higher in the sidebar (ascending sort).
- New workspaces get `sort_order = 0`; all existing workspaces increment by 1 (new project appears at the top).
- Sequential integers, increments of 1. No sparse gaps or fractional values.

### Migration

A new migration assigns initial `sort_order` values preserving the current visual order (`pinned DESC, last_opened_at DESC`, with `id` as tiebreaker):

```sql
UPDATE workspaces SET sort_order = (
  SELECT COUNT(*) FROM workspaces w2
  WHERE (w2.pinned > workspaces.pinned)
     OR (w2.pinned = workspaces.pinned AND w2.last_opened_at > workspaces.last_opened_at)
     OR (w2.pinned = workspaces.pinned AND w2.last_opened_at = workspaces.last_opened_at AND w2.id < workspaces.id)
);
```

### Query Change

`workspace-repo.listAll()` changes from:

```sql
SELECT ... FROM workspaces
WHERE last_opened_at IS NOT NULL OR pinned = 1
ORDER BY pinned DESC, last_opened_at DESC
```

to:

```sql
SELECT ... FROM workspaces
ORDER BY sort_order ASC
```

The `WHERE` filter is removed. Every workspace now has an explicit position in the sidebar. The migration assigns positions to all workspaces (including those that were previously hidden because they had never been opened). Users see their full project list, ordered as they arrange it.

---

## RPC / Server Layer

### New Method: `workspace.reorder`

```typescript
// Request
{ id: string; newIndex: number }

// Response
{ ok: true }
```

Server logic:
1. Look up the workspace's current `sort_order`.
2. Determine direction (moving up or down).
3. Execute a 2-statement transaction:

**Moving up** (e.g., position 30 to position 5):

```sql
BEGIN TRANSACTION;
UPDATE workspaces SET sort_order = sort_order + 1
  WHERE sort_order >= 5 AND sort_order < 30;
UPDATE workspaces SET sort_order = 5 WHERE id = ?;
COMMIT;
```

**Moving down** (e.g., position 5 to position 30):

```sql
BEGIN TRANSACTION;
UPDATE workspaces SET sort_order = sort_order - 1
  WHERE sort_order > 5 AND sort_order <= 30;
UPDATE workspaces SET sort_order = 30 WHERE id = ?;
COMMIT;
```

4. Broadcast a push event so other connected clients stay in sync.

### Modified Methods

- `workspace.list`: Returns workspaces ordered by `sort_order ASC`.
- `workspace.create`: Assigns `sort_order = 0` and increments all existing values by 1.

### Unchanged

`pinned` and `last_opened_at` remain in the schema. They continue to drive the Project Selector Landing page. The sidebar and landing page use independent ordering strategies.

---

## Frontend Store

### Workspace Store Changes

New action: `reorderWorkspace(id: string, newIndex: number)`

1. Optimistically splice the array (remove from old index, insert at new index).
2. Fire `workspace.reorder` RPC in the background.
3. On failure: roll back to the previous array order and surface an error toast.

### Behavioral Changes

- `createWorkspace()` prepends the new workspace to the array (index 0).
- `setActiveWorkspace()` no longer reorders the sidebar. It still updates `last_opened_at` for the landing page, but the sidebar array position is unchanged.

---

## Drag-and-Drop UI

### Library

`@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (~12KB gzipped total).

### Integration with `ProjectTree`

- Wrap the project list in `<DndContext>` and `<SortableContext>` with a vertical sorting strategy.
- Each `ProjectNode` becomes a sortable item via the `useSortable()` hook.
- Drag handle: the entire project row.

### Visual Feedback

- Dragged item: subtle elevation/opacity change.
- Drop position: indicator line between items.
- Transitions: CSS `transform` (GPU-accelerated, no layout thrashing).

### Constraints and Sensors

| Config | Value |
|--------|-------|
| Axis lock | `restrictToVerticalAxis` |
| Container lock | `restrictToParentElement` |
| Collision detection | `closestCenter` |
| Pointer activation | 5px distance threshold |
| Keyboard | `sortableKeyboardCoordinates` (arrow keys + Enter) |

### Interaction Rules

- Only top-level project nodes are draggable (not threads).
- If a project is expanded during drag, it collapses for the duration of the drag to keep the overlay compact.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Deleted workspace | Gap in `sort_order` values is harmless; no renumbering needed |
| Multiple windows | Push event syncs all clients; last write wins |
| Empty list | No drag targets; existing empty-state UI unchanged |
| Single workspace | `DndContext` is inert with one item |
| New workspace added | Appears at top (index 0); others shift down |

---

## Future: Thread Reordering

The same pattern applies: add `sort_order` to the `threads` table, implement `thread.reorder` RPC, and extend the virtualized thread list with `@dnd-kit/sortable`. The infrastructure built here (range-shift transactions, optimistic splice, push sync) is directly reusable.
