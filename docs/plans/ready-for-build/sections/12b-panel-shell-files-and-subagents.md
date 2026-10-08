# 12b · Right panel shell, Files and Subagents: build brief

When this section ships, every right-panel tool (Review, Browser, Terminal, Files, Plan, Project settings, Subagents) sits in one shell: a 48 row 1 that shares the window caption overlay, an optional 40 row 2 for the tool's own controls, nothing floating over content, and a 48 rail of vertical tabs on the right edge (one entry per tool, plus one entry per opened subagent). Files becomes a real tool: a project tree, opened files as row-1 tabs, Go to file, find, read-only code with changes since HEAD, markdown and images, and line comments that ride the next message. Subagents becomes one honest list for all providers, and each subagent opens as its own rail tab with the parent's prompt and only what its provider shares. The Coordination tab leaves the panel.

Surfaces: `apps/web` (shell, Files, Subagents), `apps/server` (file reads, change marks, subagent roster and push), `packages/contracts` (file and roster schemas, push channel), `packages/providers` and `apps/server/.../adapters/opencode` (subagent reporting), `apps/desktop` (none beyond the caption overlay owned by section 01).

This file also owns foundation ticket **F-05 · Right panel shell**.

## Boards

All on page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0 unless noted.

| Board | Node | Shows |
|---|---|---|
| 12c · Files · Tree, code, markdown, image · Dark | `2G4U-2` | Code file with line comment, Find in file, Go to file, wide panel with docked tree, tree as body view, markdown Preview/Source, image with size chip and scale |
| 12f · Files · Full window · Dark | `234Z-2` | Shell in context: row 1 file tabs + round + / expand / toggle beside the caption overlay, row 2, rail with Files active |
| 12e · Subagents · All providers · Dark | `2HDF-2` | List (running, divider, finished; Codex Stop on hover; clay Failed), detail tiers: full transcript (Codex, Copilot), steps and summary (Claude, Devin), summary only (Cursor) |
| 12g · Subagent tab · Full window · Dark | `23HJ-2` | Subagent detail as its own rail tab after Subagents, divider, provider icon with green dot, row 1 title pill, row 2 meta pill + live time + Stop |
| 10a · Review · Turn view · Revert file · Dark | `2241-2` | Shell with a picker (not tabs) in row 1 |
| 11a · Browser · Page open · Two rows · Dark | `22JT-2` | Shell with browser tabs in row 1 |
| 12a · Terminal · Shell open · Two rows · Dark | `22UJ-2` | Shell with terminal tabs in row 1; rail keeps one Terminal icon |
| 12h · Project settings · Full window · Dark | `23RB-2` | Shell with a title pill in row 1 and a section pill in row 2 |
| 08a · Finished · With changes · Dark | `21EL-2` | Panel closed: the panel toggle sits in the canvas header, immediately left of the window controls |
| Right rail · dark · expanded (page "04 · Components", `p-5-0`) | `27A-0` | Hover-expanded rail at 160 with labels, × on the hovered row, Review badge, "New tab". Still shows a "Close panel" row that 07e removed (stale) |

Exact values used below come from `get_jsx` / `get_computed_styles` on these nodes, not screenshots.

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md` (user, 2026-10-07 and 2026-10-08). Do not reopen.

Shell
- Two-row panel header from Review and Browser: row 1 (48) shares the window caption overlay, row 2 (40) holds tool-specific controls, nothing floats over content (11c, approved 2026-10-07).
- Expand-to-full-width and panel toggle are round icons beside the window controls; the rail lost its Close panel icon and the canvas header lost its toggle while the panel is open (07e, 2026-10-07).
- Vertical tabs are rail entries; horizontal tabs are row-1 tabs inside a tool (12e, 2026-10-07). Terminal keeps one rail icon and its terminals become row-1 tabs (12a, approved 2026-10-07).
- Review rail tab uses Lucide `Diff` (08). Round 32 icon buttons, selected fill, ink icon (F-03). Names-only menus (F-04). 24px fade truncation, never an ellipsis (F-02).
- Coordination tab is removed from the right panel ("this panel was a mistake"); server-side thread control stays; only the panel, its catalog entry and rail/empty-state entries go (2026-10-07).
- Close: hovering a row-1 tab swaps its glyph or dot for a close icon (same as Browser tabs); closing asks only when a process still runs (Terminal, owned by 12a).

Files (12c, approved 2026-10-08)
- Opened files are row-1 tabs (file-type icon, name; hover swaps icon for close). Round + (Ctrl P) opens Go to file: a popover under the tab strip with a search field and fuzzy results (name, folder muted); Enter opens a tab, Ctrl Enter opens beside.
- Row 2: round tree toggle, path pill (folder muted, file name ink, fade; click copies, segments open the tree there), round Find in file (Ctrl F, find bar under row 2 like the terminal's: field with "1 of 2", case / word / regex, previous, next, close; current match amber), More (Open in editor, Reveal, Copy path). Search and + no longer do the same thing.
- Body on `--color-background` like Review's diffs; docked tree separated by a 1px border.
- Read-only code with line numbers and token colours (keywords violet / `--color-pr-merged`, strings `--color-success`, tags `--color-link`, comments `--color-muted`), 2px amber bar on lines changed since HEAD.
- Below 800 the tree is a body view you toggle (row 2 becomes a "Go to file · Ctrl P" field); picking a file returns to it. From 800 the tree docks at 280 (resizable 220 to 480) like Review's files pane.
- Tree: 28 rows, single-child folders compacted, M (amber) and A (sage) marks, amber dot on folders holding changes, current file on the selected fill.
- Markdown opens rendered with a Preview / Source pill; relative links open as tabs. Images centred at fit with a dimensions · size chip and a scale pill; checker only behind transparency; SVG gets a Source flip.
- Line comments: hovering a line fills it and shows a + in the gutter; the comment opens under the line using the plan comment editor (trash, Cancel, amber check; Enter saves, Esc cancels), persists as a draft and rides the next message like Review comments, anchored by path and line.
- Data: `listWorkspaceFiles` plus a read-file RPC.

Subagents (12e, approved 2026-10-08)
- One list for all providers: running first, then finished, split by a divider (no group labels). Rows: provider icon, task, then type / model / step count where known, live time with a green dot, check + time when done, clay "Failed". No nested child rows. Stop only where supported (Codex).
- Clicking a row opens that subagent as its own vertical tab in the rail, placed after the Subagents tab, with its provider icon and a green dot while running; closed from the rail like any tab. Row 1: title pill (provider icon, task). Row 2: meta pill (type · model) with live time and, for Codex, a round Stop. No back button.
- Every detail starts with the parent's message: a right-aligned user-style bubble under a muted "From the main thread" label, full prompt (Codex spawn input, Claude Agent `prompt`, Devin `task`, Cursor `prompt` once its late metadata lands, Copilot `agentDescription`); long prompts clamp with Show all.
- Three honest tiers: full transcript (Codex, Copilot) streams the child narrative; steps and summary (Claude, Devin) show the step list, a "Summary" block and one muted line "Devin shares its steps and a summary, not the full conversation."; summary only (Cursor) shows meta and task, one line "Cursor doesn't share this subagent's steps or answer. Its result is in the reply that followed." and Show in chat.
- Fixes: Copilot child events to a roster; drop the `browser`/title heuristics in Cursor detection; show the Cursor row title from the start (metadata arrives late); Devin's fake `nativeThreadId` and the 1-step nesting; truncation keeps the first 32 entries but the copy says earlier activity is truncated; cancelled shows as Failed; same status words in the overview and the panel.
- Subagents are shown with the provider icon, never generic coloured badges (05c, 2026-10-07).

## How it works today

Paths under `apps/web/src` unless noted. Prior interview: `source/12-panels-interview.md`; claims below re-verified unless marked (inferred).

### Shell and rail
- The rail sits **left** of the panel content: `RightPanel.tsx:1320-1360` renders `RightPanelActivityRail` then `RightPanelContent` in one flex row. Paper puts the 48 rail on the **right** edge (`23GO-2`, `23QE-2`), under the caption overlay (rail `padding-top: 56`). Verified.
- Rail is 48 collapsed, 160 on hover (`ActivityRail.tsx:55-61, 882`), floating 112px over content (`ACTIVITY_RAIL_FLOATING_OVERLAP_PX`, `ActivityRail.tsx:61`), with a Browser overlap coordinator (`RightPanel.tsx:911`). Verified.
- Rail head holds "Close panel" and Maximize/Restore (`RailHeader`, `ActivityRail.tsx:694-743`); Maximize is only visible while expanded. Verified.
- Rail lists one entry per tab instance: every PTY (`rightPanelTerminalId`, `stores/diffStore.ts:168-170`), every Project Action (`rightPanelActionTerminalId`, `:173-175`), every Browser page (`BrowserPageGroup`, `ActivityRail.tsx:507-550`). Verified.
- `ScopeProgress` is dead: `RightPanel.tsx:1206` always passes `{ done: 0, total: 0 }`; the type is "kept for tab API compatibility" (`ActivityRail.tsx:45-49`). Verified.
- No tool has a two-row header in code; each renders its own header inside the content area (Browser `BrowserHeader`, Review `DiffToolbar`, Subagents and Coordination inline headers). Verified by reading `RightPanelContent` (`RightPanel.tsx:613-690`).
- The canvas header always shows a panel toggle (`components/chat/HeaderActions.tsx:60-80`, `aria-pressed` when open), duplicating the rail's Close panel. Paper: toggle in the canvas header only while closed (`21EL-2`), in panel row 1 while open (`234Z-2`). Verified.
- The desktop shell still has a 48px `DesktopTitleBar` reserving `pr-[138px]` for caption buttons (`components/desktop/DesktopTitleBar.tsx:197-206`); removing it is section 01's shell work, not this section.

### Catalog, availability, close
- Catalog `PANEL_TAB_TYPES` (`lib/panel-tabs.ts:52-126`): Browser, Terminal, Project Action (system-managed), Files (`comingSoon: true`, never opens), Review, Project settings, Plan, Subagents, Coordination. `RightPanelTab` union in `stores/diffStore.ts:8`. Verified.
- Empty state "Open a tool / Pick one to open it in this panel." with a disabled Files "Soon" row (`components/panels/PanelEmptyState.tsx`, `SoonBadge`). Verified.
- Closing the last tab leaves the panel visible on the empty state: `closeRightPanelTabInstance` (`stores/diffStore.ts:856-878`) never touches `visible`. CONTEXT.md "Terminal tab" says the panel closes. Verified (bug).
- Closing a Terminal tab kills the PTY then removes the instance (`closePanelTab`, `RightPanel.tsx:929-952`); failures are swallowed (no `.catch`). Verified.

### State model and ADR drift
- Code implements ADR-0012: per-thread record `rightPanelByThread` plus a workspace fallback `rightPanelFallbackByWorkspace`, read through `effectiveRightPanel` with copy-on-write (`stores/diffStore.ts:340-385, 426-434`). CONTEXT.md "Right panel" already describes this. ADR-0012 is still `status: proposed`; ADR-0004 (`accepted`) still says width and active tab are workspace-global, with a banner pointing at 0012. DESIGN.md says "workspace-global host" and "widths persist per workspace" (DESIGN.md "Right panel" pane entry and "Pane behavior"; DESIGN.md is being edited in this worktree, so cite by heading). Verified drift.
- ADR-0020 made every shell a peer rail tab; the locked design reverses that placement (terminals become row-1 tabs inside one Terminal rail entry). Needs a new ADR.
- Widths: min 384, default 440, wide 680 (`stores/diffStore.ts:48-66`); auto-open sizes to about half the content row and maximizes when cramped (`lib/right-panel-layout.ts:14-38`). Paper at 1440: 536 body + 48 rail = 584, conversation 552. Half of 1136 is 568; within 16px, no change proposed. Verified.
- Nothing persists across restart except Review's files-pane visibility (`stores/diffStore.ts:67-93`). Verified.

### Shortcuts
- `default-keybindings.json`: `mod+alt+b` panel, `mod+shift+b` Browser, `mod+j` Terminal, `mod+d` Review, `mod+t` Plan. Project settings, Subagents, Coordination have none. Verified.
- `mod+p` is bound globally to `commandPalette.toggle`, a "backward-compat alias" of `mod+k` (`config/default-keybindings.json:3`, `app/App.tsx:673-683`). The Files design takes Ctrl P. Verified conflict.
- When-contexts come from `lib/context-tracker.ts` (`inputFocused`, `terminalFocused`, ...). No Files context exists.

### Files
- No Files tool. `components/files/FilesPanel.tsx` is a generic resizable navigator shell used by Review's files pane (`components/diff/DiffPanel.tsx`, `WorktreeFilesPane.tsx`) and PR detail; the Files tool does **not** replace it (S10 owns its restyle).
- `file.list` (`packages/contracts/src/ws/methods.ts:1204-1210`) runs `git ls-files --cached --others --exclude-standard -z`, so gitignored files are excluded and untracked ones included; non-git folders fall back to a bounded walk (depth 8, 5,000 entries) (`apps/server/src/features/projects/files/file-service.ts:40-60, 264-285`). Unbounded for git repos. Verified.
- `file.read` exists (`methods.ts:1211-1218`) and returns a utf-8 string (`file-service.ts:107-117`). Guards: rejects absolute paths, any `..` substring (also rejects legal names like `a..b.ts`) and NUL (`:184-188`); realpath containment (`:196-213`); 256 KB cap labelled "too large for injection" (`:219-227`). No binary detection, no encoding handling, no image support. Its one web caller is Review's context expansion (`components/diff/ReviewDiffView.tsx:476`). Verified.
- `file.refresh` diffs `git status --porcelain --untracked-files=all -z` fingerprints and broadcasts `files.changed` (`file-rpc.ts:28-37`, channel at `packages/contracts/src/ws/channels.ts:127-132`). Triggered on mount, scope change, reconnect and window focus by `useWorkspaceFileRefresh` (`features/projects/files/useWorkspaceFileRefresh.ts:28-43`). Verified.
- Reusable pieces: compact-folder tree builder `lib/file-tree.ts:47` (used by `TurnChangeSummary`); scoped file-list cache in `components/chat/useFileAutocomplete.ts:69-145`; markdown file preview `components/diff/DiffPreviewMarkdown.tsx`; open-at-line and reveal `components/diff/FileEditorPicker.tsx`; shiki 4 and `@tanstack/react-virtual` are dependencies (`apps/web/package.json:31-53`); authenticated HTTP file serving pattern `/attachments/` (`apps/server/src/application/transport/ws-server.ts:437-485`).
- Review comments are `SavedDiffAnnotation` in `features/preview/state/previewAnnotationStore.ts:45`, contract `DiffAnnotationPayloadSchema` (`packages/contracts/src/models/browser-preview.ts:434-445`, `kind: "diff"`), formatted client-side in `lib/composer-feedback.ts` (inferred from grep). Drafts do not persist today; S10 "comment drafts" makes them persist.
- CONTEXT.md "Files navigator" names Review's tree "Files" (`CONTEXT.md:946-953`). A new right-panel "Files tab" needs its own glossary entry.

### Subagents
- `SubagentsPanel` (`features/subagents/roster/SubagentsPanel.tsx`, 891 lines) merges two sources:
  - Canonical roster (Codex child threads only), polled every 1.5 s while mounted (`:469-511`, interval at `:503`) through `canonicalAgent.roster` (`methods.ts:1185-1188`, schema `packages/contracts/src/models/canonical-subagent-roster.ts:57-91`, server `apps/server/src/features/agents/collaboration/subagent-lifecycle-service.ts:41-47`). Verified.
  - Narrative roster derived client-side from `Agent` tool calls (`roster/subagent-projection.ts`, 872 lines; `roster/narrative-subagents.ts:108-118`), deduped against canonical rows by alias guessing (`narrative-subagents.ts:12-70`). Verified.
- The server already builds a provider-neutral `SubagentPresentation` per Agent call (`packages/contracts/src/models/tool-call-record.ts:135-147, 198-220`, `mergeSubagentPresentation` for late metadata at `:244`), attached to ToolUse/ToolResult events (`packages/contracts/src/events/agent-event.ts:92, 111`) in `apps/server/src/features/agents/turns/provider-turn-event-application.ts`. Verified.
- Stop: only Codex implements `interruptChildTurn` (`packages/providers/src/private/codex/codex-provider.ts:2943`); `canStop` is derived per row (`subagent-lifecycle-service.ts:79-93`). Verified.
- Status words drift: canonical "Active" / "Failed" / raw `terminalOutcome` (`SubagentsPanel.tsx:88-96`); narrative "Interrupted" / "Failed" / "Completed" (`narrative-subagents.ts:88-92`); activity "Working" / "Errored" / "Cancelled" / "Finished" (`subagent-projection.ts:411-416`); overview "1 active, 2 done" from the narrative source only (`components/chat/ThreadOverview.tsx:2510, 2835`). Verified.
- Cancelled shows as Failed (inferred: narrative maps `cancelled` to "Interrupted", so the Failed path likely comes from provider-side tool results marked as errors on turn cancel; confirm with a fixture in S12P-09).
- Truncation: detail keeps the **first** 32 descendants (`subagent-projection.ts:23, 457, 470, 585, 598`) but says "Earlier activity is truncated." (`detail/NarrativeDetailView.tsx:96`). Verified bug.
- Identity glyphs: `components/ui/SubagentIdentityGlyph.tsx`, CSS `--subagent-identity-1..5` (`index.css:63-67`), used by the panel, `NarrativeDetailView`, chat `SubagentRow` and `ThreadOverview`. Verified.
- Dead code: `SubagentChangeSummary`, `SubagentLifecycleStatus` have no callers outside `features/subagents/index.ts`; `setSubagentReviewScope` has no non-test caller while `DiffPanel.tsx:203-220` still reads `subagentReviewScopeByThread`. Verified by grep.
- Providers (verified unless noted):
  - Copilot: any event with `parentToolCallId` becomes `{ type: "system", subtype: "copilot_child:..." }` (`packages/providers/src/private/copilot/copilot-event-mapper.ts:29`); `subagent.started/completed/failed` carry `toolCallId, agentName, agentDisplayName, agentDescription | error` (`:146-148`) and only feed a child index (`copilot-provider.ts:489-493`). No roster rows.
  - Cursor: `isCursorSubagentDelegationDiscriminator` treats `explore` and `browser` tool discriminators as subagents and `isCursorSubagentDelegationTitle` matches titles (`private/cursor/events/cursor-subagent-detection.ts:15-41`). The `cursor/task` metadata (description, prompt, model, durationMs) arrives after completion; a provisional "Subagent task" row is emitted on `tool_call` (`private/cursor/acp/cursor-acp-task.ts:1-66`).
  - Devin: `subagent_started` emits the lifecycle call as a second `Agent` ToolUse with `nativeThreadId: agentId` and `parentToolCallId` = the `run_subagent` marker (`private/devin/devin-acp-event-mapper.ts:338-404`), so one subagent becomes two nested Agent calls and a fake canonical alias.
  - Claude: Agent tool with child events tagged by `parent_tool_use_id` (`private/claude/claude-event-mapper.ts:201, 457, 615-648`).
  - OpenCode: `subtask` and `agent` parts are state-only (`apps/server/src/features/providers/adapters/opencode/opencode-event-mapper.ts:267-269`); the `task` tool renders as a generic tool; child-session events are routed by `sessionID` and probably dropped (inferred, `opencode-provider.ts:127-225`).

### Coordination
- `components/panels/CoordinationPanel.tsx` (305 lines) opens only from the rail and empty state; `lib/open-thread-coordination.ts` has no non-test caller; `stores/threadControlStore.ts` is used only by the panel plus refresh hooks in `transport/ws-events.ts:223, 261, 627-629, 642` and `transport/ws-transport.ts:613-617`; transport methods `readThreadControl/sendThreadControl/stopThreadControl` (`transport/types.ts:470-477`, `ws-transport.ts:1267-1275`). Verified.
- Removing it does not strand approvals. Today thread-control approvals are broadcast as ordinary `permission.request` with `threadId` set to the target thread and `ownerThreadId` to the source (`apps/server/src/features/thread-control/authority/thread-control-service.ts:555-558`), so they reach the target's approval dock and sidebar row. Verified. Approval v2 (S06-01) routes thread-operation approvals to the owner (source) thread instead, with the target named in the subject (`06-approvals.md`, `ApprovalRequestSchema.threadId`); S12P-02 asserts that rule.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Rail on the right edge, 48, under caption overlay | Rail left of content | Move rail after content; `padding-top: 56`; border-left 1px `--color-border` | web |
| Row 1 (48) + row 2 (40) in every tool | Per-tool ad hoc headers | `PanelHeader` with row-1 and optional row-2 slots; tools mount their controls there | web |
| Expand + toggle round icons in row 1 beside caption buttons | Maximize hidden in expanded rail; toggle in canvas header and rail | Move both to row 1; canvas header shows toggle only while closed | web |
| One rail entry per tool | One entry per PTY, action and Browser page | Terminals, action runs and Browser pages become row-1 tabs; rail keeps one entry per tool | web, docs (ADR) |
| Subagent detail as its own rail tab | Detail replaces the list inside Subagents | Repeatable `subagent` rail instance after Subagents, divider, provider icon, green dot | web |
| Closing the last tab closes the panel | Empty state stays visible | `closeRightPanelTabInstance` hides the panel when none remain | web |
| Coordination tab gone | Catalog, rail, empty state, panel, client store | Delete client surface; keep server thread control | web (contracts/server optional, see Q10) |
| Files tool | "Soon" teaser | Tree, tabs, code view, Go to file, find, markdown, images, comments | contracts, server, web |
| File read for viewing | utf-8 string, 256 KB, no binary/image | Structured read: text/image/binary/too large, encoding, changed lines vs HEAD | contracts, server, web |
| M / A marks | None | `file.changes` from one `git status` | contracts, server, web |
| Image bytes | None | One authenticated, scoped image route owned by S12P-03, reused by project icons (S12T-14) with their own cap and caching | contracts, server, web |
| Files line comments ride the next message | None | `kind: "file"` composer annotation sharing S10's draft store | contracts, web |
| Subagent list for all providers | Codex polled + client narrative merge | Server `subagent.roster` + `subagents.changed` push, one entry shape | contracts, server, providers, web |
| Status words everywhere | Four vocabularies | One server status per entry and one web module (`subagent-status.ts`) mapping it to each surface's words; list, tab, chips and overview import it | server, web |
| Honest detail tiers | Canonical transcript or narrative tree | Tier per entry from persisted evidence and provider capability, never from provider identity alone; fixed copy per tier | contracts, server, providers, web |
| Stable subagent identity | Client alias guessing between two sources | Server-assigned entry id that survives late metadata, a new child thread, refetch and reconnect | contracts, server, web |
| Copilot children | System events | Roster rows (steps first, then full transcript) | providers, server |
| Mod+P Go to file | Palette alias | Rebind to `files.goToFile` | web |

## Backend architecture

### 1. Workspace files (S12P-03)

One service, `FileService` (`apps/server/src/features/projects/files/file-service.ts`), gains view-oriented reads. Scope resolution stays `resolveWorkingDir(workspaceId, threadId?)` (thread must belong to the workspace).

```ts
// packages/contracts/src/models/workspace-file.ts (new)
export const FILE_LIST_MAX_PATHS = 100_000;
export const FILE_VIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Per-caller caps of the one workspace image route; S12T-14's project icons use `icon`. */
export const WORKSPACE_IMAGE_MAX_BYTES = { file: 20 * 1024 * 1024, icon: 2 * 1024 * 1024 } as const;

/** file.list result (shape change; composer autocomplete migrates in the same ticket). */
type WorkspaceFileList = { paths: string[]; truncated: boolean };

/** file.changes: marks relative to HEAD for the tree and tabs. */
type WorkspaceFileChanges = {
  git: boolean;                         // false for non-git folders: no marks
  entries: Array<{ path: string; mark: "M" | "A" }>;
  truncated: boolean;                   // capped at 5,000 entries
};

/** file.read result (shape change; Review's context expansion migrates in the same ticket). */
type FileReadResult =
  | { kind: "text"; path: string; size: number; encoding: "utf-8" | "utf-16le" | "utf-16be";
      content: string; changedLines: Array<[start: number, end: number]> | null }
  | { kind: "image"; path: string; size: number; mime: string; url: string }   // url = workspace image route, use=file
  | { kind: "binary"; path: string; size: number }
  | { kind: "too-large"; path: string; size: number; limit: number };
```

- **Paths.** Replace the `includes("..")` check with a segment check (reject when any `/`- or `\`-separated segment is `..`), keep absolute and NUL rejection and realpath containment (symlinks that escape the root stay rejected). Return paths with `/` separators.
- **Caps.** `file.list` stops at `FILE_LIST_MAX_PATHS` and sets `truncated`. Text over 2 MB returns `too-large`. The 256 KB mention cap stays on `validateMentionPath` only (it currently also applies to `read` through `validateWorkspaceRelativePath`, `file-service.ts:130-146`; split the two).
- **Binary and encoding.** BOM decides utf-8 / utf-16; otherwise a NUL byte in the first 8 KB means `binary`; otherwise decode utf-8 with `fatal: true` and fall back to `binary` on failure. Image extensions (png, jpg, jpeg, gif, webp, avif, bmp, ico, svg) return `image`. SVG also has a text read: the Source flip calls `file.read` with `as: "text"`.
- **Changed lines.** For `text` results in a git scope run `git diff --no-color --no-ext-diff -U0 HEAD -- <path>` and parse `@@ -a,b +c,d @@`; each hunk with `d > 0` yields `[c, c + d - 1]`. Pure deletions (`d = 0`) mark nothing. Untracked files and repos without a commit return `null` (the A mark already says the whole file is new; see Q7). One `git` call per open, run alongside the file read.
- **Marks.** `file.changes` runs `git status --porcelain=v1 -z --untracked-files=all` (the command `refresh` already runs; extract one helper and keep `refresh`'s fingerprint on top of it). `??` and `A` map to `A`; any other non-deleted status maps to `M`; deletions are dropped (not on disk); renames mark the new path `A`.
- **Freshness.** Reuse `files.changed` and `file.refresh`. The Files tool mounts `useWorkspaceFileRefresh` and also calls `refreshWorkspaceFiles` on `turn.diffChanged` for its scope (debounced 500 ms). On `files.changed` it refetches `file.changes` and re-reads open files whose path is in `changedPaths` (or all of them when `wholeWorkspace`).
- **Image route (one route for Files and project icons).** S12P-03 owns it; S12T-14's project icons reuse it and its path validator, and nothing else serves workspace images. `GET /workspace-images/<workspaceId>?path=<rel>&use=<file|icon>[&threadId=<id>][&v=<version>]`, beside `/attachments/` in `ws-server.ts`, with the same auth check (`handleAttachmentRequest`, `apps/server/src/application/transport/ws-server.ts:437-449`), so `<img>` authenticates with the cookie or `?token=`.
  - Scope by caller: `use=icon` resolves against the workspace root only and rejects `threadId`; `use=file` resolves through `resolveWorkingDir(workspaceId, threadId?)`, the workspace root or that thread's worktree, and the thread must belong to the workspace.
  - Path: one validator shared with `FileService` and the icon resolver. It rejects absolute paths, drive letters, UNC paths, NUL, empty segments and any `..` segment (a name like `a..b.png` is fine), normalizes to `/`, and requires realpath containment under the scope root, so a symlink that escapes stays rejected. Extensions: png, jpg, jpeg, gif, webp, avif, bmp, ico, svg.
  - Size cap by caller from `WORKSPACE_IMAGE_MAX_BYTES`: icon 2 MB, file 20 MB.
  - Caching by caller: `use=icon` carries the icon `version` as `v` and answers `Cache-Control: private, max-age=31536000, immutable`; `use=file` answers `Cache-Control: no-store`, because a file can change while it is open.
  - Both: `Content-Type` from the extension, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. The renderer only loads the route in `<img>`, so SVG scripts never run; the Files SVG Source flip reads text through `file.read`. Any validation failure, missing file or cap breach answers 404 without echoing the path. The Files tool learns "too large" from `file.read` before it builds a URL.
- **Failure modes.** Missing file returns a typed `not_found` error the tab shows as "This file no longer exists." with Close; permission errors surface the OS message in Details. All reads are idempotent.

Per-provider: no change (files are provider-neutral).

### 2. Subagent roster (S12P-08 to S12P-11)

One server seam, one entry shape, one push. S12P-08 owns each entry's identity, provider, status and detail tier; the list, the rail tab, the chat chips (S05-08) and the overview read them and build no second model. Provider complexity stays in the adapters, which fill the existing `Agent` ToolUse input (`SubagentPresentation`) honestly and declare what they can report.

```ts
// packages/contracts/src/models/subagent-roster.ts (replaces the row/roster schemas in canonical-subagent-roster.ts; the stop schemas stay)
export type SubagentStatus = "running" | "done" | "failed" | "stopped";
export type SubagentDetailTier = "transcript" | "steps" | "meta";

export interface SubagentRosterEntry {
  /** Stable for the entry's whole life: `call:<root Agent tool call id>`, or `child:<child thread id>`
   *  only for a canonical child with no recorded source call. Enrichment never re-keys it. */
  id: string;
  provider: ProviderId;               // provider of the parent message that started it, not the thread's current provider
  title: string;                      // short task, faded; "Subagent task" until the provider says
  prompt: string | null;              // full message from the parent; null until reported (Cursor)
  subagentType: string | null;        // "worker", "Explore", "researcher", Devin profile
  model: string | null;               // display label with reasoning when known
  stepCount: number;                  // persisted descendant tool calls, nested Agent calls excluded
  status: SubagentStatus;
  startedAt: string;                  // ISO; live time is computed on the client
  endedAt: string | null;
  tier: SubagentDetailTier;           // from persisted evidence and capability (rules below)
  canStop: boolean;
  sourceToolCallId: string | null;    // root Agent call; chips and "Show in chat" find the entry by it
  childThreadId: string | null;       // set only when the canonical store holds a readable child thread
  sourceMessageId: string | null;     // parent assistant message holding the call ("Show in chat")
  parentEntryId: string | null;       // nesting kept in data, not shown in the list
}

export interface SubagentRoster {
  owningParentThreadId: string;
  epoch: string;                      // server boot id; a new epoch resets revision ordering
  revision: number;
  entries: SubagentRosterEntry[];     // running first (newest first), then finished (newest first)
  truncated: boolean;                 // capped at CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN (256)
}

export interface SubagentDetail {     // subagent.detail, tier "steps" only
  entryId: string;
  steps: Array<{ toolCallId: string; toolName: string; label: string; status: "running" | "done" | "failed"; additions?: number; deletions?: number }>;
  totalSteps: number;                 // steps holds the last 32; the view says "Showing the last 32 of N steps."
  summary: string | null;             // Agent tool result text, Devin completion summary
}
```

- **Wire.** `subagent.roster { owningParentThreadId }` replaces `canonicalAgent.roster`. `subagent.detail { owningParentThreadId, entryId }` is new. `agent.child.stop` stays. New push channel `subagents.changed { threadId: owningParentThreadId, epoch, revision }`, added to `SUBSCRIPTION_SCOPED_CHANNELS` (`apps/server/src/application/transport/push.ts:17-22`) so only subscribers of the parent receive it.
- **Server.** Rename `SubagentLifecycleService` to `SubagentRosterService` (keep `stop` and `stopDescendants` as they are). `loadRoster` merges:
  1. canonical children from `acceptedProgress.loadSubagentRoster` / `durability.loadSubagentRoster` (tier `transcript`);
  2. root `Agent` tool calls of the parent from the narrative store (`apps/server/src/features/agents/conversation/narrative/narrative-store.ts`, inferred query shape) using their persisted `SubagentPresentation`, with `stepCount` = descendant tool calls by `parent_tool_call_id`.
  Dedupe on the canonical row's `sourceItemId === "toolCall:<id>"` (the exact link the web guesses at today), never on names. Identity, tier and `canStop` are computed here, not in the UI.
- **Identity.** The id comes from persisted facts that never change. It is the root `Agent` tool call id whenever one exists: every provider's narrative call, and a Codex canonical child whose `sourceItemId` names it (Codex records the source item at dispatch, `apps/server/src/features/agents/collaboration/adapters/codex-collaboration-event-adapter.ts:778-790`). Only a canonical child with no recorded source call uses its child thread id. Enrichment adds fields to the same entry: Cursor's late `cursor/task` metadata, a Copilot child thread after S12P-11, a Codex canonical row joining its narrative call. The id stays, so an open `subagent:<id>` rail tab and a chat chip keep resolving across enrichment, refetch and reconnect.
- **Provider per entry.** `provider` is the provider recorded on the assistant message that holds the root call (`messages.provider`, `apps/server/src/runtime/persistence/sqlite/schema.ts:340`; tool calls link to it through `tool_call_records.message_id`, `:474`), falling back to the thread's provider when that column is null on old rows. A thread that switched providers lists each subagent under its own provider; for a canonical child it is the child's recorded provider identity.
- **Provider capability.** Add `subagentReporting: { childTranscript: boolean; childSteps: boolean } | null` to provider metadata in `packages/contracts/src/providers/interfaces.ts`. It states what the adapter reports today; null means the provider never reports subagents. `canStop` stays `isChildTurnCancellable(provider)`.
- **Tier from evidence and capability.** The server picks each entry's tier from what is persisted for it, with the capability only filling gaps:
  1. `transcript` only when `childThreadId` points at a canonical child the store holds (a row from `loadSubagentRoster`). A provider identity alias is not a child: Devin's fake `nativeThreadId` becomes a `canonical-alias` detail today (`packages/contracts/src/models/tool-call-record.ts:97-104,222-226`) with no readable thread behind it, so it never yields `transcript`.
  2. Otherwise `steps` when the entry has persisted steps (`stepCount > 0`) or its provider declares `childSteps`.
  3. Otherwise `meta`.
  Capability never lifts a row past its data, so old rows keep the tier their records support. Copilot rows recorded before S12P-11 have no child thread and stay `steps`, or `meta` when they recorded no steps. OpenCode declares no child steps until S12P-10 proves them from a captured stream, so its entries are `meta` until then. A `steps` entry that finished with no recorded steps shows "No steps were recorded." in place of the list (proposed copy), never an empty list under a line promising steps.
- **Push instead of polling.** `SubagentRosterService` keeps an in-memory revision per parent. It bumps when (a) canonical `rosterRevision` moves (`accepted-codex-collaboration.ts:240, 401`), or (b) `provider-turn-event-application.ts` applies a ToolUse/ToolResult whose tool is `Agent` or whose ancestor is an `Agent` call. Pushes coalesce per parent at 250 ms. The web keeps one roster per parent in `subagentRosterStore`, fetches on first use, refetches when `(epoch, revision)` is newer, and refetches on reconnect. No interval anywhere; providers without subagents never cause a fetch beyond the first.
- **Status normalization** (one function on the server, `subagentStatusFrom`): running until the child's work finishes (CONTEXT "Sub-agent call"); `Completed` / successful result → `done`; `Errored` / error result → `failed`; `Cancelled`, `Interrupted`, parent stop, or turn cancel while running → `stopped`. The web has one module, `features/subagents/subagent-status.ts`, that maps the status to each surface's board words: list and rail tab "Running", "Done", "Failed", "Stopped"; chat chips (05c) "working", "finished", "failed", "stopped"; overview counts `{ active, done }`. Section 05's chips and overview row import it, and no surface derives a status from tool-call state itself.
- **Idempotency and failure.** Reads are pure. `stop` already dedupes per key (`subagent-lifecycle-service.ts:50-61`). Lost pushes heal on reconnect. Roster read errors show "Couldn't load subagents" with Retry in the list; the rail dots keep the last good roster.

Per-provider decisions:

| Provider | Title | Prompt | Type / model | Steps | `subagentReporting` and resulting tier | Stop | Change |
|---|---|---|---|---|---|---|---|
| Codex | First line of the spawn task (inferred: Codex has no separate short title) | Spawn input (`task`) | identity / model + reasoning | Child tool items (count from the child turn) | `{ childTranscript: true, childSteps: false }`; transcript when the canonical child exists | Yes (`interruptChildTurn`) | Status normalization only; data source moves to `subagent.roster`. |
| Copilot | `description` from the `task` tool arguments, else `agentDisplayName` (inferred argument name) | `agentDescription` | `agentName` / none | Child tool events with `parentToolCallId` | null today (no rows); `{ false, true }` from S12P-10 (steps); `{ true, false }` from S12P-11 for new rows, while rows recorded before it stay steps or meta | No | Map child tool events to nested ToolUse/ToolResult with `parentToolCallId` instead of system events; summary from the parent `task` tool result; later, child assistant text into a canonical child thread. |
| Claude | Agent `description` | Agent `prompt` | `subagent_type` / Agent `model` when set | Child tool calls by `parent_tool_use_id` | `{ false, true }`; steps | No | Turn cancel while an Agent call runs ends it `stopped`, not failed (S12P-09). |
| Devin | `title`, else `task` | `task` | `profile` / none | Child tool calls by `subagent_context.parentAgentId` | `{ false, true }`; steps. Old rows with the fake `nativeThreadId` alias also resolve to steps, never transcript | No | One logical subagent: merge the lifecycle call into the `run_subagent` marker (no second Agent call, no `parentToolCallId` nesting, no `nativeThreadId`); summary from `subagent_completed` (S12P-09). |
| Cursor | Provisional ACP title stripped of "Task:" from `tool_call`, replaced by `cursor/task` `description` when it lands | `cursor/task` `prompt` (null until then) | `subagentType` / `model` (late) | None | `{ false, false }`; meta | No | Drop the `browser`/`explore` discriminator and title heuristics; only `_toolName === "task"` / `cursor/task` make a subagent; late metadata merges in place through `mergeSubagentPresentation` and bumps the roster without changing the entry id (S12P-09). |
| OpenCode | `task` tool `description` (inferred) | `task` tool `prompt` (inferred) | `subagent_type` / none | Child-session tool events, only if a captured stream shows they carry the parent link (unverified) | null today; `{ false, false }` from S12P-10, so meta, until that stream proves child steps; then `{ false, true }` and steps | No | Map the `task` tool to `Agent`. Capture a real stream first; route child-session tool events under the call and declare `childSteps` only if it proves them (S12P-10). |

Detail copy per tier (exact strings; provider name from the catalog):
- transcript: no explanatory line.
- steps: "{Provider} shares its steps and a summary, not the full conversation." A finished entry with no recorded steps shows "No steps were recorded." in the list's place (proposed), and the Summary block appears only when a summary exists.
- meta: "{Provider} doesn't share this subagent's steps or answer. Its result is in the reply that followed." plus a "Show in chat" pill.

### 3. Panel state (F-05, S12P-01, S12P-13)

```ts
// stores/diffStore.ts
export type RightPanelTool = "preview" | "terminal" | "files" | "changes" | "environment" | "tasks" | "subagents";
export type RightPanelTabInstance =
  | { id: `singleton:${RightPanelTool}`; type: RightPanelTool }
  | { id: `subagent:${string}`; type: "subagent"; entryId: string };   // thread-only, grouped after Subagents; entryId is the roster's stable id
```

- Rail order stays user-controlled (drag, Alt+Shift+Up/Down). Subagent instances always render as a group directly after the `subagents` entry, separated by a divider; they reorder only within the group.
- Opening a subagent detail inserts the Subagents entry if missing (not activated), then the `subagent:<id>` instance at the end of the group, and activates it. At most 8 subagent tabs per thread; opening a ninth closes the oldest inactive one (Q4).
- Closing the Subagents entry closes its subagent tabs (Q4).
- Terminal shells, action runs and Browser pages leave `tabInstances`; their order and active item live where they already do (`features/terminal/state/terminalStore.ts`, `features/preview/state/previewTabsStore.ts`). Files keeps its own per-scope tab list in a new `filesTabsStore` (in memory, per panel scope, same lifetime rules as the panel record).
- `closeRightPanelTabInstance` sets `visible: false` when the last instance closes (CONTEXT). A tool decides its own empty state when its last row-1 tab closes: Terminal closes its rail entry (which may close the panel), Files falls back to the tree, Browser per S11.
- Per-thread state with workspace fallback (ADR-0012) is kept as implemented. Recommendation: record it in the new ADR as accepted and mark ADR-0004's width/active-tab split superseded there (do not edit old ADR bodies).

## Components

### New
- `components/panels/shell/PanelHeader.tsx`: row 1 (48; left padding 8; right padding = caption-overlay width − 48 + 8, read from `env(titlebar-area-x)` / `env(titlebar-area-width)`, 8 on macOS and full screen; gap 8; drag region except controls) with a `leading` slot (tab strip, picker or title pill), a spacer, round expand and round panel toggle; optional row 2 (40; padding-inline 8; gap 8).
- `components/panels/shell/PanelTabStrip.tsx`: horizontal tabs (32 tall, radius `--radius-control`, padding 10/12, gap 8, 14px icon, 14/20 medium label; active `--color-selected` fill and ink, inactive muted; hover swaps the icon slot for a 14px close; strip clips with a 24px right fade; round + pinned after the strip).
- `components/panels/shell/PanelTitlePill.tsx`: icon + title pill (selected fill, radius `--radius-control`, max width 320, fade).
- `components/panels/RailSubagentTab.tsx` and `RailDivider` (1px `--color-border`, 20 wide, margin 4).
- Files: `features/files/` with `FilesTool.tsx`, `FileTree.tsx` (virtualized, 28 rows, compact folders from `lib/file-tree.ts`), `CodeFileView.tsx`, `GoToFilePopover.tsx`, `FindInFileBar.tsx`, `MarkdownFileView.tsx`, `ImageFileView.tsx`, `FileCommentEditor.tsx` (reuses the plan comment editor), `filesTabsStore.ts`, `rank-file-path.ts`.
- Subagents: `features/subagents/list/SubagentList.tsx`, `SubagentListRow.tsx`, `features/subagents/detail/SubagentDetailTab.tsx`, `ParentPromptBubble.tsx`, `state/subagentRosterStore.ts` (with `entryForToolCall(threadId, toolCallId)` for chips), `features/subagents/subagent-status.ts` (`subagentStatusLabel`, `subagentChipWord`, `countSubagents`, `formatLiveDuration`).
- Server: `SubagentRosterService` (renamed), `workspace-image-route.ts` (the one image route), `git-change-marks.ts`.
- Contracts: `models/workspace-file.ts`, `models/subagent-roster.ts`, `FileAnnotationPayloadSchema` (`kind: "file"`, `filePath`, `line`, `lineContent`, `note`, `id`, `displayNumber`) in `models/browser-preview.ts`'s `ComposerAnnotationPayloadSchema` union.

### Changed
- `components/panels/RightPanel.tsx`, `ActivityRail.tsx`, `PanelEmptyState.tsx`, `lib/panel-tabs.ts`, `stores/diffStore.ts`, `lib/right-panel-layout.ts`, `components/chat/HeaderActions.tsx`, `app/App.tsx` (commands), `config/default-keybindings.json`, `lib/context-tracker.ts` (`filesFocused`).
- `features/subagents/detail/open-subagent-detail.ts` (opens a rail instance), `features/subagents/roster/SubagentsPanel.tsx` (replaced by the list), chat chips and overview read the roster store (their visuals belong to section 05).
- `components/diff/ReviewDiffView.tsx:476` (structured `file.read`), `components/chat/useFileAutocomplete.ts` (list shape, shared cache moves to `features/projects/files/workspace-file-list.ts`), `features/preview/state/previewAnnotationStore.ts` and `lib/composer-feedback.ts` (file annotations).
- Server: `file-service.ts`, `file-rpc.ts`, `ws-server.ts`, `subagent-lifecycle-service.ts`, `provider-turn-event-application.ts`, `push.ts`.
- Providers: `copilot-event-mapper.ts`, `cursor-subagent-detection.ts`, `cursor-acp-task.ts`, `cursor-acp-event-mapper.ts`, `devin-acp-event-mapper.ts`, `claude-event-mapper.ts` (cancel status), `apps/server/.../opencode/opencode-event-mapper.ts`.
- Docs: new ADR, `CONTEXT.md` ("Right panel", "Tab availability", "Terminal tab", new "Files tab", "Sub-agent call" status words), DESIGN.md "Right panel" pane entry and "Pane behavior" bullets, `docs/internals/conversation/narrative-pipeline.md:240` (link to the new detail file).

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| Rail "Close panel" row and rail Maximize button | `ActivityRail.tsx:694-743` (`RailHeader`) | Round expand and toggle in panel row 1 | F-05 | `rg -n "rail-panel-toggle\|rail-maximize-toggle\|RailHeader" apps/web/src` returns nothing (the row-1 toggle keeps the tooltip "Close panel") |
| Canvas header toggle while the panel is open | `HeaderActions.tsx:60-80` (`aria-pressed`) | Toggle renders in the canvas header only when closed; row 1 owns it when open | F-05 | `rg -n "aria-pressed=\{panelVisible\}" apps/web/src/components/chat` returns nothing |
| Dead `ScopeProgress` and `scope`/`scopeProgress` props | `ActivityRail.tsx:45-49`, `RightPanel.tsx:1206, 863` | Nothing | F-05 | `rg -n "ScopeProgress\|scopeProgress" apps/web/src` returns nothing |
| Per-terminal and per-action rail entries | `rightPanelTerminalId`, `rightPanelActionTerminalId` (`stores/diffStore.ts:168-175`), `useRailTerminalLabels` (`RightPanel.tsx:1015`), terminal branch of `RailTabInstances` | Terminal row-1 tabs from `terminalStore` | S12P-01 | `rg -n "rightPanelTerminalId\|rightPanelActionTerminalId\|useRailTerminalLabels" apps/web/src` returns nothing |
| Per-page Browser rail entries and their per-page agent pointer | `pageLabel`, `BrowserPageGroup`, `BrowserPageRailTab`, `browserPageRailClass`, `BrowserPageRailGlyph` (`ActivityRail.tsx:363-550`), the `agentControlled` pointer inside the page tab (`:401-425`), and the `:786` mount | Browser row-1 tabs from `previewTabsStore` (S11-04 restyles them as `BrowserTabStrip`; S11-07 moves the pointer to the tab and the rail glyph) | S12P-01 | `rg -n "BrowserPageGroup\|BrowserPageRailTab\|BrowserPageRailGlyph\|browserPageRailClass\|data-rail-browser-page" apps/web/src` returns nothing |
| `"action-terminal"` and `"terminal"` rail instance types | `RightPanelTab` union (`stores/diffStore.ts:8`), catalog "Project Action" entry (`lib/panel-tabs.ts:69-76`) | `RightPanelTool` with one `terminal` entry | S12P-01 | `rg -n "\"action-terminal\"" apps/web/src` returns nothing |
| ADR-0020's per-shell rail tabs and four-shell cap | `docs/adr/0020-repeatable-terminal-tabs-in-right-panel-order.md` front matter | The one right-panel tabs ADR written in S12P-01 (eight records per scope from S12T-01) | S12P-01 | `rg -n "^status: accepted" docs/adr/0020-repeatable-terminal-tabs-in-right-panel-order.md` returns nothing (the file stays, marked `status: superseded` with a link; ADRs are not deleted) |
| CoordinationPanel and its test | `components/panels/CoordinationPanel.tsx`, `.test.tsx` | Nothing (thread-operation approvals reach the owner thread's dock, per S06-01) | S12P-02 | `rg -n "CoordinationPanel" apps/web/src` returns nothing |
| Coordination catalog, union member, content slot | `lib/panel-tabs.ts:119-125`, `stores/diffStore.ts:8`, `RightPanel.tsx:655, 726-739` | Nothing | S12P-02 | `rg -n "\"coordination\"" apps/web/src` returns nothing |
| `openThreadCoordinationPanel` | `lib/open-thread-coordination.ts` and test | Nothing | S12P-02 | `rg -n "openThreadCoordinationPanel" apps/web/src` returns nothing |
| Client thread-control store and transport | `stores/threadControlStore.ts` (+test), `ws-events.ts:223, 261, 627-629, 642`, `ws-transport.ts:613-617, 1267-1275`, `transport/types.ts:470-477` | Nothing | S12P-02 | `rg -n "useThreadControlStore\|readThreadControl\|sendThreadControl\|stopThreadControl" apps/web/src` returns nothing |
| User-facing `thread.control.read/send/stop` WS methods (if Q10 says yes) | `packages/contracts/src/ws/methods.ts:861-875`, `apps/server/src/features/thread-control/transport/thread-control-rpc.ts` | MCP tools (unchanged) | S12P-02 | `rg -n "thread\.control\.(read\|send\|stop)" packages apps` returns nothing |
| Files "Soon" teaser | `comingSoon` (`lib/panel-tabs.ts:34-35, 83, 131-155`), `SoonBadge` (`PanelEmptyState.tsx`), `PanelTabTypeId = RightPanelTab \| "files"` | Real Files tool entry | S12P-04 | `rg -n "comingSoon\|SoonBadge" apps/web/src` returns nothing |
| `mod+p` palette alias | `config/default-keybindings.json:3`, the alias command registration `commandPalette.toggle` (`App.tsx:673-683`) | `files.goToFile` on `mod+p`; the palette stays on `mod+k` (`palette.open`) | S12P-04 | `rg -n 'mod\+p", "command": "commandPalette\|id: "commandPalette\.toggle"' apps/web/src` returns nothing (only the binding and the alias registration; `palette.open` is untouched) |
| Old `file.read` string result and 256 KB view cap | `file-service.ts:107-117, 219-227` (cap moves to mentions only) | `FileReadResult` | S12P-03 | `rg -n "rpc<string>\(\"file.read\"" apps/web/src` returns nothing, and the `file-service` test reading a 1 MB text file passes |
| Canonical roster polling | `SubagentsPanel.tsx:469-511` (`setInterval`, 1,500 ms) | `subagents.changed` push + `subagentRosterStore` | S12P-08 | `rg -n "setInterval\(.*1_500" apps/web/src/features/subagents` returns nothing (the list's one-second live-time tick is allowed) |
| Client roster merge and alias guessing | `roster/narrative-subagents.ts`, `roster/subagent-projection.ts` roster paths, `dedupeNarrativeRoster`, `resolveCanonicalSubagentSelection` | Server `subagent.roster` | S12P-08 | `rg -n "dedupeNarrativeRoster\|useNarrativeSubagentRoster\|resolveCanonicalSubagentSelection" apps/web/src` returns nothing |
| `canonicalAgent.roster` method and `CanonicalSubagentRoster(Row)` schemas | `methods.ts:1185-1188`, `canonical-subagent-roster.ts:57-109` | `subagent.roster`, `SubagentRosterEntry` | S12P-08 | `rg -n "canonicalAgent.roster\|CanonicalSubagentRosterRow" packages apps` returns nothing |
| Status word variants | `SubagentsPanel.tsx:88-96`, `narrative-subagents.ts:88-92`, `subagent-projection.ts:411-416` | Server `subagentStatusFrom` plus the web `subagent-status.ts` module | S12P-08 | `rg -n "\"Errored\"\|\"Finished\"\|\"Working\"\|\"Interrupted\"" apps/web/src/features/subagents -g "!**/__tests__/**"` returns nothing (tests keep canonical input words as fixtures) |
| Cursor subagent heuristics | `cursor-subagent-detection.ts:15-41` and callers (`cursor-acp-event-mapper.ts:530`, stream-json mapper) | Exact `_toolName === "task"` / `cursor/task` detection | S12P-09 | `rg -n "isCursorSubagentDelegationTitle\|isCursorSubagentDelegationDiscriminator" packages` returns nothing |
| Devin second Agent call and fake `nativeThreadId` | `devin-acp-event-mapper.ts:362-401` | One merged Agent call per subagent | S12P-09 | `rg -n "nativeThreadId" packages/providers/src/private/devin` returns nothing |
| "Earlier activity is truncated." | `detail/NarrativeDetailView.tsx:96` | "Showing the last 32 of N steps." in `SubagentDetailTab` (S12P-08 already returns the last 32) | S12P-13 | `rg -n "Earlier activity is truncated" apps/web/src` returns nothing |
| Copilot child system events | `copilot-event-mapper.ts:29` (`copilot_child:`) | Nested tool events, then child thread | S12P-10 | `rg -n "copilot_child:" packages` returns nothing |
| Old roster rows, Active/Done sections, Stop all | `CanonicalRosterRow`, `NarrativeRosterRow`, `CanonicalRosterMetadata`, `CanonicalRosterTimestamp`, `SubagentRosterList`, `StopAllConfirmationDialog`, `useStopAllControl` (`SubagentsPanel.tsx`) | `SubagentList` / `SubagentListRow` | S12P-12 | `rg -n "CanonicalRosterRow\|NarrativeRosterRow\|StopAllConfirmationDialog" apps/web/src` returns nothing |
| Roster tab state | `SubagentRosterTab`, `subagentRosterTabByThread`, `get/setSubagentRosterTab` (`stores/diffStore.ts:11, 439, 623-625, 893-899`) | Divider list (no tabs) | S12P-12 | `rg -n "SubagentRosterTab\|subagentRosterTabByThread" apps/web/src` returns nothing |
| In-panel detail selection | `SubagentDetailSelection`, `subagentDetailByThread`, `selectSubagentDetail`, `clearSubagentDetail`, `CanonicalDetailView`, `NarrativeDetailView`, back button | `subagent:<id>` rail instances + `SubagentDetailTab` | S12P-13 | `rg -n "subagentDetailByThread\|CanonicalDetailView\|NarrativeDetailView\|Back to subagents" apps/web/src` returns nothing |
| Dead subagent pieces | `SubagentChangeSummary`, `SubagentLifecycleStatus`, `subagentReviewScopeByThread` + setters + `DiffPanel.tsx:203-220` read, `features/subagents/identity/format-subagent-identity.ts` (its two callers go in S12P-12 and here) | Nothing; titles come from the roster entry | S12P-13 | `rg -n "SubagentChangeSummary\|SubagentLifecycleStatus\|subagentReviewScope\|formatSubagentIdentity" apps/web/src` returns nothing |

Not retired here: the subagent identity glyph and its colours. F-06 replaces every caller with the provider icon and owns that row (foundation ledger).

Not retired: `components/files/FilesPanel.tsx` (Review and PR navigator shell, owned by S10); `PanelEmptyState` (its list changes in S12P-02 and S12P-04, the component stays as the create surface when the panel is opened with no tools).

## Proposed tickets

Order: S12P-03 and S12P-08 have no blockers and can start at once. S12P-02's acceptance check needs S06-01's approval routing. F-05 waits on F-01, F-03 and section 01's caption-overlay shell.

### F-05 Right panel shell: two-row header, right-edge rail, panel controls

- **Blocked by:** F-02 Fade truncation primitive; F-03 Button primitives; F-04a Menu primitive; F-07a Overlay surfaces and side placement; S01-01 Window chrome without a title bar.
- **Boards:** 12f (`234Z-2`), 12g (`23HJ-2`), 10a (`2241-2`), 11a (`22JT-2`), 12a (`22UJ-2`), 12h (`23RB-2`), 08a (`21EL-2`), Right rail · dark · expanded (`27A-0`, p-5-0)
- **Delivers:** The panel looks and behaves like one shell for every tool. The rail sits on the right edge under the caption buttons. Each tool shows a 48 row 1 beside the window controls and, when it has controls, a 40 row 2; no header control floats over content. Expand and panel toggle are round icons at the end of row 1; with the panel closed the toggle sits in the canvas header at the same spot. Closing the last rail entry closes the panel.
- **Build notes:**
  - Layout: `RightPanelFrame` renders content then rail. Rail: width 48, `border-left: 1px var(--color-border)`, `padding-top: 56`, inner padding 8, gap 4; entries 32 tall, radius 8, 16px icons `--color-muted`; active entry `--color-selected` fill, ink icon and a 2px amber inner-edge bar (`box-shadow: var(--color-primary) -8px 0 0 -6px`). Keep hover expansion to 160 (`--container-right-rail-expanded`) with labels, Review badge, × on the hovered row and "New tab"; it now expands leftward over the body. Drop the Close panel row. Update the Browser overlap coordinator for the new direction.
  - `PanelHeader` (row specs under Components). Row 1 right padding comes from the caption overlay width (98 at a 138 overlay: overlay − rail 48 + 8). Row 1 spacer is a drag region; tabs and buttons are `no-drag`.
  - Mount each tool's current header content into the slots without restyling it (Review `DiffToolbar` → row 1 picker + row 2 controls, Browser header → rows, Plan header → row 1, Project settings → rows, Subagents → row 1 title pill). Section tickets restyle.
  - Expand = `uiStore.rightPanelMaximized` toggle (tooltip "Expand" / "Restore"); toggle = `toggleRightPanelAdaptive` (tooltip "Close panel · Ctrl Alt B"). `HeaderActions` renders its toggle only when `!panelVisible`.
  - `closeRightPanelTabInstance`: when no instances remain, set `visible: false` and clear maximize. Surface `terminalKill` failures as a toast instead of swallowing them (`RightPanel.tsx:947-951`).
  - Rail icons (Lucide): Browser `Globe`, Terminal `Terminal`, Files `Files`, Review `Diff`, Plan per Q13, Project settings `Settings`, Subagents `Layers`.
  - Docs: rewrite DESIGN.md "Right panel" pane entry and "Pane behavior" bullets to point at Paper and per-thread state.
- **Deletes:** rail Close panel and rail Maximize; open-state canvas toggle; `ScopeProgress`. (Tool headers are relocated, not deleted; each section restyles its own.)
- **Acceptance criteria:**
  - [ ] Rail renders to the right of the body on Windows, macOS and web; no rail entry sits under the caption buttons.
  - [ ] Every tool shows row 1 at 48; tools with controls show row 2 at 40; nothing in a header overlaps the body.
  - [ ] Expand toggles full width and back; the toggle closes the panel and reappears in the canvas header at the same x position.
  - [ ] Closing the last rail entry hides the panel; reopening shows the empty state.
  - [ ] Hovering the rail expands it leftward with labels and × on the hovered row; no Close panel row.
  - [ ] A failed terminal kill shows an error instead of silently keeping the tab.
- **Verify:** extend `components/panels/RightPanel.test.tsx`, `ActivityRail.test.tsx`, `apps/web/src/__tests__/diffStore.test.ts` (last close hides), `lib/__tests__/right-panel-layout.test.ts`. Live: `agent:up --desktop`, open Review, Browser, Terminal, Plan; screenshot each against 10a / 11a / 12a / 07e; close every rail entry and confirm the panel closes; Windows caption buttons never cover row-1 controls.

### S12P-01 Rail lists tools; terminals and browser pages become row-1 tabs

- **Blocked by:** F-05 Right panel shell: two-row header, right-edge rail, panel controls; S12T-01 Terminals survive exit and are listed by the server.
- **Reconciled:** Writes the single ADR for right panel tabs (rail = tools, row-1 tabs inside a tool), superseding ADR-0020. Terminal cap is eight records per scope (pending, running and exited, shells and actions together) from S12T-01's contract constant; + disables at eight. S12T-02 writes no ADR.
- **Boards:** 12a (`22UJ-2`), 11a (`22JT-2`), 12f (`234Z-2`)
- **Delivers:** The rail has one entry per tool. Terminals (shells and action runs) appear as tabs in Terminal's row 1 with a round +; Browser pages appear as tabs in Browser's row 1 with a round +. Closing the last terminal tab closes the Terminal entry.
- **Build notes:** Introduce `RightPanelTool` and the `RightPanelTabInstance` union (Backend 3) with a store migration for in-memory records (drop terminal/action instances, keep a `singleton:terminal` when any existed). Add `PanelTabStrip`. Terminal strip reads `terminalStore` (scope list, active terminal) and action runs; Browser strip reads `previewTabsStore` and carries the existing per-page agent pointer until S11-07 moves it. Existing labels and glyphs only; 12a and S11 restyle. `mod+j` and `mod+shift+b` keep working.
  - Cap: use S12T-01's contract constant `TERMINAL_MAX_PER_SCOPE` (8), never the web's retired four (`terminalStore.ts:70`). It counts every terminal record in the scope, pending, running and exited, shells and action runs together. The + disables at eight with the reason in its tooltip ("8 terminals are open. Close one to open another.", proposed to match S12T-01's start error).
  - ADR: this ticket writes the single ADR for right-panel tabs (next free number at merge; see Q15): "Rail lists tools; terminals and pages are tool tabs; subagent detail tabs; closing the last tool closes the panel". It supersedes ADR-0020 (`docs/adr/0020-repeatable-terminal-tabs-in-right-panel-order.md`): per-shell rail tabs and the four-shell cap give way to one Terminal rail entry, row-1 terminal tabs and S12T-01's eight-record cap, and the process-tree kill stays. It records ADR-0012 as the accepted state model. Mark ADR-0020 `status: superseded` with a link. S12T-02 writes no ADR. Update CONTEXT.md "Tab availability" and "Terminal tab".
- **Deletes:** per-terminal and per-action rail entries; per-page Browser rail entries and their per-page pointer; `"action-terminal"` rail type; ADR-0020 marked superseded.
- **Acceptance criteria:**
  - [ ] Two shells and one action run show one Terminal rail icon and three row-1 tabs.
  - [ ] Three Browser pages show one Browser rail icon and three row-1 tabs.
  - [ ] Reordering the rail never splits a tool's tabs.
  - [ ] With eight terminal records in a scope, in any mix of pending, running and exited shells and action runs, the + is disabled with its reason; closing one enables it again.
  - [ ] The new ADR names the eight-record cap from `TERMINAL_MAX_PER_SCOPE`, and ADR-0020 reads `status: superseded`.
- **Verify:** `ActivityRail.test.tsx`, `RightPanel.test.tsx`, `apps/web/src/__tests__/diffStore.test.ts`, `lib/__tests__/panel-tabs.test.ts`. Live: open two terminals and two pages; screenshot rail and row 1.

### S12P-02 Remove the Coordination tab

- **Blocked by:** S06-01 Approval v2 contract, ApprovalService, fail-closed path.
- **Boards:** none (removal)
- **Delivers:** No Coordination entry in the rail, empty state or add menu. A thread-operation approval raised by a coordinating thread still shows where S06 puts it: on the owner (source) thread's approval dock and sidebar row, with the target thread named in the request.
- **Build notes:** Delete the panel, catalog entry, union member, content slot, opener, client store, ws-events hooks and transport methods. Decide Q10 before touching the server WS methods; the MCP tools and `ThreadControlService` stay. Approval routing is S06-01's rule, not this ticket's: for thread operations `ApprovalRequest.threadId` is the owner thread and the `thread_operation` subject carries `targetThreadId` (`06-approvals.md`, Backend architecture). The acceptance check below asserts that rule, so it runs against S06-01's routing.
- **Deletes:** Coordination rows in the ledger.
- **Acceptance criteria:**
  - [ ] Every proof command for S12P-02 returns nothing.
  - [ ] Supervised cross-thread send fixture: an agent in thread A calls `thread_send` targeting thread B. A's approval dock shows the request and A's sidebar row reads "Approval required"; B shows neither; the request names B as the target.
- **Verify:** `bun run --cwd apps/web test -- src/lib/__tests__/panel-tabs.test.ts src/components/panels/__tests__/PanelEmptyState.test.tsx`; the cross-thread fixture as a server test beside `apps/server/src/features/thread-control/authority/__tests__/thread-control-service.test.ts` (request lands on the owner thread) and a web test asserting the owning dock and the sidebar marker. Live: open the empty state; no Coordination row.

### S12P-03 Files backend: capped list, change marks, structured read, image route

- **Blocked by:** None (can start immediately).
- **Reconciled:** Owns the single authenticated, scoped image-read route used by Files and by project icons (S12T-14): workspace-root and thread-worktree scopes, per-segment path checks, SVG handling, caller-specific size caps (icon 2 MB, Files 20 MB) and caching.
- **Boards:** 12c (`2G4U-2`)
- **Delivers:** The server can answer everything the Files tool needs: the project file list (bounded), M/A marks, a typed read (text with encoding and changed lines, image URL, binary, too large) and image bytes over the one authenticated, scoped image route that project icons also use. Review's context expansion keeps working on the new read.
- **Build notes:** Backend 1. Contracts in `models/workspace-file.ts`, including `WORKSPACE_IMAGE_MAX_BYTES`; `file.changes` new; `file.list` and `file.read` change shape with their callers (`useFileAutocomplete.ts`, `ReviewDiffView.tsx:476`) migrated here. Split the mention cap from the view cap. One path validator with the segment-based `..` check, shared by `FileService` and the image route and exported for S12T-14's icon resolver. `workspace-image-route.ts` mounted in `ws-server.ts` beside `/attachments/`, serving both callers: `use=file` (workspace root or thread worktree, 20 MB, `no-store`) and `use=icon` (workspace root only, 2 MB, immutable with `v`). S12T-14 adds no second route and copies no path, auth or SVG handling.
- **Deletes:** old string `file.read` result and the 256 KB cap on viewing.
- **Acceptance criteria:**
  - [ ] `a..b.ts` reads; `../x`, `a/../../x`, absolute paths and symlinks escaping the root are rejected, by `file.read` and by the image route alike.
  - [ ] A 3 MB text file returns `too-large`; a PNG returns `image` with a URL that serves with `nosniff` and the sandbox CSP and requires auth; a file with NULs returns `binary`; a UTF-16 LE file with BOM decodes.
  - [ ] The image route enforces the caller's cap and caching: a 3 MB PNG serves for `use=file` and answers 404 for `use=icon`; `use=file` answers `Cache-Control: no-store`; `use=icon` with `v` answers `immutable`; `use=icon` with a `threadId` answers 404.
  - [ ] Editing lines 12 to 15 of a tracked file returns `changedLines: [[12, 15]]`; untracked returns `null` and mark `A`.
  - [ ] Non-git folder: `file.changes` returns `git: false`.
- **Verify:** extend `apps/server/src/features/projects/files/__tests__/file-service.test.ts`, `file-service-unicode-paths.integration.test.ts`, `transport/__tests__/file-rpc.test.ts`; route test for both callers beside the attachment route tests (inferred location). Use `.dev/fixture-repo` only.

### S12P-04 Files tool: tree, file tabs, code view, Go to file

- **Blocked by:** S12P-01 Rail lists tools; terminals and browser pages become row-1 tabs; S12P-03 Files backend: capped list, change marks, structured read, image route; F-02 Fade truncation primitive; F-04b Picker primitive; F-05 Right panel shell: two-row header, right-edge rail, panel controls; F-07a Overlay surfaces and side placement.
- **Boards:** 12c (`2G4U-2`: Code file, Go to file, Wide panel, Tree), 12f (`234Z-2`)
- **Delivers:** Files opens from the rail, empty state or Ctrl P. Opened files are row-1 tabs. Row 2 holds the tree toggle, path pill and More. The body shows read-only code with line numbers, token colours and amber bars on lines changed since HEAD. The tree docks at 280 from an 800 body (resizable 220 to 480) or toggles as a body view below that.
- **Build notes:**
  - Catalog: Files becomes a real singleton (`needsThread: false`, command `files.toggle`, no default key); scope follows ADR-0004 (workspace root or thread worktree).
  - Row 1: `PanelTabStrip` of open files (vscode-icons file-type icon from `lib/vscode-icons.ts`, name), round + opens Go to file.
  - Go to file: popover under the strip (380 wide, `--color-panel`, 1px border, radius 14, padding 6, shadow `#00000080 0 16px 40px`; search row 36 with bottom border; result rows name 14/20 + folder 12/16 muted, active row `--color-hover` radius 8). Fuzzy subsequence ranking in `rank-file-path.ts` (basename and segment-start bonuses, matched letters ink). Enter opens and activates; Ctrl Enter opens the file as a tab right after the active one without switching (Q2); Esc closes. List comes from the shared scoped cache.
  - Row 2: round tree toggle; path pill (radius 18, selected fill, 13/20, folder muted, name ink, 24px fade; click copies the relative path with a "Copied" tooltip; clicking a folder segment opens the tree revealed at that folder); round Find (S12P-05); round More: Open in editor (default open-in app at the current line through the `FileEditorPicker` plumbing), Reveal (file manager), Copy path (absolute, Q17). Below the dock breakpoint with the tree showing, row 2 becomes a "Go to file · Ctrl P" field (opens the popover) plus More.
  - Tree: virtualized; rows 28, padding-inline 8, radius 8, gap 6, 13/18; compact folders from `buildFileTree`; folders with changes get a 6px amber dot; file marks mono 11/16 (`M` `--color-primary`, `A` `--color-success`, name tinted the same); current file on `--color-selected`; docked pane has a 1px right border (`box-shadow: var(--color-border) -1px 0 0 inset`), padding 6. Picking a file in body-view mode opens it and returns to the file. Dock rule: body width ≥ tree width + 520 (same helper as S10's Review pane, Q11).
  - Code view: virtualized lines; mono 13/20; gutter 44 right-aligned with padding-right 14, numbers muted; changed lines get `box-shadow: var(--color-primary) 2px 0 0 inset`; highlighting through the shiki worker with a CSS-variables theme mapped to Paper roles (keyword `--color-pr-merged`, string `--color-success`, tag `--color-link`, comment `--color-muted`, default `--color-ink`); body on `--color-background`, padding-block 12; long lines scroll horizontally (no wrap).
  - States: loading (header rows stay; the body shows one muted "Loading…" line), not found ("This file no longer exists." + Close tab), too large ("Too large to show · 3.1 MB" + Open in editor), binary ("Binary file · 412 KB" + Open in editor), empty file ("Empty file"), list truncated (tree footer "Showing 100,000 files"), non-git (no marks).
  - Freshness per Backend 1. Keybindings: `mod+p` → `files.goToFile` (opens Files if needed, then the popover). Add `filesFocused` to `context-tracker`.
  - CONTEXT.md: add "Files tab" (project files in the right panel, distinct from Review's Files navigator).
- **Deletes:** Files "Soon" teaser; `mod+p` palette alias.
- **Acceptance criteria:**
  - [ ] Ctrl P from chat opens Files and Go to file; typing "thread act" ranks `ThreadActionsMenu.tsx` first; Enter opens it as the active tab.
  - [ ] Editing a tracked file outside Mcode and refocusing the window updates its amber bars and tree mark.
  - [ ] At a 900 body the tree docks at 280 and resizes between 220 and 480; at 536 the tree toggles as a body view and row 2 shows the Go to file field.
  - [ ] Closing the last file tab shows the tree; closing the Files rail entry closes the tool.
  - [ ] Paths with spaces and non-ASCII names open (fixture-repo).
- **Verify:** unit tests for `rank-file-path.ts` and the tree model; component test for `FilesTool` with a mocked transport (prior art `components/files/__tests__/FilesPanel.test.tsx`, `components/panels/RightPanel.test.tsx`). Live: `.dev/fixture-repo`, open three files, screenshot against 12c "Code file", "Wide panel", "Tree".

### S12P-05 Files: Find in file

- **Blocked by:** S12P-04 Files tool: tree, file tabs, code view, Go to file.
- **Boards:** 12c "Find in file" (`2G96-2`)
- **Delivers:** Ctrl F (with focus in Files) or the round Find opens a 40 find bar under row 2 with match count, case / word / regex toggles, previous, next and close; the current match is amber, others highlighted; Esc closes and returns focus to the code.
- **Build notes:** Field: selected fill, radius 18, inset 1px `--color-focus` ring while focused, 13/18; count mono 11/16 muted ("1 of 2", "No results"); toggles 24 round; previous / next / close 32 round. Search runs over the decoded text in a worker-safe chunked loop; invalid regex shows "Invalid pattern" in the count slot. Find button shows pressed while open. Reuse the terminal find bar component if 12a builds one first (coordinate).
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] Enter / Shift Enter step through matches and scroll them into view; counts update as you type.
  - [ ] Ctrl F in the terminal or chat does not open the Files find bar.
- **Verify:** component test on `FindInFileBar` with a 10k-line fixture string. Live: screenshot against `2G96-2`.

### S12P-06 Files: markdown and images

- **Blocked by:** S12P-04 Files tool: tree, file tabs, code view, Go to file.
- **Boards:** 12c "Markdown" (`2GPG-2`), "Image" (`2GRA-2`)
- **Delivers:** Markdown opens rendered with a Preview / Source pill in row 2; relative links open the target as a tab (anchors scroll; external links open in the browser). Images sit centred at fit with a "1440×900 · 182 KB" chip and a scale pill (Fit, 100%, 200%); the checker shows only behind transparent pixels; SVGs get a Source flip.
- **Build notes:** Reuse `DiffPreviewMarkdown` with a link resolver (resolve against the file's folder, reject paths leaving the root, missing targets show a toast "No file at docs/x.md"). Pill: selected fill, padding 2, segments 28 tall, active segment `--color-border`, 13/18 medium. Image chip and scale pill: radius 999, 32 tall, mono 12/16 muted chip. Image source is the S12P-03 route; dimensions from the loaded `<img>`. Row 2 has no Find for images; Markdown Source view has Find.
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] `README.md` opens rendered; clicking `CONTEXT.md` opens it as a new tab.
  - [ ] A transparent PNG shows the checker only behind transparent pixels; switching 100% scrolls a large image.
  - [ ] An SVG flips to highlighted source and back.
- **Verify:** component tests for link resolution and the scale model. Live: fixture-repo README and an image; screenshot against `2GPG-2`, `2GRA-2`.

### S12P-07 Files: line comments that ride the next message

- **Blocked by:** S12P-04 Files tool: tree, file tabs, code view, Go to file; S10-11 Comment drafts persist, one limit, mentions kept; S07-06 Plan comments and the composer chip.
- **Boards:** 12c "Code file" (`2G4Z-2`), 12f (`234Z-2`)
- **Delivers:** Hovering a code line fills it and shows a + in the gutter; clicking opens the comment editor under the line (trash, Cancel, amber check; Enter saves, Esc cancels). Saved comments persist as drafts and appear in the composer with Review's comments; sending includes them, anchored by path and line; clicking one in the composer opens Files at that line.
- **Build notes:** Gutter + is a 20 square, radius 5, `--color-ink` fill with a `--color-background` plus (Paper; the notes say amber, Q6); hovered row `--color-hover`. Editor: padding 6 / 12 / 8 / 44, card `--color-panel`, 1px `--color-control-border`, radius 10, 14/20 text; trash 28 muted; Cancel text 13/20 medium muted; check 28 round `--color-primary` with `--color-primary-ink` icon. Add `FileAnnotationPayloadSchema` (`kind: "file"`) to the composer annotation union; store in S10's persisted draft store; format in `lib/composer-feedback.ts` as `path:line` + quoted line + note. Same length limit as S10's fix.
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] A comment survives reload and thread switch, shows in the composer chip count with Review comments, and is removed after send.
  - [ ] The agent receives path, line, line text and note.
- **Verify:** unit test for the formatter (prior art in `lib/composer-feedback.ts` tests, inferred) and the store. Live: comment on line 14, reload, send; screenshot against `2G8C-2`.

### S12P-08 Subagent roster: one contract, server projection, push

- **Blocked by:** None (can start immediately).
- **Boards:** 12e (`2HDF-2`)
- **Delivers:** The Subagents panel, the chat chips and the thread overview show the same subagents, with the same identity, provider and status, for every provider that reports them, without polling. A subagent keeps its identity while late metadata or a child thread arrives, and across refetch and reconnect. Its detail tier promises only what its persisted data can show.
- **Build notes:** Backend 2. Contracts `models/subagent-roster.ts`, methods `subagent.roster` and `subagent.detail`, channel `subagents.changed` (subscription-scoped). Server `SubagentRosterService` merges canonical children and narrative Agent calls and owns the entry id, the per-entry provider, `subagentStatusFrom`, the tier rule, revision and coalesced push. Provider metadata gains `subagentReporting` with today's values (Codex transcript; Claude and Devin steps; Cursor neither; Copilot and OpenCode null until S12P-10). Web `subagentRosterStore` (fetch on first use, refetch on newer `(epoch, revision)` and on reconnect, `entryForToolCall` for chips) and `subagent-status.ts` feed the existing panel rows and the overview counts and replace the four vocabularies. Section 05's chips consume this; it has no status model of its own. Detail steps keep the last 32 with "Showing the last 32 of N steps.".
- **Deletes:** polling; client merge and alias guessing; `canonicalAgent.roster` and row schemas; status variants.
- **Acceptance criteria:**
  - [ ] A Claude thread with two Agent calls shows two rows in the panel and "2 active" (then "2 done") in the overview without any interval timer.
  - [ ] A Codex child shows once (no duplicate narrative row), keeps Stop, and has the same entry id before and after its canonical row joins its narrative call.
  - [ ] Killing the WebSocket and reconnecting refreshes the roster; every entry keeps its id, and an open subagent rail tab still resolves.
  - [ ] A cancelled turn shows its running subagents as Stopped, not Failed.
  - [ ] Old rows after upgrade: a thread recorded before this ticket (Claude Agent calls, Devin's double call with the fake `nativeThreadId`) lists one row per subagent, and no entry reports `transcript` without a readable child thread.
  - [ ] Mixed providers: a thread that switched from Claude to Codex lists its Claude subagents under Claude and its Codex child under Codex.
- **Verify:** server unit tests for merge, dedupe, id stability, per-entry provider, the tier rule and status normalization beside `apps/server/src/features/agents/orchestration/__tests__/agent-service-child-stop.test.ts`, with fixtures for an old Devin double call, a Copilot-shaped row without a child thread, and a mixed-provider thread; contract round-trip test; web store test with fake pushes and a reconnect (prior art `features/subagents/roster/__tests__/SubagentsPanel.real-store.test.tsx`). Live: Claude and Codex threads in fixture-repo.

### S12P-09 Claude, Cursor and Devin report subagents honestly

- **Blocked by:** S12P-08 Subagent roster: one contract, server projection, push.
- **Boards:** 12e (`2HDF-2`)
- **Delivers:** Cursor rows appear when the subagent starts, titled from the start and updated when Cursor's metadata lands, and no browser or explore tool shows up as a subagent. Devin subagents appear once, not nested twice. Claude subagents interrupted by a stop read Stopped.
- **Build notes:** Per-provider table. Cursor: remove discriminator and title heuristics; keep `isCursorTaskAcpTool` limited to `_toolName === "task"` and the "Task:" title prefix the capture shows; make sure the late `cursor/task` ToolUse merges into the same tool call, so the entry keeps its id, and triggers a roster bump. Devin: emit one Agent ToolUse (the marker) enriched with `task`, `title`, `profile`; route children by `agentId` to the marker id; drop `nativeThreadId` and the second call. Rows Devin recorded before this ticket keep their persisted shape; S12P-08's tier rule already keeps them at steps. Claude: map turn cancel during an Agent call to `cancelled`. Capabilities stay as S12P-08 declared them.
- **Deletes:** Cursor heuristics; Devin second Agent call and fake `nativeThreadId`.
- **Acceptance criteria:**
  - [ ] Cursor fixture with a browser tool call yields zero subagent rows; a Task call yields one row from `tool_call` time, with the same entry id after its `cursor/task` metadata lands.
  - [ ] Devin fixture with two parallel subagents yields two rows, each with its own steps.
  - [ ] Claude fixture stopped mid-Agent yields status `stopped`.
- **Verify:** `packages/providers/src/private/cursor/events/__tests__/cursor-subagent-detection.test.ts`, `cursor/acp/__tests__/cursor-acp-task.test.ts`, `devin/__tests__/devin-acp-event-mapper.test.ts`, Claude mapper tests under `private/claude/__tests__`.

### S12P-10 Copilot and OpenCode subagents in the roster

- **Blocked by:** S12P-08 Subagent roster: one contract, server projection, push.
- **Boards:** 12e (`2HDF-2`)
- **Delivers:** Copilot and OpenCode subagents appear in the list. Copilot rows show their steps and a summary. OpenCode rows show steps only if OpenCode really streams them; otherwise they say plainly that OpenCode doesn't share them.
- **Build notes:** Copilot: map events carrying `parentToolCallId` (tool start/complete) to nested ToolUse/ToolResult with `parentToolCallId`; `subagent.started` fills the presentation (`agentDescription` as prompt, `agentName` as type); `subagent.failed` → failed; summary from the parent `task` tool result. Declare `subagentReporting: { childTranscript: false, childSteps: true }` until S12P-11. OpenCode: map the `task` tool to `Agent` with presentation fields; summary from its output. Child steps are unverified, so capture a real OpenCode stream with a `task` subagent first and keep it as a fixture. Only if that stream shows child-session tool events carrying the parent link, route them under the call and declare `{ childTranscript: false, childSteps: true }`. Otherwise declare `{ false, false }`, so OpenCode entries are `meta` and the detail never promises steps. Record the outcome in the per-provider table.
- **Deletes:** `copilot_child:` system events.
- **Acceptance criteria:**
  - [ ] Copilot conformance trace (`packages/providers/src/conformance/copilot-trace.ts`) with one subagent yields one row with its child tool steps.
  - [ ] An OpenCode `task` call yields one row. Its tier is `steps` only when the captured stream proves child steps; otherwise `meta`, with the meta copy and Show in chat.
- **Verify:** Copilot mapper tests (`packages/providers/src/private/copilot/__tests__`); OpenCode mapper tests in `apps/server/src/features/providers/adapters/opencode/__tests__/opencode-event-mapper.test.ts` against the captured stream; a roster test asserting the OpenCode tier for both capability values.

### S12P-11 Copilot full transcript

- **Blocked by:** S12P-10 Copilot and OpenCode subagents in the roster.
- **Boards:** 12e "Detail · full transcript" (`2HG7-2`)
- **Delivers:** A Copilot subagent's detail streams its own conversation (text and tools), like Codex.
- **Build notes:** Recommended: generalize the Codex child-thread recorder (`apps/server/src/features/agents/canonical/accepted-codex-collaboration.ts`, `collaboration/adapters/codex-collaboration-event-adapter.ts`) behind a provider-neutral child-thread port, and implement it for Copilot (child identity = `toolCallId`, items from child events). The detail then reuses the transcript renderer. Start with a half-day spike; if the generalization is larger than one context, split the port from the Copilot implementation. Declare `subagentReporting: { childTranscript: true, childSteps: false }` for Copilot only when this lands. The entry keeps its `call:<toolCallId>` id when the child thread appears. Rows recorded before this ticket have no child thread, so S12P-08's tier rule keeps them at `steps` (or `meta` with no recorded steps); the generic step read path stays for them.
- **Deletes:** the adapter's interim nested-step emission for Copilot from S12P-10. The roster's step read path is not deleted.
- **Acceptance criteria:**
  - [ ] A Copilot subagent detail shows its assistant text and tool rows live.
  - [ ] A Copilot row recorded under S12P-10 still opens as steps after upgrade, keeps its id, and never shows an empty transcript.
- **Verify:** server tests beside `apps/server/src/features/agents/canonical/__tests__/accepted-codex-collaboration.test.ts` using the Copilot trace.

### S12P-12 Subagents list

- **Blocked by:** S12P-08 Subagent roster: one contract, server projection, push; F-05 Right panel shell: two-row header, right-edge rail, panel controls; F-06 Provider icon and disc stack.
- **Boards:** 12e "List" (`2HDK-2`)
- **Delivers:** One list for all providers: running first, a divider, then finished. Each row shows its entry's provider icon, task, type · model, the step count for steps-tier entries, and a live time with a green dot; finished rows show a check and time, failed rows a clay "Failed", stopped rows a muted "Stopped" (Q3), with words from `subagent-status.ts`. Hovering a running row whose entry has `canStop` (Codex today) shows a round Stop.
- **Build notes:** Row 1: title pill "Subagents" (`Layers` icon); no row 2. List padding 4 / 8 / 8, gap 2; rows 52, radius 10, padding 10 (6 right when Stop shows), gap 10; hover `--color-hover`; title 14/20 medium ink with fade; meta 12/16 muted; time mono 12/16 (ink running, muted finished); dot 7px (`--color-success` running, `--color-error` failed); check 12px muted; Stop 28 round selected fill with an 8px ink square; divider 1px `--color-border` with 6 / 10 padding. Live time ticks once per second only while a running row is visible, formatted as Paper shows it (`48s`, `1m 12s`, `1h 3m`). Empty: "Subagents appear here when this thread delegates work." Error: "Couldn't load subagents" + Retry. Clicking a row opens its rail tab (S12P-13; until then it opens the old detail).
- **Deletes:** old rows, Active/Done sections, roster tab state, Stop all.
- **Acceptance criteria:**
  - [ ] Mixed-provider fixture renders in the order running (newest first), divider, finished (newest first).
  - [ ] Only Codex rows offer Stop; stopping turns the row Stopped without a page reload.
- **Verify:** component tests replacing `features/subagents/roster/__tests__/SubagentsPanel.test.tsx`. Live: screenshot against `2HDK-2`.

### S12P-13 Subagent detail as its own rail tab

- **Blocked by:** S12P-01 Rail lists tools; terminals and browser pages become row-1 tabs; S12P-09 Claude, Cursor and Devin report subagents honestly; S12P-12 Subagents list; S05-08 Subagent chips and overview Subagents row with provider icons.
- **Boards:** 12g (`23HJ-2`), 12e detail states (`2HG7-2`, `2HI6-2`, `2HKB-2`)
- **Delivers:** Clicking a subagent (list row, chat chip, overview) opens it as a rail tab after Subagents, behind a divider, with its provider icon and a green dot while it runs. The tab shows "From the main thread" with the parent's prompt, then what the entry's tier shows: the live transcript (Codex, Copilot rows after S12P-11), steps and a Summary (Claude, Devin, Copilot rows recorded before S12P-11, OpenCode only if S12P-10 proves its steps), or one line and Show in chat (Cursor, and OpenCode while its steps are unproven). The tab reads the tier from the roster entry and never infers it from the provider. Codex shows a round Stop in row 2.
- **Build notes:** Rail instance and grouping rules in Backend 3; rail dot 6px `--color-success` at top 4 / right 4 with a 2px ring in the entry's fill; tooltip and expanded label = title. Row 1: title pill (provider icon 14, 14/20 medium, max 320, fade), expand, toggle. Row 2: meta pill (radius 18, selected fill, padding 12, type · model 12/16 muted, 7px dot `--color-success` running or `--color-muted` finished, time mono 12/16 ink) and, for Codex while running, round 32 Stop (10px ink square). Body padding 8 / 20 / 16, gap 14. Prompt: label 12/16 muted, bubble `--color-selected`, radius 14 14 6 14, padding 10 / 14, max 420, 14/22; clamp to 6 lines with "Show all". Transcript tier mounts the existing transcript renderer with a residency lease (as `CanonicalDetailView` does) and must not repeat the prompt if the child's first message is the same text (inferred). Steps rows 28 tall, 14px muted icon, verb 13/18 muted, target 13/18 ink, `+N −N` mono 12/16; "Summary" 12/16 medium muted then 14/22 ink; tier line 12/16 muted. Meta tier line 13/20 muted plus "Show in chat" pill (32, radius 999, selected fill) that reveals `sourceMessageId` in the chat (new reveal request on the conversation store; inferred seam). Missing entry (thread deleted, roster lost): "This subagent is no longer available." with the tab still closable. `openSubagentDetail(id)` and `openSubagentsRoster()` keep their signatures so chips and overview need no change. Update `narrative-pipeline.md:240`.
- **Deletes:** in-panel detail selection and views, back button, dead subagent pieces (including `formatSubagentIdentity`), "Earlier activity is truncated.". The identity glyph is F-06's.
- **Acceptance criteria:**
  - [ ] Opening two subagents shows two rail tabs after Subagents behind a divider; the running one has a green dot that disappears when it finishes.
  - [ ] Closing Subagents closes both subagent tabs; closing the last rail entry closes the panel.
  - [ ] Each tier shows its exact copy; a finished steps entry with no recorded steps shows "No steps were recorded."; Cursor's prompt bubble fills in when its metadata lands, in the same tab.
  - [ ] Thread switch and back restores the open subagent tabs (per-thread state).
- **Verify:** component tests per tier with fixture rosters; store test for grouping, cap and close rules in `apps/web/src/__tests__/diffStore.test.ts`. Live: Codex and Claude subagents on fixture-repo; screenshot against `23HJ-2` and the three 12e detail states.

## Tests

- Highest seams: `diffStore` actions (instances, grouping, close-hides-panel), `RightPanel` render with a mocked transport, `FileService` against `.dev/fixture-repo` (git and non-git copies), `file-rpc` routing, image route auth, `SubagentRosterService.loadRoster` merge and status mapping with fake canonical and narrative sources, provider mappers against recorded traces (`packages/providers/src/conformance/`), web roster store with fake pushes.
- Prior art: `components/panels/RightPanel.test.tsx`, `ActivityRail.test.tsx`, `__tests__/PanelEmptyState.test.tsx`, `lib/__tests__/panel-tabs.test.ts`, `lib/__tests__/right-panel-layout.test.ts`, `apps/web/src/__tests__/diffStore.test.ts`, `apps/server/src/features/projects/files/__tests__/*`, `apps/server/src/features/agents/orchestration/__tests__/agent-service-child-stop.test.ts`, `packages/providers/src/private/*/__tests__/*`, `features/subagents/roster/__tests__/*` (replaced).
- Live checks run on the Electron surface with `bun run --shell system agent:up --desktop` and the electron live-testing skill; UI tickets attach before/after screenshots against the boards listed per ticket.

## Risks and open questions

1. **Ctrl P takeover** (user). `mod+p` is the palette's backward-compat alias today. Recommendation: give it to Go to file and drop the alias; the palette keeps `mod+k`.
2. **"Ctrl Enter opens beside"** (user). There is no split view in the panel. Default: open as a tab right after the active one without switching. Alternative: open in a new Mcode window or split; neither exists.
3. **Stopped / cancelled look** (user). Not drawn. Default: muted "Stopped" + time in the list, muted dot in the tab, no colour (matches 08f "Stopped by you").
4. **Subagent tab rules** (user). Default: closing Subagents closes its subagent tabs; at most 8 subagent tabs per thread, the oldest inactive closes first.
5. **Hover-expanded rail** (user). Paper boards show only the collapsed rail; the Components page still has the 160 expanded rail, with a stale Close panel row. Default: keep expansion (it carries labels and close), drop Close panel; please update the Paper component.
6. **Gutter + colour** (user). Paper draws an ink square; implementation notes say "amber +". Paper wins by rule; confirm.
7. **Amber bars on new files** (user). Default: untracked or added files show no bars (the A mark covers it) rather than a bar on every line.
8. **Copilot transcript approach** (engineering, after the S12P-11 spike). Recommendation: canonical child threads through a provider-neutral port, matching CONTEXT "Sub-agent thread". Riskiest item in this section.
9. **OpenCode child sessions** (engineering). Whether child-session events reach the adapter is unverified. S12P-10 settles it with a captured stream; until it proves them, OpenCode declares no child steps and its entries are `meta`.
10. **User-facing thread-control WS methods** (user). After S12P-02 nothing in the app calls `thread.control.read/send/stop`. Recommendation: delete them in S12P-02; MCP tools stay.
11. **Dock breakpoint** (coordinate with S10). Files uses "body width ≥ tree width + 520", the same rule as Review's pane, measured on the body excluding the rail.
12. **Token colours** (S10 author / user). Files uses Paper roles through a CSS-variables shiki theme; Review diffs use `github-dark`. Align or accept the difference.
13. **Plan rail icon** (user, left open in 08). Boards disagree: 10a / 12a show a document, 12f shows a list.
14. **Widths** (no action). Paper's 584 panel at 1440 vs code's half-row 568 is within 16px; no change proposed. DESIGN.md's rem widths are stale and get rewritten in F-05.
15. **ADR number** (doc owner). Several section authors may claim the next ADR number; take the next free number at merge.
16. **Large repositories** (engineering). `file.list` caps at 100,000 paths and the tree is virtualized; measure first open on a large repo before calling S12P-04 done.
17. **Copy path** (user). Default: the path pill copies the relative path; More › Copy path copies the absolute path.
18. **Coordination removal** (verified, no action). Thread-operation approvals reach the owner thread's dock and sidebar row under S06-01's routing (today they reach the target thread); the only loss is the coordinator's aggregate view, which the user called a mistake.
