# 10 Review panel: codebase interview (2026-10-07)

Read-only investigation before designing section 10. Three explorers (views and data, actions, file rail and shell), synthesized and spot-checked. Paths are under `apps/web/src` unless noted.

## Overview

Review is a right-panel tab (`id: "changes"`, label "Review", `mod+d`) that shows one comparison at a time through `@pierre/diffs` `CodeView`. It is a viewer. The only write paths are: a composer prefill asking the agent to commit and push, `github.createPr` (push + `gh pr create` + link), local line comments that ride the next message, an opt-in AI summary for All turns, copy path, and open in editor. There is no stage, unstage, discard, revert, direct commit, viewed state, or suggestion anywhere in UI or server.

## Key concepts

- **Comparison**: one settled object (files + stat) keyed by `scope:view:operand` (`DiffPanel.tsx:517-537`). Stale results never show under a new identity.
- **Views** (`lib/review-views.ts:55-63`): Unstaged (index to worktree), Staged (HEAD to index), Commit (sha~1 to sha, needs a pick), Branch (three-dot, ref pair), Last turn, Turn (needs a pick), All turns (code name `cumulative`). Git views hidden when the project is not a git repo; turn views exist only with a thread. Threadless + no git = no views at all.
- **Default view** (ADR-0011): threadless Unstaged; thread with turn changes Last turn; dirty tree Unstaged; else Branch. Re-evaluated live until the user picks; a pick is sticky per thread, in memory only.
- **Turn evidence**: native or tracked patch from the provider, else a git fallback between snapshot tree refs (`fidelity: same-file-changes-possible`). Badges: "Agent changes", "Tracked file evidence", "Git fallback: same-file edits may appear". Turn diffs include only agent-attributed paths.
- **ReviewFileChange**: `{path, previousPath, changeType: added|modified|deleted|renamed|copied, binary}`. No per-file +/- in the contract.

## How it works (what a design must cover)

Opening
- From the end-of-turn changes bar: View diff pins the Turn view to that turn (falls back to All turns); a file row also jumps to the file. The bar lists at most 5 files.
- From the overview Changes row: runs `changes.toggle`, so it can hide the panel if Review is already active; does not pick a view.
- Rail tab or `mod+d` (dead while any input is focused). Toggle semantics: second press hides.
- Rail badge = distinct files across all turn snapshots, "99+" cap, plus a "fresh" pulse while Review is inactive (session only).

Toolbar today
- View dropdown with file-count pill; total +/-; operand pickers: TurnPicker ("Turns with changes", ordinals count only change-bearing turns, newest first, `N files · +A −D`), CommitPicker (100 per page, "Load older commits", search sha/message), BranchRefPicker (current branch chip → one combobox with Worktrees / Local / Remotes, middle-truncated refs).
- Controls portaled from FileList: options menu (Refresh, word wrap per thread, Expand/Collapse all, global), Files toggle, Jump to file popover (flat list), unified/split (global).
- ReviewActions only for named worktree threads: "Commit or push" (prefills the composer and overwrites any draft; always enabled) and "Create PR" / "PR #n" (disabled with "No commits ahead of base branch"; PR state not shown).

Diff body
- Files expanded by default in git views and Last turn/Turn; All turns starts collapsed (`CumulativeView` omits `defaultFilesExpanded`).
- Per-file patch is lazy (expanded files only). Failure or empty becomes "No diff content"; binary "Binary file changed" (native turn diffs never mark binary).
- Context bands expand only for git sources; turn and All turns diffs stay partial.
- File header: chevron, Diff/Preview for markdown, Copy file path, Open in editor (desktop only; editor list with `:line`, Reveal in file manager).
- Line comments: gutter "+", single line, stored in memory per thread, attached to the next message as an annotation bundle and cleared on send. No resolve, no re-anchor, lost on reload. Mentions typed in the editor are dropped; editor allows 100,000 chars but the payload caps at 4,000 (fails at send).

File rail
- Docked only, needs the Review body ≥ 800px (280 + 520). Default panel is 440, wide snap 680, so the rail never shows at default sizes; the toggle stays pressed with no explanation. Visibility persists per scope in localStorage.
- Tree: folders first, numeric-aware sort, single-child chains compacted, all expanded, keyboard tree (arrows, Home, End, Enter, Space), virtualized over 30 rows. Rows: icon, basename, A/M/D/R/C glyph, Binary badge. No counts, no comment marks, no viewed state.
- Active file is set only by clicking the rail; it does not follow scroll, popover jumps, changes-bar jumps or comment jumps. Rail order (tree) differs from diff order (flat path sort).

States today
- Loading: three-dot pulse; rail "Loading files"; stat spinner; per-file pulse; refreshing spinner.
- Empty: "No changes" (Unstaged, Staged, Branch), "No commit yet", "No changes yet" (turn views), rail "No changed files" / "No matching files". Empty views lose the toolbar refresh control (it is portaled from the file list).
- Error: none. Comparison failures, the 10,000-file cap, unsafe refs, a removed worktree and git timeouts all render as the empty state.
- Stale: All turns shows "New changes available · Refresh to review the new files." instead of auto-refreshing. Live Last turn evidence flashes to loading on each revision bump.
- Disabled views: Commit (no commits ahead of origin default) and Branch (unborn or no comparison) are dimmed with no reason. A clean thread defaults to Branch even when Branch is unavailable.

## Where things live

- Panel shell: `components/panels/RightPanel.tsx`, `ActivityRail.tsx`, `lib/panel-tabs.ts`, `lib/summon-tab.ts`, `lib/right-panel-layout.ts`.
- Review: `components/diff/` (`DiffPanel`, `DiffToolbar`, `FileList`, `ReviewDiffView`, `FileActionBar`, `FileEditorPicker`, `DiffCommentEditor`, `ReviewActions`, `GitDiffView`, `LastTurnView`, `CumulativeView`, `SummaryView`, pickers, `WorktreeFilesPane`).
- State: `stores/diffStore.ts`, `features/preview/state/previewAnnotationStore.ts`.
- Shared with PR detail: `components/files/FilesPanel.tsx`, `features/pull-requests/surfaces/PullRequestFileTree.tsx`, `change-type.ts`, `HunkSeparator`, `DiffStat`. PR detail uses its own virtual grid, not Pierre, floats its file rail below 800px, shows per-file counts and patch-status badges, and has `j`/`k`/`c` keys.
- Server: `apps/server/src/features/projects/git/` (comparison, read-only git), `projects/diffs/` (snapshots, summary), `agents/turns/` (turn diff evidence), `pull-requests/` (createPr, PR draft).

## Gotchas

- Unstaged is plain `git diff`: untracked files and staged-only changes never appear there, and the dirty probe misses them.
- Snapshot tree objects are not pinned; after `git gc` an old turn may lose its diff (inferred, not verified). Snapshots are deleted after 30 days.
- `renderMode`, `viewMode`, bulk expand, file count and stat are global, not per thread. Nothing except Files visibility survives a restart.
- Dead code: `TurnEntry`, `TurnTimeline`, `CommitsView`, `CommitEntry` are unmounted; subagent review scope has no production caller and its label is never shown; `git.push` has no UI caller.
- Branch range: `getBranchRange` swaps the store's base and target before sending; check against ADR-0007 before designing the operand copy.
- Files tab ("Soon") and the in-Review Files rail share the name "Files".

## Design inputs for section 10 (already decided in 08c, keep)

Two-row header (view picker + stat with round expand/toggle; row 2 operand left, round view controls right), floating Commit bottom-right, Pierre anatomy, files popup below 800 or docked at 800+ (pending pick), separator bands full width, Review rail icon Lucide Diff.
