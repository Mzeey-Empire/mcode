# Open decisions

Questions the section briefs could not settle from the code or the boards. Each has a recommended default. Tickets build to the default unless the user answers otherwise. When the user answers, record it here with the date and update the affected brief.

The user reviewed this list on 2026-10-08. Rows marked **User, 2026-10-08** are decided; the full record and what each answer changes is in [source/user-answers-2026-10-08.md](source/user-answers-2026-10-08.md). Every other row's default stands.

## Blocking a ticket

These tickets carried the "needs decision" flag. All are now decided; S08-04 still needs the user's design sign-off on its PR.

| # | Ticket | Question | Default |
|---|---|---|---|
| B1 | S02-04 (deferred) | New project, Git URL and GitHub sources in Add project have no flow boards or backend. | Deferred to the design backlog and removed from this program. 02a ships Local folder only until boards exist. |
| B2 | S08-04 | 08e (receipt row, "reverted" label, confirm copy, Since you looked entry) was never drawn. | Build from the Components board "Diff summaries · E refined" (`15OZ-0`) and the default copy in the brief. **User, 2026-10-08:** default stands; the user signs off on the PR. |
| B3 | S08-06 | Tell the agent about a revert on the next send? | **User, 2026-10-08:** yes (default stands), as one line of context. |
| B4 | S10-13 | Does the whitespace (¶) button hide whitespace changes or show invisible characters? | **User, 2026-10-08:** hide whitespace changes (default stands). |
| B5 | S11-16 | Retire the style editor in the Browser note bubble (about 1,100 lines, on no approved board)? | **User, 2026-10-08:** retire it (default stands). |

## Design system (00)

| # | Question | Default |
|---|---|---|
| D1 | The Components page buttons board says Phosphor; the style guide and every screen use Lucide. | Lucide at 1.5px; sweep the Components page. |
| D2 | Overlay shadow: style guide says `0 8px 24px` at 24%, but menus and pickers on screens use `0 16px 40px` at 45%. | Use the screens' value for menus and pickers, and update the style guide board. |
| D3 | The 03b picker uses radius 12, padding 6 and a 34px search row, off the tokens. | Snap to radius 14, padding 8, 32px rows. |
| D4 | Light theme: hover, selected and page share neutral-100, so a selected sidebar row is invisible. | Light selected becomes neutral-200. |
| D5 | Off-scale values: terminal 13/20, spinners 10 and 13, toast motion 160 and 200ms. | Terminal 13/20 as a named terminal role; spinners 12 and 16; keep the toast timings as locked. |
| D6 | Inline 24 and 28px buttons inside larger rows (toast close, row Stop). | Allowed inside a row with a 32px target, as DESIGN.md now says. |
| D7 | Does the amber Next-step slot still exist on finished turns, now that Review is neutral? | Only on failed and interrupted end notices. |
| D8 | Stale Paper boards: Layout says sidebar 256, thread markers say "Errored", old toast card, Composer Send note. | User updates the boards so implementers do not copy them. |
| D9 | Public Sans loads from Google Fonts, so the desktop app falls back offline. | Bundle it with fontsource in F-01a. |
| D10 | Right panel default width: 07e shows 536 at 1440; DESIGN.md keeps 60rem. | 536 at 1440 (settled in F-05). |
| D11 | The polished model picker board also shows a reasoning, context and Fast flyout, Ctrl+1 to 4 favourites, a folded "Legacy models" row, and switching a started thread to another provider. No ticket owns these; F-04c only migrates today's picker onto the primitive. | **User, 2026-10-08:** out of this program, with no spec yet. File a standalone epic "Model picker extras (needs scoping)" with no tickets. |

## Shell, sidebar and notifications (01, 09)

| # | Question | Default |
|---|---|---|
| N1 | Where do File, Edit, View and Help go on Windows and Linux without a title bar? | **User, 2026-10-08:** nowhere. Remove the in-app menu and its Alt mnemonics; every item keeps another way in (shortcut or command palette). macOS keeps its native menu bar. |
| N2 | What does the bell show when no provider needs anything? | **User, 2026-10-08:** no dot, nothing on hover, no usage rows. The popover lists only providers that need action (signed out, update, rate limited); with none, it shows its header only. |
| N3 | How does the update button look after "When they finish", and how is it cancelled? | Button reads "Installs when idle" with a menu item to cancel. |
| N4 | Do app toasts (errors included) auto-hide after 8s? | Info hides after 8s; errors stay. |
| N5 | OS notification for Failed and needs-you too, not only Finished? | Yes, all three, when Mcode is unfocused. |
| N6 | Where does Sign in run its terminal? | **User, 2026-10-08:** confirmed: a terminal tab in the right panel scoped to no thread. |
| N7 | Where do rate limits appear in the bell? | On the provider's row, with the reset time. |
| N8 | What does a collapsed project row show when its threads run or need you? | The highest-priority mark among its threads. |
| N9 | "Start a chat" without a project needs backend work (every thread belongs to a project). | **User, 2026-10-08:** out of this program; the empty workspace asks for a project first. File a standalone epic "Start a chat without a project (needs scoping)" to scope after this program. |
| N10 | Daily npm registry checks for CLI versions: acceptable for privacy? | **User, 2026-10-08:** yes, once a day, with a setting to turn it off. The interval can change later. |

## Add project and new thread (02, 03)

| # | Question | Default |
|---|---|---|
| A1 | Start from origin applies to New worktree only? | Yes. |
| A2 | "Open in File Explorer" in 02a: native folder picker that adds the choice, or reveal in Explorer? | Native folder picker that adds the choice. |
| A3 | Labels without a board (Existing worktree rows, branch row after choosing a PR, whether Start from origin stays on for the next thread). | The brief's picks; Start from origin is remembered per project. |
| A4 | The closed overview button has a fill on boards 03 and 03b, but F-03 says plain at rest. | Plain at rest (F-03). |

## Thread start and turn endings (04, 08f)

| # | Question | Default |
|---|---|---|
| E1 | Should a fatal failure still offer Retry? | Yes. |
| E2 | After Retry or Resume, repeat the prompt or show a compact marker? | **User, 2026-10-08:** neither. The new attempt replaces the failed or interrupted one in the transcript: the message shows once, then the latest attempt. Records are kept. Review treats the attempts as one turn. |
| E3 | Switch model can only offer the same provider's models. Keep, hide, or build provider switching first? | Keep, limited to the same provider. |
| E4 | A scheduled "Retry at" while Mcode was closed: fire on next launch? | Only if 15 minutes overdue or less. |
| E5 | Retire the "N turns were interrupted · Retry all" banner after a restart? | Yes; per-thread Resume and the sidebar replace it. |
| E6 | Keep refilling the composer when Stop lands before the provider starts? | **User, 2026-10-08:** no. Delete the refill; the quiet "Stopped before {Provider} started" ending is the only result. |
| E7 | 04f shows "· 412 packages" after `bun install`. Intended progress text? | No; show the step name and time only. |
| E8 | Copy button for the worktree path: overview row only, trail step shows a tooltip? | Yes. |
| E9 | "Implement in a new thread" continues the plan in the same checkout. Should that new thread skip automatic Setup (the locked rule says an Existing worktree start runs Setup)? | **User, 2026-10-08:** yes, like branched threads today; only the server can request this skip (reason `plan-implement`). Also add "Implement vN in a new worktree" (S07-08b), which runs Setup as usual. |

## Running turn (05)

| # | Question | Default |
|---|---|---|
| R1 | Where does the task list title come from? No provider sends one. | **User, 2026-10-08:** "Tasks" with no plan; the plan's title when the tasks come from a plan. Never the thread title. |
| R2 | Send now: interrupt and send, or send next? | **User, 2026-10-08:** Send now means steer into the running turn. When the provider cannot steer, Send now is not shown. |
| R3 | Drop drag-to-reorder for queued messages? | Yes. |
| R4 | Drop the status label shimmer (repaints every frame)? | Yes. |
| R5 | Thought row duration "4s" (Paper) or "0:04" (m:ss rule)? | "0:04". |
| R6 | Usage bars near the limit: neutral, or amber and red as today? | Neutral until 90%, then amber. |
| R7 | Provider retrying on the status line or on its own line? | On its own quiet line under the work (08f). |

## Approvals (06)

| # | Question | Default |
|---|---|---|
| P1 | Unreadable requests: deny automatically, or a dock with only Deny? | Deny automatically with a receipt. |
| P2 | Deny note for Cursor, Devin, OpenCode: queue, or stop the turn and send now? | Queue. |
| P3 | How does the user stop the turn while the dock shows? | Stop stays in the dock footer, neutral. |
| P4 | Where does "Open diff" sit and what does it open? | A dialog with the full diff (pending edits are not in the worktree). |
| P5 | Codex can send several files in one edit request. | List the files in the dock; each opens in the diff dialog. |
| P6 | Cursor on Windows is locked to Full access by an outdated comment. Test and unlock Manual? | Yes, in S06-06. |
| P7 | A way to clear session approvals? | Not now. |
| P8 | After a crash, Mcode may not know whether a deny note already reached the provider. Send it again automatically, or ask? | Ask. The note shows as "Delivery unknown" with Send again and Remove; Mcode never re-sends it on its own. |

## Plan mode (07)

| # | Question | Default |
|---|---|---|
| L1 | Version numbers after an accepted plan: continue (v3) or restart at v1? | Continue. |
| L2 | New-comment save: amber check (Paper) or up-arrow (todo)? | Up-arrow for new, check for edit (as 07g states 2 and 4). |
| L3 | Implement with open comments: keep them on the accepted version, unsent? | Yes. |
| L4 | "No structured plan" has no board. | Overview row plus "Use last reply as plan". |
| L5 | Remove "Accept recommended" from the question dock? | Yes. |
| L6 | Undo for Resolve? | Undo toast. |
| L7 | Plan rail icon: document (10a, 12a) or list (12f, code)? | Document. |
| L8 | Add CodeMirror 6 for the live-preview editor? | Yes. |
| L9 | Can a superseded plan version be implemented? | **User, 2026-10-08:** no (confirmed). Draft and ready versions can, including the ready version a user edit forked from. |

## Finished turn (08)

| # | Question | Default |
|---|---|---|
| F1 | Revert when a file changed after the turn: overwrite later edits, or three-way merge? | Overwrite, as the Components copy says; the confirm names the affected files. |
| F2 | "Looked" means opening the thread or opening Review? | Opening the thread. |
| F3 | Drop model, tokens and cost from finished turns? | Yes; usage lives in the overview. |
| F4 | OK to add `refs/mcode/*` refs (visible in `git log --all`, pushed by `--mirror`)? | Yes. |
| F5 | Open Review on Since you looked when two or more unseen turns have changes? | No. |

## Review (10)

| # | Question | Default |
|---|---|---|
| V1 | Files at normal width: popover (08c-4) or docked (08c-5)? | Popover. |
| V2 | Commit list: commits ahead of the base, or full history? | Ahead of the base, searched on the server. |
| V3 | Default branch Branch comparison: ADR-0007 says incoming; the app shows unpushed. | Keep unpushed; record it in the new ADR. |
| V4 | Retire the All turns AI summary? | Yes; Recap covers it. |
| V5 | Drop "Agent changes" and "Tracked file evidence" labels? | Yes; keep a Git-fallback info icon. |
| V6 | "Commit and push" on a thread with no branch. | Disabled with "Create a branch to push". |
| V7 | Revert in All turns? | **User, 2026-10-08:** keep it. All turns gets Revert file, which reverts the file to before the earliest turn in the view. |
| V8 | Lose Expand all and Collapse all? | **User, 2026-10-08:** keep them, as one toggle in Review row 2. |

## Browser (11)

| # | Question | Default |
|---|---|---|
| W1 | Does sending a message hand control back? | **User, 2026-10-08:** no. Only Hand back returns control to the agent. |
| W2 | Does Hand back replay the stopped steps? | No. |
| W3 | Old shared cookies: clear once or copy into each project? | Clear once. |
| W4 | HTTP 404 and 500: the dev server's page or an Mcode page? | The dev server's page. |
| W5 | Proceed past certificate errors? | **User, 2026-10-08:** yes, as browsers do: a warning page with "Proceed to {host} (unsafe)". The exception lasts until Mcode quits, per project. The agent never proceeds on its own. |
| W6 | Screenshot: press, then click or drag in the page? | Yes. |
| W7 | Undrawn items: remove on recent pages, rail icon while the agent acts, disabled Design and Start without a thread, F12 for Developer tools. | The brief's defaults. |

## Terminal, actions and settings (12a)

| # | Question | Default |
|---|---|---|
| T1 | Action terminals run the script, then an interactive shell (the command is not typed into the shell). Two consequences: the command is not in shell history, and a `cd` or `export` in the script does not carry into the shell afterwards. OK? | Yes. |
| T2 | Terminal cap of 8 records per scope (running and exited, shells and actions together)? | Yes. |
| T3 | Startup actions are awaited until they exit 0 (S12T-11 builds this). A dev server never exits, so it cannot be a startup action under that rule. Add a per-action "Keeps running" toggle that starts the action and does not wait for it? | **User, 2026-10-08:** default stands: a follow-up ticket after S12T-11, defined later. A listening port never counts as ready, because another process can answer on it. |
| T4 | "watch" in overview rows: sample text? | Yes, sample text. |
| T5 | In repo setup commands need approving once after the upgrade. | Accept. |
| T6 | Per-action "Forget approval" replaces "Clear shared command approvals". | Yes. |
| T7 | Terminal links: loopback opens in the Browser tab, others in the system browser. | Yes. |
| T8 | More menus are not drawn. | The brief's defaults. |
| T9 | Retire the composer "N active terminals" chip? | Yes. |
| T10 | "Run on startup" hint says new worktree, but Existing worktree also runs setup. | "When a thread starts in a worktree". |
| T11 | Two terminal backends exist (legacy and modern), and both run actions. Keep one? | **User, 2026-10-08:** default stands: keep legacy and delete modern in S12T-01. Both sit on the same PTY host (`node-pty` in a child process); they differ only in the session and wire layer above it. 12a risk R1 lists what modern would have given. |

## Panel shell, Files, Subagents (12b)

| # | Question | Default |
|---|---|---|
| S1 | Go to file takes `mod+p` from the palette alias? | Yes. |
| S2 | "Ctrl Enter opens beside" without a split view. | Opens a background tab next to the active one. |
| S3 | Stopped or cancelled subagents look. | Muted "Stopped". |
| S4 | Closing Subagents closes its detail tabs; cap 8 detail tabs? | Yes to both. |
| S5 | Keep the hover-expanded rail? | Keep it, without the Close panel row. |
| S6 | Comment gutter "+": ink square (Paper) or amber (notes)? | Paper's ink square. |
| S7 | New files: no amber change bars? | Correct; the A mark covers it. |
| S8 | Delete the `thread.control.read/send/stop` WebSocket methods? | Yes; the MCP tools stay. |
