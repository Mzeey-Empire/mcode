# User answers, 2026-10-08

The user reviewed `decisions.md` and the ticket breakdown. This file records each answer and what it changes. Section briefs, `decisions.md`, `spec.md` and `tools/graph.json` must agree with it.

## Breakdown

- **Granularity.** Keep the 156 tickets. GitHub allows at most 100 sub-issues per parent. No parent comes close (largest section epic: 28), but the publisher must split a parent into a second epic, keeping every blocked-by link, if one ever passes 100.
- **The five flagged defaults** (S08-04 sign-off on the PR, S08-06 tell the agent about a revert, S10-13 hide whitespace, S11-16 retire the style editor, T3 Keeps running as a later ticket): the user did not object, so the defaults stand. S08-04 keeps its design sign-off on the PR.
- **Defaults without a comment** stand as written.

## Answers that change the plan

| # | Answer | What changes |
|---|---|---|
| D11 | Not specced. File a scoping epic for the model picker extras, with no tickets, after this program. | New standalone epic "Model picker extras (needs scoping)". Not a child of the program epic, no `ready-for-agent`. |
| N1 | Remove File, Edit, View and Help on Windows and Linux entirely. No replacement menu. The options must work without it. | S01 header ticket deletes the in-app title bar menu and its Alt mnemonics. Every item in that menu must keep another way in (shortcut or command palette); the ticket lists each item and its other way in, and adds the missing ones. macOS keeps its native menu bar: the OS shows one, and its Edit roles carry Cmd+C, V, X, A and Z. |
| N2 | When no provider needs anything: no dot, nothing on hover, no usage row. Never show the user information Mcode is not sure of. | The Providers popover lists only providers that need action: signed out, update available, rate limited (with the reset time, N7). No quiet ready rows and no usage rows. With nothing to list, the popover shows its header only (no all-ready state). The bell tooltip is just its name. Drop the usage fetch from the bell; if no other surface uses it, drop `usage` from the provider status contract. |
| N6 | Confirmed: Sign in runs in a terminal so the user can sign in calmly. | None. |
| N9 | Out of this program, but file an epic to scope it after the rest ships. | New standalone epic "Start a chat without a project (needs scoping)". No tickets, no `ready-for-agent`. |
| N10 | Daily is acceptable; can change later. | None. |
| E2 | Retry replaces the failed attempt. No "Retried" label, no second copy of the message. Resume works the same way. | The transcript shows the user message once, followed by the latest attempt only. The failed or interrupted attempt's ending and work fold are not rendered once a replacement attempt exists. Mcode keeps the earlier attempt's records (PRODUCT.md principle 13); only the view hides it. Attempts of one turn are one logical turn: the Turn view diff of a retried turn starts at the first attempt's baseline, so partial edits from a failed attempt still show in Review. If the replacement attempt also fails, its Failed ending shows (with Retry, still one-shot per attempt as the brief defines). |
| E6 | Stop before the provider starts must not refill the composer. Show a turn ending instead. | Delete `composerRecallFromStop` and its refill. The quiet "Stopped before {Provider} started" ending (already drawn on 08f) is the only result. Add a retirement ledger row with a proof. |
| E9 | Confirmed: Implement in a new thread skips Setup (reason `plan-implement`). Also add Implement in a new worktree. | New ticket S07-08b "Implement in a new worktree" after S07-08: a third menu item "Implement vN in a new worktree", plus a palette command. Creates a branchless worktree at the source checkout's current commit, like the composer's New worktree, and starts the new thread there; Setup runs as for any new worktree. `plan.implement` gains `target: "new-worktree"`. Uncommitted changes in the source checkout do not move; when the source is dirty the menu item says so (proposed copy, no board). Same request, recovery and compensation rules as S07-08, plus removing the created worktree when compensation removes the empty thread. |
| L9 | Confirmed: superseded versions cannot be implemented. | None. |
| R1 | Task list title: no plan gives "Tasks"; tasks from a plan show the plan's title. Never the thread title. | Update the S05 task list ticket and its tests. |
| R2 | Send now means steer. If a provider cannot steer, do not show Send now. | Send now is shown only when the thread's provider supports steering into the running turn. No "send next" fallback under that name. The S05 brief lists each adapter's steer support. |
| V7 | Keep Revert in All turns (the cumulative view). | All turns file headers get Revert file too. It reverts the file to before the earliest turn in the view's range. S08-03's preview and apply accept that range for a file scope; Undo works the same way. The 10c confirm copy gets an All turns variant (proposed copy, no board). |
| V8 | Keep Expand all and Collapse all. It was only dropped because the 10a board does not draw it. | Keep `bulkDiffExpand`. Add one toggle icon to Review row 2 (Lucide `chevrons-down-up` / `chevrons-up-down`, tooltip "Collapse all" or "Expand all"). Remove its retirement ledger row. |
| W1 | Sending a message does not hand control back. | Only the explicit Hand back control returns the Browser to the agent. Update the S11 ticket and tests. |
| W5 | Certificate errors: let the user proceed, as browsers do. | Show a browser-style warning page with the error, details, Back to safety and "Proceed to {host} (unsafe)". Proceeding trusts that host and certificate fingerprint in that project's partition until Mcode quits. The agent never proceeds on its own; it sees the error. The address bar shows a "Not secure" mark while the exception is in use. |
| T11 | Question: what does the terminal run on? | Answer only, no change. Both backends sit on the same PTY host (`node-pty` in a child process, `apps/server/src/features/terminal/host/`). They differ only in the session and wire layer above it. Keeping legacy keeps every user's current terminal. |
