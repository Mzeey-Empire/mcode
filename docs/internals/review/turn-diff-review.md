# Last turn changes

Review's **Last turn** view uses the provider's complete patch when it is available and valid. **Agent changes** identifies this source. **Live** means the turn is still running. The settled patch belongs to the assistant message and remains available after reopening the thread while its turn's snapshots remain readable.

For a single snapshot, source selection uses a valid provider unified patch first, then native full before-and-after evidence such as Cursor ACP. If native evidence is unavailable or rejected, complete tracked file-tool evidence supplies **Tracked file evidence**. Otherwise, Review uses attributed Git snapshots. **Git fallback: same-file edits may appear** explains that another editor's changes to the same file can appear in that comparison. All providers use the same Last turn controls.

Retry attempts share the first attempt's turn id. When multiple attempts contributed paths, Review reads Git evidence from the first baseline to the last snapshot: the replacement's native patch cannot describe earlier edits. A missing snapshot from a finished attempt makes the entire turn unavailable, even when later snapshots survive. Cumulative readers omit that whole turn. This also covers captures that were never written; grouping expiry dates alone would still silently shorten those turns. See [turn-snapshot-range.ts](../../../apps/server/src/features/projects/diffs/snapshots/turn-snapshot-range.ts).

The native text patch limit is 2,097,152 UTF-8 bytes, 20,000 parsed lines, and 32,768 bytes per line. The server validates the complete patch before accepting it. It rejects incomplete hunks, unsafe paths, unsupported quoted paths, binary patches, and over-limit evidence. It does not truncate patches. Repeated Cursor edits must connect the previous after state to the next before state. Rejected evidence uses the next valid source.

Live patches stay in memory. A completed turn stores its selected source separately from the Git snapshot. Stop, failure, replacement, and invalidation clear Live evidence without replacing the previous settled comparison. A reconnected client reads settled evidence until it receives a fresh diff update. Other connected clients retain their Live view. Existing messages and completed Git snapshots remain readable after the database upgrade.

Rename-with-content patches emitted with changed file headers are supported. Git-style rename or copy metadata without this native text form uses Git fallback, with its stated same-file fidelity limit.

## Snapshot pins

Git snapshots are loose tree objects, so `git gc` would prune them. Each database file has a store id, and its pins live under `refs/mcode/<storeId>/` in the repository's common git directory, so linked worktrees share them. A running turn holds `baselines/<threadId>/<executionId>`, or `baseline-trees/<threadId>/<tree>` when no execution was admitted. A settled row holds `snapshots/<snapshotId>`, a commit of `ref_after` whose parent pins `ref_before`. A process lists and deletes refs only under its own store id, so two Mcode stores can share a repository safely. See [snapshot-ref-pins.ts](../../../apps/server/src/features/projects/diffs/snapshots/snapshot-ref-pins.ts).

Pins are ordinary refs. They appear in `git log --all` and in `git for-each-ref refs/mcode/`. A default clone or fetch copies only branches and tags, so clones do not inherit them; `git clone --mirror` does. Pin failures are logged and never fail a turn. Startup and `snapshot.cleanup` sweep the store's refs against its rows.

The store id is bound to the database file's path. Moving or copying the data folder mints a new id. The new store pins only rows it writes after that point, because the old store's refs already keep the inherited trees. Without that rule every development runtime, which starts from a copy of the live database, would add refs to the user's repositories. The old store's refs stay until someone removes them by hand. `git for-each-ref refs/mcode/` lists them, and `git update-ref -d <ref>` removes one.
