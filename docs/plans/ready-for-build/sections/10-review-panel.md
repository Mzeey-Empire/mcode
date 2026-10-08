# 10 · Review panel: build brief

Review is the right-panel tab that shows one diff at a time. When this section ships, the tab has a two-row header with a names-only view menu. The menu lists six views: Turn (with a turn picker that follows the latest turn), All turns, Unstaged (now including untracked files), Staged, Commit, and Branch, where both sides are pickable. Every failure or limit shows its own state, and none of them pretends to be "No changes". A Files navigator docks at 800px and wider and opens as a popover below that, and it follows the file in view. Pierre headers show the file name first. Turn views get a per-file Revert icon. A floating Commit button opens a real Commit sheet: pick files, edit a message from the utility model, then commit, optionally pushing. Line comments persist as drafts. Surfaces: `apps/web` Review components and stores, `packages/contracts` git, turn-diff and annotation schemas, and the `apps/server` git, snapshot and turn-diff services. No provider adapter changes.

Paper page: https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0

## Boards

| Board | Node | Shows |
|---|---|---|
| 08c · Review open | `21OI-2` | Review in context at the default 536px panel. The header still reads "This turn", which 10a supersedes with "Turn". |
| 08c-2 · Header by view | `2D33-2` | Row 1 and row 2 for This turn, Branch and Commit. Its Branch row shows the compare side as plain text, which 10e supersedes. |
| 08c-3 · Files docked ≥800 | `24OA-2` | Expanded panel. The Files pane docks at 320 (280–480) with a "Filter files" field, a compacted folder row, and file rows with `-N +N`. The active file uses the selected fill. Commit moves to `right: 337` so it stays over the diff. |
| 08c-4 · Files popup at normal width | `2D70-2` | A 300px popover anchored under Files (`right 16, top 96`, radius 18, padding 8) with a "Search files" row and the same tree. |
| 08c-5 · Files docked at normal width | `2DEZ-2` | The alternative to 08c-4: the tree docks at about 220 inside the 536 panel, leaving the diff about 316. **Not decided** (see Q1). |
| 10a · Turn view · Revert file | `2241-2` | Row 1 is "Turn ⌄ · 2 files +10 -10" with expand and toggle. Row 2 is "Turn 3 latest ⌄" plus refresh, a unified/split pill, wrap (on), whitespace, and Files. The filename-first header has copy, open and revert icons. Commit floats bottom-right. |
| 10b · View picker open | `2DV5-2` | A 200px names-only menu in three groups: Turn ✓, All turns / Unstaged, Staged (dimmed) / Commit (dimmed), Branch. |
| 10c · States | `2E31-2` | Loading, Empty ("No file changes in Turn 2"), Couldn't load (Details, Retry), Too many files ("Choose another view"), Turn no longer available, and the Revert file confirm. |
| 10d · Commit sheet | `2EAB-2` | A sheet above Commit with 3 files (flat), the generated message, "Written by Haiku 5.5", regenerate, and "Commit 2 files ⌄". A second example with 23 files groups them by folder, uses tri-state checkboxes, adds "Filter files", and scrolls a list of about 7 rows with a bottom fade. |
| 10e · Commit and Branch pickers | `2EM3-2` | Commit picker (380w): search, rows of sha, subject (fade) and time, and the footer "4 matches in 412 commits". Branch: `mcode-3f2a ⌄ → origin/main ⌄`, a 320w picker with a Local / Origin segmented control and "Showing 100 of 214". |

Exact values to copy (get_jsx, read 2026-10-08):

- **Header rows.** Row 1 is 48 tall with padding-left 16. Its picker button is 32 tall with 10px padding and a 14/500 ink label plus a 12px muted chevron. The stat is "2 files" at 13 muted, then mono 12 `+N` in `--color-success` and `-N` in `--color-error`. Row 2 is 40 tall with a bottom `--color-border` border and gap 8. Its controls are round 32 buttons on `--color-selected`. The on state (wrap, Files) and the active unified/split segment use `--color-control-border`. The pill is 32 tall with 2px padding and 28px segments.
- **File header.** 36 tall, padding 8/6, gap 6, bottom border. It has a 20px chevron cell, a 16px change icon, the name at 13/500 ink (no shrink), the folder at 13 muted in a clip frame with the 24px fade mask, deletions then additions in mono 12, and 24px icon buttons (radius 6, 14px muted icons).
- **Floating Commit.** 40px circle on `--color-selected` with shadow `0 8px 24px #00000066` at `bottom 16, right 16`. When the Files pane is docked it sits at `right = pane width + 1 + 16`.
- **Commit sheet.** `--color-panel` with a border, radius 18, padding 14, gap 12, and shadow `0 16px 40px #00000080`. It is anchored at `bottom 68, left 12, right 12`. The file block uses `--color-background`, radius 10, padding 4, and 32px rows. Checkboxes are 16px with radius 4: checked and indeterminate are filled with ink, unchecked uses a 1.5px `--color-control-border` border. The list caps at 228px with a 28px bottom fade. The message box uses `--color-background`, a border, radius 10, and padding 12/12/8. Its subject is 14 ink and its body 13 muted. Its footer is 28 tall and holds "Written by …" at 12 muted plus a round 28px regenerate button. The split button is `--color-primary` and 32 tall: label 13/600 `--color-primary-ink` with 14px padding, a 1px divider at 25% opacity, and a 30px chevron segment.
- **State bodies.** A 20px icon, then a 14/500 ink title, a 13 muted detail, and 28px pill buttons. Retry and "Choose another view" use `--color-selected`. Details is plain muted text. The icon is `--color-error` for Couldn't load, `--color-primary` for Too many files, and muted for Turn gone. The revert confirm is an inset with padding 12, `--color-panel`, a border at `color-mix(var(--color-error) 35%, transparent)`, padding 12/14, and Cancel plus a `--color-destructive` "Revert" button.

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md` ("Review (10)", "Diffs"). Dated 2026-10-07 unless noted.

- **Header.** Row 1 holds the view picker, the diff stat, and the round expand and panel-toggle buttons in the caption overlay (F-05). Row 2 is fixed and always present: the view's operand on the left and round view controls on the right (refresh, unified/split pill, wrap, whitespace, Files). They never overlay the diff. Commit floats alone bottom-right. Wrap starts on.
- **Views.** Last turn merges into Turn, which opens on the latest turn and reads "Turn 3 latest". The menu lists names only, in three groups split by dividers (Turn, All turns / Unstaged, Staged / Commit, Branch), with no labels, counts or operands. Unavailable views stay listed and dimmed, with the reason in a tooltip ("Nothing staged", "No commits ahead of origin/main"). A thread never defaults to an unavailable Branch view.
- **Unstaged** includes untracked files, and the dirty probe must see them too.
- **Revert file.** Turn views get an icon in the file header. It opens the 08 revert confirmation in place, scoped to one file. No staging, no discard in other views, no viewed state.
- **Commit is a real commit** and replaces the agent prefill.
  - The floating Commit opens a sheet listing every uncommitted file in the worktree, tracked and untracked. All are checked except new (untracked) files. The sheet has an "N of M files" select-all and per-file +/-.
  - The message is prefilled by `settings.model.utility` through `UtilityCompletionService`, the same path as PR drafts. It stays editable. The footer reads "Written by <utility model>" (a label, not a picker), with a round 28px regenerate button (tooltip "Regenerate message").
  - The amber split button reads "Commit N files", with "Commit and push" in its menu.
  - Past about 12 rows, files group by folder with compacted paths. Each folder row has a three-state checkbox, a chevron, a file count and folder +/-. Folders start collapsed, except the folder of the file in view. Deleted files are struck through with "deleted". Untracked files sit at the end, unchecked. "Filter files" joins the select-all row past 10 files. With many files the sheet keeps its height and only the list scrolls.
  - The backend needs RPCs for message generation (from the selected paths' diff), for `git add -- <paths>` plus commit, and for an optional push that reuses `git.push`. The sheet must surface hook failures and "nothing to commit". Remove the composer prefill (`useThreadGitActions.ts`).
- **Pickers** use the 03b anatomy: a search row, a flat list, silent paging with "Showing x of y", a check on the selected row, and no section labels.
  - Commit rows show the short sha (mono), the subject (fade), and a relative time. Search matches sha and subject across all history, not only the loaded page. The footer reads "N matches in M commits".
  - Branch has a picker on both sides, `compare → base`, each opening a Local | Origin segmented list. Local holds local and worktree branches. Origin holds remote refs without the `origin/` prefix. The base side opens on Origin and the compare side on Local, and each side remembers its last tab. Search runs in the open tab. When the open tab has no matches but the other tab does, the empty list says so and one click switches.
- **States (10c).** Loading keeps the header and controls. Empty names the view or turn and keeps Refresh. Comparison errors get their own state with Details and Retry. The 10,000-file cap shows "Too many files to show · N changed files" with Choose another view. A pruned or 30-day-old turn says its changes are gone.
- **File rail.** The active file follows the file in view (scroll-spy), including jumps from the changes bar, the popover and comments. Rail order matches diff order.
- **Comments** persist as drafts across reloads until sent. Fix the 4,000 vs 100,000 length mismatch and keep mentions.
- **Diffs.**
  - Pierre (`@pierre/diffs` 1.4.1) anatomy everywhere. The header title is filename-first with the folder muted and faded (no ellipsis), done through the filename-suffix slot or a custom header. Separator bands run full width.
  - Below 800, Files opens a 300px popover under the Files button with the same filter and tree, and picking a file jumps and closes it. `FileJumpPopover` merges into it. At 800 and wider the pane docks (320 default, 280–480, diff keeps 520).
- **Ligatures off** in diffs (this brief). The Review rail icon stays Lucide Diff, as it is today (`apps/web/src/lib/panel-tabs.ts:86-88`).
- **Still open in 08** (not decided; see Risks): files popup (08c-4) vs docked (08c-5) at normal width, Commit overlapping the diff while scrolling, and the docked tree search style.

## How it works today

Paths are under `apps/web/src` unless they start with `apps/`, `packages/` or `docs/`. I spot-checked the claims from the 2026-10-07 interview (`source/10-review-interview.md`). They hold, with the additions below.

**Views and defaults**
- The catalog has seven views in toolbar order: Unstaged, Staged, Commit, Branch, Last turn, Turn, All turns (`lib/review-views.ts:55-63`). Git views are hidden, not dimmed, in a non-git repo (`lib/review-views.ts:87-95`).
- The default is `last-turn`, then `unstaged`, then `branch` (`lib/review-views.ts:119-127`). The thread sync only refuses an empty Commit, so a clean thread lands on an unavailable Branch (`components/diff/DiffToolbar.tsx:223-240`). Verified.
- Commit and Branch are disabled with no reason (`DiffToolbar.tsx:490-497`). The menu shows a file-count pill (`DiffToolbar.tsx:430-440`).
- Three separate client probes feed the menu: `useCommitAvailability`, `useBranchAvailability` and `useWorkingTreeDirty` (`DiffToolbar.tsx:616-774`). The dirty probe calls `getWorkingTreeFiles(staged=false)` (`DiffToolbar.tsx:757-761`), which runs `git diff --name-only` (`apps/server/src/features/projects/git/git-comparison-service.ts:114-124`). It misses untracked and staged-only changes. Verified.

**Comparisons (server)**
- `readReviewComparison` maps Unstaged to plain `git diff` with no args (`git-comparison-service.ts:311-316`), so untracked files never appear. Verified.
- Name-status and numstat run together, but only the binary flag survives per file. `ReviewFileChange` has no per-file counts (`packages/contracts/src/models/review-comparison.ts:10-17`).
- Parsing throws `"Review comparison is limited to 10000 files"` at file 10,001 (`git-comparison-service.ts:647-658`, `722-726`). The only consumer that recognises it does so by string prefix (`git-comparison-service.ts:580-582`).
- `git.reviewComparison` resolves the thread checkout with a lenient resolver. When the thread or workspace row is missing it returns `undefined`, and the call silently reads the workspace root (`apps/server/src/features/projects/git/transport/git-rpc.ts:193-201`, `252-262`). The strict resolver beside it is unused there (`git-rpc.ts:264-283`).
- Other git reads swallow failures into empty results: `listCommits` (`git-comparison-service.ts:56-61`), `readWorkingTreeDiff` (`:138-143`) and `listBranchesAt` (`git-repository-service.ts:313-325`).

**Comparisons (client)**
- `DiffPanel` keys one settled comparison by `scope:view:operand` (`components/diff/DiffPanel.tsx:517-537`). On a failure it records `comparisonErrorIdentity` (`DiffPanel.tsx:432-436`) but renders nothing distinct. `GitDiffView` shows the "⊘ No changes" empty state when `resolved` is null (`components/diff/GitDiffView.tsx:48-51`). Errors render as empty. Verified.
- Refresh, the options menu, Files, Jump and the unified/split toggle are portaled from `FileList` into the toolbar (`components/diff/FileList.tsx:332`). Any view that does not mount a `FileList` (empty or error) loses Refresh. Refresh is also blocked in the Commit view (`DiffPanel.tsx:596-602`).
- Branch: the client re-labels the server pair as `current → selected` (`components/diff/BranchRefPicker.tsx:84-105`) and swaps it back on the wire (`DiffPanel.tsx:510-515`). For a feature branch this sends `origin/main...feat` (correct). For the default branch the server proposes `main...origin/main` (ADR-0007 rule 1), but the swap sends `origin/main...main`, which shows unpushed commits. The ADR text and the shipped behaviour disagree (see Q11). Only the right side is pickable (`BranchRefPicker.tsx:308-314`).
- The Commit picker loads 100 commits per page (`components/diff/CommitPicker.tsx:18`) over "the branch's own commits since its base" (`CommitPicker.tsx:56-62`, `106-122`). That is `git log <base>..<branch>` (`git-comparison-service.ts:549-553`). Search filters only the loaded pages.

**Turns**
- `turnDiff.getComparison` returns `null` when the turn has no snapshot row (`apps/server/src/features/projects/diffs/transport/turn-diff-rpc.ts:48-51`). The client turns that into an empty comparison, "No changes yet" (`DiffPanel.tsx:158-166`).
- A Git-fallback turn whose tree objects were pruned keeps its file list but gets empty stats, because `getDiffStats` catches the error (`apps/server/src/features/projects/diffs/snapshots/snapshot-service.ts:371-379`). Every file then shows "No diff content".
- Live evidence is discarded on each revision bump (`DiffPanel.tsx:405`), so Last turn flashes to loading. Verified.
- TurnPicker ordinals count only turns with changes (`components/diff/TurnPicker.tsx:34-41`), and it mirrors the server's file-count rule on the client (`TurnPicker.tsx:18-24`).
- Badges render in `LastTurnView.tsx:78`: "Agent changes", "Tracked file evidence", "Git fallback: same-file edits may appear". All turns shows a "New changes available" banner instead of refreshing (`CumulativeView.tsx:38`).

**Snapshots**
- Dirty-tree snapshots are `write-tree` output from a temporary index. Nothing references them (`snapshot-service.ts:386-418`). Clean-tree snapshots are `HEAD^{tree}` (`snapshot-service.ts:224-233`).
- `validateRef` exists but has no callers (`snapshot-service.ts:345-357`). Rows older than `SNAPSHOT_MAX_AGE_DAYS` (default 30) are deleted at startup (`apps/server/src/application/bootstrap/server-bootstrap.ts:609-616`).
- **The gc risk is confirmed in code.** Unreachable objects older than `gc.pruneExpire` (git default 2 weeks) are deleted by any `git gc` or auto-gc. A Git-fallback turn between 14 and 30 days old can lose its diff, and the baseline that S08's revert needs. Git's default prune window is general knowledge; I did not test it here.

**Files rail**
- The pane renders only when visible and when the panel is at least 800 wide; otherwise `ReviewFilesPane` returns null (`DiffPanel.tsx:17-21`, `1094`). `FileJumpPopover` is a separate flat list (`FileList.tsx:461`).
- The active file is set only by a rail click (`DiffPanel.tsx:814-817`).
- The diff order is a flat `localeCompare` (`FileList.tsx:105-108`). The tree puts folders first with a numeric sort (`features/pull-requests/lib/pull-request-file-tree.ts:50-58`). The two orders differ. Verified.
- Files visibility persists per scope in localStorage (`stores/diffStore.ts:70-92`).

**Diff surface**
- `ReviewDiffView` uses Pierre `CodeView` with `lineDiffType: "word-alt"`, wrap or scroll overflow, `layout.gap 16` and `--diffs-font-family: var(--font-mono)`, which leaves JetBrains Mono ligatures on (`components/diff/ReviewDiffView.tsx:483-500`, `734-748`).
- The header uses `renderHeaderPrefix` and `renderHeaderMetadata` (`ReviewDiffView.tsx:582-611`). `FileActionBar` shows only on expanded files.
- Pierre 1.4.1 also exposes `renderCustomHeader`, `renderHeaderFilenameSuffix` and `onScroll(scrollTop, viewer)` (`@pierre/diffs/dist/react/CodeView.d.ts:26`, `51-54`). The underlying viewer adds `getTopForItem(id)` and `scrollTo` (`dist/components/CodeView.d.ts:265`, `309`). I read these from the main checkout's installed package, because this worktree has no `node_modules`.

**Actions**
- `ReviewActions` renders only for named worktree threads: "Commit or push" and "Create PR" (`components/diff/ReviewActions.tsx:48-53`). "Commit or push" sets the composer prefill `COMMIT_PREFILL` (`hooks/useThreadGitActions.ts:11-12`, `101-104`).
- The thread overview has its own "Commit or push" rows wired to the same handler (`components/chat/ThreadOverview.tsx:1770-1790`, `2318-2320`, `2867`). `pendingPrefill` itself has other users (`features/conversation/messages/chat-view/ChatViewSurface.tsx:214`, `556`), so only the commit prefill goes.
- `git.push` exists, with Review-task targets and CI bumps, but has no UI caller (`git-rpc.ts:285-353`; `transport/ws-transport.ts:1502` is its only caller in `apps/web`). Verified.
- `UtilityCompletionService.complete` returns `{ text, model }`. It falls back to Claude when the utility provider can't complete (`apps/server/src/shared/completion/utility-completion-service.ts:33-62`). The PR draft path hides AI failure behind a commit-only fallback (`apps/server/src/features/pull-requests/drafts/pr-draft-service.ts:91-101`). Do not copy that pattern.
- `RepositoryGitMutationLock.run` serialises mutations per repo path (`apps/server/src/features/projects/git/repository-git-mutation-lock.ts:15-37`). The executor rejects with `killed: true` on timeout and carries `stderr` (`git/execution/real-git-executor.ts:230-245`).
- Branchless worktree threads have no branch (ADR-0015), so push needs a branch first.

**Comments**
- Saved line comments live in memory in `previewAnnotationStore.diffByThread`. Unsaved text lives in a module-level map (`components/diff/DiffCommentEditor.tsx:29`). Save passes only `note`, so mentions typed in the editor are dropped (`DiffCommentEditor.tsx:102-108`). Verified.
- The editor accepts up to `MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS` = 100,000 (`features/conversation/messages/selection/comment-editor-model.ts:22-24`; `packages/contracts/src/models/selected-text-comment.ts:7`). The payload caps the note at `PREVIEW_ANNOTATION_STRING_MAX.note` = 4,000 and has no mentions field (`packages/contracts/src/models/browser-preview.ts:31-37`, `433-444`). Verified.
- Selected-text comments already persist with mentions inside the persisted composer draft (`stores/composerDraftStore.ts:42-48`, `147-200`).

**Dead code** (verified by `rg`)
- `TurnEntry` and `TurnTimeline` are referenced only by each other and the barrel. `CommitsView` and `CommitEntry` are referenced only by the barrel and a comment (`components/diff/index.ts:4-7`).
- `commitsByThread` is written only for `CommitsView` (`transport/ws-events.ts:472-496`).
- `selectedFile`, `diffContent` and `diffLoading` are referenced only in `diffStore`.
- `setSubagentReviewScope` has no caller, so the subagent Review filter in `DiffPanel` is dead.
- `ScopeProgress` is the rail's legacy tasks payload (`components/panels/ActivityRail.tsx:45-49`). It is not Review's, so it goes to F-05 / S12.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Row 1: view picker, stat, expand, toggle | One wrapping toolbar row with a count pill (`DiffToolbar.tsx:293-322`) | Fill F-05's row 1 slot: picker plus "N files +A -D". Expand and toggle belong to F-05. | web |
| View menu | Seven entries, two disabled with no reason, git views hidden off-git | Six names in three divider groups (F-04). Dimmed with a reason from `git.reviewState` and the turn list. | contracts, server, web |
| Turn view "Turn 3 latest" | Separate Last turn and Turn. Ordinals count changed turns only. | One `turn` view with a follow-latest operand. Stable ordinals come from the server (`turnDiff.listTurns`). | contracts, server, web |
| Default view | Can land on an unavailable Branch | Turn (latest) if any turn changed files, else Unstaged if dirty, else Branch if available, else Unstaged | web |
| Unstaged includes untracked | `git diff` only | Temporary intent-to-add index, copied from the real index or created empty only when no index exists. Files carry `untracked: true`. | server, contracts |
| Dirty probe | `git diff --name-only` | `git.reviewState` reads `git status --porcelain=v2` | server, contracts, web |
| Row 2 operand | Commit and Turn sit inline; Branch wraps to its own line (`DiffToolbar.tsx:589-613`) | Row 2 left: turn picker, commit picker, or the compare and base pickers | web |
| Row 2 controls | Portaled from `FileList`, plus an options menu (Refresh, wrap, expand all) | A fixed row of refresh, unified/split pill, wrap, whitespace and Files. The options menu and expand all go away. | web |
| Refresh everywhere | Lost when empty or errored. Blocked in Commit. | Always in row 2, in every view and state | web |
| Commit picker | 100 per page, filters loaded commits | `git.searchCommits`: server search and paging, "N matches in M commits" | contracts, server, web |
| Branch pickers | Current-branch chip plus one combobox, with a swap | `compare → base`, both pickable, Local / Origin tabs over S03-04's qualified-ref listing with the Review purpose. Local and origin twins stay separate refs. The contract is renamed so the swap goes away. | contracts, server, web |
| States (10c) | Errors render as empty; the cap throws | A typed `ReviewComparisonResult` drives `ReviewStateBody` | contracts, server, web |
| Turn no longer available | Shown as "No changes yet" | `unavailable: snapshot-expired \| snapshot-pruned` | server, contracts, web |
| Snapshots survive gc | Dangling trees | Baselines pinned at capture, snapshots pinned at finalization, all under `refs/mcode/<storeId>/`, and a startup sweep limited to that store's namespace | server |
| Per-file counts | None | `additions` and `deletions` on `ReviewFileChange` | contracts, server, web |
| Files ≥800 docked, <800 popover | Docked only; the jump popover is separate | One `FilesNavigator` in two hosts | web |
| Scroll-spy, rail order | Click only; two different orders | `CodeView.onScroll` plus one shared order for tree, diff and sheet | web |
| Filename-first header | Pierre default (full path, rtl ellipsis) | `renderCustomHeader` with Mcode actions | web |
| Ligatures off | On | `unsafeCSS` font features off | web |
| Revert file | None | Header icon (Turn view) that opens the S08 confirm inset | web (server owned by S08) |
| Floating Commit and sheet | Prefill "Commit and push the current changes." | `git.generateCommitMessage` and `git.commit` (+push) as a durable commit request that reconciles after a lost response or restart. Sheet UI. Prefill removed. | contracts, server, web |
| Comments persist, limit, mentions | In memory, mentions dropped, 4,000 vs 100,000 | The persisted `ComposerDraft` becomes the one next-message draft store (Review, Files and Browser comments, plan-comment selection, staged snapshots). One limit. `mentions` on the payload. | contracts, web, server |
| Evidence badges, stale banner | Badges plus the "New changes available" banner | Not drawn. Proposal: drop both, keep a Git-fallback info icon (Q6), refresh All turns in place. | web |

## Backend architecture

One seam per concern. Every new wire method is added to `packages/contracts/src/ws/methods.ts` with `lazySchema`, routed in `git-rpc.ts` or `turn-diff-rpc.ts`, and exposed on `transport/types.ts` and `ws-transport.ts`. All thread-scoped git calls switch to the strict `resolveWorkspaceRepoPath` (`git-rpc.ts:264-283`). A missing worktree folder becomes a typed failure instead of a silent read of the workspace root.

### 1. Comparison v2 (S10-02, S10-03)

```ts
// packages/contracts/src/models/review-comparison.ts
ReviewFileChange = {
  path: string; previousPath: string | null;
  changeType: "added" | "modified" | "deleted" | "renamed" | "copied";
  binary: boolean;
  additions: number | null;   // numstat; null for binary or evidence without counts
  deletions: number | null;
  untracked: boolean;         // true only in "unstaged" and "uncommitted"
};

/** Every comparison read returns one of these. Expected states are values, not thrown errors. */
ReviewComparisonResult =
  | { status: "ready"; comparison: ReviewComparison }
  | { status: "too-many-files"; fileCount: number; limit: 10_000 }
  | { status: "unavailable"; reason: "unborn" | "no-base" | "snapshot-expired" | "snapshot-pruned" }
  | { status: "failed"; failure: { kind: "timeout" | "worktree-missing" | "unsafe-ref" | "git-error";
                                   summary: string;   // "git diff timed out after 10s"
                                   detail: string } }; // raw stderr for Details

// git.reviewComparison params
view: "unstaged" | "staged" | "commit" | "branch" | "uncommitted";
// branch: { base, compare }; commit: { sha }. "uncommitted" is HEAD (or the empty tree) → worktree incl. untracked;
// the Commit sheet uses it and it never appears in the view menu.
```

- **Untracked files.** Add one helper, `withIntentToAddIndex(cwd, run)`, in `git-comparison-service.ts`, following the temporary-index pattern at `snapshot-service.ts:386-418`. It works in five steps:
  1. Resolve the real index path with `git rev-parse --git-path index` (per worktree) and pick a temp path beside it, `mcode-review-index-<uuid>`, so split-index shared files still resolve (inferred).
  2. Build the temp index. Copy the real index to the temp path; the copy keeps staged entries, intent-to-add entries and unmerged stages. **Only** when the copy fails because the real index does not exist (`ENOENT` on the source: a fresh `git init` that has never staged anything) run `git read-tree --empty` with `GIT_INDEX_FILE` set to the temp path. Any other failure (permission, lock, disk) returns `failed/git-error` with the error as `detail`. It never falls back to an empty index, which would show every tracked file as added.
  3. List untracked files with `git ls-files --others --exclude-standard -z`, and run `git add -N` on them against the temp index, using literal pathspecs batched like `snapshot-service.ts:20-60`.
  4. Run the existing name-status and numstat diff with `GIT_INDEX_FILE` set to the temp index.
  5. Unlink the temp index in a `finally`, so a failed or timed-out diff leaves nothing behind.

  The real index is never written: it stays byte-identical. Rename detection now pairs a deleted tracked file with its untracked new copy. If the untracked count alone exceeds 10,000, return `too-many-files` without building the index.
- **Per-file patches for untracked files.** In `readWorkingTreeDiff`, use the same helper scoped to the path, or `git diff --no-index -- /dev/null <path>`. Test `/dev/null` handling on Windows. The `untracked` flag tells `lib/load-file-diff.ts` which path to take.
- **Counts.** `runReviewComparison` already runs `--numstat -z`. Keep the per-path numbers instead of folding them into totals. Cumulative gets its counts from `snapshot.getCumulativeDiffStats`. Native turn patches get theirs from `parseTurnDiff`, or `null` if the parser has none (not checked).
- **Cap.** Catch the parse limit inside the service, using a typed error class instead of matching the message string. Run `git diff --shortstat <range>` for the true file count and return `too-many-files`.
- **Failures.** Map an executor rejection with `killed: true` to `timeout`. Map a missing `cwd` (an `fs.existsSync` check before running) to `worktree-missing`. Map `assertSafeRef` throws to `unsafe-ref`. Map anything else to `git-error`, with `stderr` as `detail`.
- **Turns.** `turnDiff.getComparison` returns `ReviewComparisonResult`. A message with no snapshot row returns `unavailable: snapshot-expired`. A snapshot whose `ref_before` or `ref_after` fails `validateRef` (`snapshot-service.ts:345-357`) returns `unavailable: snapshot-pruned`. That gives `validateRef` its first caller. Cumulative wraps its reads the same way.
- **Retire** `git.reviewDiffStats`, because totals come with the comparison. Also retire `git.branchFiles` and `git.workingTreeFiles` once the thread overview migrates (see S10-02).

### 2. Review state probe (S10-02)

```ts
"git.reviewState": { params: { workspaceId: string; threadId?: string },
  result:
    | { isGitRepo: false }
    | { isGitRepo: true;
        head: string | null;                       // null = unborn
        branch: string | null;                     // null = detached or branchless
        uncommitted: { staged: number; unstaged: number; untracked: number };
        commitsAhead: { count: number; base: string } | null;
        branchDefault: { compare: string; base: string } | { unavailable: "unborn" | "no-base" } } }
```

This is one cheap call:
- `git status --porcelain=v2 --branch -z --untracked-files=normal` gives the head, the branch and the counts. Untracked directories count once, which is enough for the dirty signal.
- `git rev-list --count <base>..HEAD` gives `commitsAhead`, with the base from the existing `resolveCommitListBase` (`git-comparison-service.ts:296-304`).
- The ADR-0007 ladder gives `branchDefault`.

It replaces the three client probes and the thread overview's probes (`ThreadOverview.tsx:907-950`, `1312-1313`). It is refetched on `diffRevision` bumps and when the view menu opens, as the probes are today. It is also the dirty signal for ADR-0011, the source of Commit-button visibility (`staged + unstaged + untracked > 0`), and the source of the Commit sheet's `expectedHead`.

### 3. Turn list (S10-03)

```ts
"turnDiff.listTurns": { params: { threadId },
  result: Array<{ messageId: string; ordinal: number;          // 1-based among the thread's user turns, stable after expiry
                  createdAt: string; phase: "live" | "settled";
                  fileCount: number; additions: number | null; deletions: number | null;
                  evidence: "native" | "tracked" | "git" | null;
                  availability: "available" | "snapshot-expired" }> }
```

- The server owns the rendered-file rule. TurnPicker stops mirroring it (`TurnPicker.tsx:18-24`).
- Ordinals come from message order, not snapshot rows, so a turn whose snapshot expired keeps its number. The message-ordering query is not designed yet; the turn repository is the likely home, but I have not confirmed it.
- Pruned detection stays lazy, done in `getComparison`, to avoid one `cat-file` per row.

### 4. Branch refs and commit search (S10-05)

```ts
// BranchComparison (contracts/src/git.ts:57-71) becomes:
{ compare: string | null; base: string | null; isUnborn: boolean; isComparisonAvailable: boolean }
// compare and base are fully qualified ref names ("refs/heads/main", "refs/remotes/origin/main").
// `refs` leaves BranchComparison: each picker pages through S03-04's qualified-ref listing.
// The client's swap (BranchRefPicker.tsx:89-105, DiffPanel.tsx:510-515) is deleted.
// The wire range is always `${base}...${compare}` (three-dot, ADR-0007).

"git.searchCommits": { params: { workspaceId; threadId?; query?: string /*≤200*/; offset: number; limit: number /*≤100*/ },
  result: { commits: Array<{ sha: string; shortSha: string; subject: string; date: string }>;
            matchCount: number; totalCount: number } }   // "4 matches in 412 commits"
```

- **Ref listing (S03-04's, reused).** There is no Review-specific ref RPC. Each Branch picker calls the qualified-ref listing that S03-04 owns, with its Review purpose. S03-04 owns the method name, parameter names, cursor paging, result shape and errors; S10-05 adds nothing to that contract. Review relies on these properties of it:
  - Every row carries its full ref name, which is also the selection value. Local `main` and `origin/main` are two separate rows and two separate selections even when their short names match. The Review purpose never drops a remote twin; the new-thread purpose may group twins for display.
  - A side filter. Local returns `refs/heads/*` with linked-worktree branches marked. Origin returns `refs/remotes/*` without `*/HEAD`; the display label strips `origin/` and other remotes keep their prefix.
  - Sorting: the default branch first, then the branch checked out in the thread's worktree (S03-04's current-worktree context, not the project folder), then by committer date.
  - A server-side case-insensitive query, a stable `total` for "Showing x of y", and typed errors, never `[]`.

  The empty-tab hint "No local matches · 3 in Origin" reads the other side's `total` from one more call with the same query and the smallest page size. Qualified names pass `assertSafeRef` unchanged (`git-comparison-service.ts:770-772` allows `/`).
- **`searchCommits`.** Run `git log <range> --format=%H%x00%h%x00%s%x00%aI` with no stats, filter subjects and sha prefixes case-insensitively in the server, and page the result. `totalCount` is `git rev-list --count <range>`. The range equals the Commit view's domain (see Q3); one parameter changes it. Use a 10s timeout and return a typed failure on timeout.
- **New ADR.** Record the Branch `compare → base` model, both sides pickable, and the default-branch direction in a new ADR at the next free number when it merges (`docs/README.md:65-66`; other sections also add ADRs, so do not reserve a number now). It amends ADR-0007's rule 1 example (Q11) and ADR-0011's defaults (Last turn merged, no unavailable Branch default). Do not edit the old ADRs.

### 5. Commit message and commit (S10-08)

```ts
"git.generateCommitMessage": {
  params: { workspaceId: string; threadId?: string; paths: string[] /*1..10_000*/ },
  result:
    | { status: "ok"; subject: string; body: string; model: { provider: ProviderId; id: string; name: string } }
    | { status: "failed"; reason: "provider-unavailable" | "timeout" | "unparseable" | "empty-diff"; message: string } }

"git.commit": {
  params: { workspaceId: string; threadId?: string;
            requestId: string;               // uuid, one per click: the operation identity, replayed only for the same inputs
            expectedHead: string | null;     // reviewState.head when the sheet built its list; null = unborn. A precondition, not idempotency
            files: Array<{ path: string; previousPath: string | null }>; // 1..10_000; renames carry both
            message: string;                 // trimmed, 1..65_536
            push: boolean },
  result:
    | { status: "committed"; sha: string; shortSha: string; branch: string | null;
        push: { status: "skipped" }
            | { status: "pending" }                   // push not finished yet; replay the same requestId to get its outcome
            | { status: "pushed"; destination: string } // e.g. "origin refs/heads/mcode-3f2a"
            | { status: "failed"; summary: string; detail: string } }
    | { status: "rejected"; reason:
        | { kind: "nothing-to-commit" }
        | { kind: "head-moved"; head: string | null } // the sheet's expectedHead is stale; nothing committed
        | { kind: "no-branch" }                       // push requested on a branchless or detached checkout; nothing committed
        | { kind: "identity-missing"; detail: string }
        | { kind: "conflicts"; detail: string }       // unmerged paths
        | { kind: "index-locked"; detail: string }
        | { kind: "failed"; summary: string; detail: string } } // hooks, signing, anything else: full output in detail
    | { status: "unknown"; head: string | null; detail: string } } // ownership unproved: Mcode cannot prove this request made a commit; never pushed
```

**Message generation** lives in the same service. It builds the diff of the selected paths from HEAD to the worktree, including untracked files, through the helper in section 1. The diff is truncated with `truncateUnifiedDiff` and preceded by `--stat` for every path. The prompt also carries the last 10 commit subjects as a style sample, and asks for JSON `{subject, body}` with the subject at 72 characters or fewer, parsed like `pr-draft-parser.ts`. It calls `UtilityCompletionService.complete(prompt, cwd)`. `model.name` comes from the provider model catalog (`ProviderModelInfo.name`, `packages/contracts/src/providers/models.ts:8-13`; the server-side lookup is not checked) and falls back to the id. There is **no fallback text** on failure. The client ignores late results by request sequence.

**Durable commit request.** A HEAD check is a precondition, not idempotency: a commit that succeeds and then loses its response (or its server) would otherwise come back as `head-moved`, losing the SHA and the push outcome. Each `requestId` is therefore a row:

```sql
CREATE TABLE git_commit_requests (
  request_id TEXT PRIMARY KEY NOT NULL,  -- client uuid, one per click
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  repo_path TEXT NOT NULL,               -- checkout resolved by the strict resolver at request time
  inputs_hash TEXT NOT NULL,             -- sha256 of files, message, push and expectedHead; a replay must match
  original_head TEXT,                    -- HEAD read under the lock; null = unborn
  state TEXT NOT NULL,                   -- prepared | committed | rejected | unknown
  commit_sha TEXT,
  rejection TEXT,                        -- JSON reason when rejected, detail when unknown
  push_destination TEXT,                 -- JSON target captured at commit time; null when push = false
  push_state TEXT NOT NULL,              -- skipped | pending | pushed | failed
  push_failure TEXT,                     -- JSON {summary, detail}
  prepared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Rows older than 30 days are deleted at startup, beside `removeExpiredSnapshots`.

**Commit** runs in this order:

1. **Replay.** If a row exists for `requestId`, its `inputs_hash` must match (else a validation error). A settled row returns its stored result. A `prepared` row is reconciled first (step 4). A `committed` row whose push is `pending` and not running in this process runs the push now (step 3).
2. **Inside `RepositoryGitMutationLock.run(cwd)`:**
   1. `git rev-parse --verify -q HEAD` must equal `expectedHead`, else return `head-moved`.
   2. If `push` is set and there is no branch, return `no-branch`.
   3. Validate the paths with the literal-pathspec rules in `snapshot-service.ts:20-31`. Rejections up to here change nothing and are not stored; a replay recomputes them.
   4. If `push` is set, resolve and capture the destination now: the review target from `reviewWorktreeService.resolvePushTarget(threadId)`, else `{ remote: "origin", ref: "refs/heads/<branch>" }`.
   5. Insert the row as `prepared` with `original_head`, `inputs_hash` and the destination. This write commits before git runs.
   6. Write the paths (plus `previousPath` for renames) as a NUL-separated file in `<gitdir>/mcode-commit-<uuid>`.
   7. Run `git add -N --pathspec-from-file=<f> --pathspec-file-nul` for the selected **untracked** paths only.
   8. Write the message to a file and run `git -c core.quotePath=false commit --pathspec-from-file=<f> --pathspec-file-nul -F <msgfile>`. Pathspec commits use `--only` semantics: the selected paths are committed from the worktree, and other staged entries stay staged and are not committed. Hooks run normally. Use a timeout of 300s, since hooks can run linters.
   9. Settle from what this process saw, after the `git commit` child has exited, still under the lock:
      - Exit 0, and HEAD's first parent is `original_head` (no parent when `original_head` is null): this request made HEAD. Store `committed` with `commit_sha` and `push_state` (`pending` or `skipped`). A `commit-msg` hook that rewrote the message does not matter, because ownership comes from the exit status and the parent check, not from the message.
      - Exit non-zero or killed by the timeout, and HEAD still equals `original_head`: no commit happened. Roll back the intent-to-add entries with `git rm --cached -q`, classify the stderr (or "Commit timed out after 300s"), and store `rejected`.
      - Anything else, such as exit 0 with HEAD on another parent, or a failure with HEAD moved: another writer may have moved HEAD, so store `unknown` with the current HEAD.

      Unlink the temp files in every case. A crash before this step leaves the row `prepared` for reconciliation (step 4).
3. **Push** (outside the lock). Only a `committed` row is pushed, because only that state proves this request made the commit. An `unknown` or `prepared` row is never pushed. Extract `pushToResolvedTarget` and `schedulePushBumps` from `git-rpc.ts:298-353` into one `GitPushService`, used by both `git.push` and `git.commit`. For a commit request it pushes the **captured SHA to the captured destination**, `git push <remote> <sha>:<ref>` without force, never "the current branch", so a checkout switched during the push gap cannot redirect it. Today both paths push the checked-out branch (`git-repository-service.ts:293-299`, `pull-request-review-git-service.ts:351-390`); the extracted service takes the source SHA. When the branch has no upstream, set it after a successful push. Store `pushed` or `failed`. A failed push never undoes the commit, and its result is reported separately.
4. **Reconcile** (a `prepared` row left by a crash or restart; startup reconciles every `prepared` row before accepting RPCs, and a replay that finds one does the same). Take the lock and re-read the row, because the original request may have settled it while the replay waited. A row that is still `prepared` means no process recorded what `git commit` did, so reconciliation never stores `committed` and never pushes. Parent, subject and committer time are not proof of ownership: an external commit with the same subject on the same parent matches all three, and a hook can rewrite the subject of a real one.
   - HEAD equals `original_head` and the worktree's index lock (`git rev-parse --git-path index.lock`) is absent: this request's commit is not on the branch, and no `git commit` from it is still running. Store `rejected` with "Commit was interrupted".
   - Anything else: HEAD moved, whatever its parent, subject or time, or an index lock shows that a `git commit` may still be running. A crashed server can leave its git child running (inferred). Store `unknown` with the current HEAD. The commit may exist, so Mcode never retries it, never pushes it and never reports a plain failure.

The client keeps a `requestId` until it receives a settled result and resends it after a reconnect. A lost response therefore ends in the stored outcome instead of a second commit, and a restart that interrupted the commit ends in `rejected` or `unknown`. Startup does not start pushes; a `pending` push runs when the request is replayed (Risks).

The commit flow needs git 2.25 or later for `--pathspec-from-file`, and it assumes a pathspec commit includes intent-to-add files. Both are prove-first items for the real-git tests in S10-08 (not yet verified).

### 6. Snapshot pinning (S10-12)

Refs live in the repository's common git dir, so every linked worktree and every Mcode runtime database that touches the repo sees the same refs. Runtime databases are separate (the live app and each worktree's `.dev/db/app.sqlite` snapshot, `docs/agents/runtime.md:48,59`). One database cannot tell whether another database's ref is orphaned, so each database owns a namespace and only ever sweeps its own.

- **Store id.** A one-row table `store_identity (store_id TEXT NOT NULL, database_path TEXT NOT NULL, created_at TEXT NOT NULL)` holds a UUID minted on first start. At every start the server compares the normalized real path of the open database file with `database_path`. When they differ the file was copied, for example by `agent:setup`'s SQLite backup into a worktree, so the server mints a new `store_id` and records the new path. A cloned development database therefore never shares an owner with the live app. Every Mcode ref lives under `refs/mcode/<storeId>/`.
- **Captures under the lock.** Every snapshot capture (`turn-runtime-controller.ts:598-608`, `turn-file-effects.ts:158`, `turn-execution-file-evidence.ts:81`, `turn-finalizer.ts:556`) moves inside `RepositoryGitMutationLock.run(cwd)`, so a capture and its pin never interleave with a revert or a commit on the same checkout (section 08 relies on this ordering).
- **Baseline pin at capture.** Every turn-start capture (`turn-runtime-controller.ts:598-608`, `turn-file-effects.ts:158`) pins its tree as soon as it exists, inside the same lock: `B = git commit-tree <ref_before>`, then `git update-ref refs/mcode/<storeId>/baselines/<threadId>/<ref_before> B`. Clean baselines (`HEAD^{tree}`) are pinned too, because HEAD can be rebased away during a turn. The pin survives a restart, so a turn that recovery resumes or finalizes later still has its baseline.
- **Snapshot pin at finalization.** After the snapshot row persists (`writeTurnSnapshot`, `turn-finalizer.ts:584-614`), `A = git commit-tree <ref_after> -p B` (B is the baseline commit, recreated if its ref is missing), then `git update-ref refs/mcode/<storeId>/snapshots/<snapshotId> A`, then `update-ref -d` the baseline ref. A turn that writes no snapshot releases its baseline ref at finalization.
- **Identity.** Use a fixed `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (`Mcode`, `mcode@localhost`) so a repo without `user.email` works. T3 Code pins its checkpoints the same way under `refs/t3/checkpoints` (`.opensrc/…/t3code/main/apps/server/src/vcs/GitVcsDriverCore.ts:1037-1072`; read-only prior art).
- **Sweep.** It runs at startup, after `removeExpiredSnapshots` (`server-bootstrap.ts:610-616`) and after turn recovery has settled or resumed interrupted turns, and again after `snapshot.cleanup`. For each repo this database knows, it runs `for-each-ref refs/mcode/<storeId>/` only:
  - `snapshots/<id>` with no row: `update-ref -d`.
  - A row whose trees still validate but has no pin in this namespace, including rows inherited from a copied database: pin it (backfill).
  - `baselines/<threadId>/*` whose thread has no running or resumable turn: `update-ref -d`.
  - `reverts/*`: S08-03's rules (section 08, Backend §4).

  Never list, read or delete refs under another store id.
- **Failures.** A snapshot or baseline pin that fails is logged and never fails the turn; the snapshot is then exposed to gc as it is today. Revert recovery pins are different: S08-03 refuses to write without one.
- `refs/mcode/*` is not in fetch or push refspecs, but it does appear in `git log --all` (see Risks).

### 7. The next-message draft store (S10-11)

One store holds everything that rides the next message: the persisted per-thread `ComposerDraft` (`stores/composerDraftStore.ts:42-72`, written to localStorage through `composerDraftStorage`). Review diff comments, Files line comments (S12P-07), Browser design-note pages (S11-15) and the plan-comment selection (S07-06) all live in it, beside the text, attachments and selected-text comments it already holds. There is no server draft table and no RPC that reads or writes drafts; the server only stages draft images (below). S11's `thread_annotation_drafts` sketch is replaced by this. Plan comments themselves stay authoritative server records in `plan_comments` (S07); the draft holds only which of them ride the next send.

```ts
interface ComposerDraft {
  // …existing fields (composerDraftStore.ts:42-72)
  diffComments?: DraftDiffComment[];          // S10-11: DiffAnnotationPayload + DraftElementMeta
  diffCommentEditor?: { target; annotationId?; note; mentions };            // S10-11
  planCommentSelection?: { planVersionId: string; includedIds: string[]; excludedIds: string[]; revision: number }; // S10-11, read by S07-06
  planCommentEditor?: DraftPlanCommentEditor; // added by S07-06 with its schema, serializer and parser
  fileComments?: DraftFileComment[];          // added by S12P-07: FileAnnotationPayload + DraftElementMeta
  browserNotePages?: DraftBrowserNotePage[];  // added by S11-15: v2 page; each note carries DraftElementMeta; snapshots are StagedDraftImage
  submissions?: DraftSubmission[];            // S10-11: Sends whose admission has not settled
}
// agent.send gains `stagedDraftImageIds?: string[]` (S10-11); admission leases and copies them.
/** A draft image the server holds durably; never an OS temp path. */
type StagedDraftImage = { stagingId: string; name: string; mimeType: string; sizeBytes: number };
/** Every sendable element. Any change writes revision + 1; nothing edits a revision in place. */
type DraftElementMeta = { id: string; revision: number };
/** Fields whose elements a Send can carry; S12P-07 and S11-15 extend it with their fields. */
type DraftElementField = "diffComments" | "planCommentSelection";
/** What one Send froze: the element revisions and the image references its message carries. */
type DraftSubmission = {
  messageId: string;                                              // the client message id passed to agent.send
  elements: Array<{ field: DraftElementField; id: string; revision: number }>;
  planComments?: { ridingIds: string[]; excludedIds: string[] };  // the plan-comment selection at Send
  stagingIds: string[];                                           // images the frozen revisions reference
};
```

- **Plan-comment selection.** The next send carries the open, unsent comments of the latest non-accepted version whose ids are in `includedIds`. A newly saved comment joins `includedIds`. × moves an id to `excludedIds`, and the chip's undo moves it back. A comment in neither list (made in another window, or copied forward to a new version with `carriedFromCommentId`) joins `includedIds` when the client reconciles the selection with the plan's comment list; carried-forward ids keep the side of the comment they came from. Ids whose comment is resolved, deleted or already sent are dropped on reconcile, because the server record is authoritative. S07-06 renders the chip from this field.
- **Plan-comment editor.** The unsaved plan-comment editor (anchor, note, mentions) is S07-06's field, `planCommentEditor`. S07-06 defines its schema and adds its serializer, parser and round-trip test in this store, following the pattern below. S10-11 does not define it.
- **Durable snapshot staging.** Images that sit in a draft are staged on the server, never kept as an OS temp path (today's captures go to the OS temp folder, `apps/desktop/src/features/preview/capture/handlers.ts:584`, and can vanish under a persisted note). Two new methods on `AttachmentService`:
  - `attachments.stageDraft { threadId, attachment: AttachmentMeta } → StagedDraftImage` copies the file, with the same size and MIME checks as `persist` (`attachment-service.ts:96-180`), to `<attachments>/<threadId>/draft/<stagingId>.<ext>`, and removes the source when it is in a Mcode temp folder.
  - `attachments.releaseDraft { threadId, stagingIds }` deletes staged files at once unless an admission holds a lease on them; a leased id is deleted when its lease ends. Missing files are not an error.

  An image is released only when no current element in this draft and no pending submission references it. Releases happen on every way out:
  - **Discard:** removing a note, a page or the whole tile, clearing the draft, or replacing a page snapshot with a redraw releases the ids that are now unreferenced. A snapshot that a pending submission carries stays until that submission settles.
  - **Thread deletion:** `removeForThread` already deletes `<attachments>/<threadId>` (`attachment-service.ts:236-260`, called from `thread-service.ts:134`, `cleanup-worker.ts:390,480,503` and `workspace-service.ts:93,108`), which includes `draft/`. The client drops that thread's draft when the thread disappears.
  - **Settled submission:** see Settling below.
  - **Orphans** from a crash between draft removal and release: startup deletes staged files older than 30 days. A draft that still points at one shows the snapshot as missing.
- **Send freezes what it submits.** Every sendable element carries `DraftElementMeta`. The element is the unit of ownership, never its container: one Review comment, one file comment, one Browser note, and the plan-comment selection. A Browser page is a container, so its submitted revision is the revisions of its submitted notes plus the marked snapshot the message carries (S11-15 applies this). On Send the client appends a `DraftSubmission` to `submissions` and builds the `agent.send` payload from exactly those revisions. `stagedDraftImageIds` is the submission's `stagingIds`, and `messageId` is the client message id `agent.send` already accepts (`packages/contracts/src/ws/methods.ts:297-298`). While a submission is pending, its revisions are hidden from the chip and from editors, and a second Send never resubmits a revision that a pending submission holds. Containers stay usable.
- **Later edits stay separate.** A change that reaches a submitted element after Send writes a new current revision. The change can come from another window, from a reconcile, or as a new note on a submitted page (a new element in that page's current revision). The submission and the message keep the frozen revision and its image references; nothing rewrites them.
- **Admission leases and promotes images.** When `agent.send` arrives, admission takes an in-process lease on each `stagedDraftImageIds` entry before reading it, and holds it until the admission settles. It copies each leased file into message attachment storage in the step that persists the other attachments (`turn-admission-dispatch-coordinator.ts:596-601`). It never deletes the staged source, so a failed admission cannot destroy the draft's image. A failed admission deletes the copies it made. A staged id that no longer exists fails the send with a typed `draft_image_missing { stagingId }`; the draft keeps the element and shows its snapshot as missing with Retake, instead of sending notes without their image. The server holds the lease because windows do not share in-memory draft state (`apps/web/src` has no `storage` event listener), so one window cannot see another window's pending submission. A discard in another window therefore reaches `releaseDraft`, which defers a leased id until its lease ends. Leases live in memory; a deferred release lost to a restart leaves the file for the orphan sweep.
- **Settling a submission.** Success is the `agent.send` result, or the user message with that `messageId` arriving on the thread stream after a lost response. It deletes each submitted element whose current revision still equals its submitted revision and keeps every element with a newer revision. For the plan-comment selection it removes `ridingIds` from `includedIds` and the frozen `excludedIds` from `excludedIds`, because an exclusion applies to one send (S07); changes made after Send stay. Failure deletes only the submission record. The elements were never removed, so they return as they are now, later edits included. In both cases the client then releases each of the submission's `stagingIds` that no current element and no other pending submission references. After success the message holds its own copy of each image. A clean capture that a current page still uses stays. After a restart, pending submissions are resolved against the thread's messages: present means success, absent means failure. The composer text keeps today's revision guard (`clearSubmittedDraft`, `features/conversation/composer/draft/useComposerFormController.ts:502-528`). The diff-comment half of today's clear-everything dispatch guard (`composer-submission-annotations.ts:13-38`) goes away; S11-15 retires the Browser half.
- **Who adds which field.** S10-11 builds the store rules once and the fields it can define itself. The rules are element revisions, submissions, staging, leases, release, the serializer and parser pattern, and the write-failure notice. The fields are `diffComments`, `diffCommentEditor`, `planCommentSelection`, `submissions` and `stagedDraftImageIds`. S12P-07 adds `fileComments`, S11-15 adds `browserNotePages`, and S07-06 adds `planCommentEditor`, because their schemas are theirs. Each adds its serializer, parser and round-trip test in the same ticket.
- **Serializer and parser.** A new field is not durable until both sides know it: `parseStoredComposerDraft` rebuilds the draft field by field (`lib/composer-draft-storage.ts:126-157`), so an unknown field is dropped on every reload. `serializeComposerDraft` writes each new field. The parser validates each with its contracts schema (`DiffAnnotationPayloadSchema`, the S12P-07 file annotation schema, the S11 v2 page schema with `StagedDraftImage`, S07-06's plan-comment editor schema, a new `PlanCommentSelectionSchema` and a new `DraftSubmissionSchema`), drops elements that fail (stored JSON is untrusted), and logs how many it dropped. Every new field lands with a serialize, `JSON.stringify`, parse round-trip test. `draftHasNoSendableContent` (`composerDraftStore.ts:100-105`) counts every new field, so a draft holding only comments, notes, a plan selection or a pending submission persists. Bump the persist `version` from 1 to 2 with a `migrate` that keeps v1 drafts unchanged.
- **Write failures.** `composerDraftStorage.setItem` swallows quota and storage errors today (`lib/composer-draft-storage.ts:171-177`). It must still never throw into the composer, but it records the failure in a small store; the composer shows a muted inline notice, "Draft not saved · Storage is full", and logs once per failure streak. The next successful write clears it. Staged images keep only references in localStorage, which keeps drafts small.
- `previewAnnotationStore.diffByThread`, its diff actions and the module `draftCache` (`DiffCommentEditor.tsx:29`) are removed.
- **Payload.** `DiffAnnotationPayloadSchema` (`browser-preview.ts:433-444`) gains `mentions: MessageMentionsSchema()`. Its note uses the selected-text comment limit (`MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS`) instead of `PREVIEW_ANNOTATION_STRING_MAX.note`, with an aggregate refine like `selected-text-comment.ts:48-80`. The editor and the payload then share one limit.
- **Server.** `appendPreviewAnnotations` (`apps/server/src/features/agents/transport/agent-rpc.ts:244`) serialises the mentions. Mention resolution follows ADR-0014, as selected-text comments do; I have not traced the exact call path.

### Per-provider decisions

| Behavior | Claude | Codex | Cursor | Copilot | Devin (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| Comparisons, states, pickers, Files, header | no change | no change | no change | no change | no change | no change |
| Turn list and turn outcomes | no change; evidence source is already provider-neutral | no change | no change | no change | no change | no change |
| Revert file | no change (S08 operation works on snapshots) | no change | no change | no change | no change | no change |
| Commit message | no change; utility model through `UtilityCompletionService`, independent of the thread's provider | no change | no change | no change | no change | no change |
| Comment drafts and mentions | no change; rides the existing annotation bundle | no change | no change | no change | no change | no change |

## Components

### New

- `ReviewViewMenu`: the F-04 names-only menu. It has groups `[turn, cumulative] / [unstaged, staged] / [commit, branch]`, dims unavailable views with a tooltip reason, and checks the active view. Its reasons come from one pure function, `reviewViewAvailability(scope, reviewState, turns)` in `lib/review-views.ts`:
  - Turn and All turns: "No turns yet". Threadless: "Open a thread to review its turns".
  - Staged: "Nothing staged".
  - Commit: "No commits ahead of {base}".
  - Branch: "No commits yet" when unborn, "No branch to compare against" when there is no base.
  - Any git view in a non-git workspace: "Not a git repository". Unstaged is never dimmed in a git repo.
- `ReviewStatSummary`: "N files +A -D" for row 1, hidden while loading or empty.
- `ReviewControlsRow`: fixed row 2. The operand slot is on the left and `ReviewViewControls` on the right: refresh, unified/split pill, wrap, whitespace (S10-13), and Files. All controls are F-03 round buttons.
- `TurnOperandPicker`: "Turn N" plus a muted "latest" while following, opening an F-04 picker over `turnDiff.listTurns` (turns with changes, plus the latest turn). The store keeps `selectedTurnByThread: "latest" | messageId`. Choosing the newest row sets `"latest"`.
- `CommitOperandPicker`: the 10e Commit picker (sha 56w mono muted, subject with F-02 fade, relative time, check) over `git.searchCommits`, with footer "N matches in M commits".
- `BranchOperandPickers`: `compare ⌄ → base ⌄`, each an F-04 picker with Local / Origin tabs over S03-04's qualified-ref listing (Review purpose). Selections are full ref names. The last tab per side is remembered in session memory. The empty list offers "N in Origin" when the other side has matches.
- `ReviewStateBody`: the 10c bodies (loading pulse, empty, couldn't load with Details that expand raw output in place with Copy, too many files, turn gone), driven by `ReviewComparisonResult`.
- `ReviewFileHeader`: the Pierre `renderCustomHeader` with chevron, change icon, name, faded folder, `-N +N`, and actions (copy path, open in editor, revert in the Turn view, plus the existing markdown preview toggle, which is not drawn but kept). Actions show only on expanded files, as today.
- `FilesNavigator`: the filter row (F-04 search row) and tree, built from one shared order. It has two hosts: `FilesDockedPane` (FilesPanel 320, 280–480) and `FilesPopover` (300w, anchored under Files, closes on pick or Esc).
- `useReviewScrollSpy(viewerRef, orderedPaths)`: `onScroll` throttled to one update per animation frame. It binary-searches `getTopForItem` to find the active path. Jumps set the active path immediately.
- `lib/review-file-order.ts`: `orderReviewFiles(files)`, the depth-first order of `buildPullRequestFileTree` (folders first, numeric). The diff, the tree and the Commit sheet all use it.
- `CommitFloatingButton`: shown when `uncommitted > 0`. It shows the F-03 on state while the sheet is open.
- `CommitSheet`, made of `CommitFileList` (flat at 10 files or fewer, grouped by compacted folder above that, tri-state folders, filter past 10, untracked last), `CommitMessageBox`, and the F-03 split button.
- `FileRevertConfirm`: hosts S08's confirmation component as an inset under the header.

### Changed

- **Panel:** `DiffPanel.tsx` gets `ReviewComparisonResult`, the merged Turn view, live keep-previous for following, and no subagent filter. `DiffToolbar.tsx` is replaced by F-05 row-1 content plus `ReviewControlsRow`; the file may be deleted.
- **Diff surface:** `FileList.tsx` loses the portal, options menu, jump popover and file-count reporting. `ReviewDiffView.tsx` gets the custom header, ligatures off, full-width bands, `layout.paddingBottom` 72 for the floating button, and `onScroll`.
- **Pickers and files:** `TurnPicker.tsx`, `CommitPicker.tsx` and `BranchRefPicker.tsx` are rewritten as the operand pickers. `WorktreeFilesPane.tsx` becomes `FilesDockedPane`.
- **Stores and libs:** `lib/review-views.ts` gets six views, availability and new defaults. `stores/diffStore.ts` drops `last-turn`, gains `selectedTurnByThread` and `branchSelectionByScope { compare, base }`, and gets the deletions in the ledger.
- **Drafts:** `previewAnnotationStore.ts`, `composerDraftStore.ts`, `lib/composer-draft-storage.ts`, `composer-submission-annotations.ts` and `DiffCommentEditor.tsx` change per section 7.
- **Other callers:** `TurnChangeSummary.tsx` pins the messageId, or `"latest"` when the bar belongs to the latest turn. `ThreadOverview.tsx` gets new probes, and its "Commit or push" becomes "Commit…", which opens Review with the sheet. `useThreadGitActions.ts` loses the prefill.
- **Server:** `git-comparison-service.ts`, `git-rpc.ts`, `turn-diff-rpc.ts`, `snapshot-service.ts`, `turn-finalizer.ts`, `turn-runtime-controller.ts`, `turn-file-effects.ts`, `server-bootstrap.ts` and `AttachmentService` (draft staging, leases, admission copy), plus a new `GitCommitService`, `GitPushService` and `diffs/snapshots/snapshot-ref-pins.ts`, and the `git_commit_requests` and `store_identity` tables.
- **Contracts:** `review-comparison.ts`, `git.ts`, `browser-preview.ts`, the attachment staging methods and `ws/methods.ts`.
- **Docs:** `CONTEXT.md` (Review tab, Comparison, Turn view, Last turn removed, Files navigator hosts, new "Commit sheet" entry) and `docs/internals/review/turn-diff-review.md` ("Last turn" renamed to the Turn view following the latest turn).

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| `TurnEntry`, `TurnTimeline`, `CommitsView`, `CommitEntry` and their barrel exports | `components/diff/*.tsx`, `components/diff/index.ts:4-7` | nothing (dead) | S10-01 | `rg -n "TurnEntry\|TurnTimeline\|CommitsView\|CommitEntry" apps/web/src` returns nothing |
| `commitsByThread`, `commitsLoadingByThread`, `setCommits`, `setCommitsLoading`, `selectedFile`, `selectFile`, `SelectedFile`, `diffContent`, `setDiffContent`, `diffLoading` | `stores/diffStore.ts` | nothing (dead) | S10-01 | `rg -n "commitsByThread\|setCommitsLoading\|selectFile\|setDiffContent\|diffLoading" apps/web/src/stores apps/web/src/transport apps/web/src/components/diff apps/web/src/__tests__/diffStore.test.ts` returns nothing |
| Commits refetch on turn persist | `transport/ws-events.ts:472-496` | nothing | S10-01 | `rg -n "commitsByThread" apps/web/src/transport` returns nothing |
| Subagent Review scope (`SubagentReviewScope`, `setSubagentReviewScope`, `clearSubagentReviewScope`, its state, `projectVisibleComparison` filter, `isScopedCumulative`, `subagentScopeLabel`) | `stores/diffStore.ts`, `components/diff/DiffPanel.tsx` | nothing (no caller) | S10-01 | `rg -n "SubagentReviewScope\|subagentScope" apps/web/src` returns nothing |
| `useCommitAvailability`, `useBranchAvailability`, `useWorkingTreeDirty` | `DiffToolbar.tsx:616-774` | `useReviewState` over `git.reviewState` | S10-02 | `rg -n "useWorkingTreeDirty\|useBranchAvailability\|useCommitAvailability" apps/web/src` returns nothing |
| `git.reviewDiffStats`, `git.branchFiles`, `git.workingTreeFiles` (once no callers remain) and their transport methods | contracts `ws/methods.ts:942-1020`, `git-rpc.ts`, `ws-transport.ts` | totals inside `ReviewComparisonResult`, plus `git.reviewState` | S10-02 | `rg -n "reviewDiffStats\|branchFiles\|workingTreeFiles\|getReviewDiffStats\|getBranchFiles\|getWorkingTreeFiles" apps packages` returns nothing |
| Errors rendered as empty: `GitDiffView` `EmptyState`/`LoadingPulse`, `DiffPanel` `LoadingPulse`, "No changes yet" labels, `isReviewComparisonLimitError` string match | `GitDiffView.tsx:27-51`, `DiffPanel.tsx:1119`, `LastTurnView.tsx:31`, `CumulativeView.tsx:23`, `git-comparison-service.ts:580-582` | `ReviewStateBody`, typed results | S10-03 | `rg -n -a "No changes yet\|isReviewComparisonLimitError\|function EmptyState" apps/web/src/components/diff apps/server/src` returns nothing |
| All turns stale banner "New changes available" | `CumulativeView.tsx:38` | refresh in place | S10-03 | `rg -n "New changes available" apps/web/src` returns nothing |
| TurnPicker's client copy of the render rule | `TurnPicker.tsx:18-41` | `turnDiff.listTurns` | S10-03 | `rg -n "renderedFileCount" apps/web/src` returns nothing |
| TurnPicker's hand-built cmdk list (`Command`, `CommandGroup`, `CommandInput`, `CommandEmpty`) | `components/diff/TurnPicker.tsx` | F-04b `Picker` in the row-2 operand slot | S10-04 | `rg -n "CommandGroup\|CommandInput\|CommandEmpty" apps/web/src/components/diff/TurnPicker.tsx` returns nothing |
| `last-turn` view, "Last turn" label, `LastTurnView`, `LastTurnComparisonView`, evidence badges | `lib/review-views.ts:60`, `stores/diffStore.ts:40,721`, `LastTurnView.tsx`, `DiffPanel.tsx:1032-1062` | Turn view following the latest turn | S10-04 | `rg -n "last-turn\|Last turn\|LastTurnView\|Tracked file evidence\|Agent changes" apps/web/src CONTEXT.md docs/internals` returns nothing |
| Old view dropdown and count pill (`ReviewViewMenu`, `ReviewFileCount`, `reviewFileCount` and `setReviewFileCount`) | `DiffToolbar.tsx:375-440`, `FileList.tsx:110-117`, `stores/diffStore.ts:509` | F-04 `ReviewViewMenu`, `ReviewStatSummary` | S10-04 | `rg -n "ReviewFileCount\|reviewFileCount\|review-file-count" apps/web/src` returns nothing |
| Toolbar portal (`ReviewToolbarSlotContext`, `controlsSlotRef`, `review-file-controls-slot`), `FileListToolbar`, `ReviewOptionsMenu`, `RenderModeToggle`, `FilesToggle` | `components/diff/review-toolbar-slot.ts`, `FileList.tsx:279-450`, `540-577` | `ReviewControlsRow` | S10-04 | `rg -n "ReviewToolbarSlotContext\|ReviewOptionsMenu\|review-file-controls-slot\|FileListToolbar" apps/web/src` returns nothing |
| Expand/Collapse all (`bulkDiffExpand`, `setBulkDiffExpand`) | `stores/diffStore.ts:513`, `ReviewDiffView.tsx:279` | nothing (not in design; Q9) | S10-04 | `rg -n -a "bulkDiffExpand" apps/web/src` returns nothing (`-a`: `ReviewDiffView.tsx` contains NUL bytes, so plain `rg` skips it as binary) |
| `ReviewActions` in Review | `components/diff/ReviewActions.tsx` | Create PR stays in the overview and header; Commit becomes the floating sheet (S10-09) | S10-04 | `rg -n "ReviewActions" apps/web/src` returns nothing |
| `DiffToolbar` | `components/diff/DiffToolbar.tsx` | F-05 row 1 content plus `ReviewControlsRow` | S10-04 | `rg -n "DiffToolbar" apps/web/src` returns nothing |
| Single-side branch picker (`CurrentRefChip`, `RefCombobox`, `normalizeToCurrentComparison`), client swap `getBranchRange`, `BranchComparison.target` and `.refs`, `setBranchBase` and `setBranchTarget` semantics | `BranchRefPicker.tsx`, `DiffPanel.tsx:510-515`, `packages/contracts/src/git.ts:57-71` | `BranchOperandPickers`, `{compare, base}`, S03-04's qualified-ref listing | S10-05 | `rg -n "normalizeToCurrentComparison\|getBranchRange\|CurrentRefChip\|branchComparison\.target" apps/web/src apps/server/src packages/contracts/src` returns nothing |
| Client-side commit filtering and paging (`COMMIT_LIMIT`, "Load older commits", "Search older commits", `mergeFirstPageCommits`) | `CommitPicker.tsx` | `git.searchCommits` | S10-05 | `rg -n "Load older commits\|Search older commits\|mergeFirstPageCommits" apps/web/src` returns nothing |
| Pierre default header slots (`HeaderToggleButton`, `renderHeaderPrefix`, `renderHeaderMetadata`) and `[data-diffs-header="default"]` CSS | `ReviewDiffView.tsx:582-611`, `642-678`, `745-747` | `ReviewFileHeader` via `renderCustomHeader` | S10-06 | `rg -n -a "renderHeaderPrefix\|renderHeaderMetadata\|HeaderToggleButton\|data-diffs-header" apps/web/src/components/diff` returns nothing (`-a` as above; without it this proof passes falsely today) |
| `FileJumpPopover`, `FileJumpItem`, the flat `localeCompare` diff sort, the `ReviewFilesPane` "docked only" null gate | `FileList.tsx:105-108`, `453-535`; `DiffPanel.tsx:1063-1116` | `FilesNavigator` (popover and docked), `orderReviewFiles` | S10-07 | `rg -n "FileJumpPopover\|FileJumpItem\|ReviewFilesPane" apps/web/src` returns nothing |
| `WorktreeFilesPane` | `components/diff/WorktreeFilesPane.tsx` | `FilesDockedPane` | S10-07 | `rg -n "WorktreeFilesPane" apps/web/src` returns nothing |
| Commit prefill (`COMMIT_PREFILL`, `handleCommitOrPush`, "Ask the agent to commit and push the changes") | `hooks/useThreadGitActions.ts:11-12,101-104`; `ThreadOverview.tsx:1774-1787,2805,2867`; `HeaderActions.test.tsx:162,802` | `CommitSheet` and `git.commit`; the overview row becomes "Commit…", which opens the sheet | S10-09 | `rg -n "COMMIT_PREFILL\|handleCommitOrPush\|Commit or push\|Ask the agent to commit" apps/web/src` returns nothing |
| In-memory diff comments (`diffByThread` and its actions), module `draftCache` | `features/preview/state/previewAnnotationStore.ts`, `DiffCommentEditor.tsx:24-33`, `composer-submission-annotations.ts:55`, `ReviewDiffView.tsx:283` | `ComposerDraft.diffComments` and `diffCommentEditor` | S10-11 | `rg -n -a "diffByThread\|draftCache" apps/web/src` returns nothing |
| Diff note limit `PREVIEW_ANNOTATION_STRING_MAX.note` on `DiffAnnotationPayloadSchema` (the Browser preview payload keeps its own limit) | `packages/contracts/src/models/browser-preview.ts:443` | `MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS`, shared with the editor | S10-11 | `bun run --cwd packages/contracts test -- src/models/__tests__/diff-annotation-payload.test.ts` passes, accepting a 5,000-character note with mentions and rejecting one over the shared limit |
| Summary lens (`SummaryView`, `summaryRecord`, `diffSummary.*` RPCs, `settings.diffSummary`, `diffs/summaries/*`, the `diff_summaries` table, CONTEXT "Summary") | web, server, contracts, `schema.ts:882` | Recap (ADR-0013); decision V4 retires it | S10-03 | `rg -n "SummaryView\|diffSummar\|summaryRecord\|diff_summaries" apps/web/src apps/server/src packages/contracts/src CONTEXT.md` returns nothing |

`ScopeProgress` (`components/panels/ActivityRail.tsx:45-49`) is not Review's; F-05 deletes it (section 12b ledger).

## Proposed tickets

### S10-01 Retire dead Review code

- **Blocked by:** None (can start immediately).
- **Boards:** none (prefactor)
- **Delivers:** No user-visible change. Removes the dead commit and turn components, store fields, the commits refetch, and the subagent Review filter, so later tickets edit less code.
- **Build notes:** Web only. Delete the files, barrel lines and store fields from the ledger rows marked S10-01. Run `bun run --cwd apps/web typecheck` to find stragglers.
- **Deletes:** ledger rows S10-01.
- **Acceptance criteria:**
  - [ ] Every S10-01 proof command returns nothing.
  - [ ] Review still opens, switches views and comments as before.
- **Verify:** `bun run --cwd apps/web test -- src/components/diff/__tests__/DiffPanel.files.test.tsx src/components/diff/__tests__/FileList.test.tsx`. Live: open Review on a `.dev/fixture-repo` thread and switch through every view.

### S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe

- **Blocked by:** None (can start immediately).
- **Boards:** 10b `2DV5-2` (Unstaged includes untracked), 08c-3 `24OA-2` (tree counts)
- **Delivers:**
  - Unstaged lists untracked files as new files with their content, and a moved file shows as a rename.
  - Every file carries `-N +N`.
  - The thread overview's change count and Review's dirty signal see untracked and staged-only changes.
- **Build notes:**
  - Contracts: `ReviewFileChange` v2, the `uncommitted` view, `git.reviewState` (sections 1–2).
  - Server: `withIntentToAddIndex`, per-file numstat, the untracked per-file patch, `git.reviewState`.
  - Web: `useReviewState` replaces the three probes. Migrate the `ThreadOverview.tsx:907-950` and `1312-1313` probes to `git.reviewComparison` and `git.reviewState` in the same ticket, then delete the retired RPCs.
  - Test seam: `GitComparisonService` with a real temp repo.
- **Deletes:** ledger rows S10-02.
- **Acceptance criteria:**
  - [ ] An untracked file appears in Unstaged with `untracked: true`, `changeType: "added"` and the correct `additions`.
  - [ ] Deleting a tracked file and adding it under a new name yields one `renamed` entry.
  - [ ] A fresh `git init` repo with untracked files and no index file lists them in Unstaged and `uncommitted` (the empty temp index is used only because the index is absent). An unreadable index returns `failed/git-error`, never an empty index.
  - [ ] Staged plus unstaged edits to one file, an existing intent-to-add entry, an unmerged path and an ignored file each appear (or, for the ignored file, do not) exactly as `git status` reports them.
  - [ ] The real index is byte-identical (same sha256) before and after every comparison read above, and no `mcode-review-index-*` file remains after a read that fails or times out.
  - [ ] `git.reviewState` reports dirty for untracked-only and staged-only trees.
  - [ ] The ADR-0011 default picks Unstaged for an untracked-only thread.
  - [ ] The thread overview's Changes row counts untracked files.
- **Verify:** New `apps/server/src/features/projects/git/__tests__/git-comparison-untracked.integration.test.ts`, modelled on `diffs/snapshots/__tests__/snapshot-service.integration.test.ts`. Extend `git-comparison-service.test.ts` (FakeGitExecutor) for counts. Live: create `notes.md` in the fixture repo; Review › Unstaged shows it with `+N`.

### S10-03 Truthful comparison outcomes and turn list

- **Blocked by:** S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe.
- **Boards:** 10c `2E31-2`
- **Delivers:**
  - A timeout, missing worktree, unsafe ref or git error shows "Couldn't load this comparison" with Details and Retry.
  - Over 10,000 files shows "Too many files to show · 12,480 changed files. Review shows up to 10,000." with Choose another view.
  - An expired or pruned turn says "Turn 1's changes are gone".
  - Empty views name what is empty.
  - All turns refreshes in place.
- **Build notes:**
  - `ReviewComparisonResult` on `git.reviewComparison`, `turnDiff.getComparison` and the cumulative reads. Strict path resolution. The typed cap error, plus `--shortstat` for the true count. `validateRef` for pruned snapshots. `turnDiff.listTurns` with stable ordinals.
  - Web: `ReviewStateBody`. `DiffPanel` maps the status to a body, and the pulse waits for the result.
  - Empty copy:
    - Turn: "No file changes in Turn N" / "The agent answered without editing files".
    - Unstaged: "No unstaged changes".
    - Staged: "Nothing staged".
    - Branch: "No changes between {compare} and {base}".
    - All turns: "No file changes in this thread yet".
    - Expired: "Snapshots older than 30 days are cleared". Pruned: "Git removed this turn's snapshot".
  - Retire the All turns AI summary (decision V4): `SummaryView`, the `diffSummary.*` RPCs, `settings.diffSummary`, `diffs/summaries/*`, and the `diff_summaries` table through a Drizzle migration. All turns renders only the typed comparison.
  - Seam: the RPC route functions with FakeGitExecutor.
- **Deletes:** ledger rows S10-03.
- **Acceptance criteria:**
  - [ ] An executor rejection with `killed: true` returns `failed/timeout`. Details shows the raw stderr and Copy copies it.
  - [ ] 10,001 name-status records return `too-many-files` with the shortstat count.
  - [ ] A message without a snapshot row returns `snapshot-expired`. A snapshot whose tree fails `cat-file -t` returns `snapshot-pruned`.
  - [ ] A thread whose worktree folder was deleted returns `worktree-missing`, not a read of the workspace root.
  - [ ] No code path renders a failure as "No changes".
- **Verify:** Extend `git-comparison-service.test.ts` and `diffs/transport/__tests__/snapshot-rpc.test.ts`, and add `turn-diff-rpc.test.ts`. Web: extend `GitDiffView.test.tsx` and `DiffPanel.files.test.tsx` per status. Live: point a fixture thread's Branch base at a bad ref and see Couldn't load and Retry. Delete a worktree folder and see Couldn't load.

### S10-04 Two-row header, names-only view menu, merged Turn view

- **Blocked by:** S10-01 Retire dead Review code; S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe; S10-03 Truthful comparison outcomes and turn list; F-03 Button primitives; F-04a Menu primitive; F-05 Right panel shell: two-row header, right-edge rail, panel controls.
- **Boards:** 10a `2241-2`, 10b `2DV5-2`, 08c-2 `2D33-2` (Commit row; Branch row comes in S10-05)
- **Delivers:**
  - Row 1 reads "Turn ⌄ · 2 files +10 -10".
  - Row 2 holds the operand (left) and refresh, unified/split, wrap and Files (right), in every view and state.
  - The menu has six names in three groups. Unavailable views are dimmed with a tooltip reason.
  - Turn opens on "Turn N latest" and follows new turns, including live ones, without flashing to loading. Picking an older turn pins it.
  - The default never lands on an unavailable view.
  - Refresh works in every view, including Commit.
- **Build notes:**
  - Web only. Use the F-05 row-1 slot and the row-2 surface.
  - `reviewViewAvailability` is pure and unit-tested.
  - `selectedTurnByThread: "latest" | messageId`. Following keeps the last settled or live comparison visible while the next revision loads (fix `DiffPanel.tsx:405`).
  - The ADR-0011 default goes through `defaultReviewView(scope, changeState, availability)`.
  - `TurnChangeSummary` pins its messageId.
  - The whitespace slot stays empty until S10-13.
  - Update `CONTEXT.md` (Review tab, Turn view, Last turn removed) and `docs/internals/review/turn-diff-review.md`.
- **Deletes:** ledger rows S10-04.
- **Acceptance criteria:**
  - [ ] The menu order and dividers match 10b exactly. Staged is dimmed with "Nothing staged" when `staged = 0`. Commit is dimmed with "No commits ahead of origin/main" when `commitsAhead.count = 0`.
  - [ ] A clean thread whose Branch is unavailable defaults to Unstaged.
  - [ ] Row 2 stays 40px and Refresh stays visible in loading, empty, error and too-many states.
  - [ ] When a new turn starts while the view follows the latest turn, the view moves to it and keeps the previous diff on screen until the new one settles.
  - [ ] Wrap starts on. The unified/split pill shows the active segment filled.
- **Verify:** New `lib/__tests__/review-views.test.ts`. Extend `TurnPicker.test.tsx` (follow and pin, ordinals) and `DiffPanel.files.test.tsx`. Live: Electron live-testing skill on a fixture thread with three turns. Compare row 1 and row 2 against 10a and the menu against 10b. Take screenshots before and after.

### S10-05 Commit and Branch pickers with server search and paging

- **Blocked by:** S10-04 Two-row header, names-only view menu, merged Turn view; S03-04 Paged branch and pull request targets (backend); F-04b Picker primitive.
- **Reconciled:** Reuses S03-04's qualified-ref listing with an explicit purpose filter. Review keeps local and origin twins as separate selectable refs; the new-thread picker may group them for display. Remove the competing `git.listRefs` sketch.
- **Boards:** 10e `2EM3-2`
- **Delivers:**
  - Commit search finds any commit in the range, by subject or sha prefix, with the footer "4 matches in 412 commits".
  - Branch shows `compare ⌄ → base ⌄`. Each side opens Local | Origin (base opens on Origin, compare on Local) with silent paging and "Showing 100 of 214". When the open tab has no match but the other does, the list offers a one-click switch.
  - Local `main` and `origin/main` are separate choices, so a diverged local branch can be compared against its remote twin.
- **Build notes:**
  - Contracts: `BranchComparison {compare, base}` with qualified ref names, and `git.searchCommits` (section 4). No ref-listing contract: the pickers call S03-04's qualified-ref listing with its Review purpose and add nothing to it. If S03-04 lacks a property section 4 lists, fix it in S03-04's contract, not with a second RPC.
  - Web: `BranchOperandPickers` and `CommitOperandPicker` on F-04. The selection is stored per scope as `{compare, base}` (full ref names), and the wire range is `${base}...${compare}`. The other tab's match count comes from a second listing call with the smallest page size.
  - Migrate `ThreadOverview` off `comparison.target`.
  - Write the Branch ADR at the next free number. Update CONTEXT "Comparison".
- **Deletes:** ledger rows S10-05.
- **Acceptance criteria:**
  - [ ] Searching "delete" returns matches beyond the first page, and the counts match `git rev-list --count`.
  - [ ] Picking `origin/main` as compare and `mcode-3f2a` as base sends `refs/heads/mcode-3f2a...refs/remotes/origin/main`.
  - [ ] With local `main` and `origin/main` diverged, Local lists `main` and Origin lists `main` (label) for `refs/remotes/origin/main`. Comparing one against the other shows the commits each side lacks.
  - [ ] Sorting puts the default branch first and the thread worktree's branch second, not the project folder's branch.
  - [ ] A branchless thread's compare side reads `HEAD`, and its base defaults to the saved base branch (ADR-0015).
  - [ ] Ref listing failures show an error row, not an empty list.
  - [ ] No code swaps base and target anywhere, and no `git.listRefs` method exists.
- **Verify:** Extend `git-service-branch-comparison.test.ts`. Add a `git-commit-search.integration.test.ts` real-repo test with 300 commits, and a picker test against S03-04's listing with 150 refs including a diverged `main`/`origin/main` pair. Live: the 10e flows on the fixture repo.

### S10-06 Diff presentation: filename-first header, ligatures off, full-width bands

- **Blocked by:** S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe; S10-04 Two-row header, names-only view menu, merged Turn view; F-01b Token vocabulary rename; F-02 Fade truncation primitive.
- **Boards:** 10a `2241-2`, 08c-3 `24OA-2`
- **Delivers:**
  - Each file header reads `▾ ⧈ ThreadActionsMenu.tsx apps/web/src/features/thread-actions… -9 +4` with copy, open and (Turn) revert slots.
  - Collapsed files still show their counts.
  - `=>` renders as two glyphs.
  - "17 unmodified lines" bands run edge to edge.
  - The last lines can scroll clear of the floating Commit.
- **Build notes:**
  - `renderCustomHeader` takes its counts from `ReviewFileChange`.
  - `unsafeCSS`: `font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0`.
  - Style the bands per the Paper values (32px rows, 32px chevron cell on `--color-panel`, mono 12 muted label).
  - `layout.paddingBottom: 72`.
- **Deletes:** ledger rows S10-06.
- **Acceptance criteria:**
  - [ ] Folder text fades with the 24px mask and never shows an ellipsis.
  - [ ] Deletions appear before additions in the header, per Paper.
  - [ ] The header is 36px, and actions appear only on expanded files.
- **Verify:** Extend `PierreCodeView.test.tsx` and `FileActionBar.test.tsx`. Live: screenshot 10a parity at 536 and at the expanded width.

### S10-07 Files navigator: docked at 800+, popover below, scroll-spy, one order

- **Blocked by:** S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe; S10-04 Two-row header, names-only view menu, merged Turn view.
- **Boards:** 08c-3 `24OA-2`, 08c-4 `2D70-2` (recommended; 08c-5 `2DEZ-2` if Q1 picks docked)
- **Delivers:**
  - From 800 wide, Files docks the tree (320, 280–480) and Commit shifts left.
  - Below 800, Files opens a 300px popover with a filter and the tree. Picking a file jumps to it and closes the popover.
  - The active file follows scrolling and every jump (rail, popover, changes bar, comment chip).
  - The tree, the diff and the Commit sheet share one order.
- **Build notes:** Web only. `FilesNavigator` plus two hosts. `useReviewScrollSpy` uses Pierre `onScroll` and `getTopForItem`. `orderReviewFiles` lives in `lib/review-file-order.ts`. The Files button shows its on state while docked or while the popover is open, and visibility still persists per scope.
- **Deletes:** ledger rows S10-07.
- **Acceptance criteria:**
  - [ ] At a 536 panel, the Files popover opens under Files (`top 96, right 16`). Esc and outside-click close it.
  - [ ] Scrolling past a file header moves the active row in both hosts.
  - [ ] The diff order equals the tree's depth-first order for `a/b/10.ts`, `a/b/9.ts`, `a/z.ts`, `b.ts`.
  - [ ] `FileJumpPopover` is gone.
- **Verify:** Extend `DiffPanel.files.test.tsx` and `FileList.test.tsx`, and `features/pull-requests/lib/__tests__/pull-request-file-tree.test.ts` for the order helper. Live: resize the panel across 800 and scroll a ten-file diff.

### S10-08 Commit backend: message generation, commit, push

- **Blocked by:** S10-02 Comparison data: per-file counts, untracked in Unstaged, review state probe.
- **Boards:** 10d `2EAB-2`
- **Delivers:**
  - The server writes a commit message from the selected paths' diff with the utility model and reports which model wrote it.
  - It commits exactly the selected files (tracked, untracked, deleted, renamed), leaves other staged changes staged, and runs hooks.
  - It optionally pushes the commit it made, to the destination captured when it committed, and reports the push separately.
  - A repeated click, a lost response or a server restart never makes two commits. A commit stored before a lost response or restart keeps its SHA and push outcome.
  - Mcode never pushes a commit it cannot prove it made. When a crash leaves ownership unproved, the result is `unknown`.
- **Build notes:**
  - Section 5: new `GitCommitService`, `GitPushService` (extracted from `git-rpc.ts:298-353`, taking an explicit source SHA), the `git_commit_requests` table and migration, and the two RPCs. Startup reconciles `prepared` rows before accepting RPCs and deletes rows older than 30 days.
  - It runs inside `RepositoryGitMutationLock`, writes temp pathspec and message files in the git dir, and uses a 300s commit timeout. The lock is in-process; reconciliation, not the lock, covers a crash.
  - Only the process that saw `git commit` exit stores `committed`. Reconciliation stores `rejected` or `unknown`, never `committed`, and only `committed` rows push. Do not match commits by parent, subject or time.
  - Add a test-only fault hook to `GitCommitService` that stops after the `prepared` write, after `git commit` exits but before the settle write, or before the push. It throws a sentinel the service does not catch, and the test then builds a fresh service on the same database file to stand in for a restart.
  - Classify failures from stderr. Never substitute fallback message text. `expectedHead` is a precondition only; idempotency comes from the stored request.
- **Deletes:** none (the prefill goes in S10-09 with its replacement UI).
- **Acceptance criteria:**
  - [ ] With `a.ts` (unstaged), `b.ts` (staged, unselected) and `new.md` (untracked, selected), the commit contains `a.ts` and `new.md` only, and `b.ts` is still staged afterwards.
  - [ ] Calling twice with the same `requestId` yields one commit and returns the same sha and push result. The same `requestId` with different inputs is rejected.
  - [ ] Lost response after the commit: a fresh service on the same database replays the `requestId` and returns `committed` with the original sha, not `head-moved`.
  - [ ] Restart before push (fault hook before the push): the row is `committed` with push `pending`; the replay pushes the captured sha to the captured destination and returns `pushed`.
  - [ ] Branch change in the push gap: after the commit, check out another branch, then let the push run; the bare remote's original branch receives the captured sha and the other branch is not pushed.
  - [ ] External same-subject commit: the fault hook stops after the `prepared` write and before `git commit` runs, then an external `git commit` with the same subject lands on `original_head`. Startup reconciles the row to `unknown` with that HEAD. Replaying the `requestId` with `push: true` returns `unknown`, and the bare remote is unchanged.
  - [ ] Crash after `git commit` exits 0 but before the settle write: startup reconciles to `unknown`, never `committed`, and nothing is pushed.
  - [ ] Hook rewrite: a `commit-msg` hook that rewrites the subject still returns `committed` with the new commit's sha, and Commit and push sends that sha.
  - [ ] A `prepared` row with HEAD unchanged and no index lock reconciles to `rejected` ("Commit was interrupted"). With `index.lock` present it reconciles to `unknown`.
  - [ ] A stale `expectedHead` returns `head-moved` and commits nothing.
  - [ ] A failing `pre-commit` hook returns `rejected/failed` with the hook output in `detail`, rolls back the intent-to-add entries, and leaves HEAD unchanged.
  - [ ] Committing with nothing changed returns `nothing-to-commit`.
  - [ ] A push failure returns `committed` with `push.failed`.
  - [ ] Generation failure returns `failed` with a reason, never text.
- **Verify:** New `apps/server/src/features/projects/git/__tests__/git-commit-service.integration.test.ts` against a real temp repo, a local bare remote, and `pre-commit` and `commit-msg` hook scripts. It builds a second service on the same database file to stand in for a restart. Prove git 2.25+ `--pathspec-from-file` and the intent-to-add pathspec commit there first. Extend `git-service-push.test.ts` for the extracted service.

### S10-09 Commit sheet and floating Commit

- **Blocked by:** S10-08 Commit backend: message generation, commit, push; S10-06 Diff presentation: filename-first header, ligatures off, full-width bands; F-03 Button primitives; F-07a Overlay surfaces and side placement; F-12 Form controls.
- **Boards:** 10a `2241-2` (button), 10d `2EAB-2`
- **Delivers:**
  - The Commit button floats bottom-right whenever there are uncommitted changes, in any git scope.
  - The sheet lists every uncommitted file:
    - Checked by default except new files, with "N of M files" select-all.
    - Flat at 10 files or fewer. Grouped by folder above that, with tri-state folders, counts and +/-. Folders start collapsed past about 12 rows, except the folder of the file in view.
    - "Filter files" past 10. Deleted files struck through. Untracked files last.
  - The message arrives with "Written by Haiku 5.5", and regenerate rewrites it.
  - "Commit N files" commits. "Commit and push" commits then pushes.
  - Hook failures, nothing-to-commit, head-moved and push failures show in the sheet with Details.
  - An `unknown` result reads "Couldn't confirm the commit" with Details and the current HEAD, and offers no Commit retry and no push.
  - Success closes the sheet and leaves Review as it was.
  - The overview's "Commit or push" becomes "Commit…", which opens Review with the sheet.
- **Build notes:**
  - Web, using `git.reviewComparison({ view: "uncommitted" })`, `git.reviewState.head` as `expectedHead`, and a fresh `requestId` per click. The sheet keeps that `requestId` until it receives a settled result (including push `pushed` or `failed`) and resends it after a reconnect; while push is `pending` it shows "Pushing…".
  - Live refresh on `diffRevision` keeps choices per path; newly appearing files take the default.
  - Generate once on open, then only on regenerate. While generating, the message area is read-only with the placeholder "Writing a message…". With no files selected, the placeholder is "Select files to commit".
  - For branchless threads "Commit and push" is disabled with the tooltip "Create a branch to push" (Q7).
  - Esc or × closes; the button shows its on state while open.
  - Add a CONTEXT "Commit sheet" entry.
- **Deletes:** ledger row "Commit prefill".
- **Acceptance criteria:**
  - [ ] The sheet matches 10d at 3 and 23 files: list height 228 with a 28px fade, and the footer split button.
  - [ ] Unchecking a folder unchecks all its files, and a partly checked folder shows indeterminate.
  - [ ] The primary label counts the checked files, and the button is disabled at 0 files or with an empty message.
  - [ ] The commit prefill is gone from the overview and header tests.
  - [ ] A failing hook shows the output in the sheet, and the files stay checked for a retry.
  - [ ] A dropped connection during Commit resends the same `requestId`; the sheet shows one commit and its push result.
- **Verify:** New `components/diff/__tests__/CommitSheet.test.tsx`. Update `HeaderActions.test.tsx` and `useThreadGitActions.branchless-pr.test.tsx`. Live: in the fixture repo, edit two files, add one, and commit two. Then add `.git/hooks/pre-commit` that exits 1 and see the failure. Video for the PR.

### S10-10 Revert file in the Turn view

- **Blocked by:** S08-03 Turn revert server operation (preview, apply, undo); S08-04 Revert this turn: menu item, inline confirm, receipt with Undo; S10-06 Diff presentation: filename-first header, ligatures off, full-width bands.
- **Boards:** 10a `2241-2`, 10c `2E31-2` ("Revert file")
- **Delivers:**
  - In the Turn view, each expanded file header has a Revert icon (tooltip "Revert file").
  - It opens S08's confirm inset under the header: "Revert ThreadActionsMenu.tsx to before Turn 3? / Only this file changes. The turn's other edits stay." with Cancel and Revert.
  - On success the inset closes and the conversation shows S08's receipt. On `stale` the inset re-renders from the fresh preview; on `failed` it shows S08's copy for that outcome in place.
- **Build notes:** Web only, through S08-04's `useTurnRevert` and `RevertConfirm`. It calls S08-03's `turn.revert.preview { threadId, messageId, scope: { kind: "file", path } }`, then `turn.revert.apply { threadId, messageId, scope, previewToken, requestId }` with the token from that preview and a new `requestId` per Revert click. `useTurnRevert` keeps the `requestId` until a result arrives and resends it after a reconnect; Retry is a new click with a new id. The receipt's Undo is S08's. Pinning (S10-12) protects the baseline. All turns and git views have no icon (Q8).
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] The icon appears only in the Turn view.
  - [ ] Cancel leaves the file untouched.
  - [ ] Revert changes only that file in the worktree.
  - [ ] Two clicks on Revert for the same file, with an Undo between them, send two different `requestId`s and revert twice.
  - [ ] The inset is keyboard reachable, and Esc cancels.
- **Verify:** Component test beside `FileActionBar.test.tsx`. Live: revert one file of a two-file fixture turn and check `git status`.

### S10-11 Comment drafts persist, one limit, mentions kept

- **Blocked by:** None (can start immediately).
- **Reconciled:** Owns the one draft store for everything that rides the next message: Review comments, Browser design notes (S11-15), file line comments (S12P-07) and plan-comment chip selection (S07-06). Decision: the persisted composer draft, no new table. It must persist included and excluded plan comment ids, stage screenshot snapshots durably with reference release on discard, thread deletion and successful admission, update the serializer, parser and the write-failure path (surface failure, never silently drop), and clear only the submitted draft revision after admission. Plan comments themselves stay records in `plan_comments`.
- **Boards:** none new (existing gutter "+" and editor)
- **Delivers:**
  - The persisted composer draft becomes the one store for everything that rides the next message. Review line comments, an open comment editor and the plan-comment selection (rendered by S07-06) survive a reload until they are sent. The same store, with durable image staging, is ready for Files line comments (S12P-07), Browser note pages with their snapshots (S11-15) and the unsaved plan-comment editor (S07-06).
  - Send carries exactly the revisions it froze. An edit made while Send is pending survives, whether the send succeeds or fails, and a failed send loses nothing, images included.
  - The editor and the payload share one limit, so a long note never fails at send.
  - Mentions typed in a comment reach the agent.
  - A draft that cannot be saved says so instead of disappearing on the next reload.
- **Build notes:** Section 7. This ticket builds the store's rules once; S12P-07, S11-15 and S07-06 add their own fields on top. `planCommentEditor` and its serializer and parser are S07-06's, not this ticket's.
  - Web: `diffComments`, `diffCommentEditor` and `planCommentSelection` with `DraftElementMeta`, the `submissions` field, the serializer, the validating parser, the persist `version` 2 migration, `draftHasNoSendableContent`, the write-failure notice, and the `planCommentSelection` reconcile helper S07-06 calls. Put the send flow in a pure module (`features/conversation/composer/draft/draft-submission.ts`: freeze, settle on success or failure, and the unreferenced-image set) so the field owners reuse it and it is the test seam. Migrate the `previewAnnotationStore` diff actions to the draft. The composer chip (`DiffCommentsComposerAttachment`) reads from the draft.
  - Server: `attachments.stageDraft`, `attachments.releaseDraft` with lease deferral, `stagedDraftImageIds` on `agent.send`, the admission lease and copy in `turn-admission-dispatch-coordinator.ts` (copies removed on failure, staged source never deleted), `draft_image_missing`, and the 30-day startup sweep of `draft/` folders. S11-15 is the first real caller of staging; this ticket proves it with a fixture image.
  - Contracts: `StagedDraftImage`, `PlanCommentSelectionSchema`, `DraftSubmissionSchema`, `stagedDraftImageIds`, and the `DiffAnnotationPayloadSchema` changes (mentions, shared limit).
- **Deletes:** ledger rows S10-11.
- **Acceptance criteria:**
  - [ ] Save two comments, reload, and both are still in the diff and in the composer chip. An open editor's unsaved text and mentions also survive.
  - [ ] Each field this ticket adds survives serialize, `JSON.stringify` and parse. A stored element that fails its schema is dropped and counted in a log line, and the rest of the draft restores.
  - [ ] A draft holding only comments or only a plan selection is persisted.
  - [ ] A forced storage quota error shows "Draft not saved · Storage is full", the composer keeps working, and the next successful write clears the notice.
  - [ ] A staged fixture image keeps working after its source temp file is deleted and reaches the admitted message through `stagedDraftImageIds`. After a successful send, no file that the draft no longer references remains under the thread's `draft/` folder. Discarding releases it. Deleting the thread removes it. A missing staged file fails the send with `draft_image_missing` and keeps the element.
  - [ ] Same-item edit during send: a submitted Review comment edited while Send is pending keeps its edited revision after success and after failure, and the message carries the text at Send. A comment added while Send is pending stays in the draft.
  - [ ] Cross-window discard: while window A's send is pending, a second window discards the same element and calls `releaseDraft` for its staged image. The file survives until A's admission settles, A's message holds the image, and the file is gone once the lease ends.
  - [ ] Admission failure after image staging: a forced failure after admission has copied the staged images deletes those copies, leaves every staged file in place, and returns every element. A retry sends the same images.
  - [ ] Lost success response: the `agent.send` result is dropped and the user message with the submitted `messageId` arrives on the stream. Unchanged submitted elements are deleted, an element edited during send stays at its new revision, and only images that nothing references are released.
  - [ ] Restart with a pending submission: when the thread holds that `messageId`, success applies; when it does not, every element returns.
  - [ ] An excluded plan comment id survives a reload and is not sent. A comment created in another window is included by default.
  - [ ] A 5,000-character note sends, and an `@file` mention in a comment is present in the sent bundle.
- **Verify:** `bun run --cwd apps/web test -- src/components/diff/__tests__/DiffCommentEditor.test.tsx src/features/conversation/composer/DiffCommentsComposerAttachment.test.tsx src/lib/composer-draft-storage.test.ts src/features/conversation/composer/draft/draft-submission.test.ts` (extend the storage test; `draft-submission.test.ts` is new and covers the same-item edit, lost success response and restart cases; prior art for draft fields is `features/conversation/composer/draft/composer-selected-text-comments.test.ts`). The server tests below cover the lease, the cross-window discard and the admission failure after staging. `bun run --cwd apps/server test -- src/features/attachments/storage/__tests__/attachment-service-draft-staging.test.ts src/features/agents/turns/__tests__/turn-admission-draft-images.test.ts` (both new, temp directories; prior art `attachment-service-virtual.test.ts`). `bun run --cwd packages/contracts test -- src/models/__tests__/diff-annotation-payload.test.ts` (new). Live: comment, reload Electron, send.

### S10-12 Pin turn snapshots so git gc cannot prune them

- **Blocked by:** None (can start immediately).
- **Reconciled:** Owns snapshot pinning for every section, namespaced by the owning database: `refs/mcode/<storeId>/snapshots/<id>` (a cloned dev database gets its own storeId). Sweep only refs under this store's namespace. Pin the dirty pre-turn baseline when it is captured, not at finalization. S08-03 adds `reverts/` beside it.
- **Boards:** 10c `2E31-2` ("Turn no longer available", pruned case becomes rare)
- **Delivers:** Turn diffs, revert baselines and the baseline of a turn still running stay readable for the full 30-day retention, even after `git gc --prune=now`. Each runtime database pins and sweeps only its own refs, so a development clone can never delete the live app's pins.
- **Build notes:** Section 6. New `apps/server/src/features/projects/diffs/snapshots/snapshot-ref-pins.ts` (store id, baseline, snapshot and sweep helpers; S08-03 adds its `reverts/` helpers here). The `store_identity` table and migration. Move all four snapshot capture sites inside the repo mutation lock, pin baselines there at the two turn-start sites, transfer or release them in `writeTurnSnapshot`, and run the sweep after `removeExpiredSnapshots`, after turn recovery and after `snapshot.cleanup`. Document the namespace, the clone rule and `git log --all` visibility in `docs/internals/review/turn-diff-review.md`.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] After `git gc --prune=now`, a pinned dirty-tree snapshot still diffs.
  - [ ] A dirty baseline survives `git gc --prune=now` while its turn is still running, and survives a server restart before finalization. Finalization moves it into the snapshot pin and deletes the baseline ref. A turn that writes no snapshot releases it.
  - [ ] Two databases with different store ids share one repo and a linked worktree. Either one's sweep deletes only its own orphaned refs, and every ref under the other store's id survives, including hand-made `reverts/` refs that stand in for S08-03.
  - [ ] A database file copied to a new path mints a new store id on its first start; the original keeps its id.
  - [ ] After the row expires and the sweep runs, the ref is gone. A row without a pin, including one inherited from a copied database, is pinned by the sweep.
  - [ ] Works in a linked worktree and in a repo with no `user.email`.
  - [ ] Pinning failures are logged and never fail the turn.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/diffs/snapshots/__tests__/snapshot-ref-pins.integration.test.ts src/features/projects/diffs/snapshots/__tests__/snapshot-service.integration.test.ts` (the first is new: real git, two temp database files, a linked worktree, `git gc --prune=now`).

### S10-13 Whitespace control

- **Blocked by:** S10-04 Two-row header, names-only view menu, merged Turn view.
- **Needs decision:** Whether the whitespace button hides whitespace changes or shows invisible characters.
- **Boards:** 10a `2241-2` ("Show whitespace", off at rest)
- **Delivers:** The fourth row-2 control, with the behaviour chosen in Q2.
- **Build notes:**
  - If Q2 is "hide whitespace changes": add `ignoreWhitespace: boolean` to `git.reviewComparison` and the per-file patch reads, passing `-w` for git views. Git-fallback turns are also git diffs. Native agent patches dim the control with the tooltip "Not available for agent patches".
  - If Q2 is "show invisibles": web only, through Pierre's token transformer. Its feasibility is unproven.
  - Per-thread preference, like wrap.
- **Deletes:** none.
- **Acceptance criteria:** decided with Q2.
- **Verify:** Unit test at the comparison service seam. Live toggle.

## Tests

- **Server, highest seam.** Test the services against real temporary repos (prior art: `apps/server/src/features/projects/diffs/snapshots/__tests__/snapshot-service.integration.test.ts`). Cover untracked files, rename pairing, an absent index, intent-to-add, conflicts, index immutability, commits of selected paths, hooks (including a `commit-msg` rewrite), durable commit requests across a second service on the same database file (including an external same-subject commit after a crash, which must reconcile to `unknown` and never push), a bare remote for push, draft image leases and admission copies, gc with pinning, and two store ids on one repo. Use `FakeGitExecutor` (`git/execution/fake-git-executor.ts`) for timeouts (`killed: true`), the cap, and stderr classification (prior art `git-comparison-service.test.ts`, `git-service-push.test.ts`). Test RPC routing at `routeGitRpc` and `routeTurnDiffRpc`.
- **Web.** Test the pure `lib/review-views.ts` availability and defaults, and `lib/review-file-order.ts`. Test components with mocked transport: `DiffPanel.files.test.tsx` per result status, `TurnPicker.test.tsx` for follow and pin, `PierreCodeView.test.tsx` for the custom header, `FileList.test.tsx` for order, and the new `CommitSheet.test.tsx`. Test comments with `DiffCommentEditor.test.tsx`, `DiffCommentsComposerAttachment.test.tsx`, `lib/composer-draft-storage.test.ts` for every new draft field and write failures, and `draft-submission.test.ts` for freezing and settling submissions.
- **Commands.** Run `bun run --cwd apps/server test -- <files>` and `bun run --cwd apps/web test -- <files>`, one command per workspace. Then run `bun run lint` and `bun run typecheck` for the changed scope.
- **Live.** Use `bun run --shell system agent:up --desktop`, then `bun run agent:ready`, and drive the app with `.agents/skills/electorn-live-testing/SKILL.md` on `.dev/fixture-repo` threads only. UI tickets need before and after screenshots or video for the PR.

## Risks and open questions

Product calls go to the user. The rest are facts for the ticket owner to prove.

1. **Q1 (user): Files at normal width.** The choice is the 08c-4 popover or the 08c-5 docked tree at about 220. Recommend **08c-4**:
   - It keeps the diff at 520 or wider, so split view and line comments stay usable. 08c-5 leaves about 316px, which wraps almost every line.
   - It merges `FileJumpPopover` into one component.
   - It matches PR detail, which also floats its rail below 800.
2. **Q2 (user): what the ¶ control does.** The layer is named "Show whitespace" and is off at rest. Pierre 1.4.1 has no invisibles option. Recommend **"Hide whitespace changes"** (`-w`), dimmed for native agent patches, with the tooltip renamed to match. The alternative, rendering invisible characters, needs a token transformer that is unproven.
3. **Q3 (user): Commit list domain.** Today, and in the 10b tooltip, the list covers commits ahead of the base. 10e's "412 commits" and "across all history" suggest full history. Recommend keeping ahead-of-base for the list and for Commit availability, and searching that whole range on the server. Full history is a one-parameter change, but it would make the "No commits ahead of origin/main" reason meaningless.
4. **Q4 (user, open since 08): Commit overlapping the diff while scrolling.** Recommend accepting the overlap and adding 72px bottom padding so content can scroll clear. No hide-on-scroll motion.
5. **Q5 (user): Summary lens.** The AI prose for All turns, `settings.diffSummary` and CONTEXT "Summary" are not drawn. Recommend retiring them, because thread Recap (ADR-0013) covers this. Decision V4 defaults to retire, so S10-03 retires them; a "keep" answer removes that ledger row and build note.
6. **Q6 (user): evidence labels.** The labels are not drawn. Recommend dropping "Agent changes" and "Tracked file evidence". Keep the Git-fallback caveat as a muted info icon after the turn picker, with the tooltip "Git fallback: edits to the same files by other tools may appear".
7. **Q7 (user): branchless threads.** Recommend disabling "Commit and push" with the tooltip "Create a branch to push". The alternative is the Create PR flow, which asks for a branch name first (ADR-0015).
8. **Q8 (user, S08): Revert in All turns.** Recommend the Turn view only. The 10c copy is per turn, and S08's operation is per turn.
9. **Q9 (user): Expand/Collapse all.** It is not in the design and is removed in S10-04. Confirm that losing it is acceptable.
10. **Q10 (user, open since 08): docked tree search style.** Recommend one F-04 search row in both hosts, with the placeholder "Filter files".
11. **Q11 (user, ADR): Branch default direction on the default branch.** ADR-0007 rule 1 says `main...origin/main` (incoming). The shipped client sends `origin/main...main` (unpushed) because of the swap. Recommend keeping "unpushed", which matches ADR-0007's own context, and recording it in the new Branch ADR.
12. **S10 call, flagged: turn ordinals.** Ordinals count every user turn, so "Turn 2" can be the empty state 10c draws and numbers survive snapshot expiry. The picker lists turns with changes plus the latest turn. Today ordinals count only turns with changes.
13. **S10 call, flagged: Commit button visibility.** The Commit button is hidden when nothing is uncommitted, rather than shown disabled, so it never floats over a clean diff.
14. **"Since you looked"** (approved in 08, owned by S08) appears only in a Paper layer name. S08-08 adds it as a Review view in menu group 1, after Turn; it needs the designer sign-off listed in section 08.
15. **Commit semantics (prove first in S10-08).** `--pathspec-from-file` needs git 2.25 or later. Check what `bun run doctor` enforces. Also prove that intent-to-add entries commit under `--only`, how hook-modified files behave, and that Windows paths stay literal.
16. **Hooks can be slow.** The 300s timeout plus a busy state in the sheet cover it. Hook output appears only on failure; streaming it is out of scope.
17. **Pinning visibility.** `refs/mcode/<storeId>/*` commits appear in `git log --all` and in graph tools. T3 Code accepts the same trade-off. Moving the Mcode data folder mints a new store id, and the old namespace's refs then stay until removed by hand (`git for-each-ref refs/mcode/` lists them). Document both in `docs/internals/review/` when S10-12 lands.
18. **Persisted comment anchors.** Anchors (path, side, line) can drift after a reload once the diff changes. No re-anchoring is designed. Comments stay on their saved line and in the composer chip.
19. **Pending push without a replay.** A push left `pending` by a restart runs when the client replays its `requestId`. If no client replays it (the sheet was closed and the app restarted), the commit stays local and the row expires after 30 days. Startup deliberately does not push on its own.
20. **Cross-section.**
    - F-05 owns the row-1 slot API and the caption overlay padding (Paper row 1 has padding-right 98).
    - F-04 owns the menu, picker, segmented tabs and paging.
    - S03-04 owns the qualified-ref listing; S10-05 only consumes it.
    - S08 owns the revert operation, confirm component and receipt.
    - S12P-07 (Files line comments), S11-15 (Browser note pages) and S07-06 (plan-comment chip and unsaved plan-comment editor) keep their next-message state in S10-11's draft store and use its element revisions and submissions. None of them adds a second in-flight mark.
    - The thread overview owner must accept the "Commit…" row change.
    - `chat/DiffViewer.tsx` (no callers) belongs to S06 (the approval dock preview).
    - F-05 deletes `ScopeProgress` (12b ledger).
