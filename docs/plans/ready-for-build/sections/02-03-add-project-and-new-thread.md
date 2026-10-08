# 02–03 · Add project and New thread: build brief

The user adds a project from one palette (sources, then a folder browser with an exact "ready to add" state), then lands on a composer-first new-thread screen: a heading with the project as an amber slot, a 760-wide composer, and the thread overview card open beside it. The overview card holds the workspace mode (New worktree, Existing worktree, Local) and the start branch before the first send. The branch picker pages through every branch and pull request with a real total and a real error, and can start a new worktree from the latest `origin` without touching local branches.

Surfaces: web (`apps/web`) and Electron (`apps/desktop`, native folder dialog only), contracts (`packages/contracts`), server git and GitHub services (`apps/server`). This section also owns the overview card shell and its row registry; other sections register rows into it.

## Boards

Page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0

| Board | Node | Shows |
|---|---|---|
| 02a · Add project · Palette · Sources · Dark | `2B65-2` | Palette (600 wide, top 80, centred, no-blur backdrop `color-mix(--color-page 60%)`), search "Search sources, or type ~/ to browse", "Sources" label, rows Local folder / New project / Git URL / GitHub repository ("Not connected" meta), footer hints ↑↓ Navigate, Enter Select, Esc Close |
| 02b · Choose project · Anchored popover · Empty · Dark | `2B1Q-2` | Chooser (300 wide) anchored under the heading slot: glyph tile, "No projects yet", "Add a folder to start working in its code.", divider, row "Add project · Folder, Git, GitHub ›" |
| 02c · Add project · Palette · Browse ~/ · Dark | `2BBK-2` | Path row (back arrow, mono `~/`, Add chip "Add Ctrl Enter" disabled at `~`), "Folders" label, folder rows (chevron on the highlighted row), footer Navigate / Enter Open / Alt+↑ Parent / Esc Close + "Open in File Explorer" |
| 02d · Add project · Palette · Ready to add · Dark | `2BH5-2` | Exact folder `~/src/mcode/`, Add chip enabled, label "Folders in mcode" |
| 03 · New thread · Dark | `1ZHP-2` | Breadcrumb "mcode / New thread", heading "What should we build in **mcode**?" (32/40 600, slot amber with 2px dashed amber underline), attached rail (652 wide) with "New worktree ⌄" and "main ⌄", composer 760, "Start a chat without a project instead." |
| 03b · New thread · Branch picker · Dark | `2AUM-2` (picker `2B04-2`) | Picker 320 wide under the rail trigger: search, Branches \| Pull requests, flat mono rows with "current" / "worktree" meta and a check lane, 5 rows visible with fades, "Showing 50 of 568", footer "Start from origin" switch |
| 03b · Branch picker · States · Dark | `2BP1-2` | PR tab ("Showing 30 of 42", no footer), scrolled ("Showing 100 of 568", top fade), origin on, search with "Pull requests" group, no match (`Nothing matches "sidebar-v2"`), list failed ("Couldn't list branches", mono git error, Retry, no footer) |
| 03c · New thread · Overview open · Dark | `1ZN7-2` (card `1ZS8-2`) | Card 280 wide at top 56 / right 16; header "Overview" + ⋯ + sliders; rows "New worktree · Create ⌄", "From **main** ⌄"; divider; Usage. Canvas padding-right 328; rail gone; header overview button on (ink icon) |
| 03d · New thread · Overview · Workspace menu · Dark | `20F4-2` (menu `20LL-2`) | Menu 288 wide opening to the left of the card (right 304, top 120): label "Workspace", New worktree (check), Existing worktree, Local with mono meta "mcode"; trigger row gets `--color-hover` fill |
| 03e · New thread · Overview · Branch picker · Dark | `20M5-2` (anchor `20SM-2`) | The 03b picker opening to the left of the card (right 304, top 156), branch row filled |

Related boards owned elsewhere: `01 · Empty workspace · Dark` (`1ZDG-2`, section 01), `04a`–`04g` (section 04: first-send motion, startup steps including "Fetching origin/main"), `12j` (`258G-2`, full overview with all sections, used here only to fix the section order).

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md`. Do not reopen.

- 02 Add project is four boards: sources palette, choose-project popover, browse `~/`, ready to add.
- 03 is variant A, "composer is the screen". The heading's project name is an amber selectable slot, the same slot as 01.
- Composer is 760 wide everywhere and never resizes; new-thread start columns were widened so first send is a translateY only (2026-10-07). The motion itself is section 04 (04g).
- 03b picker (2026-10-07): Branches | Pull requests segmented, flat list, PR matches grouped under branch search, silent infinite scroll with "Showing x of y", scroll fades, 5 visible rows, no row icons, counts or captions. Build notes: PR list is capped at 30 server-side (`gh --limit 30`); paging is new for both tabs; "Start from origin" is new (`git.fetchBranch` refuses a checked-out main); the server returns `[]` on git failure and needs a real error; the trigger reads "On main" in Direct mode.
- 03c/03d/03e approved 2026-10-07: the overview hosts the target on a new thread. Workspace row is a selector (New worktree "Create" / Existing worktree / Local "mcode"); the copy button became a chevron. Branch row reads "From main" / "From origin/main" and opens the 03b picker. Composer rail removed on 03c–e. Opening a new thread always reopens the overview (option B), so the selectors are visible before first send. Overview menus open to the side (left of the card, top-aligned to the trigger row), never below it. Existing worktree has no submenu: choosing it switches mode and the worktree is picked in the branch row.
- Overview width 280 (was 320), canvas padding-right 328. Open by default under the header (top 56, right 16). Header overview button: selected fill and ink icon when open, muted when closed. The overview only lists what exists at that moment.
- The mode/branch rail above the composer disappears after first send; mode, branch and tasks live in the overview.
- Right panel open: the overview card closes (implementation notes, Plan mode list).
- Section 04 shows a fetch step when Start from origin is on.
- Truncation is a 24px right-edge fade (F-02), never an ellipsis. Menus are names-only (F-04). UI copy is dev-terse.
- ADR-0015 (proposed): New worktree creates a branchless worktree from the selected base branch; upfront branch-naming controls go away.

Drift to note, not chase: on `03`/`03b` the closed overview button carries `--color-selected` fill with a muted icon (`2AZL-2`), while F-03 says ghost at rest. Follow F-03.

## How it works today

Paths are under `apps/web/src` unless they start with `apps/`, `packages/` or `docs/`.

### Add project

- One palette handles commands, projects and folders. Browse mode is not a view; it switches on when the query looks like a path (`~/`, `/`, `./`, drive letters) (`components/palette/CommandPalette.logic.ts:102-142`). There is no Sources view.
- Every "add project" entry opens the palette with the query pre-seeded to `~/` (`stores/commandPaletteStore.ts:75-77`): the `workspace.new` command (`app/App.tsx:734-744`) and the chooser's footer "New project" button (`components/chat/NewThreadProjectPicker.tsx:36-41`).
- `BrowseView` (`components/palette/views/BrowseView.tsx`) calls `filesystem.browse` (`:144`), filters to folders client-side and hides dot folders unless the filter starts with `.` (`CommandPalette.logic.ts:219-230`). Enter descends, Alt+↑ ascends, Cmd/Ctrl+Enter adds an exact directory (`BrowseView.tsx:47-57`, footer `:556-578`). The add button is a 132px primary button inside the input row (`CommandPalette.tsx:193-221`). The backdrop blurs (`CommandPalette.tsx:106`).
- The home guard is client-only and literal: adding is refused only when the query is exactly `~`, `~/` or `~\` (`BrowseView.tsx:214-224`). Typing the absolute home path (`C:\Users\me\`) passes (verified by reading).
- Add calls `workspace.create { name, path }` (`packages/contracts/src/ws/methods.ts:668-671`) and on any failure shows "Could not add this folder. Try again." (`BrowseView.tsx:275`); the server's reason is dropped.
- `WorkspaceService.create` returns the existing workspace for a registered path, evicts a soft-deleted one, detects git, and inserts (`apps/server/src/features/projects/lifecycle/workspace-service.ts:38-56`). It does not check that the path exists or is a directory (verified by reading; `detectGitRepo` just falls back to `false`, `:128-141`). The contract has no length bounds.
- `filesystem.browse` resolves `~`, walks up to the nearest existing ancestor, returns at most 500 entries, and lists Windows drives for `/` (`apps/server/src/features/projects/lifecycle/filesystem-browser.ts:54-147`). Keep it.
- A native folder dialog exists end to end but nothing in the web app calls it: `ipcMain.handle("show-open-dialog")` (`apps/desktop/src/main/main.ts:353-364`), bridge `showOpenDialog` (`apps/desktop/src/main/preload.ts:61`, `transport/desktop-bridge.d.ts:488`).
- No clone, `git init` or GitHub repository listing RPC exists (`rg "clone|git init|gh repo" apps/server/src` finds none). GitHub sign-in state is available through `pullRequest.capabilities` (`ok: false, error.code: "unauthenticated"`, `packages/contracts/src/pull-requests.ts:262-271`).

### New-thread surface

- A new thread has no `Thread` record. `beginNewThread` clears the active thread, sets `pendingNewThread`, resets the target to the remembered mode, and hides the right panel (`features/projects/state/workspaceStore.ts:1770-1777`, `:1812-1831`). Unsent drafts persist their target in `ThreadDraftTarget` (`stores/threadDraftStore.ts:25-34`).
- `NewThreadSurface` renders `NewThreadWelcome` (logo, heading with an inline project picker styled as a link, a grid of six starter prompts) and the composer below it (`features/conversation/messages/chat-view/ChatViewSurface.tsx:39`, `:147-190`). There is no canvas header and no overview on a new thread: `HeaderActions` (and so `ThreadOverview`) mounts only for an existing thread (`ChatViewSurface.tsx:341`).
- The composer rail is `ComposerNewThreadContext`: a 40px strip with a project pill plus "Clear project" X, `ModeSelector` ("Local" / "New worktree" / "Existing worktree"), and `ComposerTargetSelection` (`features/conversation/composer/execution/ComposerNewThreadContext.tsx:36-100`). Not a git repo: modes collapse to a static "Local" label (`:31-34`, `:78-86`).
- The composer column is `PRIMARY_CONTENT_RAIL_CLASS = "mx-auto w-full max-w-[96rem]"` (`lib/layout-rails.ts:2`, used at `features/conversation/composer/Composer.tsx:639`), not 760.
- "Start a chat without a project" does not exist; threads always belong to a workspace (CONTEXT.md "Workspace").

### Composer modes and target state

- Modes are `"direct" | "worktree" | "existing-worktree"` (`components/chat/ModeSelector.tsx:12-33`); the last choice is remembered globally in localStorage (`lib/composer-mode-preference.ts`).
- Target state is global on `workspaceStore`: `newThreadMode`, `newThreadBranch`, `newThreadBranchSource`, `newThreadPullRequestNumber`, `selectedWorktree`, plus list caches `branches`, `openPrs`, `worktrees` (`workspaceStore.ts:575-587`, actions `:1857-1945`).
- Send builds the target in `newThreadCreationTarget` (`workspaceStore.ts:367-387`). PRs force `worktreeBranchMode: "named"`; otherwise New worktree is branchless (ADR-0015). Existing worktree with nothing chosen throws "No worktree selected" at send (`:386`).
- Hard-coded `"main"` fallbacks, wrong for `master`/`trunk` repos: `useComposerTargetSelection.ts:119`, `workspaceStore.ts:376`, `:381`, server default `branch = "main"` (`apps/server/src/features/agents/turns/thread-creation-coordinator.ts:210`).
- Direct mode with a different branch shows a checkout confirmation, then `git.checkout` before dispatch (`features/conversation/composer/submission/useComposerSubmissionController.ts:325-366`). Keep.
- Dead ADR-0015 leftovers: `customBranchName`, `autoPreviewBranch`, `branchCustomName`, `branchAutoPreview`, `setCustomBranchName`, `regenerateAutoPreview`, `setBranchCustomName` have no reader in the send path (`workspaceStore.ts:582-583`, `:703-729`, `:1091-1103`); `ThreadDraftTarget` still stores two of them.

### Branch picker

- `BranchPicker` (`components/chat/BranchPicker.tsx`): popover above the trigger (`side="top"`, 280 wide, `:258`), tabs Local / Remote / PRs with count badges (`:222-226`), client-side substring search over everything loaded, spinner while loading. The trigger always reads "From {branch}" (`:253`), including Direct mode.
- The PR tab is only offered in New worktree mode (`features/conversation/composer/execution/ComposerTargetSelection.tsx:32-47`) and disappears entirely when the list is empty (`BranchPicker.tsx:214`), so a `gh` failure hides the tab with no reason (verified by reading).
- Existing worktree mode shows a separate `WorktreePicker` (lazy, `ComposerTargetSelection.tsx:50-73`, `components/chat/WorktreePicker.tsx`), plus a base-branch `BranchPicker` for detached worktrees.
- The same components serve the inline fork composer (`ComposerStatusStrip.tsx:21-81`, shown only while `branchFromMessageId` is set, `Composer.tsx:632`).
- Server: `git.listBranches` returns a full unpaged array; `listBranchesAt` swallows every git error into `[]` (`apps/server/src/features/projects/git/git-repository-service.ts:312-327`). `github.listOpenPrs` runs `gh pr list --limit 30` and resolves `[]` on any error (`apps/server/src/features/pull-requests/github/github-service.ts:237-260`).
- `branch.changed` pushes reload the whole list and auto-select the new current branch unless the user picked one (`transport/ws-events.ts:511-523`).
- Hidden coupling: the overview PR row's title comes from the picker's cached `openPrs` (`hooks/useThreadGitActions.ts:46-49`, `components/chat/ThreadOverview.tsx:1698-1705`), so a thread's PR title only shows if that PR is in the first 30 loaded for the new-thread picker. `github.branchPr` returns no title (`gh pr view --json number,url,state`, `github-service.ts:201`; `packages/contracts/src/github.ts:4-11`).
- Dead: `workspaceStore.fetchBranch` and the `fetchingBranch` spinner have no caller (`workspaceStore.ts:1936-1945`); the `git.fetchBranch` RPC is reachable only from that dead action. PR heads are fetched server-side at thread creation (`thread-creation-coordinator.ts:283-286`).

### Start from origin

- Not present. `fetchBranchAt` fetches into `FETCH_HEAD`, then moves the local branch with a non-forced refspec `${source}:${localRef}` (`git-repository-service.ts:221-283`). Git refuses that refspec for a branch checked out in any worktree; the real-git test "rejects a behind branch checked out in the current worktree" pins it (`apps/server/src/features/projects/git/__tests__/git-repository-fetch.test.ts:256-269`). So "update main, then branch from it" fails in the common case where `main` is checked out in the project folder.
- Branchless worktrees are created with `git worktree add --detach <path> <branch>` (`apps/server/src/features/projects/git/git-worktree-service.ts:349-350`).
- Startup phases are `thread | worktree | setup | agent`, a static list per kind (`packages/contracts/src/thread-startup.ts:20-25`, `:107-111`). `ThreadStartupBlock` already carries `retry` / `continue` actions (`:96-102`).

### Thread overview

- `ThreadOverview` is one 2,954-line file (`components/chat/ThreadOverview.tsx`). It renders a Base UI `Popover` anchored to the header trigger, `w-80` (320) (`:2903-2928`), with the whole body in one `renderOverviewBody` function (`:2551-2899`): masthead (project actions ⋯ + settings), setup error and attempt card, save recovery, Changes, repository link, Plans, Local mode menu, Create branch, branch menu, disabled Commit, Usage bars, Subagents, PR row, Browser, Sources, Recap.
- Open state: `open = openRequested || (choice ?? (hasRoom || panelVisible))` (`:2154`). It opens when the right panel is visible, the opposite of the new rule. The choice resets on thread switch (`:2143-2174`). Outside press and focus-out are ignored (`:2165-2170`).
- Layout: `overviewStore.reserveThreadId` (`stores/overviewStore.ts`) tells the chat view to add right padding `clamp(0px, calc(1536px + 688px - 100%), 344px)` (`lib/composer-layout.ts:74-121`, consumed at `features/conversation/messages/chat-view/useChatViewState.ts:111`, `:169`).
- Trigger: `Settings2` icon button `size="icon-xs"`, `bg-muted` when open, CI dot (`ThreadOverview.tsx:330-361`).
- Side menus already open left (`side="left" sideOffset={12}`, `:2713-2720`, `:2774-2787`), anchored to the row, not the card edge.
- Callers that open it remotely: `requestOpen` from the PR fork and review-task dialogs (`features/pull-requests/surfaces/PullRequestForkDialog.tsx:397`, `PullRequestReviewTaskDialog.tsx:163`).
- Usage comes from the thread record (`usageByProvider[thread.provider]`, `ThreadOverview.tsx:2359-2361`), so it cannot render for a new thread today.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Sources palette (02a) | No Sources view; add-project seeds `~/` | Sources view in the palette; `addProject` intent opens it; `~/` still browses | web |
| Palette chrome | Blurred black backdrop, 576/680 widths, big Add button | 600 wide, top 80, `color-mix(--color-page 60%)` backdrop, no blur, footer hints | web |
| New project, Git URL, GitHub sources | Nothing | Deferred to the design backlog: no flow boards, not built in this program (S02-04) | none |
| Browse (02c/02d) | Works, different chrome; generic add error; literal home guard | Path row with back to Sources, Add chip, "Folders in {name}", typed add errors, server-side home/root refusal | contracts, server, web |
| "Open in File Explorer" | Bridge exists, unused | Native folder dialog, adds the chosen folder (Q3) | web, desktop |
| Project chooser (02b) | `NewThreadProjectPicker` 256 wide, "New project" footer | Anchored chooser with empty state and "Add project · Folder, Git, GitHub" row | web |
| Heading with amber slot, composer 760 | Welcome with logo and starters; 96rem column | Start column: heading + slot, rail, composer 760, below line | web |
| Rail (03) | 40px strip with project pill, Clear X, `ModeSelector`, pickers | 652 rail with workspace menu + branch picker; hidden when the overview card is shown and after first send | web |
| Workspace menu (03d) | `ModeSelector` dropdown | Names-only menu, label "Workspace", check, folder meta | web |
| Branch picker (03b) | 3 tabs with counts, client filter, 30 PR cap, `[]` errors | F-04 picker, 2 segments, server search, paging with totals, typed errors, Retry, over the one qualified-ref listing that Review also uses | contracts, server, web |
| Existing worktree choice | Separate `WorktreePicker` | Worktree-scoped list inside the branch picker | contracts, server, web |
| Start from origin | Nothing | Picker footer switch; New worktree starts from `origin/<branch>` without moving local refs; startup `fetch` phase | contracts, server, web |
| Overview card shell | 320 popover anchored to the trigger | 280 card docked at top 56 / right 16, padding-right 328, registry of rows | web |
| Overview on a new thread (03c) | No header, no overview | Card with Workspace and Branch rows, open on every new thread | web |
| Overview menus to the side (03d/03e) | Anchored to the row with 12px offset | Anchored to the card's left edge, 8px gap, top-aligned to the row | web |
| Header overview button | `bg-muted` when open | F-03 round 32 button, on = selected fill + ink icon | web |
| Right panel interaction | Overview opens when the panel is visible | Card hides while the panel is visible; button shows it as an overlay | web |
| PR row title | From the picker's first 30 PRs | `PrInfo.title` from `github.branchPr` | contracts, server, web |

## Backend architecture

Two new seams: one **qualified-ref listing** shared with Review (S10-05), and a paged pull request list that uses the same result envelope. Plus a Start from origin flag on thread creation and typed registration errors. Everything else reuses existing services.

### A. Qualified ref listing (`git.refs.list`), shared with Review

S03-04 owns the one ref listing for every branch picker: the new-thread picker, Existing worktree mode, the inline fork strip, the overview branch menu, and Review's `compare → base` pickers (S10-05). Review adds no second listing. It lives in `GitRepositoryService` (`apps/server/src/features/projects/git/git-repository-service.ts`), routed in `git-rpc.ts`. Every ref keeps its full name, so `refs/heads/main` and `refs/remotes/origin/main` stay distinct refs. An explicit purpose decides which refs a caller gets; no caller filters the result afterwards.

```ts
// packages/contracts/src/git.ts
/** A checkout location shown on a ref row. */
export const TargetWorktreeSchema = lazySchema(() =>
  z.object({ path: z.string().min(1).max(4096), folder: z.string().min(1).max(255) }));

/** One qualified ref. A local branch and its origin twin are two refs with the same `branchName`. */
export const GitRefSchema = lazySchema(() => z.object({
  kind: z.literal("ref"),
  fullName: z.string().min(1).max(512),            // "refs/heads/main", "refs/remotes/origin/main"
  shortName: z.string().min(1).max(512),           // git's %(refname:short): "main", "origin/main"
  branchName: GitBranchNameSchema,                 // "main" for both twins
  remote: z.string().min(1).max(100).nullable(),   // null for refs/heads
  twin: z.string().min(1).max(512).nullable(),     // new-thread purpose only: the grouped same-name origin ref
  isCurrent: z.boolean(),                          // checked out in the context worktree
  isDefault: z.boolean(),                          // the origin/HEAD target, or its local twin
  worktree: TargetWorktreeSchema().nullable(),     // checked out in another linked worktree
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  committedAt: z.string().datetime(),
}).strict());

/** A linked worktree with a detached HEAD, listed for Existing worktree mode. */
export const DetachedWorktreeTargetSchema = lazySchema(() => z.object({
  kind: z.literal("detached-worktree"),
  worktree: TargetWorktreeSchema(),
  headShortSha: z.string().regex(/^[0-9a-f]{7,40}$/),
}).strict());

export const GitRefPurposeSchema = lazySchema(() => z.enum(["new-thread", "existing-worktree", "review"]));
export const GitRefSideSchema = lazySchema(() => z.enum(["local", "origin"]));

/** Shared result envelope for paged picker lists. */
export function pagedTargetResultSchema<T extends z.ZodTypeAny, E extends z.ZodTypeAny>(item: T, error: E) {
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      items: z.array(item).max(100),
      total: z.number().int().nonnegative(),   // matches for this purpose, side and query, all pages
      nextCursor: z.string().min(1).max(512).nullable(),
    }),
    z.object({ ok: z.literal(false), error }),
  ]);
}

export const GitListErrorSchema = lazySchema(() => z.object({
  code: z.enum(["not_a_repository", "git_failed", "timed_out"]),
  message: z.string().min(1).max(512),
  detail: z.string().max(2000).optional(),  // first stderr line, e.g. "fatal: bad object refs/heads/main"
}));

// packages/contracts/src/ws/methods.ts
"git.refs.list": {
  params: z.object({
    workspaceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256).optional(), // context worktree: this thread's worktree, else the project folder
    purpose: GitRefPurposeSchema(),
    side: GitRefSideSchema().optional(),             // required for purpose "review", rejected otherwise (invalid_input)
    query: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  result: pagedTargetResultSchema(
    z.discriminatedUnion("kind", [GitRefSchema(), DetachedWorktreeTargetSchema()]),
    GitListErrorSchema(),
  ),
},
```

Purpose and side filter, applied before paging, so `total` and every page match what the caller shows:

| Purpose | Side | Callers | Returns |
|---|---|---|---|
| `new-thread` | none | New-thread picker Branches tab (New worktree, Local), inline fork strip, overview branch menu | Local branches, plus remote-tracking refs with no same-name local branch (`*/HEAD` symrefs dropped). When both twins exist they are grouped for display into one row: the local ref, with the origin ref's full name in `twin`, which Start from origin targets (section C). |
| `existing-worktree` | none | Existing worktree mode | Branches checked out in linked worktrees, plus detached worktrees |
| `review` | `local` | Review's compare and base pickers, Local tab (S10-05) | Every `refs/heads/*` ref, linked-worktree branches marked through `worktree` |
| `review` | `origin` | Review's compare and base pickers, Origin tab (S10-05) | Every `refs/remotes/*` ref except `*/HEAD` symrefs. Twins of local branches are never dropped; each is its own row and its own selection. |

Behavior:

- One `git for-each-ref --format=…%(HEAD)…%(worktreepath)…%(objectname)…%(committerdate:iso-strict) refs/heads refs/remotes` in the context worktree, plus `git worktree list --porcelain` for detached worktrees. Both are cheap enough to re-run per page (568 refs in the board); the cursor is an opaque offset. No caching.
- Context: with `threadId`, the thread's worktree (via `resolveWorkingDir(workspaceId, threadId)`, and the thread must belong to the workspace); without it, the project folder. `isCurrent` is `%(HEAD) == "*"` in that worktree. `worktree` is set when another linked worktree has the branch checked out (today's `type: "worktree"` conflates the project folder and linked worktrees, `git-repository-service.ts:397-400`).
- One sort for every purpose: the default branch first (`origin/HEAD` target, or its local twin), then the branch checked out in the context worktree, then committer date descending, then `fullName` ascending so pages are stable. Under `new-thread`, local refs come before remote-only refs after those first two. In the common case both lead rows are `main`, which matches the board order (inferred from `2B0F-2`).
- `query` is a case-insensitive substring match on `shortName` (and the worktree folder), applied before paging; `total` counts matches. Review's empty-tab hint ("No local matches · 3 in Origin") reads the other side's `total` from one more call with the same query and `limit: 1`.
- Labels are the client's: Review shows `branchName` for `origin` refs and `shortName` for other remotes. The selection value is always `fullName`.
- Errors: non-git project → `not_a_repository` (replaces the silent `[]` in `git-rpc.ts:72-75`); git exit ≠ 0 → `git_failed` with the first stderr line as `detail`; executor timeout → `timed_out`. Never `[]` on failure.
- Idempotent read; safe to retry.

### B. Paged pull request targets (`github.pullRequestTargets.list`)

Lives in `GithubPullRequestClient` (`apps/server/src/features/pull-requests/github/github-pull-request-client.ts:1916`), which already runs `gh api graphql` through its runner and maps failures to `GithubPullRequestClientError` (`:823`). A thin `GithubService` method resolves the workspace to `owner/name` from the `origin` remote (reuse `GitRepositoryService.getRemoteUrl` normalization).

```ts
// packages/contracts/src/github.ts
export const PullRequestTargetSchema = lazySchema(() => z.object({
  number: z.number().int().positive(),
  title: z.string().max(512),
  headRefName: z.string().min(1).max(255),
  author: z.string().max(100).nullable(),
  isCrossRepository: z.boolean(),
  url: z.string().url().max(2048),
}));

"github.pullRequestTargets.list": {
  params: z.object({
    workspaceId: z.string().min(1).max(256),
    query: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),   // GraphQL endCursor
    limit: z.number().int().min(1).max(50).default(30),
  }),
  result: pagedTargetResultSchema(PullRequestTargetSchema(), PullRequestErrorSchema()),
},
```

- No query: `repository(owner, name) { pullRequests(states: OPEN, first, after, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount pageInfo nodes { … } } }`. `total = totalCount`.
- Query: `search(query: "repo:O/N is:pr is:open <q>", type: ISSUE, first, after) { issueCount … }`; when `q` is `#?\d+`, also fetch that number and put it first. `total = issueCount`.
- Errors reuse `PullRequestErrorSchema` (`packages/contracts/src/pull-requests.ts:332`): `unauthenticated`, `rate_limited` (with `resetAt`), `remote_unavailable` (gh missing, network), `stale_cursor`, plus one new code `remote_not_github` added to `PullRequestErrorCodeSchema` for a project whose `origin` is not a GitHub repository.
- `PrInfoSchema` gains `title` and `getBranchPr` requests it (`github-service.ts:201`), so the overview PR row stops reading the picker cache.

### C. Start from origin

Decision proposed here (Q2 confirms): Start from origin applies to **New worktree** only. It never moves a local branch, so a checked-out `main` is never a problem. Local and Existing worktree run on a checkout the user already has; updating that checkout stays the user's git workflow.

```ts
// CreateAndSendSchema (packages/contracts/src/ws/methods.ts:356)
startFromOrigin: z.boolean().optional(),
// refine: startFromOrigin requires mode "worktree", no pullRequestNumber, no existingWorktreePath → invalid_input
// refine: branch is required when mode is "worktree" (drops the server "main" default for worktrees)

// packages/contracts/src/thread-startup.ts
ThreadStartupPhaseSchema = z.enum(["thread", "fetch", "worktree", "setup", "agent"]);
// phases become a function of kind and options:
// managed-worktree + startFromOrigin → thread, fetch, worktree, setup, agent
```

Server flow in `ThreadCreationCoordinator.create` (`thread-creation-coordinator.ts:282-296`):

1. Advance the startup to `fetch`.
2. `GitRepositoryService.fetchOriginTrackingBranch(repoPath, branch)`: `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`. This writes only the remote-tracking ref; it never touches `refs/heads/*`. Returns the fetched sha.
3. `GitWorktreeService.createWorktree(..., { branchless: true, startPoint: "refs/remotes/origin/<branch>" })`. `createWorktreeArgs` (`git-worktree-service.ts:348-355`) uses `startPoint ?? branch` as the commit-ish for `--detach`.
4. The thread's `base_branch` stays `<branch>` (not `origin/<branch>`), so Create PR's `--base` and Review's upstream-first comparison (ADR-0007) keep working.

Failures become a `ThreadStartupBlock` on the `fetch` phase: `{ code: "start_from_origin_failed", message, actions: ["retry", "continue"] }`. Codes in the message detail: no `origin` remote, branch missing on origin, network/auth failure, timeout. `continue` starts from the local branch instead. Retry is idempotent (`+` refspec overwrites only the tracking ref). Cancel during fetch uses the existing `cancelIfRequested` path.

Start from origin on a grouped row starts from its `twin`, the origin ref of the same name. A remote-only target (`remote: "origin"`) always starts from origin: the client sends `startFromOrigin: true` and the switch shows on and disabled (inferred; no board).

Section 04 renders the `fetch` step ("Fetching origin/main", 04f) and the block actions.

### D. Project registration

`workspace.create` gets bounds and typed failures. The only callers are the palette (`BrowseView.tsx:271` through `workspaceStore.ts:1117-1120`) and the desktop reliability script (`apps/desktop/scripts/desktop-packaging/package-validation/desktop-reliability-test.mjs:119`); update both in the same ticket.

```ts
"workspace.create": {
  params: z.object({
    path: z.string().trim().min(1).max(4096),
    name: z.string().trim().min(1).max(120).optional(),   // server derives the folder name when absent
  }),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), workspace: WorkspaceSchema(), reused: z.boolean() }),
    z.object({ ok: z.literal(false), error: z.object({
      code: z.enum(["path_not_absolute", "path_not_found", "not_a_directory", "too_broad", "permission_denied"]),
      message: z.string().min(1).max(512),
    }) }),
  ]),
},
```

- Server validates before insert: absolute, exists (`stat`), directory, readable. `too_broad` refuses the home directory and filesystem or drive roots after `realpath`, closing the literal-only client guard.
- Canonicalize with `realpath` before `findByPath`, so `C:\src\mcode` and `C:\src\mcode\` cannot become two projects (inferred risk on Windows; add a test).
- `reused: true` when the path was already a project; the palette then just opens it.

### E. Clone and create sources (design backlog, not in this program)

Kept as a starting sketch for the design backlog; S02-04 is deferred and nothing here is built in this program. A later design could use `workspace.createRepository { parentPath, name }` (mkdir + `git init`, typed errors `already_exists`, `permission_denied`), and `workspace.clone { url | githubRepository, parentPath }` as a long-running operation with progress events (`clone.progress`), cancellation, and the same typed registration result. GitHub repository listing would reuse `GithubPullRequestClient`'s runner (`viewer { repositories(first, after, affiliations) }`) with `PullRequestErrorSchema`. "Not connected" reads `pullRequest.capabilities` (`ok: false`, `unauthenticated`).

### Per-provider decisions

| Provider | Decision |
|---|---|
| Claude | No change. Thread creation already receives mode, branch and worktree from the coordinator. |
| Codex | No change. |
| Cursor | No change. |
| Copilot | No change. |
| Devin (ACP) | No change. |
| OpenCode | No change. |

The only provider-shaped surface on these boards is the Usage block on a new thread (03c). It needs provider-scoped usage for the composer's selected provider instead of `usageByProvider[thread.provider]`. That belongs to the section that owns the Usage row (section 05, inferred); the registry below lets it declare `new-thread` support.

## Components

### New

Overview shell (`apps/web/src/features/thread-overview/`):

- `overview-subject.ts`: the subject the card describes.

  ```ts
  /** What the overview card is about: an unsent new thread or a durable thread. */
  export type OverviewSubject =
    | { readonly kind: "new-thread"; readonly workspaceId: string }
    | { readonly kind: "thread"; readonly thread: Thread };
  ```

- `overview-registry.ts`: the only file other sections edit to add rows.

  ```ts
  /** Card sections in board order (12j `258G-2`). Dividers sit between visible sections. */
  export type OverviewSectionId = "lane" | "activity" | "terminals" | "summary";

  /** One registered block of the overview card. */
  export interface OverviewEntry {
    readonly id: string;                       // test id: `overview-entry-${id}`
    readonly section: OverviewSectionId;
    readonly order: number;                    // ascending within the section; leave gaps of 10
    readonly subjects: readonly OverviewSubject["kind"][];
    /** Renders null when there is nothing to show ("lists only what exists"). */
    readonly Entry: ComponentType<{ subject: OverviewSubject }>;
  }

  /** Header icon buttons beside the "Overview" label (⋯ actions, settings). */
  export interface OverviewHeaderAction {
    readonly id: string;
    readonly order: number;
    readonly subjects: readonly OverviewSubject["kind"][];
    readonly Action: ComponentType<{ subject: OverviewSubject }>;
  }

  export const OVERVIEW_ENTRIES: readonly OverviewEntry[] = [/* sections append here */];
  export const OVERVIEW_HEADER_ACTIONS: readonly OverviewHeaderAction[] = [/* … */];
  ```

  A section hides itself, with its divider, when none of its entries rendered. Use CSS, not state: each entry root carries `data-overview-entry`; `.overview-section:not(:has([data-overview-entry])) { display: none }`, and the divider is drawn on `.overview-section:has([data-overview-entry]) ~ .overview-section:has([data-overview-entry])`. Recap and Usage share the `summary` section, so no divider separates them (12j). This keeps "only lists what exists" without a visibility protocol between rows and shell. Document the rule in `docs/internals/renderer/ui-components.md`.

- `OverviewCard.tsx`: the shell. 280 wide, padding 16, gap 20, `--radius-14`, `--color-panel`, 1px `--color-border` (`1ZS8-2`). Header row 32: "Overview" 14/20 500 muted, then registered header actions as F-03 buttons. Scrolls inside `max-height: calc(100% - 72px)` with a 40px bottom scroll fade (`25IS-2`).
- `OverviewRow.tsx`: the 32px row anatomy used by most entries: 16px icon lane, label 14/20 ink with F-02 fade, optional muted prefix ("From"), meta 12/16 muted, 16px chevron; open state `--color-hover` fill, `--radius-6` (`20KJ-2`).
- `OverviewSideMenu.tsx`: anchors any F-04 menu or picker to the card's left edge, 8px gap, top = trigger row top − 4 (`20LL-2` right 304 / top 120; `20SM-2` top 156). Built on F-07's side popover. Falls back below the row only when there is no room on the left.
- `OverviewToggleButton.tsx`: F-03 round button with the sliders icon; `aria-pressed`; CI dot unchanged.
- `useOverviewPresentation.ts` and a rewritten `stores/overviewStore.ts`:

  ```ts
  type OverviewPresentation = "docked" | "overlay" | "hidden";
  // subjectKey: `thread:${id}` | `new-thread:${workspaceId}`
  interface OverviewState {
    closedSubjects: ReadonlySet<string>;          // session memory, user closed it
    overlaySubject: string | null;                // transient overlay while docking is impossible
    toggle(subjectKey: string, dockable: boolean): void;
    reopen(subjectKey: string): void;             // called by beginNewThread and openThreadDraft (option B)
    requestOpen(threadId: string): void;          // kept for the PR fork and review-task dialogs
  }
  // docked  = !closed && !rightPanelVisible && canvasWidth >= OVERVIEW_DOCK_MIN_CANVAS (48 + 520 + 328 = 896)
  // overlay = user toggled it while docking is impossible; Esc or outside press closes it
  // hidden  = otherwise
  ```

  Constants live in `lib/composer-layout.ts`: `OVERVIEW_CARD_WIDTH = 280`, `OVERVIEW_CARD_TOP = 56`, `OVERVIEW_CARD_INSET = 16`, `OVERVIEW_CANVAS_RESERVE = 328`, `OVERVIEW_DOCK_MIN_CANVAS = 896`. The canvas gets `padding-right: 328px` only while docked.

New-thread target (`apps/web/src/features/conversation/composer/execution/`):

- `WorkspaceTargetMenu.tsx`: F-04 names-only menu, label "Workspace", rows New worktree / Existing worktree / Local with mono folder meta, check on the selected row (`20LL-2`). Not a git repo: only Local, rendered as a static row. Existing worktree is disabled when the project has no linked worktrees (inferred).
- `BranchTargetPicker.tsx`: composes F-04's picker. Segmented Branches | Pull requests only in New worktree mode; Local and Existing worktree show the Branches list without segments or footer (inferred from today's PR gating, `ComposerTargetSelection.tsx:32-47`). Rows: mono name 12/18 ink with F-02 fade, meta "current" / "worktree" 12/16 muted, 14px check lane; PR rows: title 13/18 ink, `#1804 · feat/sidebar-resize` mono 12/16 muted (`2BPH-2`). Branch search in New worktree mode shows branch matches, then a "Pull requests" group. Silent paging: request the next page when the list is within two rows of the end; "Showing {loaded} of {total}" when `total > loaded`; top fade appears once scrolled. Empty: `Nothing matches "{query}"`. Error: "Couldn't list branches" / "Couldn't list pull requests", mono detail, Retry; no footer while erroring (`2BW0-2`). Footer: "Start from origin" switch (New worktree, Branches tab only).
- `useBranchTargets.ts`, `usePullRequestTargets.ts`: paging hooks over `git.refs.list` (purpose `new-thread` or `existing-worktree`) and `github.pullRequestTargets.list`. Query debounce 150ms; results keyed by `workspaceId|threadId|purpose|query`; a `branch.changed` push invalidates the branch cache for that workspace instead of reloading a global list.
- `NewThreadTargetRail.tsx`: the 652-wide attached rail (`2AXW-2`): workspace trigger (152) and branch trigger. Renders only for a new thread while the overview card is not shown.
- `new-thread-target-copy.ts`: one function for trigger and row labels so rail and overview agree: New worktree "From main" / "From origin/main"; Local "On main"; Existing worktree "On {branch}" or the worktree folder for a detached worktree (inferred, Q4); PR selected "From #1804" (inferred, Q4).

Start column (`apps/web/src/features/conversation/messages/chat-view/`):

- `NewThreadStartColumn.tsx`: centred column `max-width: var(--container-reading)` (760), gap 24: heading, rail + composer, below-composer line.
- `ProjectSlotHeading.tsx`: "What should we build in {slot}?" 32/40 600 −0.02em; slot amber, 2px dashed amber underline, padding-bottom 2 (`1ZQB-2`); opens the chooser.

Add project (`apps/web/src/components/palette/`):

- `views/SourcesView.tsx`: "Sources" label and source rows (14px icon, 13/18 500 title, 12/16 muted subtitle, optional meta). Rows come from a data list so unbuilt sources are absent, not dead.
- `PaletteFooterHints.tsx`: keycaps 20 high, 11/14 500, `--radius 5`, `--color-selected` (`2BB5-2`), with a right-aligned optional link.
- `ProjectChooser.tsx` (`components/chat/` or `features/projects/`): the 02b popover, 300 wide, empty state and populated F-04 list, Add project row (meta lists built sources only).

Server:

- `GitRepositoryService.listRefsAt` (section A), `fetchOriginTrackingBranch`.
- `GithubPullRequestClient.listRepositoryOpenPullRequests` and `GithubService.listPullRequestTargets`.
- `WorkspaceService.create` validation.

### Changed

- `components/chat/ThreadOverview.tsx`: split into entry modules registered in `OVERVIEW_ENTRIES` (S03-01); the popover container goes (S03-02).
- `components/chat/HeaderActions.tsx`: takes an `OverviewSubject` so the new-thread surface can mount the toggle.
- `features/conversation/composer/ComposerStatusStrip.tsx` (inline fork): uses `WorkspaceTargetMenu` and `BranchTargetPicker` instead of `ModeSelector`, `BranchPicker`, `WorktreePicker`.
- `features/conversation/composer/execution/ComposerTargetSelection.tsx` and `useComposerTargetSelection.ts`: render the new picker; drop `variant`, `triggerClassName`, `iconSize`.
- `features/projects/state/workspaceStore.ts`: drops list caches and dead naming state; adds `newThreadStartFromOrigin`.
- `stores/threadDraftStore.ts`: `ThreadDraftTarget` adds `startFromOrigin`, drops `customBranchName` and `autoPreviewBranch`; the stored-draft validator accepts old drafts (missing field → `false`, extra fields ignored).
- `hooks/useThreadGitActions.ts`: PR title from `PrInfo.title`.
- `components/palette/CommandPalette.tsx`, `views/BrowseView.tsx`, `stores/commandPaletteStore.ts`: new chrome, Sources entry, Add chip, typed add errors.
- `lib/composer-layout.ts`: overview constants replaced.
- `CONTEXT.md` "Overview": a card under the header, open by default, present on a new thread (holds mode and branch), otherwise thread-scoped. Add a "Start from origin" entry under Composer.

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| `renderOverviewBody` monolith | `components/chat/ThreadOverview.tsx:2551-2899` | Entry modules in `OVERVIEW_ENTRIES` | S03-01 | `rg -n "renderOverviewBody" apps/web/src` returns nothing |
| Overview popover container, `ThreadOverviewTrigger`, `useThreadOverviewOpenState`, `SIDE_OVERVIEW_COLLISION_AVOIDANCE`, `getOverviewCollisionAvoidance` | `ThreadOverview.tsx:132-141`, `:330-361`, `:2143-2174`, `:2903-2928` | `OverviewCard`, `OverviewToggleButton`, `useOverviewPresentation` | S03-02 | `rg -n "ThreadOverviewTrigger\|useThreadOverviewOpenState\|SIDE_OVERVIEW_COLLISION" apps/web/src` returns nothing |
| `reserveThreadId`, `setReserveThread`, `clearReserveThread` | `stores/overviewStore.ts`, `useChatViewState.ts:111`, `:169` | `useOverviewPresentation` (`docked`) | S03-02 | `rg -n "reserveThread" apps/web/src` returns nothing |
| `OVERVIEW_POPOVER_RESERVE_PX`, `OVERVIEW_THREAD_GAP_PX`, `OVERVIEW_RIGHT_RESERVE_PX`, `OVERVIEW_AUTO_OPEN_MIN_ROW`, `OVERVIEW_THREAD_CONTENT_MAX_WIDTH_PX`, `shouldAutoOpenOverview`, `overviewNoPaddingMinWidth`, `overviewResponsivePaddingPx`, `overviewResponsivePaddingRight` | `lib/composer-layout.ts:74-121` | `OVERVIEW_CARD_*`, `OVERVIEW_CANVAS_RESERVE`, `OVERVIEW_DOCK_MIN_CANVAS` | S03-02 | `rg -n "OVERVIEW_POPOVER_RESERVE_PX\|shouldAutoOpenOverview\|overviewResponsivePadding" apps/web/src` returns nothing |
| `NewThreadWelcome`, `NEW_THREAD_STARTERS`, `McodeLogo variant="newThread"` on the new-thread canvas | `ChatViewSurface.tsx:39`, `:147-190` | `NewThreadStartColumn`, `ProjectSlotHeading` | S03-03 | `rg -n "NewThreadWelcome\|NEW_THREAD_STARTERS\|new-thread-starters" apps/web/src` returns nothing |
| `git.listBranches` RPC, `GitRepositoryService.listBranches(workspaceId)`, transport `listBranches` | `methods.ts:875-878`, `git-rpc.ts:72-75`, `git-repository-service.ts:128-131`, `transport/ws-transport.ts:1188`, `transport/types.ts:403` | `git.refs.list` (overview branch menu migrated too, `ThreadOverview.tsx:1311`) | S03-05 | `rg -n "git\.listBranches\|listBranches\(" apps packages` returns nothing (`listBranchesAt(` does not match; section 10 owns it) |
| `github.listOpenPrs` RPC, `GithubService.listOpenPrs`, `parseGithubPrDetails`, `PrDetailSchema` / `PrDetail`, transport `listOpenPrs` | `methods.ts:1230-1233`, `github-service.ts:237-260`, `packages/contracts/src/github.ts:16-27` | `github.pullRequestTargets.list`, `PrInfo.title` | S03-05 | `rg -n "listOpenPrs\|PrDetail\b\|parseGithubPrDetails" apps packages` returns nothing |
| `git.fetchBranch` RPC and transport `fetchBranch` (no live caller) | `methods.ts:906-913`, `git-rpc.ts:93-96`, `ws-transport.ts:1351-1352`, `transport/types.ts:615`, `__tests__/mocks/transport.ts:258` | Server-internal `fetchBranchAt` (PR heads) and `fetchOriginTrackingBranch` | S03-05 | `rg -n "git\.fetchBranch\|fetchBranch:" apps/web packages/contracts` returns nothing |
| `workspaceStore` `branches`, `branchesLoading`, `loadBranches`, `openPrs`, `openPrsLoading`, `loadOpenPrs`, `fetchingBranch`, `fetchBranch` | `workspaceStore.ts:575-587`, `:1857-1945` | `useBranchTargets`, `usePullRequestTargets` | S03-05 | `rg -n "openPrs\|loadBranches\|branchesLoading\|fetchingBranch" apps/web/src` returns nothing |
| `branch.changed` reload-and-auto-select | `transport/ws-events.ts:511-523` | Cache invalidation in `useBranchTargets`; default target from `isCurrent` | S03-05 | `rg -n "loadBranches" apps/web/src/transport` returns nothing |
| `BranchPicker` | `components/chat/BranchPicker.tsx` | `BranchTargetPicker` | S03-05 | `rg -n "components/chat/BranchPicker" apps/web/src` returns nothing |
| `WorktreePicker`, `LazyWorktreePicker`, `isDetachedTargetWorktree` | `components/chat/WorktreePicker.tsx`, `ComposerTargetSelection.tsx:10`, `:50-73`, `useComposerTargetSelection.ts:253-256` | Worktree-scoped `BranchTargetPicker` | S03-05 | `rg -n "WorktreePicker\|isDetachedTargetWorktree" apps/web/src` returns nothing |
| Hard-coded `"main"` new-thread and fork fallbacks | `useComposerTargetSelection.ts:109,119`, `workspaceStore.ts:376`, `:381` | Default target = the current (or default) branch from page one | S03-05 | `rg -n '\x7C\x7C "main"' apps/web/src/features/projects/state/workspaceStore.ts apps/web/src/features/conversation/composer/execution/useComposerTargetSelection.ts` returns nothing (existing-thread fallbacks in `composer-submission-routes.ts:233` and `ChatViewSurface.tsx:514` are out of scope) |
| `ComposerTargetSelection` `variant` / `triggerClassName` / `iconSize` styling props | `useComposerTargetSelection.ts:12-24`, `:153-159` | Fixed rail and strip anatomy | S03-05 | `rg -n '"context-strip"\|"status-bar"' apps/web/src/features/conversation` returns nothing (the `new-thread-context-strip` test id goes in S03-06) |
| `ModeSelector`, `ALL_MODE_OPTIONS`, `ModeOption` (type `ComposerMode` moves to `composer-mode.ts`) | `components/chat/ModeSelector.tsx`; importers `ComposerStatusStrip.tsx`, `ComposerNewThreadContext.tsx`, `useComposerExecutionTarget.ts:2`, `ComposerOptionControls.tsx`, `Composer.tsx`, `ComposerAccessControls.tsx` | `WorkspaceTargetMenu` | S03-06 | `rg -n "ModeSelector\|ALL_MODE_OPTIONS" apps/web/src` returns nothing |
| `ComposerNewThreadContext` (project pill, "Clear project" X, static "Local" label, `new-thread-context-strip`) | `execution/ComposerNewThreadContext.tsx` | `NewThreadTargetRail`; project lives in the heading slot | S03-06 | `rg -n "ComposerNewThreadContext\|new-thread-context-strip\|Clear project" apps/web/src` returns nothing |
| Dead naming state: `customBranchName`, `autoPreviewBranch`, `setCustomBranchName`, `regenerateAutoPreview`, `branchCustomName`, `branchAutoPreview`, `setBranchCustomName`, `generateBranchId`, `ThreadDraftTarget.customBranchName` / `autoPreviewBranch` | `workspaceStore.ts:44`, `:582-583`, `:703-729`, `:1091-1103`, `:1800-1801`, `:1826`; `threadDraftStore.ts:30-31`, `:110-111`; `useComposerFormController.ts:177-178`, `:311-312`; `ChatViewSurface.tsx:516-517`, `:543` | Nothing (ADR-0015) | S03-08 | `rg -n "autoPreviewBranch\|customBranchName\|branchCustomName\|generateBranchId" apps/web/src` returns nothing |
| Server default `branch = "main"` for worktree creation | `thread-creation-coordinator.ts:210` | Contract requires `branch` for `mode: "worktree"` | S03-08 | `bun run --cwd packages/contracts test -- src/__tests__/create-and-send.test.ts` passes, including "rejects mode worktree without branch" (the destructured default may stay for Local mode) |
| Palette backdrop blur and `widthClass` sizes | `CommandPalette.tsx:43-49`, `:106` | 600 palette chrome | S02-01 | `rg -n "backdrop-blur-xs\|widthClass" apps/web/src/components/palette` returns nothing |
| In-input "Add project" button (`palette-add-folder`), `BrowseShortcuts` | `CommandPalette.tsx:193-221`; `BrowseView.tsx:556-578` | Add chip, `PaletteFooterHints` | S02-02 | `rg -n "palette-add-folder\|BrowseShortcuts" apps/web/src/components/palette` returns nothing |
| `addProject` intent seeding `~/` | `commandPaletteStore.ts:75-77` | Opens `SourcesView` | S02-01 | `rg -n 'intent === "addProject" \? "~/"' apps/web/src` returns nothing |
| Generic add error "Could not add this folder. Try again." | `BrowseView.tsx:275` | Typed registration errors | S02-02 | `rg -n "Could not add this folder" apps/web/src` returns nothing |
| `NewThreadProjectPicker` | `components/chat/NewThreadProjectPicker.tsx`, `ChatViewSurface.tsx:14`, `:156` | `ProjectChooser` | S02-03 | `rg -n "NewThreadProjectPicker" apps/web/src` returns nothing |

`GitBranchSchema` and `listBranchesAt` stay: Review's branch comparison still returns them (`apps/server/src/features/projects/git/git-comparison-service.ts:247`). Their swallowed-error bug belongs to section 10.

## Proposed tickets

### S03-01 Overview entry registry (prefactor)

- **Blocked by:** None (can start immediately).
- **Boards:** `12j · Thread overview with Terminals` (`258G-2`) for section order only
- **Delivers:** No visible change. The overview's body is a list of registered entries, so later sections add or replace rows without touching the shell or each other.
- **Build notes:** Create `features/thread-overview/overview-subject.ts` and `overview-registry.ts` (types above). Move each block of `renderOverviewBody` into its own module under `features/thread-overview/entries/` and register it with the section it will live in: `lane` (local mode, create branch, branch menu, commit, PR), `activity` (save recovery, changes, repository, plans, subagents, browser, sources), `summary` (recap, usage). Masthead ⋯ and settings become `OVERVIEW_HEADER_ACTIONS`. Setup error and attempt card go in `lane` at order 0. Keep the existing popover and styling. Subjects are `["thread"]` for every moved entry. Hooks that fed several rows (`useThreadGitActions`, change summary loading) move into the entry that uses them, or into a small shared hook in `features/thread-overview/`.
- **Deletes:** `renderOverviewBody`.
- **Acceptance criteria:**
  - [ ] `ThreadOverview.tsx` is under 400 lines and renders `OVERVIEW_ENTRIES` filtered by subject.
  - [ ] Every existing test id (`workspace-menu-changes`, `thread-overview-plan`, `thread-overview-local`, `workspace-menu-branch`, `thread-overview-subagents`, PR row ids) still renders in the same order.
  - [ ] Adding an entry needs one line in `overview-registry.ts` and no shell edit.
- **Verify:** `bun run --cwd apps/web test -- src/features/thread-overview/__tests__/overview-registry.test.tsx src/components/chat/ThreadOverview.branchless-pr.test.tsx src/components/chat/HeaderActions.test.tsx src/stores/__tests__/overviewStore.test.ts`; `overview-registry.test.tsx` is new and asserts order and subject filtering. Live: open a thread in `.dev/fixture-repo`, open the overview, compare against a before screenshot.

### S03-02 Overview card shell

- **Blocked by:** S03-01 Overview entry registry; F-01b Token vocabulary rename; F-03 Button primitives; F-07a Overlay surfaces and side placement; F-04a Menu primitive.
- **Boards:** `03c` (`1ZN7-2`, card `1ZS8-2`), `12j` (`258G-2`)
- **Delivers:** On any thread the overview is a 280 card under the header (top 56, right 16), open by default, with the header button on (selected fill, ink icon). The conversation re-centres with padding-right 328. Opening the right panel hides the card; the button then shows it as an overlay that Esc or an outside click closes. Closing the right panel brings the docked card back unless the user closed it. Narrow canvas (< 896) behaves like the right panel case.
- **Build notes:** `OverviewCard`, `OverviewToggleButton`, `OverviewSideMenu`, `useOverviewPresentation`, rewritten `overviewStore` (keep `requestOpen` for `PullRequestForkDialog.tsx:397` and `PullRequestReviewTaskDialog.tsx:163`). Sections and dividers via the `:has()` rule. Ported side menus (local mode, branch) switch to `OverviewSideMenu`. Card scrolls internally with the 40px bottom fade. Update `CONTEXT.md` "Overview" and the ui-components doc paragraph.
- **Deletes:** Ledger rows for the popover container, `reserveThread*`, and the `composer-layout.ts` overview constants.
- **Acceptance criteria:**
  - [ ] Card geometry and colours match `1ZS8-2` via computed styles (width 280, padding 16, gap 20, radius 14).
  - [ ] Default open on every thread; the user's close sticks for that thread for the session and survives thread switches.
  - [ ] Right panel open → card hidden, button off; button → overlay; Esc closes overlay; right panel close → docked card returns.
  - [ ] Canvas padding-right is 328 only while docked; the composer never drops below 520.
  - [ ] Side menus open left of the card with an 8px gap, top-aligned to the trigger row.
  - [ ] An empty section and its divider do not render.
- **Verify:** `bun run --cwd apps/web test -- src/features/thread-overview/__tests__/OverviewCard.test.tsx src/stores/__tests__/overviewStore.test.ts src/components/chat/ThreadOverview.branchless-pr.test.tsx src/components/chat/HeaderActions.test.tsx`. `OverviewCard.test.tsx` is a new component test at the `OverviewCard` seam with a fake registry (empty sections hidden, divider placement, presentation states); the store test is in `overviewStore.test.ts`; the two existing overview tests keep passing through this ticket (see Tests). Live (Electron, `agent:up --desktop`): fixture thread, toggle the card, open and close the right panel, resize the window below 896 + sidebar, screenshot each state.

### S03-03 New-thread start column

- **Blocked by:** F-01b Token vocabulary rename; F-02 Fade truncation primitive.
- **Boards:** `03` (`1ZHP-2`, column `1ZQ7-2`), `01` (`1ZDG-2`) for the empty variant
- **Delivers:** A new thread shows "What should we build in **{project}**?" with the amber dashed slot, the rail and the 760 composer centred, and no below-composer line: "Start a chat without a project instead." on board 03 is not built, because a projectless chat is out of this program (decision N9, user 2026-10-08; its own scoping epic). The composer is 760 wide here and in threads.
- **Build notes:** `NewThreadStartColumn`, `ProjectSlotHeading`; composer max width `var(--container-reading)` via one constant replacing `PRIMARY_CONTENT_RAIL_CLASS` in `Composer.tsx:639` only (the message column belongs to section 05). Mount the canvas header on the new-thread surface (breadcrumb "{project} / New thread", top actions) so S03-07 can place the toggle; if Section 01 owns the header shell, consume it.
- **Deletes:** `NewThreadWelcome`, `NEW_THREAD_STARTERS`, the logo on the new-thread canvas.
- **Acceptance criteria:**
  - [ ] Heading type 32/40 600 −0.02em; slot `--color-primary` with a 2px dashed underline; slot opens the project chooser (S02-03; until then the existing chooser).
  - [ ] Composer box is 760 wide at 1440 and keeps its width when the thread starts.
  - [ ] Long project names fade (F-02), never ellipsis.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/messages/chat-view/__tests__/NewThreadStartColumn.test.tsx`, a new render test for the column and slot. Live: screenshot at 1440×900 against `1ZHP-2`.

### S03-04 Paged branch and pull request targets (backend)

- **Blocked by:** None (can start immediately).
- **Reconciled:** Owns one qualified-ref listing (full ref names, explicit purpose filter, one paging and result contract, current-worktree context, sorting) shared with Review's Branch picker (S10-05). Test diverged local and origin branches with the same short name.
- **Boards:** `03b` (`2AUM-2`), `03b states` (`2BP1-2`)
- **Delivers:** Two RPCs that page with totals and typed errors: `git.refs.list`, the one qualified-ref listing that the new-thread picker and Review's Branch pickers (S10-05) share, and `github.pullRequestTargets.list`; `PrInfo.title`.
- **Build notes:** Contracts in `packages/contracts/src/git.ts`, `github.ts`, `ws/methods.ts` (use `lazySchema`); `remote_not_github` added to `PullRequestErrorCodeSchema`. Server: `GitRepositoryService.listRefsAt` (for-each-ref + `worktree list --porcelain` in the context worktree; purpose and side filter, twin grouping for `new-thread`, and the one sort in section A), `GithubPullRequestClient.listRepositoryOpenPullRequests` (repository connection or search), `GithubService.listPullRequestTargets` (owner/name from `origin`), router entries in `git-rpc.ts` and `pull-request-rpc.ts`, transport methods in `transport/types.ts` and `ws-transport.ts`. `getBranchPr` requests `title`.
- **Deletes:** Nothing yet; the old RPCs go in S03-05 with their last callers.
- **Acceptance criteria:**
  - [ ] 568 refs page as 50/50/…; `total` is stable across pages; the default branch first, then the context worktree's branch; every row carries its full ref name.
  - [ ] Diverged same-name branches: local `feature/x` and `origin/feature/x` at different commits. `review` with `side: "local"` returns `refs/heads/feature/x` and with `side: "origin"` returns `refs/remotes/origin/feature/x`, each with its own `headSha`; `new-thread` returns one `feature/x` row whose `twin` is `refs/remotes/origin/feature/x`.
  - [ ] With `threadId` for a thread in a linked worktree, `isCurrent` marks that worktree's branch, not the project folder's.
  - [ ] `purpose: "review"` without `side`, or `side` with another purpose, is rejected as invalid input.
  - [ ] Corrupt ref or non-repo returns `ok: false` with `git_failed` / `not_a_repository` and the stderr line, never `[]`.
  - [ ] `existing-worktree` returns linked-worktree branches and detached worktrees only.
  - [ ] PR page returns `total` from GitHub, pages past 30, maps unauthenticated, rate-limited and non-GitHub origin to typed errors.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/git/__tests__/git-refs-list.test.ts src/features/pull-requests/github/__tests__/github-pull-request-client.test.ts` and `bun run --cwd packages/contracts test -- src/__tests__/git-refs-list.test.ts src/__tests__/pull-requests.test.ts`. The server `git-refs-list.test.ts` is a new real-git test (prior art `git-repository-fetch.test.ts`: disposable repos with a bare `origin`, 120 branches, a diverged `feature/x` and `origin/feature/x` pair, a linked and a detached worktree, a corrupt ref). The PR client tests extend `github-pull-request-client.test.ts` with a stubbed runner (query shape, cursor, error mapping). The contract `git-refs-list.test.ts` is new, for the `git.refs.list` purpose and side rule and the paged result; `pull-requests.test.ts` is extended for the `github.pullRequestTargets.list` result and `remote_not_github`.

### S03-05 Branch target picker

- **Blocked by:** S03-04 Paged branch and pull request targets (backend); F-04b Picker primitive; F-02 Fade truncation primitive.
- **Boards:** `03b` (`2AUM-2`, picker `2B04-2`), `03b states` (`2BP1-2`)
- **Delivers:** The rail's branch trigger and the inline fork strip open the new picker: search, Branches | Pull requests (New worktree only), flat list with "current" / "worktree", silent infinite scroll with "Showing x of y", PR matches grouped under branch search, no-match and error states with Retry. Existing worktree mode lists only worktrees. The default target is the project's current branch, not a literal "main".
- **Build notes:** `BranchTargetPicker`, `useBranchTargets`, `usePullRequestTargets`, `new-thread-target-copy.ts`. Selecting a branch sets `newThreadBranch` / `newThreadBranchSource: "branch"`; a PR sets `"pr"` + number; a worktree row sets `selectedWorktree` (Existing worktree) from the row's `worktree` data. Migrate `ComposerTargetSelection` and the fork strip, and switch the overview branch menu data source (`ThreadOverview.tsx:1311` or its S03-01 entry module) to `git.refs.list` with purpose `new-thread` and the thread's id as context. A grouped row shows once; Start from origin on it uses its `twin`. `useThreadGitActions` reads `pr.title`.
- **Deletes:** Ledger rows for `git.listBranches`, `github.listOpenPrs`, `git.fetchBranch`, the `workspaceStore` list caches, `branch.changed` auto-select, `BranchPicker`, `WorktreePicker`, client `"main"` fallbacks, styling props.
- **Acceptance criteria:**
  - [ ] Five rows visible; bottom fade always, top fade once scrolled; no icons, counts or captions on rows.
  - [ ] Scrolling to the end loads the next page with no spinner row; "Showing 100 of 568" updates.
  - [ ] Searching "sidebar" in New worktree mode shows branch matches then a "Pull requests" group.
  - [ ] Git failure shows "Couldn't list branches", the git line in mono, Retry; Retry refetches.
  - [ ] `gh` not signed in shows the PR error in the PR tab instead of hiding the tab.
  - [ ] Esc closes; selecting closes and updates the trigger.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/composer/execution/__tests__/BranchTargetPicker.test.tsx src/features/conversation/composer/execution/__tests__/Composer.checkout-dialog.test.tsx src/features/conversation/composer/execution/__tests__/Composer.footer-checkout.test.tsx`. `BranchTargetPicker.test.tsx` is a new component test at the picker seam with a fake transport (paging, grouping, error, retry); update the two `Composer` checkout tests. Live: in `.dev/fixture-repo` run `for i in $(seq 1 120); do git -C .dev/fixture-repo branch "paging/b$i"; done`, open the picker, scroll to the end, read "Showing 123 of 123" (or the actual count), search, break a ref (`echo junk > .dev/fixture-repo/.git/refs/heads/broken`) to see the error, then remove it.

### S03-06 Workspace target menu and new-thread rail

- **Blocked by:** S03-05 Branch target picker; S03-03 New-thread start column; F-04a Menu primitive.
- **Boards:** `03` (`1ZHP-2`, rail `2AXW-2`), `03d` menu (`20LL-2`)
- **Delivers:** The rail above the composer (shown while the overview card is not) has a workspace trigger opening the names-only "Workspace" menu and the branch trigger from S03-05. Not a git repo shows only Local. The rail is gone after first send.
- **Build notes:** `WorkspaceTargetMenu`, `NewThreadTargetRail`; move `ComposerMode` to `features/conversation/composer/execution/composer-mode.ts`; migrate the fork strip. Rail visibility = new thread && overview presentation is `hidden`.
- **Deletes:** `ModeSelector` rows, `ComposerNewThreadContext` row.
- **Acceptance criteria:**
  - [ ] Rail 652 wide, attached to the composer top, triggers 32 high, muted labels and icons (`2AXW-2`).
  - [ ] Menu matches `20LL-2`: label "Workspace", check on the current mode, Local shows the project folder in mono.
  - [ ] Choosing Existing worktree switches mode only; the branch trigger then lists worktrees; Send is disabled until one is chosen.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/composer/execution/__tests__/WorkspaceTargetMenu.test.tsx src/features/conversation/composer/execution/__tests__/NewThreadTargetRail.test.tsx src/features/conversation/composer/execution/__tests__/Composer.checkout-dialog.test.tsx`. The first two are new component tests for the menu and rail visibility; `Composer.checkout-dialog.test.tsx` mocks `ModeSelector` today and changes with it. Live: switch modes on a fixture new thread, send in each mode, confirm the thread starts in the right place.

### S03-07 Overview target rows on a new thread

- **Blocked by:** S03-02 Overview card shell; S03-06 Workspace target menu and new-thread rail.
- **Boards:** `03c` (`1ZN7-2`), `03d` (`20F4-2`), `03e` (`20M5-2`)
- **Delivers:** Every new thread opens with the overview card showing "New worktree · Create ⌄" and "From **main** ⌄" (or "Local · mcode" / "On main"; Existing worktree per Q4). Rows open the workspace menu and the branch picker to the left of the card. The rail hides while the card shows; closing the card brings the rail back. First send swaps these rows for section 04's checkout rows.
- **Build notes:** Register `target.workspace` and `target.branch` entries (`section: "lane"`, `subjects: ["new-thread"]`) using `OverviewRow`, `WorkspaceTargetMenu`, `BranchTargetPicker` inside `OverviewSideMenu`. Mount `OverviewCard` and the toggle on the new-thread surface with subject `{ kind: "new-thread", workspaceId }`. Call `overviewStore.reopen` from `beginNewThread` and `openThreadDraft` (option B). Header actions declare whether they support `new-thread` (section 12 decides ⋯; settings opens Project settings for the workspace).
- **Deletes:** Nothing beyond S03-06.
- **Acceptance criteria:**
  - [ ] New thread → card open, rows read from the same copy function as the rail.
  - [ ] Closing the card on a new thread shows the rail; reopening hides it; opening another new thread reopens the card.
  - [ ] Workspace menu: right 304 / top 120 at 1440×900; branch picker: right 304 / top 156.
  - [ ] Draft reopen restores mode, branch and Start from origin in both the card and the rail.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/messages/chat-view/__tests__/ChatViewSurface.new-thread-overview.test.tsx`, a new integration test at the new-thread surface seam (card visible, rows, rail toggling). Live (Electron): new thread in `.dev/fixture-repo`, open both menus, screenshot against `20F4-2` and `20M5-2`, close the card and confirm the rail.

### S03-08 Start from origin

- **Blocked by:** S03-05 Branch target picker; S03-07 Overview target rows on a new thread; S04-01 Startup record v2: step times, step details, fetch phase, attached-worktree kind.
- **Reconciled:** Server flag and toggle only. S04-06 renders the fetch step in the trail.
- **Boards:** `03b` footer (`2B1L-2`), `03b states · Origin on` (`2BS9-2`), `03c` branch row; `04a`/`04f` for the fetch step (section 04)
- **Delivers:** In New worktree mode the picker footer switch "Start from origin" makes the thread start from the freshly fetched `origin/<branch>`; the overview reads "From origin/main". Local branches, including a checked-out `main`, never move. If the fetch fails the startup waits with Retry and "continue" (start from local).
- **Build notes:** Section C. Contract field and refines, `fetch` phase, `fetchOriginTrackingBranch`, `startPoint` in `createWorktree`, coordinator flow, startup block. Client: `newThreadStartFromOrigin` in `workspaceStore`, `ThreadDraftTarget.startFromOrigin`, reset on new thread, sent only in New worktree mode, forced for remote-only targets. Add the CONTEXT.md "Start from origin" entry.
- **Deletes:** Dead naming state and server `"main"` default (ledger).
- **Acceptance criteria:**
  - [ ] With `main` checked out in the project folder and behind origin, a New worktree thread with the switch on starts at origin's tip; `git rev-parse main` is unchanged.
  - [ ] Switch off: worktree starts at local `main` as today.
  - [ ] No origin / branch missing on origin / network failure → startup blocked on `fetch` with a readable message; "continue" starts from local.
  - [ ] The switch is absent in Local and Existing worktree modes and on the PR tab.
  - [ ] Old drafts without the field load with the switch off.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/git/__tests__/start-from-origin.test.ts src/features/agents/turns/__tests__/thread-creation-startup.test.ts`, `bun run --cwd packages/contracts test -- src/__tests__/thread-startup.test.ts src/__tests__/create-and-send.test.ts` and `bun run --cwd apps/web test -- src/stores/__tests__/threadDraftStore.test.ts src/features/conversation/composer/execution/__tests__/BranchTargetPicker.test.tsx`. Server: a new real-git test `start-from-origin.test.ts` (checked-out behind `main`, missing remote branch, no origin) and the coordinator test in `thread-creation-startup.test.ts`. Contracts: `thread-startup.test.ts` and a new `create-and-send.test.ts` ("rejects mode worktree without branch", the `startFromOrigin` refines). Web: `threadDraftStore.test.ts` loads an old draft without the field with the switch off, and S03-05's `BranchTargetPicker.test.tsx` shows the switch only in New worktree mode on the Branches tab. Live: `git init --bare .dev/fixture-origin.git`, add it as `origin` of `.dev/fixture-repo` if absent, push `main`, push one extra commit from a temporary clone under `.dev/`, start a New worktree thread with the switch on, check the worktree `HEAD` equals the origin commit and local `main` did not move.

### S02-01 Palette shell and Sources view

- **Blocked by:** F-01b Token vocabulary rename; F-04b Picker primitive.
- **Boards:** `02a` (`2B65-2`, palette `2BA4-2`)
- **Delivers:** "Add project" from the sidebar +, the `workspace.new` command and the chooser opens the palette on Sources: Local folder only. New project, Git URL and GitHub are deferred to the design backlog (S02-04), and rows are data-driven, so they are absent rather than dead. Typing `~/` or a path browses. The palette chrome matches 02a for every palette view.
- **Build notes:** `SourcesView`, `PaletteFooterHints`, chrome in `CommandPalette.tsx` (600 wide, top 80, backdrop without blur, search row 34, divider, section label). `commandPaletteStore.open({ intent: "addProject" })` pushes the Sources view with an empty query. Local folder → browse at `~/`.
- **Deletes:** Backdrop blur, `widthClass` sizes, `addProject` seeding.
- **Acceptance criteria:**
  - [ ] Palette geometry and backdrop match `2BA4-2` / `2BA3-2` via computed styles.
  - [ ] Arrow keys move the highlight (`--color-hover` row); Enter selects; Esc closes.
  - [ ] No row exists for a source that cannot complete.
- **Verify:** `bun run --cwd apps/web test -- src/components/palette/CommandPalette.test.tsx src/stores/__tests__/commandPaletteStore.test.ts`. Extend `CommandPalette.test.tsx` (intent opens Sources, `~/` switches to browse); `commandPaletteStore.test.ts` asserts today's `~/` seeding for the `addProject` intent and changes with it. Live: click the sidebar + and screenshot against `2B65-2`.

### S02-02 Browse folders and ready to add

- **Blocked by:** S02-01 Palette shell and Sources view.
- **Boards:** `02c` (`2BBK-2`), `02d` (`2BH5-2`)
- **Delivers:** The browse view has a path row with back to Sources, an Add chip ("Add Ctrl Enter", "⌘ Enter" on macOS) enabled only for an exact, addable folder, "Folders" / "Folders in {name}", folder rows with a chevron on the highlighted row, and footer hints. "Open in File Explorer" (desktop only) opens the native folder dialog and adds the chosen folder (Q3). Adding a bad path says why.
- **Build notes:** Section D contract and server validation; `BrowseView` maps error codes to copy (inferred copy: "This folder doesn't exist.", "That's a file, not a folder.", "Pick a folder inside your home folder.", "Mcode can't read this folder."). Platform label: "File Explorer" on Windows, "Finder" on macOS, "Files" on Linux (inferred). Update `desktop-reliability-test.mjs:119` for the result union.
- **Deletes:** In-input add button, `BrowseShortcuts`, generic add error.
- **Acceptance criteria:**
  - [ ] Add is disabled at `~`, at drive roots, and for the absolute home path; the server also refuses them (`too_broad`).
  - [ ] A deleted folder typed by path cannot be added; the message names the reason.
  - [ ] Re-adding a registered folder opens it (`reused: true`) without a duplicate in the sidebar.
  - [ ] Web client hides "Open in File Explorer".
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/lifecycle/__tests__/workspace-service-create.test.ts` and `bun run --cwd apps/web test -- src/components/palette/CommandPalette.test.tsx src/components/palette/views/__tests__/BrowseView.test.tsx`. The server test is new, next to `filesystem-browser.test.ts`, for `WorkspaceService.create` validation (temp dirs, a file, home, trailing slash). The web tests cover chip enablement; `CommandPalette.test.tsx` drives today's `palette-add-folder` button and changes with it. Live (Electron): browse to `.dev/fixture-repo`, add it, try the home path, use the native dialog.

### S02-03 Project chooser popover

- **Blocked by:** S02-01 Palette shell and Sources view; S03-03 New-thread start column.
- **Boards:** `02b` (`2B1Q-2`, chooser `2B5O-2`)
- **Delivers:** The heading slot opens a chooser anchored under it. With no projects: glyph tile, "No projects yet", "Add a folder to start working in its code.", and the Add project row, which opens Sources. Its meta lists built sources only, so it reads "Add project · Folder ›" here (the board shows "Folder, Git, GitHub"). With projects: F-04 search and flat list with a check on the active project, then the Add project row.
- **Build notes:** `ProjectChooser`; reuse `beginNewThread(workspaceId)`. The populated state has no board; it follows F-04 anatomy (inferred). The row's meta lists only built sources, so it reads "Folder" in this program (S02-04 is deferred).
- **Deletes:** `NewThreadProjectPicker`.
- **Acceptance criteria:**
  - [ ] Empty state matches `2B5O-2` apart from the row meta ("Folder"); the row opens the palette on Sources.
  - [ ] Choosing a project switches the new thread to it and closes the chooser.
- **Verify:** `bun run --cwd apps/web test -- src/features/projects/__tests__/ProjectChooser.test.tsx`, a new component test for both states. Live: empty database snapshot is not available, so check the empty state in the component test and the populated state live with `.dev/fixture-repo`.

### S02-04 New project and clone sources (merged)

- **Blocked by:** Not a ticket. Deferred to the design backlog: New project, Git URL and GitHub sources have no boards. Excluded from this program and from F-99.

## Tests

- **Server, real git:** follow `apps/server/src/features/projects/git/__tests__/git-repository-fetch.test.ts` (disposable repos through `RealGitExecutor`, a bare `origin`, helper `git(cwd, ...args)`). New files: `git-branch-targets.test.ts`, `start-from-origin.test.ts`. These are the highest-value tests here; the bugs they pin (swallowed errors, refused refspec) only show against real git.
- **Server, GitHub:** stub the `gh` runner as `github-pull-request-client.test.ts` does; assert GraphQL variables, cursor round-trip, `totalCount` / `issueCount` mapping, and error codes.
- **Server, registration:** `WorkspaceService.create` with temp dirs; prior art `apps/server/src/features/projects/lifecycle/__tests__/`.
- **Server, coordinator:** `apps/server/src/features/agents/turns/__tests__/thread-creation-startup.test.ts` for the `fetch` phase, block, retry and continue.
- **Contracts:** `packages/contracts/src/__tests__/thread-startup.test.ts` and a new paged-envelope test.
- **Web:** test at component seams with the transport mock (`apps/web/src/__tests__/mocks/transport.ts`): `OverviewCard` with a fake registry, `BranchTargetPicker`, `WorkspaceTargetMenu`, `CommandPalette` intents, `ProjectChooser`. Keep `ThreadOverview.branchless-pr.test.tsx` and `HeaderActions.test.tsx` passing through S03-01/02. The web e2e suite is broadly red on main (store-introspection rot); do not gate on it.
- **Live:** `bun run --shell system agent:up --desktop`, `bun run agent:ready`, drive with `.agents/skills/electorn-live-testing/SKILL.md`, touch only `.dev/fixture-repo` (and `.dev/fixture-origin.git` for S03-08). UI tickets attach before and after screenshots to the PR.

## Risks and open questions

1. **Q1, decided:** New project, Git URL and GitHub repository have rows on 02a but no flow boards and no backend. They are deferred to the design backlog (S02-04) and excluded from this program and F-99. The palette ships with Local folder only; designing 02e to 02g comes first when the backlog item is picked up.
2. **Q2, user:** Start from origin in New worktree mode only (recommended: never mutates a checkout the user already has), or also in Local and Existing worktree as a fast-forward of that checkout (touches the user's working tree and may collide with a running thread there).
3. **Q3, user:** "Open in File Explorer" opens the native folder dialog and adds the choice (recommended; the bridge exists unused), or reveals the current folder in the OS file manager.
4. **Q4, user:** Copy without boards: Existing worktree rows (recommended: workspace row meta = worktree folder, branch row "On {branch}"), PR-selected branch row (recommended "From #1804"), and whether Start from origin is remembered for the next new thread (recommended: no, default off).
5. **Ownership, parent:** The start column (heading, slot, rail container) and the new-thread canvas header are shared with Section 01. This doc assumes S03-03 builds the column and Section 01 renders its placeholder variant; reconcile before tickets are filed. The Usage block on a new thread needs provider-scoped usage from the Usage row owner. Section 04 renders the `fetch` step this doc adds.
6. **Behavior change, accepted unless the user objects:** PR search moves from a client substring filter over 30 PRs to GitHub search over all open PRs. GitHub search matches title, body and number, not a substring of the head branch name.
7. **Size risk:** S03-01 moves about 2,500 lines. If it overflows one agent context, split it by section (lane, activity, summary) with the registry landing first.
8. **Drift:** the closed overview button has a fill on `03`/`03b`; F-03 says ghost at rest. Following F-03.
