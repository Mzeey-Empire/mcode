# 08 · Finished turn: build brief

When a turn ends, its work collapses into one "Worked for 1m 42s ›" fold, and the final answer reads as plain prose. A single "7 steps" meta line closes the turn, with no clock, duration, model or cost. Turns that changed files end with a changes bar. The bar shows the files as a tree with a diff stat and has a muted Review button that opens the Review panel pinned to that turn. Its ⋯ menu offers Review changes, Copy file paths and **Revert this turn…** (new). Revert opens a confirmation directly under the bar, then writes a receipt to the timeline, and the receipt has an Undo action. Review gains a **Since you looked** view (new), which combines the changes from turns that finished while you were away.

Surfaces: web conversation timeline (`apps/web`), contracts, server (revert operation and its recovery material, the Since you looked comparison). Electron behaves the same as web. Section 10 owns the Review panel itself and snapshot pinning (S10-12). Section 08f owns turn endings that do not finish. Section 01 owns the sidebar Finished row, the OS notification and the one seen marker (S01-03) that Since you looked reads.

## Boards

| Board | Node | Shows |
|---|---|---|
| `08a · Finished · With changes · Dark` | `21EL-2` (page p-6-0) | Work fold `21IH-2`, answer prose `21IL-2`, actions row `21IM-2`, meta line `21IX-2`, changes bar `21J0-2` (expanded, latest turn) |
| `08b · Finished · Answer only · Dark` | `250Q-2` (p-6-0) | Same turn with no changes bar ("Worked for 18s", "2 steps") |
| `08c · Finished · Review open · Dark` | `21OI-2` (p-6-0) | Review opens on the Turn view from the bar. The bar is unchanged and Review is not highlighted. The header reads "This turn", which 10a supersedes with "Turn" plus "Turn 3 latest". |
| `08d · Finished in the background · Dark` | `207O-2` (p-6-0) | Reference only. The sidebar Finished row is "S01 thread row state model" and the OS notification is "S01 OS notification". |
| `Diff summaries · E refined · Dark` | `15OZ-0` (Components p-5-0) | Changes bar component states: Expanded grouped `15P6-0`, Row hover `15T4-0`, Collapsed `15X9-0`, Folder collapsed `15XZ-0`, **Turn menu `160S-0`**, Many files `1623-0`, Loading counts `1643-0`, Counts unavailable `165M-0`, Binary and untracked `166V-0`, **Revert confirmation `16A3-0`**, Placement `16B1-0` (stale: still shows model, tokens, cost and clock; 08a wins) |
| `Diff summaries · E refined · Light` | `16C7-0` (p-5-0) | Light pair (dark first) |
| `10c · Review · States` → `State · Revert file` | `2E96-2` (p-6-0) | Shared revert confirm anatomy (`2EA2-2`), scoped to one file |
| `10c` → `State · Turn no longer available` | `2E7Y-2` (p-6-0) | Copy for an expired or pruned snapshot |
| `06d · Approved · Turn resumes` → `Receipt / Allowed once` | `2799-2` (p-6-0) | Receipt row anatomy reused by the reverted receipt |
| `10b · Review · View picker open` | `2DV5-2` (p-6-0) | View picker groups. Since you looked joins group 1. |

Exact values, read with `get_jsx` / `get_computed_styles`. Tokens come from F-01.

- **Turn group:** column, gap 12.
- **Work fold** (`21IH-2`): row h32, gap 6, border-bottom 1px `--color-border`. Label is 14/20 sans `--color-muted`, then a chevron-right 14 (stroke 1.5, muted).
- **Answer:** `--text-prose` / `--leading-prose`, `--color-ink`.
- **Actions row** (`21IM-2`): h24, gap 4. Two 24×24 buttons, radius `--radius-6`, with 14px muted icons: fork (split-arrow path from `21IO-2`, not Lucide GitFork) and copy. Visible at rest.
- **Meta line** (`21IX-2`): h24, gap 12. "7 steps" is mono 12/16 muted, followed by a 1px `--color-border` rule that fills the remaining width.
- **Changes bar, expanded:** `--color-panel`, radius `--radius-control`, padding 8/8/10/12, gap 6.
- **Changes bar, collapsed:** one row h44, padding 0 8 0 12, gap 8.
- **Bar header row:** h32, gap 8, in this order:
  - ± icon 14 muted
  - "Changed N files" 14/500 ink
  - stat in mono 12/16: `+N` in `--color-success`, `−N` (U+2212) in `--color-error`, gap 6
  - chevron 14 muted, down when expanded and right when collapsed (toggles the list)
  - spacer
  - collapse-all or expand-all, 28×28, radius-6, 14 icon (chevrons-down-up or chevrons-up-down)
  - "Review", 13/500 muted
  - ⋯ 28×28, `--color-hover` fill while its menu is open
- **File row:** h28, radius-6, padding-left 8 plus 18 per depth level, padding-right 4, gap 8. Contents in order:
  - 12px leading slot
  - file-type icon 16
  - name 13/500 ink
  - annotation 12/16:
    - `new`: `--color-success`
    - `deleted`: `--color-error`, with the name muted and struck through
    - `from <old>` and `edited later`: muted
  - spacer
  - `+N` column, 40 wide, right-aligned
  - `−N` column, 36 wide, right-aligned
  - 56px actions slot. On hover it shows Open in editor and Copy path (24-wide each) and the row gets the `--color-hover` fill.
- **Folder row:** chevron 12, folder 14, label 13 muted, count 12 muted, folder +/− totals.
- **Many files footer:** "N folders · Review all", 13/500 muted, padding-left 8.
- **Turn menu** (`160S-0`): 240 wide, `--color-panel`, 1px `--color-border`, radius `--radius-menu`, padding 4. Rows are h32, padding-inline 12, gap 8, with a 20px icon slot and a 14 ink label. Rows:
  - Review changes (± icon)
  - Copy file paths (copy icon)
  - Revert this turn…: undo icon and label in `--color-error`
- **Revert confirm** (`16AS-0`, `2EA2-2`):
  - Card: `--color-panel`, 1px border `color-mix(--color-error 35%, transparent)`, radius `--radius-control`, padding 12/14, gap 10.
  - Title 14/500 ink. Body 13/20 muted.
  - Buttons right-aligned, gap 8: Cancel is a text button (14/500 ink, h32, padding 14, radius 18). Revert has a `--color-destructive` fill with `--color-destructive-ink` text, h32, radius 18.
- **Receipt row** (`2799-2`): h28, padding-inline 8, gap 8. Icon 14, label 14/20 sans muted, detail mono 12/20 muted.

## Locked decisions

- 2026-10-07 (screen pass, 08 closed by the user): 08a and 08b show the finished turn with a merged meta line and no clock or duration. Review stays on the end-of-turn changes bar and is not amber.
- 2026-10-07: **Revert this turn** and **"Since you looked"** are approved as new features. 08e (scope picker with Since you looked, Revert this turn… menu, confirm, reverted receipt) was **not drawn** (`screen-pass-todo.md`, 08 entry).
- 2026-10-07 (10 Review decisions): Revert file is an icon in the file header of Turn views. It opens "the 08 revert confirmation in place, scoped to one file" (`implementation-notes.md`, Review (10)). The All turns view gets it too, and there it reverts the file to before the earliest turn in the view's range (user, 2026-10-08, V7). Last turn merges into Turn. The view picker shows names only, in three groups, and unavailable views are dimmed with a tooltip reason.
- 2026-10-07 (08f notes): the work fold names how the turn ended: "Stopped after 48s", "Interrupted after 30s", "Failed after 1m 02s". A cancelled turn keeps its edits, and "Revert this turn lives in the turn ⋯ menu." The changes bar stays on turns that did not finish.
- 2026-10-08 (user, E2): Retry and Resume replace the failed or interrupted attempt in the transcript. The attempts of one turn are one turn: its changes bar, its Review Turn view and Revert this turn start at the first attempt's baseline, so a failed attempt's partial edits still show and still revert.
- 2026-10-07 (05): steps count tool calls only. Narration and the final answer render as prose. Reasoning is a collapsed "Thought" row.
- 2026-10-07: truncation is the 24px right-edge fade (F-02), never an ellipsis.
- 2026-10-07: Finished, not yet opened, is an 8px green dot plus a green "Finished" line, cleared on open. The OS notification fires only when Mcode is unfocused (S01).
- Paper wins over DESIGN.md for values.

## How it works today

### Finished turn layout

- **No work fold.** `PersistedNarrative` renders every saved narrative row inline (`apps/web/src/features/conversation/narrative/PersistedNarrative.tsx:41-77`). The pipeline doc states it as policy: "Long turns keep all narrative text in the chat, with no summary view" (`docs/internals/conversation/narrative-pipeline.md:62-64`). That paragraph becomes false. Verified.
- **Row order per assistant message:**
  1. `persisted-narrative`, emitted by `virtual-items.ts:396-402`
  2. `message` (bubble plus footer)
  3. `persisted-turn-footer`
  4. `turn-changes`, emitted by `assistantTailItems`

  `assistantTailItems` (`apps/web/src/features/conversation/messages/virtual-items.ts:452-474`) appends both the footer row and the `turn-changes` row. This order already matches 08a. Verified.
- **Meta line today:** `TurnFooter` renders `7 STEPS · 1 SUB-AGENT [hairline rule] 14.3s`. It is uppercase mono with tracking, carries the duration, and adds outcome labels "You stopped", "Turn interrupted" and "Turn failed", plus approval-review text (`narrative/TurnFooter.tsx:16-23,55-65,87-108`). `PersistedTurnFooter` falls back to a duration computed from narrative record timestamps (`narrative/PersistedTurnFooter.tsx:45-54`). The canonical duration is turn wall time (`messages/canonical-message-projection.ts:153-163`). Verified.
- **Assistant footer today:** fork, copy and a hooks popover, shown only on hover (`opacity-0 … group-hover`, `messages/MessageBubble.tsx:919`). Next to them is a metadata line "model · N tok · $cost · HH:MM" (`MessageBubble.tsx:928-940`). 08a draws the icons at rest and drops the metadata. Verified.

### End-of-turn changes bar (`apps/web/src/components/chat/TurnChangeSummary.tsx`)

- Header reads "N files changed", followed by the totals and an outline "View diff ↗" button (`:211-241`). The list caps at 5 files and shows "+N more files" (`:28,308-317`). Rows show a change glyph and no annotations. Folders compress single-child chains, but the common root is not stripped (`:47-79`). Verified.
- Counts come lazily from `snapshot.listByThread` + `snapshot.getDiffStats` (git numstat). Fetch errors are swallowed ("stats are decorative", `:155-157`), so a failure looks like "no counts". This is a bug against "do not hide failures". Verified.
- The bar reads `useWorkspaceStore.getState().activeThreadId` instead of the transcript's own thread (`:139,163`). A transcript rendered for a non-active thread would query the wrong thread. Bug, inferred (needs a non-active rendered transcript to reproduce).
- View diff pins Review to this turn. It calls `setRightPanelTab("changes")`, `setReviewTurnForThread(serverMsgId)` and `setReviewViewForThread("turn")`, and falls back to All turns when the snapshot is missing (`:161-194`). A file row also requests a file jump (`:200-205`). Keep this behavior. Verified.
- `isLatestTurn` expands the latest bar, and older bars collapse unless toggled manually (`:117-123`; `MessageList.tsx:301` owns the ref). Verified.
- No turn ⋯ menu, no revert, no "edited later". Verified.
- Dead code nearby: `components/diff/TurnTimeline.tsx` and `TurnEntry.tsx` are referenced only by the barrel (`components/diff/index.ts:4`) and `__tests__/TurnTimeline.expand.test.tsx`. `CommitsView` is also dead, but it belongs to S10. `CommitEntry` is live through `CommitPicker`. Verified with `rg`.

### Turn snapshots (server)

- **Capture** (`SnapshotService.captureRef`, `apps/server/src/features/projects/diffs/snapshots/snapshot-service.ts:221-240,386-418`): a clean tree uses `HEAD^{tree}`. A dirty tree uses a temp `GIT_INDEX_FILE` + `add -A` + `write-tree`, so untracked-but-not-ignored files are captured and **ignored files are not**. The real index is never touched. Verified.
- **When:** `ref_before` is captured at turn start (`features/agents/orchestration/turn-runtime-controller.ts:598-600`). `ref_after` is captured by the finalizer (`features/agents/turns/turn-finalizer.ts:547-556`). Verified.
- **Paths:** `files_changed` holds the workspace-scoped **file effects** (agent-attributed file tools) when the provider produced any. Otherwise it falls back to `git diff --name-only before..after`, which also catches shell side effects and concurrent edits (`turn-finalizer.ts:529-538,568-574`). `worktree_path` is always written as `null` (`:598-600`), so readers resolve the working directory from thread and workspace (`diffs/transport/snapshot-rpc.ts:164-175`). Verified.
- **Attribution:** `attributedWorkspacePathGroups` keeps rename pairs and stops at 512 paths (`snapshots/snapshot-attribution.ts:32-50`). File effects are capped at 256 (`packages/contracts/src/models/file-effect.ts:5`). Tool classification is provider-neutral (`features/agents/turns/turn-file-tracker.ts:664-673,774-779`):
  - `_mcodeFileMutations`, which Cursor ACP emits
  - `file_change`, the Codex shape
  - explicit tool names: edit, write, delete, create, rename, move, apply_patch, strreplace, searchreplace
- **Retention:** rows older than `SNAPSHOT_MAX_AGE_DAYS` (30) are deleted at startup and by `snapshot.cleanup` (`application/bootstrap/server-bootstrap.ts:610-614`; `turns/persistence/turn-snapshot-store.ts:146-158`). Git objects are never pinned. Dirty-tree snapshot trees are unreachable objects, so `git gc` can prune them after `gc.pruneExpire` (default 2 weeks), before the 30 days pass. Inferred from git defaults, not reproduced here.
- **All turns** is `first.ref_before..last.ref_after` over the union of attributed paths (`snapshot-rpc.ts:103-144`). Verified.
- **Attempts:** a Retry is a new turn with its own execution, assistant message and snapshot, and only the replaced checkpoint's `phase = "retried"` records it (section 10, How it works today, "Attempts"). So a retried turn's bar and any revert of it start at the retry's own baseline, which already holds the failed attempt's edits. A restart-interrupted attempt has no snapshot at all. Verified.
- No write path exists for turn files: no revert, restore or discard in contracts or server (`rg -n -i "revert|restore" packages/contracts/src` finds nothing relevant). Verified.

### Seen state

- `thread.markViewed` exists (`packages/contracts/src/ws/methods.ts:814-817`). It only flips `status` from `completed` to `paused` and returns early otherwise (`features/thread-control/lifecycle/thread-service.ts:180-183`). Verified.
- The web client calls it on open, with a 150ms debounce (`features/projects/state/workspaceStore.ts:197-205`), and when a turn ends while its thread is active, regardless of window focus (`stores/threadStore.ts:2473-2476`). No turn-anchored "seen through" marker exists. Verified.

### Timeline receipts and concurrency

- System messages already carry typed metadata: `messages.system_notice` (`runtime/persistence/sqlite/schema.ts:361`) and a strict `SystemNoticeMetadataSchema` (`packages/contracts/src/models/message.ts:34-62`). `SystemMessageContent` renders them (`MessageBubble.tsx:790-823`). This is the receipt seam. Verified.
- `RepositoryGitMutationLock` serializes mutations per path key (`features/projects/git/repository-git-mutation-lock.ts:8-37`). Only PR review uses it today. Verified.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Work fold "Worked for 1m 42s ›" | None; all rows inline | New collapsed fold per settled turn. The label table covers every outcome, and the rows expand inline as virtual rows. | web |
| Final answer prose | Markdown bubble | Same renderer with the `--text-prose` token | web (F-01) |
| Actions row (fork, copy) | Hover only, plus a hooks popover and a metadata line | Visible at rest. Metadata dropped. Hooks popover kept when hooks ran (not drawn, see Q). | web |
| Merged meta line "7 steps [hairline rule]" | Uppercase, with duration, outcome and approval text | Counts only, lowercase. Duration and outcome move into the fold label. Approval review becomes a row inside the fold. | web |
| Changes bar header | "N files changed", totals, "View diff ↗" | "Changed N files +A −D ⌄ · collapse-all · Review · ⋯" | web |
| Bar rows | Max 5, glyphs, "+N more" | Tree with common-prefix strip, annotations, count columns, hover actions, many-files rule | web |
| Bar counts | git numstat fetch, errors swallowed | `file_effects` counts from the snapshot payload. Legacy rows fall back to git stats. Loading shows a skeleton, failure shows "Counts unavailable". | web |
| Turn ⋯ menu | None | Review changes, Copy file paths, Revert this turn… | web (F-04) |
| Revert this turn / Revert file | None | One server operation: preview, apply, undo. Each click is a durable request with pinned recovery material written before the first file write, and unfinished operations are recovered at startup. Revert file from All turns covers a range of turns. | contracts, server, web |
| Bar and revert of a retried turn | Start at the retry's own baseline, so the failed attempt's edits vanish | One turn from the first attempt's baseline, read through S10-03's turn range | server, contracts, web |
| Revert confirm (inline) | None | Card under the bar; copy driven by the preview | web |
| Reverted receipt with Undo | None | System message with a `turn-reverted` notice and a `turn_reverts` row | contracts, server, web |
| "reverted" or "edited later" on bar rows | None | Derived from `reverted_paths` and later snapshots | contracts, server, web |
| Agent told about the revert | None | One hidden line in the next turn's prompt (default on, Q3) | server |
| Since you looked view | None | Visit baseline from S01-03's `thread.acknowledgeSeen` response, cumulative `afterSequence`, view entry | contracts, server, web |
| Snapshot pinning | Unpinned trees, DB-only expiry | S10-12 pins snapshots and turn baselines under `refs/mcode/<storeId>/`. S08-03 adds `refs/mcode/<storeId>/reverts/<id>`. Each store sweeps only its own namespace. | server |
| 08d Finished row and OS notification | `status=completed` badge | S01 | None |

## Backend architecture

### 1. Turn revert operation (shared by Revert this turn and S10 Revert file)

**Semantics (default, matches the drawn Components copy "Reverting removes those edits too"):** every scope path returns to its content in the target range's `ref_before` tree, as a git checkout of that tree writes it. A path the range added is deleted, and a path it removed is recreated. A rename restores the old path and deletes the new one, across a whole chain: `a → b → c` restores `a` and deletes `c` in one operation, because the scope is always rename-closed (preview step 2). Later edits to those paths, whether by later turns or by the user, are overwritten only after the confirm names them. The operation writes the working tree only: **it never touches the index, commits or branches.** The alternative is a three-way inverse that keeps later edits that don't overlap. It is rejected for v1 (Q1).

**Target range.** Every preview and apply reads one range from S10-03's `turnSnapshotRange(threadId, messageId, fromMessageId?)` (section 10, Backend §3), never a single snapshot row:

- A turn is every attempt of one user turn (E2). `messageId` may name any attempt's assistant message; it resolves to the whole turn. A turn retried after a failure that edited files starts at the first attempt, so Revert this turn restores the first attempt's pre-state, including paths only the failed attempt touched.
- Without `fromMessageId` the range is `messageId`'s turn. With it (file scope only, Revert file from All turns, V7) the range is every turn from `fromMessageId`'s through `messageId`'s, in message order, each turn whole. A `fromMessageId` that comes after `messageId` is a validation error.
- The range's `ref_before` is its first row's `ref_before`, its `ref_after` the last row's `ref_after`, and its attributed groups the union over its rows. A turn that was never retried is a one-row range, so its behavior is unchanged.
- A turn whose range is incomplete (a finished attempt's snapshot row expired or was never written, section 10, Backend §3) is never read as a shorter range. Revert treats it as expired: `snapshot_missing`.

**Two identities, kept apart.** Every Revert or Undo click carries a client-generated `requestId`. It is the operation's identity: the server persists it with the bound parameters and the outcome, and replays only that request. The `previewToken` is only a precondition. It proves the files are still in the state the user confirmed. A new click gets a new `requestId`, so Revert, Undo, then Revert again is three operations, even though the third preview hashes to the same token as the first.

**Recovery before writing.** A git tree is not a byte-exact record of the working tree. `captureRef` goes through `add -A` with clean filters (`snapshot-service.ts:398-416`), so line endings, filtered files, symlinks on some platforms and the executable bit can differ on the way back, and two different files can produce the same filtered blob. Every decision a write, a rollback or recovery makes about a path therefore compares raw states (presence, file type, mode, size, raw sha256, symlink target), never filtered blobs. Before the first destructive write, the operation records two raw states for each path it will touch: `pre`, the path as it is now, and `planned`, the exact state the write will leave. It stores the bytes of both as unfiltered blobs (`git hash-object -w --no-filters`), pins them under `refs/mcode/<storeId>/reverts/<id>`, and commits a `prepared` row holding both states. Only then does it write, and it writes each path from its planned blob, so the bytes on disk are the bytes recorded. Rollback, Undo and recovery restore from the `pre` blobs, so they are byte-exact. The forward revert still equals a git checkout of `ref_before`, because the planned bytes come from `checkout-index` (`planCheckout` below).

**Contract** (`packages/contracts/src/models/turn-revert.ts`, new; register in `ws/methods.ts` and `ws/channels.ts`, use `lazySchema`):

```ts
export const TurnRevertScopeSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn") }),
  z.object({
    kind: z.literal("file"),
    path: z.string().min(1).max(4096),                    // must be attributed to a turn in the range
    fromMessageId: z.string().min(1).max(256).optional(), // All turns: first turn of a range ending at messageId; omitted = messageId's turn
  }),
]));

/** What apply will do to one path, computed from before/after/current blob ids. */
export const RevertFilePlanSchema = lazySchema(() => z.object({
  path: z.string().max(4096),
  previousPath: z.string().max(4096).optional(),   // rename source that apply recreates
  action: z.enum(["restore", "delete", "recreate"]),
  state: z.enum(["clean", "changed_later", "already_reverted"]),
  changedBy: z.enum(["later_turn", "outside"]).optional(), // set when state = changed_later
  binary: z.boolean(),
}));

export const TurnRevertUnavailableSchema = z.enum([
  "not_git",            // workspace is not a git repo: no snapshots exist
  "snapshot_missing",   // row expired (30 days) or never written, for any finished attempt of the target turn
  "snapshot_pruned",    // ref_before/ref_after objects gone (gc)
  "worktree_missing",   // resolved cwd no longer exists
  "no_attributed_files",
  "recovery_expired",   // Undo only: the revert's recovery material passed the 30-day window
]);

export const TurnRevertPreviewSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    // Precondition, not an identity: sha256 over the repo identity (git common dir), the resolved cwd,
    // the range's snapshot ids in order, the scope, and each scope path's presence, file type, mode and raw-content sha256.
    previewToken: z.string().max(128),
    files: z.array(RevertFilePlanSchema()).max(512),
    skipped: z.array(z.object({
      path: z.string().max(4096),
      reason: z.enum(["ignored", "submodule", "folder_in_the_way"]), // folder_in_the_way: a file must be recreated where a folder now holds unrelated files
    })).max(512),
    unattributedChangeCount: z.number().int().nonnegative(), // paths changed in the turn window by commands, not reverted
  }),
  z.object({ status: z.literal("nothing_to_revert") }), // every path already at its before-state
  z.object({ status: z.literal("busy"), reason: z.enum(["turn_running", "revert_running"]) }),
  z.object({ status: z.literal("unavailable"), reason: TurnRevertUnavailableSchema }),
]));

export const TurnRevertRecordSchema = lazySchema(() => z.object({
  id: z.string(),
  threadId: z.string(),
  targetMessageId: z.string(),
  fromMessageId: z.string().nullable(),   // set for an All turns range revert
  kind: z.enum(["turn", "file", "undo"]),
  path: z.string().nullable(),
  undoesRevertId: z.string().nullable(),
  undoneByRevertId: z.string().nullable(),
  files: z.array(z.object({
    path: z.string(), previousPath: z.string().optional(),
    action: z.enum(["restore", "delete", "recreate"]),
  })).max(512),
  receiptMessageId: z.string(),
  createdAt: z.string(),
}));

export const TurnRevertResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("reverted"), revert: TurnRevertRecordSchema(), receipt: MessageSchema() }),
  z.object({ status: z.literal("stale"), preview: TurnRevertPreviewSchema() }), // files moved since preview: re-render the confirm
  z.object({ status: z.literal("busy"), reason: z.enum(["turn_running", "revert_running"]) }),
  z.object({ status: z.literal("unavailable"), reason: TurnRevertUnavailableSchema }),
  z.object({
    status: z.literal("failed"),
    // unchanged: failed before the first write. rolled_back: files were written, then put back byte-exact.
    // recovery_failed: some paths could not be put back, or could not be proved to hold this operation's write.
    // `paths` lists them, they are left as they are, and startup retries recovery.
    outcome: z.enum(["unchanged", "rolled_back", "recovery_failed"]),
    paths: z.array(z.string().max(4096)).max(512),
    detail: z.string().max(500),
  }),
]));
```

| Wire | Params | Result |
|---|---|---|
| `turn.revert.preview` | `{ threadId, messageId, scope }` | `TurnRevertPreview` |
| `turn.revert.apply` | `{ threadId, messageId, scope, previewToken, requestId }` (`requestId`: uuid, one per click) | `TurnRevertResult` |
| `turn.revert.undo` | `{ threadId, revertId, requestId }` | `TurnRevertResult` (`stale` = files changed since the revert, so Undo is refused) |
| push `turn.reverted` | `{ threadId, revert: TurnRevertRecord, receipt: Message }` | Other clients append the receipt and refresh bar state |
| `snapshot.listByThread` (changed) | None | Each `TurnSnapshot` gains `reverted_paths: string[]`: paths currently reverted by committed, non-undone records whose range holds this row and that this row attributes. A range revert therefore marks the path on every row of its range that touched it. S08-08 adds `message_sequence`; S10-03 adds `attempt_count`. |
| `SystemNoticeMetadataSchema` (changed) | `kind` adds `"turn-reverted" \| "turn-revert-undone" \| "turn-revert-interrupted"`, plus `revertId?: string (max 64)` | None |

A `requestId` that is already stored with different bound parameters is a validation error, not a result.

**Server** (`apps/server/src/features/projects/diffs/revert/turn-revert-service.ts`, new; RPC router `diffs/transport/turn-revert-rpc.ts`, same pattern as `snapshot-rpc.ts`). Dependencies: `TurnSnapshotRepo`, S10-03's `turnSnapshotRange`, `SnapshotService` (new methods below), `SnapshotRefPins` and the store id from S10-12, `RepositoryGitMutationLock`, thread and workspace services, the application database writer, broadcast. Move `resolveSnapshotCwd` out of `snapshot-rpc.ts:164-175` into a shared helper.

New `SnapshotService` methods, reusing the existing pathspec batching (`literalPathspecs`, `batchPathspecGroups`):

- `blobIdsAt(cwd, ref, paths)`: `ls-tree -z <ref> -- <:(literal) paths>` returns `Map<path, {blob, mode} | null>`.
- `currentBlobIds(cwd, seedRef, paths)`: temp index seeded with `read-tree <seedRef>`, then `add -A -- <paths>`, then `ls-files -s -z -- <paths>`. This hashes the working tree exactly the way `captureRef` does (clean filters, eol, symlinks, modes) without touching the real index. Preview classification uses it and nothing else. It never decides what a write, rollback or recovery may touch, because a clean filter or EOL normalization maps different raw bytes to one blob.
- `workingTreeState(cwd, paths)`: `lstat` per path, no git. Returns `PathState { kind: "absent" | "file" | "symlink" | "directory"; mode: number; size: number; sha256: string | null; linkTarget: string | null }`, hashing raw bytes for files and the target string for symlinks. A folder's state is its kind only. The `previewToken`, the commit check, Undo's staleness check and recovery all compare `PathState`s, so mode-only and type-only changes are visible. Mode is compared only where git tracks it (`core.fileMode`); on Windows, where git ignores the executable bit, kind and content decide.
- `captureRaw(cwd, paths)`: writes each existing file's raw bytes with `hash-object -w --no-filters --stdin-paths` and each symlink target with `hash-object -w --stdin`. Returns `RawPathState` per path: its `PathState` plus `rawBlob` (null for absent paths and folders).
- `planCheckout(cwd, ref, operationId, paths)`: temp index seeded with `read-tree <ref>`, then `checkout-index --prefix=<staging>/ -- <paths present in ref>` into a staging folder at `git rev-parse --git-path mcode-revert-<operationId>`. Under `--prefix`, git still applies each real path's attributes, so the staged bytes are what a checkout of that path would write: smudge filters, eol conversion, symlinks per `core.symlinks`, and modes. A scratch repo on git 2.41 confirmed CRLF conversion and a smudge filter under `--prefix`. `captureRaw` on the staging folder gives each path's planned `RawPathState`. A path absent from `ref` plans as `absent`, and a path that `ref` holds as a tree plans as `directory`. The staging folder is deleted in a `finally`. It writes nothing in `cwd`.
- `pinRecovery(cwd, storeId, operationId, states)`: builds a tree from every `pre` and `planned` raw blob in a temp index (`update-index --index-info`, `write-tree`), wraps it with `commit-tree` (fixed `Mcode` identity, as S10-12) and points `refs/mcode/<storeId>/reverts/<operationId>` at it. Throws when any step fails; the caller then writes nothing.
- `restoreRaw(cwd, entries)`: the only writer. It puts each path into a recorded `RawPathState`. Files are written from `cat-file blob <rawBlob>` to a temp file in the same folder, named with the operation id, and renamed over the target, then given their recorded mode (not on Windows). Symlinks are recreated from `linkTarget`. Absent paths are deleted. Before every write or delete, a `realpath` check confirms the parent folder is inside `cwd`, so a symlinked folder cannot redirect it. Order: deletions deepest first, then removal of parent folders that are now empty and that no target state needs, then writes, so a file-to-folder or folder-to-file transition works. Apply, rollback, Undo and recovery all write through it.

**Preview algorithm:**

1. Resolve the target range (above). A missing snapshot row for `messageId` or `fromMessageId`, or an incomplete range for either turn, gives `snapshot_missing`. A non-git workspace gives `not_git`. Resolve `cwd`; if it doesn't exist, return `worktree_missing`.
2. Scope. The scope is rename-closed: it holds every path joined to a seed path by a rename, so a revert never removes a rename's new name without restoring its old one.
   - Seeds. Turn scope: every path the range attributes. File scope: `path`, which a row of the range must attribute; any other path is a validation error, so the RPC never starts from a path the range did not touch.
   - Rename links come from two sources. The first is each attributed group of each row (`[path, oldPath]`, `snapshot-attribution.ts:35-38`). The second is the renames git reports over the range, `git diff --name-status -z -M --diff-filter=R <ref_before> <ref_after>`, the same pairs the Turn view shows as one file. The git pairs matter on their own: a git-fallback row's `files_changed` comes from `git diff --name-only` (`snapshot-service.ts:263`), which lists a rename by its new name only (checked on git 2.41), so that row never names the old path. Copies are not links, because a copy leaves its source in place.
   - The scope is the closure of the seeds over those links. For `a → b` in Turn 1 and `b → c` in Turn 3, the groups are `[b, a]` and `[c, b]`, which `collectAttributedWorkspacePathGroups` keeps apart (`snapshot-attribution.ts:58-68`). The closure of `c` is `{a, b, c}`: apply recreates `a`, deletes `c`, and classifies `b`, absent at both ends, as `already_reverted`. The same holds for two renames inside one attempt, across the attempts of a retried turn, and for a single git-detected rename in one turn.
   - Every later step uses the closed scope: classification (step 4), `unattributedChangeCount` (step 5), the `previewToken` (step 7), the `pre` and `planned` capture and the recovery pin (Apply step 3), and through them Undo and recovery. A path in the closure that no row attributes is still restored, because it is the other side of a rename in the range's own diff. The plan entry for the final name carries the original name as `previousPath`.
3. Check that `cat-file -e` succeeds for the range's `ref_before` and `ref_after`; otherwise return `snapshot_pruned`.
4. Read `before = blobIdsAt(ref_before)`, `after = blobIdsAt(ref_after)` and `current = currentBlobIds(ref_after)`, all from the range's refs. Classify each path:
   - `already_reverted` when current equals before.
   - `clean` when current equals after.
   - `changed_later` otherwise. `changedBy` is `later_turn` when a snapshot of a turn after the range, on a thread with the same resolved `cwd`, attributes the path; otherwise it is `outside`. Rows inside the range, such as earlier attempts of a retried turn or the other turns of an All turns range, are never "later".

   Gitignored paths (`check-ignore`) and gitlinks go to `skipped`. A path whose before-state is a file but which is now a folder holding files outside the scope goes to `skipped` as `folder_in_the_way`, because recreating it would delete unrelated work.
5. `unattributedChangeCount` is `git diff --name-only ref_before ref_after` over the range, minus the attributed paths and the scope. It is 0 when no row of the range has file effects.
6. Busy check: return `busy` when any thread whose resolved working directory equals `cwd` has an active turn or thread startup, or when a revert is in flight for that `cwd`.
7. `previewToken` hashes the repo identity, `cwd`, the range's snapshot ids in order, the scope and `workingTreeState` of every scope path.

**Apply.** It runs inside `RepositoryGitMutationLock.run(cwd)`:

1. **Replay.** Look up `turn_reverts.request_id = requestId`. If it exists with the same bound parameters (`threadId`, `messageId`, `scope`, `previewToken`), return its stored outcome and write nothing: `committed` returns `reverted`, `rolled_back` and `recovery_failed` return `failed` with that outcome. A live writer holds the lock, so a replay finds a `prepared` row only when an earlier status write failed; it settles that row with the startup-recovery check below before answering. Outcomes that wrote nothing (`stale`, `busy`, `unavailable`, `nothing_to_revert`, `failed/unchanged`) are not stored, so a replay recomputes them.
2. **Precondition.** Recompute the preview. If its token differs from the request's `previewToken`, return `stale` with the fresh preview.
3. **Prepare.** For every path the write will touch (scope paths minus `already_reverted` and `skipped`), `captureRaw` records the `pre` state and `planCheckout(cwd, ref_before, id, paths)`, with the range's `ref_before`, records the `planned` state. `pinRecovery` pins both sets of blobs. Then insert the `turn_reverts` row in state `prepared`: request id, bound parameters, and each path's action, before-blob, `pre` and `planned`. If any step fails, return `failed/unchanged`. No file has been written yet.
4. **Write.** `restoreRaw(cwd, plannedStates)`.
5. **Commit.** Read every touched path's `workingTreeState`. Each must equal its `planned` state; a mismatch means another writer got in, and it is handled as a failure after the first write (step 6). Then, in **one** database write (prior art `persistTurnSnapshot`, `features/agents/turns/persistence/turn-finalization-write-operations.ts:11`), set the row to `committed` and insert the receipt system message at `latestSequence + 1`. The receipt has role `system`, fallback content text ("Reverted Turn 3 · 7 files" for a turn, "Reverted a.ts · Turn 3" for a file, "Reverted a.ts · Turns 1–5" for a range), and `systemNotice { kind: "turn-reverted", presentation: "timeline", revertId }`. Broadcast `turn.reverted` and `turn.diffChanged` after the write commits. The git watcher emits `files.changed` as usual.
6. **Failure after the first write** (a write error such as a Windows file lock, `EBUSY`/`EPERM`, a commit-check mismatch, or a failed commit write): settle the row with the recovery rule below, so a path is put back only when it holds exactly its planned state. Set the row to `rolled_back`, or to `recovery_failed` with the listed paths, and return the matching `failed` result. If that status write also fails, the row stays `prepared` and startup recovery settles it.

**Undo** (`turn.revert.undo`) follows the same replay rule by `requestId`. Load the target record `r`: it must be `committed`, have `kind ≠ undo` and not be undone, and its recovery ref must still exist (else `unavailable: recovery_expired`). Under the lock, compare each touched path's `workingTreeState` with `r`'s `planned` state, which `r`'s commit check proved was on disk. Any mismatch returns `stale`. Otherwise prepare an `undo` row whose `pre` is each path's current raw state and whose `planned` is `r`'s `pre`. Its own pin holds both sets of blobs, so its recovery never depends on `r`'s ref. Then `restoreRaw` the planned states and, in one write, commit the undo row, a `turn-revert-undone` receipt and `r.undone_by_revert_id`. Failure handling is the same as apply.

**Startup recovery.** Before the server accepts RPCs, after `removeExpiredSnapshots` (`server-bootstrap.ts:610-616`), `TurnRevertService.recoverUnfinished()` takes the repo lock for every `prepared` and `recovery_failed` row. It first deletes leftover temp files that carry the row's operation id. Then it reads each touched path's raw `workingTreeState` and compares it with the row's recorded raw states:

- Equal to `pre`: never written, or already put back. Nothing to do.
- Equal to `planned`: these are the exact bytes, type and mode this operation wrote. `restoreRaw` puts `pre` back, and the path is read again to confirm it now equals `pre`.
- Anything else: someone changed the path after the crash. This includes an edit that only changes line endings and an edit that a clean filter would hide, because recovery never compares filtered blobs. Leave the path alone and list it.
- Not provable: the row has no `planned` state for the path, or the path holds its planned state but the recovery ref or its `pre` blob is missing. Write nothing to the path and list it.

The row becomes `rolled_back` when every path equals its `pre`. Otherwise it becomes `recovery_failed` with the listed paths, keeps its row and its recovery ref (the sweep never deletes them, §4), and the next start tries again. Each settled row gets one `turn-revert-interrupted` receipt, "Revert of Turn 3 was interrupted. Files were put back." or "Revert of Turn 3 was interrupted. 2 files could not be put back: a.ts, b.ts", so a crash is never silent.

**Across a range** (a retried turn, or a Revert file from All turns):

- **Undo** is unchanged. It never reads snapshots: it compares each touched path with the record's `planned` state and writes back the record's `pre` bytes, so undoing a range revert works exactly like undoing a one-turn revert.
- **Recovery** is unchanged for the same reason: it reads only the row's raw states and its recovery ref.
- **Edited later** means a turn after the range's last turn attributes the path. Rows inside the range are what the revert covers, never "later". On the bar, `reverted` outranks `edited later` on every row of the range that touched the path (`reverted_paths`).
- **Edits inside the range** that no turn attributes, such as a hand edit between two turns or two attempts, are part of the range's diff, which the view shows. Revert undoes them without naming them; only a change after the range's end is `changed_later`.

**Ordering with turns:** every snapshot capture (`turn-runtime-controller.ts:598-608`, and the `captureRef` calls in `turn-file-effects.ts:158`, `turn-execution-file-evidence.ts:81` and `turn-finalizer.ts:556`) runs inside `RepositoryGitMutationLock.run(cwd)`, together with its baseline pin; S10-12 makes that change. A send that arrives during a revert then waits, and its `ref_before` reflects the reverted files. This is the cross-component trap to document. The lock is in-process: it does not stop an editor, external git or a second Mcode runtime on the same repo.

**DB** (Drizzle schema in `runtime/persistence/sqlite/schema.ts`, generate the SQL with `bun run db:generate`):

```sql
CREATE TABLE turn_reverts (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,    -- client requestId: the operation identity
  request_params TEXT NOT NULL,       -- JSON of the bound parameters; a replay must match them
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  target_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  from_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, -- first turn of an All turns range; null otherwise
  kind TEXT NOT NULL,                 -- turn | file | undo
  path TEXT,                          -- file scope only
  undoes_revert_id TEXT REFERENCES turn_reverts(id) ON DELETE SET NULL,
  undone_by_revert_id TEXT,
  state TEXT NOT NULL,                -- prepared | committed | rolled_back | recovery_failed
  files TEXT NOT NULL,                -- JSON [{path, previousPath?, action, beforeBlob|null, pre: RawPathState, planned: RawPathState}], written before the first file write
  recovery_ref TEXT,                  -- refs/mcode/<storeId>/reverts/<id>; null once expired
  failure TEXT,                       -- JSON {paths, detail} for rolled_back and recovery_failed
  receipt_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, -- set when committed or settled by recovery
  agent_notified_at TEXT,             -- see §3
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_turn_reverts_thread ON turn_reverts(thread_id, created_at);
CREATE INDEX idx_turn_reverts_target ON turn_reverts(target_message_id);
CREATE INDEX idx_turn_reverts_unfinished ON turn_reverts(state) WHERE state IN ('prepared', 'recovery_failed');
```

**Failure modes and their UI:**

| Result | UI |
|---|---|
| `busy` | Item disabled: "Wait for the turn to finish" |
| `unavailable` | Confirm shows the reason, with Close only |
| `stale` | Confirm re-renders with the new copy |
| `failed/unchanged` | "Couldn't revert <file> · <detail>. Nothing was changed." with Retry (a new click, so a new `requestId`) |
| `failed/rolled_back` | "Couldn't revert <file> · <detail>. Files were put back as they were." with Retry |
| `failed/recovery_failed` | "Couldn't put back N files: a.ts, b.ts. Check Review › Unstaged." No Retry. Mcode retries recovery on the next start and writes an interrupted receipt. |
| `nothing_to_revert` | "Already reverted" |

### 2. Since you looked (reads the S01-03 seen marker)

**Marker:** S01-03 owns the one seen marker and its only write, `thread.acknowledgeSeen({ threadId, throughSequence })`. `throughSequence` is the settled message sequence the client has actually rendered. The response is `{ previous: { sequence, at }, current: { sequence, at } }`, returned atomically. A repeat is a no-op, and a sequence beyond the thread's settled history is rejected. S01-03 also retires `thread.markViewed` and migrates every caller, including today's focus-blind end-of-turn call (`stores/threadStore.ts:2473-2476`). This section adds no column, RPC or `markViewed` change of its own.

**Visit baseline:** the first acknowledgement of a visit that advances the marker (`previous.sequence < current.sequence`, where a null sequence counts as 0) fixes the baseline: the web client stores `sinceLookedBaselineByThread[threadId] = previous.sequence ?? 0` in memory. It stores the baseline **before** it applies the response to the attention state, so the Finished badge never clears without a baseline. Later acknowledgements in the same visit, including turns that end while you watch, do not replace it, and a no-op response sets nothing. Leaving the thread drops it (`clearThread`, the same rule as ADR-0011's per-thread view state). Because the marker persists on the server, "finished while the app was closed or the thread was unopened" works across restarts. If another window acknowledged first, this window receives a no-op and Since you looked stays unavailable in it.

S01-03's client caller receives the response. S08-08 subscribes to it through the hook or store field that S01-03 exposes; S01-03 names it.

**Comparison:** `snapshot.getCumulativeDiff` and `snapshot.getCumulativeDiffStats` take an optional `afterSequence: number`. With it they select whole turns, never single rows (E2):

- A turn is in when its latest attempt's assistant message sequence is greater than `afterSequence`. Then every row of its S10-03 range is in (`turnSnapshotRange`), including an attempt that settled before the baseline.
- A turn is one unit here as it is in the Turn view, the changes bar and revert. Filtering rows instead would start a retried turn at its replacement whenever the user looked between a failure and its Retry, and drop the failed attempt's edits that the Turn view shows.
- An incomplete turn is skipped, as an expired one is (section 10, Backend §3, Retention).
- The selected rows then go through the All turns path (`snapshot-rpc.ts:103-144`): from the first selected row's `ref_before` to the last one's `ref_after`, over the union of their attributed paths, with the same 10,000-file cap.

`TurnSnapshotStore.listByThread` joins `messages` for `message_sequence`. No new comparison engine. S08-08 owns both changes.

### 3. Agent notice (default on, Q3)

At turn admission, the server selects `turn_reverts` rows for the thread that are `committed`, have `agent_notified_at IS NULL` and whose net effect still stands (not undone). It prepends one hidden line to the provider prompt and sets `agent_notified_at` in the same write that persists the user message. The line reads: `Note from Mcode: the user reverted your earlier changes to: a.ts, b.ts (restored to their state before that turn).` The line is not shown in the user bubble. The prompt assembly site is inferred to be `turn-admission-dispatch-coordinator.ts` and must be verified. All adapters receive plain text, so no adapter changes.

### 4. Snapshot pinning and revert recovery refs

- **Turn snapshots and baselines are S10-12's** (section 10, Backend §6). It owns the store id, `refs/mcode/<storeId>/snapshots/<id>`, the baseline pin taken at capture time, the fixed git identity and the startup sweep. Revert depends on it: `ref_before` must still exist when the user reverts, and S08-03 is blocked by S10-12.
- **Revert recovery refs are S08-03's:** `refs/mcode/<storeId>/reverts/<operationId>` points at the commit `pinRecovery` builds from the `pre` and `planned` raw blobs. It is created before the row is inserted and before any file write. Unlike snapshot pins, a recovery pin that fails stops the operation (`failed/unchanged`).
- **Sweep.** S08-03 extends S10-12's startup sweep with `reverts/`, inside this store's namespace only. It deletes a recovery ref when no row has its id, or when a `committed` or `rolled_back` row is older than `SNAPSHOT_MAX_AGE_DAYS` (30). In that case it also clears the row's `recovery_ref`, so Undo returns `unavailable: recovery_expired`. It never deletes the ref of a `prepared` or `recovery_failed` row, and never reads or deletes refs under another store's id. Refs under `refs/` are shared by every linked worktree and every runtime database on the repo, which is why a store can only reason about its own namespace.
- After the 30-day window, revert returns `snapshot_missing` and Review shows 10c "Turn 1's changes are gone".

### Provider decisions

Revert, the seen marker and Since you looked operate on git trees and Mcode's own records. None of them goes through an adapter. Revert scope depends on how well each adapter's file edits are attributed, and that is unchanged here.

| Provider | Revert op / Since you looked | Revert scope source today | Agent notice | Native rewind |
|---|---|---|---|---|
| Claude | No change | Explicit file tools Edit/Write (`turn-file-tracker.ts:774-779`). MultiEdit is not in the list, so such turns fall back to git names (inferred). | No change (plain prompt text) | Not used. Claude SDK file checkpointing is rejected for neutrality (existence inferred). |
| Codex | No change | `file_change` items (`turn-file-tracker.ts:681-688`) | No change | Not used. Codex undo is rejected for neutrality (inferred). |
| Cursor | No change | `_mcodeFileMutations` (`packages/providers/src/private/cursor/acp/cursor-acp-event-mapper.ts`) | No change | Not used |
| Copilot | No change | Explicit tool names, else git fallback (inferred) | No change | None |
| Devin (ACP) | No change | Explicit tool names, else git fallback (inferred) | No change | None |
| OpenCode | No change | Explicit tool names, else git fallback (inferred) | No change | None |

## Components

### New

- `features/conversation/turn/WorkFold.tsx`: the fold row, plus a pure `workFoldLabel(outcome, durationMs)` table:

  | Outcome | Label |
  |---|---|
  | completed | "Worked for 1m 42s" |
  | cancelled | "Stopped after 48s" |
  | interrupted | "Interrupted after 30s" |
  | errored | "Failed after 1m 02s" |
  | unknown duration | "Worked" |

  Durations use `formatDuration` (`lib/time.ts:2-17`). Expanding inserts the turn's narrative rows (startup trail, narration, tool groups, thoughts, receipts, hooks, approval-review row) as separate virtual rows through the existing group-expansion state (`useTranscriptGroupExpansion.ts`), keyed `work-fold:<messageId>`.
- `features/conversation/turn/TurnMetaLine.tsx`: "N steps · K sub-agents" (zero counts omitted) plus the rule. Same count semantics as today (narrative-pipeline Trap 6).
- `features/conversation/turn/TurnChangesBar.tsx` plus a pure `changes-tree.ts`: header, tree, annotations, many-files rule, row hover actions. Reuses `FileTypeIcon`, `FileEditorPicker`, and the copy-path action from `components/diff/FileActionBar.tsx`. `SubagentChangeSummary` (S12) can adopt it later. Not this ticket.
- `features/conversation/turn/TurnMenu.tsx`: three items on F-04.
- `features/conversation/turn-revert/RevertConfirm.tsx` and `useTurnRevert.ts`: preview, apply and undo state machine. `useTurnRevert` creates one `requestId` per Revert or Undo click, keeps it until a terminal result arrives, and resends it after a reconnect. **S10 Revert file reuses both.**
- `features/conversation/turn-revert/TurnRevertReceipt.tsx`: receipt row rendered from `systemNotice.kind` (reverted, undone, interrupted).
- `lib/turn-ordinals.ts`: `turnOrdinals` extracted from `components/diff/TurnPicker.tsx:34-41` so the picker, receipts and the Since you looked label agree.
- Server: `diffs/revert/turn-revert-service.ts` (apply, undo, `recoverUnfinished`), `diffs/transport/turn-revert-rpc.ts`, and `turns/persistence/turn-revert-store.ts`, which adds `turn_reverts` to the schema. Recovery pins go through S10-12's `diffs/snapshots/snapshot-ref-pins.ts`.

### Changed

- `virtual-items.ts`: for a settled assistant message, emit a `work-fold` item where `persisted-narrative` used to be. Narrative rows are emitted only while the fold is expanded. Replace `persisted-turn-footer` with `turn-meta-line` and `turn-changes` with the new bar. Order: fold, answer, actions, meta line, bar (08a).
- Live-to-settled transition. When the current turn settles:
  - **Following the tail:** the fold appears collapsed, and the viewport stays pinned to the bottom.
  - **Scrolled up into that turn's rows:** the fold is recorded as expanded, so the row being read is not yanked away. It collapses on the next visit.
  - **Reduced motion:** no height animation.
- `MessageBubble.tsx`: actions visible at rest. Delete `AssistantMessageMetadata`. Handle system notices `turn-reverted`, `turn-revert-undone` and `turn-revert-interrupted` before the default divider.
- `SnapshotService` gains `blobIdsAt`, `currentBlobIds`, `workingTreeState`, `captureRaw`, `planCheckout`, `pinRecovery` and `restoreRaw`.
- `TurnSnapshotStore.listByThread` returns reverted paths (S08-03), joins the message sequence (S08-08) and returns `attempt_count` (S10-03). `server-bootstrap.ts` runs `recoverUnfinished()` before accepting RPCs.
- `diffStore.ts`: `sinceLookedBaselineByThread`, set from S01-03's acknowledgement response, and the `DiffViewMode` union gains `"since-looked"` (S10 owns the picker entry layout).

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| `TurnChangeSummary` (+ `__tests__/TurnChangeSummary.test.tsx`) | `apps/web/src/components/chat/TurnChangeSummary.tsx` | `TurnChangesBar` | S08-02 | `rg -n "TurnChangeSummary" apps/web/src` returns nothing |
| `MAX_DISPLAYED_FILES` = 5 and the "+N more files" button | same file `:28,308-317` | Many-files rule plus "N folders · Review all" | S08-02 | `rg -n "MAX_DISPLAYED_FILES" apps/web/src` returns nothing |
| Outline "View diff ↗" button | same file `:231-239` | Muted "Review" text button | S08-02 | `rg -n "View diff" apps/web/src` returns nothing |
| Swallowed stats error (`catch {}`) | same file `:155-157` | "Counts unavailable" state | S08-02 | `bun run --cwd apps/web test -- src/features/conversation/turn/__tests__/TurnChangesBar.test.tsx` passes, including the case where a failed count fetch renders "Counts unavailable" |
| `TurnFooter`, its outcome labels, duration, uppercase styling and `ApprovalReviewStatus` | `narrative/TurnFooter.tsx` | `TurnMetaLine`, the `WorkFold` label table, and an approval-review row inside the fold | S08-01 | `rg -n "TurnFooter\b\|TurnFooterStatus\|ApprovalReviewStatus" apps/web/src` returns nothing |
| `PersistedTurnFooter` (its duration fallback moves into `workFoldLabel`) | `narrative/PersistedTurnFooter.tsx` | `TurnMetaLine` and `WorkFold` | S08-01 | `rg -n "PersistedTurnFooter\|persisted-turn-footer" apps/web/src` returns nothing |
| `TurnFooter.test.tsx` | `narrative/__tests__/` | `TurnMetaLine.test.tsx`, `WorkFold.test.tsx` | S08-01 | `rg --files apps/web/src -g "TurnFooter.test.tsx"` returns nothing |
| `AssistantMessageMetadata` (model · tok · $ · HH:MM) | `MessageBubble.tsx:928-940` | Nothing (08a draws none; Q4) | S08-01 | `rg -n "agent-message-metadata" apps/web/src` returns nothing |
| Hover-only opacity on assistant actions (the user-message copy button keeps its hover reveal) | `MessageBubble.tsx:919` | Visible at rest | S08-01 | `bun run --cwd apps/web test -- src/features/conversation/messages/__tests__/MessageBubble.test.tsx` passes with its `agent-message-actions` assertion rewritten to "visible at rest" (today it asserts the hover class, `:583`) |
| Pipeline doc "no summary view" paragraph, Trap 5 and checklist text that reference the `TurnFooter` duration | `docs/internals/conversation/narrative-pipeline.md:62-64,302,381-403,456-510,530` | Rewritten for the work fold | S08-01 | `rg -n "TurnFooter" docs/internals` returns nothing |
| Private `turnOrdinals` | `components/diff/TurnPicker.tsx:34-41` | `lib/turn-ordinals.ts` | S08-04 | `rg -n "function turnOrdinals" apps/web/src/components` returns nothing |

`TurnTimeline` and `TurnEntry` are dead code deleted by S10-01 (section 10 ledger). S01-03 retires `thread.markViewed` and its callers (section 01 ledger); this section changes neither.

## Proposed tickets

### S08-01 Finished turn layout: work fold, merged meta line, actions row

- **Blocked by:** F-01b Token vocabulary rename.
- **Boards:** 08a `21EL-2` (`21IH-2`, `21IL-2`, `21IM-2`, `21IX-2`), 08b `250Q-2`
- **Delivers:**
  - A settled turn shows "Worked for 1m 42s ›" collapsed above the prose answer, fork and copy icons at rest, then "7 steps [hairline rule]".
  - Clicking the fold expands the turn's rows inline and clicking again collapses them.
  - Stopped, interrupted and failed turns name their ending in the fold label. 08f adds the end notice.
  - A turn with no narrative rows shows no fold and no meta line.
- **Build notes:** web only. Add new virtual item types `work-fold` and `turn-meta-line` (`virtual-items.ts:396-474`). The fold uses the existing group-expansion seam, so children stay separate measured rows. Duration comes from the canonical summary (`canonical-message-projection.ts:153-163`), with the legacy record fallback moved from `PersistedTurnFooter.tsx:45-54`. The approval-review text becomes the first row inside the fold. The hooks popover stays in the actions row when the turn ran hooks. Rewrite the pipeline doc sections listed in the ledger. Coordinate with S05 (live rows) and 08f (end notice only; this ticket owns the fold label table).
- **Deletes:** TurnFooter rows, PersistedTurnFooter, AssistantMessageMetadata, hover opacity, doc paragraphs.
- **Acceptance criteria:**
  - [ ] A settled turn renders fold → prose → actions → meta line in the 08a order, with Paper values.
  - [ ] The fold label matches the table for each `TurnOutcome`. The duration is turn wall time.
  - [ ] The meta line has no clock, duration, model, tokens or cost.
  - [ ] Expanding and collapsing keeps the clicked row in place. Expanded children virtualize.
  - [ ] When a turn settles while the user is scrolled into its rows, nothing jumps (fold stays expanded). While following the tail, the viewport stays pinned.
  - [ ] Fork and copy are visible at rest and keyboard reachable.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/turn/__tests__/WorkFold.test.tsx src/features/conversation/turn/__tests__/TurnMetaLine.test.tsx src/features/conversation/narrative/__tests__/PersistedNarrative.thread.test.tsx`. Prior art: `TurnFooter.test.tsx`, `MessageList.thread-switch.test.tsx`. Live: `agent:up`, then in a `.dev/fixture-repo` thread ask the agent to read two files and answer. Watch the turn settle. The rows fold to "Worked for …", "N steps [hairline rule]" appears, and nothing jumps. Scroll up mid-turn and repeat: the fold stays open.

### S08-02 End-of-turn changes bar and turn ⋯ menu

- **Blocked by:** F-01b Token vocabulary rename; F-02 Fade truncation primitive; F-04a Menu primitive; S10-03 Truthful comparison outcomes and turn list.
- **Boards:** 08a `21J0-2`, 08c `21OI-2`, Components `15OZ-0` (all states except Revert confirmation)
- **Delivers:**
  - "Changed N files +A −D ⌄" with a folder tree. The longest common directory prefix is stripped (08a shows bare file names).
  - Row annotations: `new`, `deleted` (struck-through name), `from <old>`, `edited later` (a later snapshot in this thread attributes the path), `Binary`, `Untracked` (Q8).
  - Collapse all and expand all.
  - When more than 12 rows would show, folders start collapsed with "N folders · Review all". If only root files exist, the first 12 show with "N more files · Review all" (proposed, designer to confirm).
  - Row hover shows Open in editor (desktop only) and Copy path. A row click opens Review and jumps to the file.
  - The muted Review button pins the Turn view to this turn.
  - ⋯ menu: Review changes and Copy file paths (newline-separated, repo-relative, forward slashes).
  - A retried or resumed turn's bar covers the whole turn from its first attempt's baseline, so a file that only the failed attempt edited is listed (E2). The replaced attempt shows no bar of its own; section 08f hides it.
- **Build notes:** web.
  - Counts come from `snapshot.file_effects` (already on `snapshot.listByThread`). Only legacy rows (no effects) call `snapshot.getDiffStats`. Loading shows the skeleton (`1643-0`). A failed or null count shows "Counts unavailable" (`165M-0`).
  - A row with `attempt_count` > 1 (S10-03) is read like a legacy row: its files, kinds and counts come from `snapshot.getDiffStats({ snapshotId })`, which the server answers over the turn's range, because the row's own `file_effects` covers its attempt only. Copy file paths copies that list.
  - Use the transcript's `threadId` prop, not `activeThreadId`.
  - The latest bar is expanded and older bars collapsed. Keep the manual override map.
  - Hide collapse-all when the tree has no folder rows. 08a draws it with none (Q7).
- **Deletes:** TurnChangeSummary (+ test), the 5-file cap, View diff, the swallowed catch. (`TurnTimeline` and `TurnEntry` go earlier, in S10-01.)
- **Acceptance criteria:**
  - [ ] The 08a bar renders pixel-equal to `21J0-2` with two files at the root.
  - [ ] The Components states Expanded grouped, Collapsed, Folder collapsed, Many files, Loading, Counts unavailable, and Binary and untracked all render from fixtures.
  - [ ] Review and Review changes open the Review panel on Turn = this turn. A missing snapshot falls back to All turns (today's behavior).
  - [ ] Copy file paths copies every attributed path, not just the visible ones.
  - [ ] The bar never queries a thread other than the one its transcript renders.
  - [ ] Given a row with `attempt_count: 2` whose `file_effects` lists `b.ts` and `c.ts`, the bar renders the `snapshot.getDiffStats` result (`a.ts`, `b.ts`, `c.ts` with range counts), shows Loading until it arrives, and never shows the `file_effects` counts.
  - [ ] `rg` proofs in the ledger pass.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/turn/__tests__/TurnChangesBar.test.tsx src/features/conversation/turn/__tests__/changes-tree.test.ts`. Prior art: `components/chat/__tests__/TurnChangeSummary.test.tsx`. Live: in a fixture thread, ask for edits to 7 files in 3 folders. Check the grouped tree, the counts, Review opening the Turn view, and the ⋯ menu.

### S08-03 Turn revert server operation (preview, apply, undo)

- **Blocked by:** S10-12 Pin turn snapshots so git gc cannot prune them; S10-03 Truthful comparison outcomes and turn list.
- **Reconciled:** Absorbs S08-05. Apply and undo take a client `requestId` (operation identity, replayed only for the same request); `previewToken` is only a precondition over repo identity, snapshot, scope and each path's presence, type, mode and content. Persist a prepared operation and pin its recovery material (`refs/mcode/<storeId>/reverts/<id>`, plus raw bytes and metadata for touched paths where a tree cannot restore exactly) before the first write; recover unfinished operations on startup. Revert UI (S08-04) cannot ship before this.
- **Boards:** Components `16A3-0`, 10c `2E96-2` (copy inputs only)
- **Delivers:**
  - `turn.revert.preview`, `turn.revert.apply` and `turn.revert.undo` with the contracts in Backend §1. Apply and Undo take a client `requestId` and replay only that request. `previewToken` is a precondition over repo identity, the range's snapshots, scope and each path's presence, type, mode and raw content.
  - Every operation reads its target range through S10-03's `turnSnapshotRange`. A retried turn reverts to its first attempt's pre-state (E2). The file scope takes an optional `fromMessageId`, so Revert file from All turns reverts the file to before the earliest turn of the range (V7); `turn_reverts.from_message_id` and `TurnRevertRecord.fromMessageId` record it.
  - Durable recovery (absorbed from S08-05): before the first file write, a `prepared` row records each touched path's raw `pre` state and the exact raw `planned` state the write will leave, and both sets of bytes are pinned at `refs/mcode/<storeId>/reverts/<id>`. Every write goes through `restoreRaw`, so disk matches the record. Rollback and Undo restore byte-exact. `recoverUnfinished()` settles interrupted operations at startup by comparing raw content, type and mode, never filtered blobs. It puts back only paths that hold exactly their planned state, and it lists and leaves alone any path it cannot prove. It writes an interrupted receipt.
  - The `turn_reverts` table, the receipt system message, `turn.reverted` push, `snapshot.listByThread` with `reverted_paths`.
  - The startup sweep covers `reverts/` in this store's namespace only. Revert relies on S10-12 having moved every snapshot capture inside the repo mutation lock.
- **Build notes:** contracts, server, DB migration. No UI, so Revert cannot reach users before its recovery path exists (S08-04 and S10-10 are blocked by this ticket). Uses S10-12's store id and `snapshot-ref-pins.ts`, and S10-03's `turnSnapshotRange` for the target range. A new ADR, at the next free number when it merges, "Turn revert restores pre-turn content", records restore semantics, worktree-only writes, request identity versus precondition, raw `pre` and `planned` states recorded before the first write, recovery by raw comparison only, and the rejected three-way merge. Add one paragraph to `docs/internals/review/turn-diff-review.md` on the lock ordering with baseline capture and on startup recovery. Add a test-only fault hook to `TurnRevertService` that can stop after prepare, after the Nth path write, or inside the commit write, either with an error (exercises rollback) or with a sentinel the service does not catch (simulates process death; the test then builds a fresh service on the same database and repo and calls `recoverUnfinished()`).
- **Deletes:** None.
- **Acceptance criteria:**
  - [ ] Apply restores modified, added (deleted on revert), removed (recreated) and renamed paths to their `ref_before` content. HEAD and `git diff --cached` are unchanged.
  - [ ] `changed_later` names `later_turn` vs `outside` correctly. `already_reverted` is a no-op. A file-scope path outside the turn's attribution is rejected.
  - [ ] Retried turn: attempt 1 edits `a.ts` and `b.ts` and fails; its replacement edits `b.ts` and `c.ts`. Revert this turn, given either attempt's message id, restores all three to attempt 1's `ref_before`, and `a.ts` is not `changed_later`. Undo restores the bytes from after the replacement.
  - [ ] Range: Turns 1 and 3 edit `a.ts`. A file scope with `fromMessageId` = Turn 1 and `messageId` = Turn 3 restores `a.ts` to Turn 1's `ref_before`. A hand edit after Turn 3 makes it `changed_later`/`outside`; a Turn 4 that edits it makes it `changed_later`/`later_turn`. `reverted_paths` lists `a.ts` on the Turn 1 and Turn 3 rows only. Undo restores byte-exact.
  - [ ] A `fromMessageId` after `messageId`, and a path no turn in the range attributes, are validation errors. Replaying a `requestId` with a different `fromMessageId` is rejected.
  - [ ] Rename chain across turns: Turn 1 renames `a.ts` to `b.ts` and Turn 3 renames `b.ts` to `c.ts`, each with file effects. A file scope on `c.ts` with `fromMessageId` = Turn 1 previews `a.ts` as `recreate` and `c.ts` as `delete` (with `previousPath: "a.ts"`), and both paths are in the `previewToken` hash and the `prepared` row. Apply leaves `a.ts` with its bytes from before Turn 1 and no `b.ts` or `c.ts`. Undo restores `c.ts` and removes `a.ts`. A file scope on `a.ts` resolves the same set.
  - [ ] Rename chain inside one turn: the same two renames across the two attempts of a retried turn, and again inside one attempt, give the same result for Revert this turn and for a file scope on `c.ts`.
  - [ ] Git-fallback rename: a turn without file effects renames `a.ts` to `c.ts`, so its `files_changed` lists only `c.ts`. Revert this turn and a file scope on `c.ts` both recreate `a.ts` and delete `c.ts`.
  - [ ] Recovery over a chain: simulated process death after the first path write of the cross-turn chain revert, then `recoverUnfinished()`, puts `a.ts` and `c.ts` back byte-exact and writes one interrupted receipt.
  - [ ] Incomplete range: attempt 1 of a retried turn is past the 30-day cutoff and its row is deleted while the replacement's row remains. Revert this turn, a file scope on it, and a range whose `fromMessageId` names it all return `unavailable: snapshot_missing` and write nothing.
  - [ ] Apply, Undo, then Apply again on the same turn, each with a new `requestId`, reverts a second time in a real repo. Replaying any of the three `requestId`s returns that request's own stored outcome and writes nothing.
  - [ ] A lost response: the same `requestId` sent again returns the first outcome. The same `requestId` with different parameters is rejected.
  - [ ] A content change, a mode-only change (executable bit, POSIX only; git ignores it on Windows) or a file-to-symlink change after preview returns `stale` with a fresh preview.
  - [ ] When the fault hook stops right after prepare, the `prepared` row and its `reverts/` ref exist, the row holds a `pre` and a `planned` raw state for every touched path, and no file has changed.
  - [ ] After a successful apply, every touched path's raw state equals its recorded `planned` state. For the CRLF, smudge-filter, symlink and executable fixtures, the planned bytes equal what an in-place `git checkout` of `ref_before` writes for the same path.
  - [ ] Simulated process death after prepare, after the first path write, and before the commit write: `recoverUnfinished()` restores every touched path byte-exact, marks the row `rolled_back` and writes one `turn-revert-interrupted` receipt. A path edited after the crash is left alone and listed, and the row is `recovery_failed`.
  - [ ] Crash after the forward write of a CRLF file under `core.autocrlf=true`, then an EOL-only edit to that file (CRLF to LF) before restart: recovery leaves the new bytes, lists the path, and the row is `recovery_failed` with its recovery ref kept.
  - [ ] Crash after the forward write of a file under a repo-local clean filter, then an edit the clean filter hides (for example a filter that strips comments and an edit inside a comment): recovery leaves the new bytes, lists the path, and the row is `recovery_failed`.
  - [ ] With the `reverts/` ref deleted by hand before restart, recovery writes no file, lists every path that holds its planned state, and keeps the row `recovery_failed`.
  - [ ] A forced commit-write failure rolls back and returns `failed/rolled_back`. A forced failure in `captureRaw`, `planCheckout` or `pinRecovery` returns `failed/unchanged` and touches no file.
  - [ ] Undo restores the exact pre-revert bytes for CRLF files under `core.autocrlf=true`, a file with mixed line endings, a file under a repo-local clean/smudge filter, a symlink and an executable file. Undo after a further edit returns `stale`.
  - [ ] A file-to-folder and a folder-to-file transition revert and undo cleanly. A folder that also holds unrelated files is reported in `skipped` as `folder_in_the_way` and left alone.
  - [ ] Busy while any thread on the same `cwd` is running. A send issued mid-revert starts after it with a post-revert `ref_before`.
  - [ ] Ignored paths are reported in `skipped`.
  - [ ] Undo still works after `git gc --prune=now`, in a linked worktree and in a repo with no `user.email`. The startup sweep deletes only this store's orphaned `reverts/` refs, keeps the refs of `prepared` and `recovery_failed` rows, and leaves another store's `reverts/` refs alone.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/diffs/revert/__tests__/turn-revert-service.integration.test.ts src/features/projects/diffs/revert/__tests__/turn-revert-recovery.integration.test.ts src/features/projects/diffs/snapshots/__tests__/snapshot-service.integration.test.ts`. Prior art: `snapshot-service.integration.test.ts` (real git in a temp dir). Contract parse tests sit beside `packages/contracts` model tests.

### S08-04 Revert this turn: menu item, inline confirm, receipt with Undo

- **Blocked by:** S08-02 End-of-turn changes bar and turn ⋯ menu; S08-03 Turn revert server operation (preview, apply, undo).
- **Needs decision:** 08e (receipt row, reverted label, confirm copy) was never drawn. Build to the default copy; the user signs off the design on the PR (user, 2026-10-08).
- **Boards:** Components Turn menu `160S-0`, Revert confirmation `16A3-0`; 06d receipt `2799-2`
- **Delivers:**
  - "Revert this turn…" in the ⋯ menu, disabled with a tooltip when the cause is known on the client:
    - "Wait for the turn to finish"
    - "Not a git repository"
    - "This turn's snapshot is gone"
    - "Already reverted"
  - Choosing it collapses the file list and opens the confirm under the bar. The confirm loads the preview, and Revert stays disabled until it arrives. Copy:
    - Title: "Revert N files to before this turn?"
    - Body, one sentence picked in this order:
      1. One file edited by a later turn: "ProjectTree.tsx was edited by a later turn. Reverting removes those edits too." (drawn)
      2. Several: "ProjectTree.tsx and 2 other files were edited later. Reverting removes those edits too."
      3. Changed outside: "ProjectTree.tsx changed after this turn. Reverting removes those changes too."
      4. Clean: no body.
    - Plus a second muted line when `unattributedChangeCount > 0`: "Files changed by commands in this turn are not reverted."
  - Esc and Cancel close the confirm. Focus starts on Cancel.
  - On success:
    - The confirm closes.
    - The bar header and rows show a muted `reverted` annotation (it outranks `edited later`).
    - A receipt row "↶ Reverted Turn 3 · 7 files" appears in the timeline where the revert happened, with a trailing "Undo" text button.
  - Undo writes "Undid revert · Turn 3" and removes the Undo button. Undo is disabled with "Files changed since the revert" on `stale`, and with "Undo is no longer available" on `recovery_expired`.
  - `stale` re-renders the confirm. `failed` shows the body for its outcome (Backend §1 failure table): Retry for `unchanged` and `rolled_back`, no Retry for `recovery_failed`.
  - An interrupted receipt reads "Revert of Turn 3 was interrupted. Files were put back." or names the files that could not be put back. It has no Undo.
- **Build notes:**
  - Web: `RevertConfirm` and `useTurnRevert` (shared with S10), `TurnRevertReceipt`, `lib/turn-ordinals.ts` extraction, `turn.reverted` push handler.
  - `useTurnRevert` generates a `requestId` (`crypto.randomUUID()`) when the user clicks Revert or Undo, keeps it while the call is unanswered, and resends the same id after a reconnect. Retry is a new click with a new id.
  - Receipt ordinals render live from the snapshots, with the content fallback when the snapshot has expired.
  - Add CONTEXT.md entries "Turn revert" and "Revert receipt" (provider-neutral).
- **Deletes:** private `turnOrdinals`.
- **Acceptance criteria:**
  - [ ] Each body variant renders from a preview fixture, and each `failed` outcome renders its own copy.
  - [ ] Reverting the latest turn in a fixture thread restores the files on disk and shows the receipt and annotation without a reload. A second window receives them through the push.
  - [ ] Undo restores. The receipt and the bar state survive a reload.
  - [ ] A dropped connection during apply resends the same `requestId` and shows one receipt, not two.
  - [ ] Nothing in the menu or confirm is amber. Revert uses `--color-destructive`.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/turn-revert/__tests__/RevertConfirm.test.tsx src/features/conversation/turn-revert/__tests__/TurnRevertReceipt.test.tsx`. Live (Electron): in a fixture thread, have the agent edit 3 files, then edit one by hand. ⋯ → Revert this turn… shows the "changed after this turn" body. Click Revert; `git status` in the fixture repo shows the files at their pre-turn content, and the index is unchanged. Click Undo; the content returns.

### S08-05 Pin turn snapshots and revert safety trees (merged)

- **Blocked by:** Not a ticket. Merged into S08-03: revert safety material must be persisted and pinned before the first destructive write.

### S08-06 Tell the agent about reverts on the next turn

- **Blocked by:** S08-03 Turn revert server operation (preview, apply, undo).
- **Boards:** None (no visible UI)
- **Delivers:** the next prompt sent after a revert carries one hidden Mcode line naming the reverted paths. It is sent once, and undone reverts are skipped.
- **Build notes:** server only, at turn admission or prompt assembly (site inferred, verify). Mark `agent_notified_at` in the same write as the user message. No adapter changes.
- **Deletes:** None.
- **Acceptance criteria:**
  - [ ] The note is present exactly once after a revert and absent after Undo.
  - [ ] It is not shown in the user bubble and not persisted in message content.
- **Verify:** `bun run --cwd apps/server test -- src/features/agents/turns/__tests__/turn-revert-agent-note.test.ts` (new, at the admission seam on real SQLite, with `turn-conversation-write-operations.test.ts` in the same folder as prior art: the provider prompt carries the note exactly once after a revert and not after Undo, and neither the user bubble nor the persisted message content holds it). Live: revert, then ask "what did you change in X?" and confirm the answer reflects the revert.

### S08-07 Seen marker on threads (merged)

- **Blocked by:** Not a ticket. Merged into S01-03 (one seen marker on threads, used by the sidebar Finished state and by Since you looked).

### S08-08 Since you looked view

- **Blocked by:** S01-03 Thread attention facts on the server; S10-04 Two-row header, names-only view menu, merged Turn view.
- **Reconciled:** Reads the seen marker from S01-03: takes its visit baseline from the `thread.acknowledgeSeen` response before the badge clears. Owns the `afterSequence` parameter on the cumulative diff methods.
- **Boards:** 10b `2DV5-2` (picker anatomy). The 08e scope picker was not drawn.
- **Delivers:**
  - Review's view picker lists Turn, **Since you looked**, All turns in group 1.
  - It is available when this visit's baseline exists and a turn after it has changes. Otherwise it is dimmed with the tooltip "Nothing new since you looked".
  - Row 2 shows the covered turns as plain text, "Turns 3–5" or "Turn 5", with no picker.
  - The diff shows only the changes from turns after the baseline.
- **Build notes:**
  - Server and contracts: `snapshot.getCumulativeDiff` and `snapshot.getCumulativeDiffStats` accept `afterSequence`, and `snapshot.listByThread` returns `message_sequence` (Backend §2). Both read through S10-03's typed comparison result.
  - `afterSequence` selects whole turns by the Backend §2 rule, the only selection rule; the client never filters rows on its own. Availability uses the same rule on `snapshot.listByThread`: a row whose `message_sequence` is greater than the baseline and whose `files_changed` is non-empty or whose `attempt_count` is above 1. A count above 1 means an earlier attempt of that turn changed files, even when the latest attempt changed none.
  - Web: `DiffViewMode` gains `"since-looked"`. Comparison key `since-looked:<baseline>`. The baseline is `previous.sequence` from the first marker-advancing response of S01-03's `thread.acknowledgeSeen` in this visit, stored before the response clears the badge, held in memory per thread and cleared in `clearThread`. This ticket adds no seen marker, column or `markViewed` change. Ordinals come from `lib/turn-ordinals.ts`. The ADR-0011 default view is unchanged (Q6). Add a CONTEXT.md entry "Since you looked".
- **Deletes:** None.
- **Acceptance criteria:**
  - [ ] With turns 3–5 finishing while the thread is closed, opening it and choosing Since you looked shows the union of those turns' attributed changes.
  - [ ] The baseline is set from the acknowledgement response before the Finished badge clears. A no-op acknowledgement does not set or move it.
  - [ ] Watching turn 6 finish does not change the baseline.
  - [ ] Cumulative stats with `afterSequence` cover only the later turns' attributed paths.
  - [ ] Looked between a failed attempt and its Retry: attempt 1 edits `a.ts` and fails; the user acknowledges through its sequence, so the next visit's baseline sits between the two attempts. The replacement then edits `b.ts` and completes. On return, Since you looked is available and lists `a.ts` and `b.ts`. `getCumulativeDiffStats({ afterSequence })` counts both files from attempt 1's `ref_before`, and `getCumulativeDiff` returns patches for both.
  - [ ] The same fixture where the replacement edits nothing: Since you looked is still available and shows `a.ts`.
  - [ ] The view is unavailable after an app restart with no new turns.
- **Verify:** `bun run --cwd apps/web test -- src/lib/__tests__/review-views.test.ts src/__tests__/diffStore.test.ts` and `bun run --cwd apps/server test -- src/features/projects/diffs/transport/__tests__/snapshot-rpc.test.ts`. Live: queue two follow-ups and switch threads until both finish. Return: the sidebar shows Finished (S01). Review › Since you looked lists both turns' files.

**Cross-section dependency:** S10-10 Revert file is blocked by S08-03 and S08-04. It calls `turn.revert.preview` and `turn.revert.apply` with `scope { kind: "file", path }` from the Turn view and `scope { kind: "file", path, fromMessageId }` from All turns, a `previewToken` from that preview and a fresh `requestId` per click, through `useTurnRevert`, and renders `RevertConfirm`. Its Turn view copy is "Revert <file> to before Turn N?" and "Only this file changes. The turn's other edits stay." (`2EA2-2`); S10-10 carries the proposed All turns variant.

## Tests

- **Highest seams:**
  - `TurnRevertService` against a real temp repo (server integration).
  - `virtual-items` plus `TranscriptItemRenderer` for layout order and the fold (web unit).
  - `TurnChangesBar` with snapshot fixtures (web unit).
- **Prior art:**
  - `apps/server/src/features/projects/diffs/snapshots/__tests__/snapshot-service.integration.test.ts`: `createGitRepo` helper, real git, no mocks.
  - `apps/web/src/components/chat/__tests__/TurnChangeSummary.test.tsx`
  - `apps/web/src/features/conversation/narrative/__tests__/TurnFooter.test.tsx`
  - `apps/web/src/features/conversation/messages/__tests__/MessageList.thread-switch.test.tsx`
- **Revert fixtures:** files that are modified, added, deleted, renamed, binary, gitignored, symlinked, executable, CRLF under `core.autocrlf=true`, mixed line endings, and under a repo-local clean/smudge filter. A file-to-folder and a folder-to-file transition. A later snapshot touching one path. A by-hand edit. A read-only file to force a write failure (Windows: an open handle). A retried turn (a failed attempt that edited files, then its replacement) and a three-turn range for the All turns file scope. A rename chain `a → b → c` across two turns, across two attempts and inside one attempt, and a git-fallback rename with no file effects.
- **Request and recovery cases:** apply, undo, apply with new `requestId`s; a replayed `requestId` after a lost response; a reused `requestId` with other parameters; mode-only and type-only changes after preview; the fault hook stopping after prepare, after the first path write and inside the commit write, both as an error and as simulated process death followed by `recoverUnfinished()` on a fresh service; a path edited between the crash and recovery, including an EOL-only edit and an edit a clean filter hides; a recovery ref deleted before restart.
- **Must-not-break checks:** the index and HEAD are untouched, no writes happen outside attributed paths, the recovery row (with `pre` and `planned` raw states) and ref exist before any write, rollback and Undo are byte-exact, recovery never writes a path whose raw state equals neither recorded state, and replay never writes twice.
- **Runtime:** use `.dev/fixture-repo` only (AGENTS.md "Test data").

## Risks and open questions

**Product calls for the user:**

- **Q1. Revert semantics** when a file changed after the turn.
  - Default: restore to the before-turn content and warn by name. This is what Components `16AS-0` says ("Reverting removes those edits too").
  - Alternative: a three-way inverse that keeps later edits that don't overlap. It is more precise but needs an undrawn conflict UI.
- **Q2. What counts as "looked".**
  - Default: opening the thread. This reuses S01-03's `thread.acknowledgeSeen` and the S01 Finished moment, and its distinct value comes when 2 or more turns finish while you are away.
  - Alternative: opening Review on the thread, in the style of GitHub's "changes since your last review". This is more useful when you chain turns without reviewing. It needs only a different trigger, same storage.
- **Q3. Tell the agent about reverts** on the next send (S08-06). Default yes. Without it, the agent may assume its edits still exist.
- **Q4. Model, tokens and cost** are gone from finished turns (08a draws none; the Components placement board still shows them). Default: drop them; usage lives in the overview.
- **Q5. Pin snapshot trees and revert recovery material under `refs/mcode/<storeId>/*`.** Default yes (decision F4). They become visible to `git log --all` and `git push --mirror`. Without pinning, dirty-tree turns can lose their diff and revert after about 2 weeks (inferred), and Undo would have nothing exact to restore from.
- **Q6. Auto-open Review on Since you looked** when 2 or more unseen turns have changes. Default no; ADR-0011 is unchanged. A yes needs a new ADR.

**Designer items (Q-D, 08e not drawn).** Defaults are proposed above and need drawing or sign-off:

- receipt row and Undo placement
- `reverted` annotation on the bar
- confirm body variants: outside edit, several files, command-changed files, loading, failure, unavailable
- disabled menu tooltips
- Since you looked entry, its row-2 "Turns 3–5" label and its dimmed tooltip
- root-only many-files footer

Q7: 08a draws collapse-all with no folders; the default hides it. Q8: the meaning of the `Untracked` label in `166V-0` is inferred as "not in git snapshots"; designer to confirm.

**Facts to check during build:**

- Whether a trailing system message (the receipt) disturbs assistant-row reuse in `TurnFinalizer.materializeAssistantRow` (`turn-finalizer.ts:633`, inferred safe because the compaction divider already does this).
- Where the provider prompt is assembled for S08-06.
- Whether the tracker's `file_effects` counts always equal the Review Turn-view stat. Native Codex patches may differ (inferred). Add an equality test for tracked evidence.

**Section overlap:**

- S10-01 deletes the dead `TurnTimeline`/`TurnEntry`. S10 builds Revert file on S08-03/S08-04 and owns snapshot and baseline pinning (S10-12).
- S10-03 owns the attempt link and the turn range (section 10, Backend §3). The bar (S08-02), revert (S08-03) and Since you looked (S08-08) read it; section 08f hides the replaced attempt in the transcript.
- 08f should not re-implement the fold label table (S08-01 owns it).
- S06 owns the approval-review text and the receipt anatomy that S08-01 and S08-04 reuse.
- S01-03 owns the seen marker, `thread.acknowledgeSeen`, the `markViewed` retirement and any change to `status=completed`.

**Known limits (documented, not fixed):**

- A turn on the git fallback attributes concurrent user edits made during the turn. Revert undoes those too.
- Gitignored files can't be reverted from snapshots.
- Git detects renames by similarity. A rename that git does not detect and no file effect records reverts as a separate delete and add, which is also how Review shows it.
- Non-git workspaces have no revert in v1.
- The forward revert writes git's checkout of `ref_before`, so a filtered or mixed-line-ending file comes back as a fresh checkout would write it. Undo and rollback are byte-exact.
- A later edit that leaves a path byte-identical to its planned state, for example deleting a file the revert had already deleted, cannot be told apart from the operation's own write. Recovery puts the pre-state back.
- The repo lock is per server process. A second Mcode runtime, an editor or external git can still write the same files during a revert; the precondition and recovery checks detect it afterwards but cannot prevent it.
