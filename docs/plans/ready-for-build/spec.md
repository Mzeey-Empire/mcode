# Spec: build the Ready for build screens (sections 01 to 12)

## Problem Statement

A developer runs several coding agents at once in Mcode, across projects and branches. Today the app makes them work to keep track of things:

- The sidebar shows a dot, but not *why* a thread needs them. A finished thread looks the same once they glance away, and an approval waiting in a background thread is invisible until they open it.
- Starting a thread hides what is happening behind a progress card. Setup output lives in a separate card, and they cannot cancel a slow start.
- While a turn runs, reasoning and the answer are mixed together, the status says "Thinking..." while the answer streams, and the task list is a small pill that says "3/4 steps".
- Approvals arrive as raw JSON with tiny buttons. Decisions vanish when the turn ends, file edits come without a diff for some providers, and an invalid request can leave the agent waiting forever.
- Plan mode writes the plan into the chat as prose. The developer cannot edit it, comment on it, or know which version the agent will implement.
- When a turn stops, fails, or is interrupted, the only trace is a footer label. It names no cause and offers no next step.
- Review is a viewer. "Commit" pastes a prompt asking the agent to commit, untracked files never appear, errors show as "No changes", and comments disappear on reload.
- The Browser shares one cookie jar across every project, opens `localhost` over https, and lets the agent silently take the page back after the developer clicks into it.
- Project actions run in a read-only text box. Setup is a separate concept from actions, ports are never detected, and terminals vanish two seconds after they exit.
- Visually, the app has drifted from the design system: ellipses instead of fades, mixed icon families, raw colours, and many one-off menus and pickers.

## Solution

Build the screens on the Paper page "05 · Ready for build", sections 01 to 12, with the backend they need:

- A thread's state can be read at a glance. Each sidebar row says what it needs ("Approval required", "Answers required", "Plan ready", "Interrupted"), or that it finished or failed. Needs-you outranks done. Toasts announce changes in other threads, and an OS notification fires when Mcode is in the background.
- A new thread opens on the composer, with the thread overview card holding the workspace mode and branch. Starting shows a steps trail with timestamps that can be cancelled. Setup becomes the project's startup actions, run in real terminals.
- While a turn runs:
  - Reasoning shows as a collapsed Thought row, and narration and the answer as prose.
  - Tool rows are collapsed.
  - The status line says what is actually happening.
  - The task list and queued messages share one tray on top of the composer.
- Approvals take the composer's place with a typed request (command, file edit with diff, and so on), keyboard keys, and receipts that stay on the timeline. Deny with a note works for every provider, natively where possible.
- Plan mode produces a versioned plan record. The developer edits it in a live-preview editor and comments on highlighted text. Implement sends exactly the version on screen.
- A finished turn shows a work fold, a changes bar, and Revert this turn. A turn that does not finish ends with one notice that names the cause and offers one action: Retry, Resume, Retry at reset, or Sign in.
- Review gets a two-row header, honest error states, untracked files, a real commit sheet, pickers that search the server, and comments that survive reloads.
- The Browser gets one profile per project, tabs, a two-row header, a device toolbar, design notes that ride the composer, and a take-control and hand-back model the agent respects.
- The right panel gets one shell: two-row header, rail as tool tabs, row-1 tabs inside a tool. Files, Subagents (one honest list for every provider), Terminal, and Project settings (General and Actions) are built on it.
- Everything is built from one set of design-system primitives that match the Paper style guide. Every component they replace is deleted.

## User Stories

Shell, sidebar and notifications

1. As a developer, I want the window to have no title bar and the window controls to share the top row, so that the app gives its height to my work.
2. As a developer, I want the sidebar to default to 304px and resize between 220 and 340, so that thread titles fit without crowding the conversation.
3. As a developer, I want each thread row to say "Approval required", "Answers required", "Plan ready" or "Interrupted" with an amber ring, so that I know what a thread needs without opening it.
4. As a developer, I want a thread that needs me never to be dimmed, so that it stands out from running threads.
5. As a developer, I want a running thread's row to fade with a spinner and no text, so that busy threads recede while I scan.
6. As a developer, I want a finished thread I have not opened to show a green dot and "Finished", so that I can see which results are new.
7. As a developer, I want a failed thread to show "Failed", so that I can tell it apart from one that finished.
8. As a developer, I want a thread's row state to clear when I open it, so that the sidebar reflects what I have not seen yet.
9. As a developer, I want a toast at the top of the conversation when another thread finishes or needs me, so that I notice without watching the sidebar.
10. As a developer, I want finished toasts to hide after 8 seconds unless I hover them, and needs-you toasts to stay, so that the important ones wait for me.
11. As a developer, I want to click a toast to open its thread and swipe it away to dismiss it, so that toasts are fast to act on.
12. As a developer, I want an OS notification when a thread finishes while Mcode is in the background, so that I can work in another app and come back on time.
13. As a developer, I want the bell to list providers that need signing in, a CLI update, or that have a new model, so that setup problems reach me before a turn fails.
14. As a developer, I want the update button to show checking, up to date, available, downloading, ready and failed states, so that I always know where an update stands.
15. As a developer, I want to choose "When they finish" when installing an update while agents run, so that an update never kills a running turn.
16. As a developer, I want to hover the update button to read the release notes, so that I can decide whether to update now.

Add project and new thread

17. As a developer, I want to add a project from a palette with local folder, browse, and ready-to-add steps, so that adding a project takes seconds.
18. As a developer, I want the add flow to refuse my home folder and drive roots and to explain why, so that I do not register a project by mistake.
19. As a developer, I want a new thread to open on the composer with the project name as a selectable slot, so that I can start typing right away.
20. As a developer, I want the composer to stay 760px wide everywhere, so that the first send only slides it into place.
21. As a developer, I want the thread overview to open on a new thread with the workspace mode and branch rows, so that I can check where the agent will run before I send.
22. As a developer, I want to choose New worktree, Existing worktree or Local from the workspace row, so that I control isolation per thread.
23. As a developer, I want a branch picker with Branches and Pull requests tabs, search, and paging that shows "Showing x of y", so that I can find any branch or PR in a large repo.
24. As a developer, I want the branch picker to show a real error when git or gh fails, so that I do not mistake a failure for an empty list.
25. As a developer, I want "Start from origin" when creating a new worktree, so that the agent starts from the latest remote code without moving my checked-out main.

Thread starting

26. As a developer, I want a steps trail with per-step timestamps while the thread starts, so that I can see what is slow.
27. As a developer, I want "Starting thread" to hold until the provider's first response, so that the app never says it is running before it is.
28. As a developer, I want to expand the setup step to see the script and its live output, so that I can tell why setup is slow or failing.
29. As a developer, I want to stop a slow start with Stop or Esc, so that I am never stuck waiting.
30. As a developer, I want a failed setup to offer Retry, Continue without setup, and Open terminal, so that I can recover without restarting the thread.
31. As a developer, I want an existing worktree to run setup on each start unless another thread is live there, so that its dependencies stay current without disturbing a running agent.
32. As a developer, I want the startup actions I marked "Run on startup" to be the setup step, so that there is one concept, not two.

Running turn

33. As a developer, I want the agent's reasoning shown as a collapsed "Thought" row, so that the answer reads as prose and the thinking stays one click away.
34. As a developer, I want narration and the final answer at 16px prose, so that long answers are comfortable to read.
35. As a developer, I want tool rows collapsed with an inline chevron and edit rows marked with a pencil, so that a long turn stays scannable.
36. As a developer, I want the step count to include tool calls only, so that the number means something.
37. As a developer, I want the status line to say "Answering" while the answer streams, and to show compacting, rate limits and retries when they happen, so that I trust what it says.
38. As a developer, I want durations shown as m:ss in mono, so that times line up and read quickly.
39. As a developer, I want subagents shown with their provider icon, and the overview to show up to three icons with the total in text, so that I can see delegated work at a glance.
40. As a developer, I want the task list docked above the composer with one segment per task, so that I can see progress without scrolling.
41. As a developer, I want queued follow-ups in the same tray with Send now, Edit and Remove, so that I can manage what goes next.
42. As a developer, I want "Jump to latest" when I scroll up during a turn, so that I can read back and return in one click.
43. As a developer, I want Stop and the Full access chip to be neutral, not red or amber, so that the screen is calm while the agent works.
44. As a developer, I want the thread overview to list changes, tasks and usage while a turn runs, so that I see the thread's state in one place.

Approvals

45. As a developer, I want a pending approval to replace the composer with a dock that says what is being asked, so that I cannot miss it or type past it.
46. As a developer, I want the status line to say "Waiting for approval", so that I know the agent is blocked on me.
47. As a developer, I want a file edit approval to show the diff, clipped with a fade and scrollable sideways, so that I can judge the change before allowing it.
48. As a developer, I want several waiting approvals shown as "2 of 3", so that I know how many remain.
49. As a developer, I want keyboard keys to allow and deny, so that I can approve without the mouse.
50. As a developer, I want "Allow for this session" only when the provider can state its scope, so that I never grant more than I think.
51. As a developer, I want to deny with a note the agent receives, for every provider, so that I can redirect instead of only refusing.
52. As a developer, I want "Allowed once" and "Denied" receipts to stay in the timeline, so that I can see later what I decided.
53. As a developer, I want approvals in background threads to show in the sidebar without opening the thread, so that no agent waits on me unseen.
54. As a developer, I want an approval request the app cannot read to be denied visibly instead of hanging, so that an agent never waits forever.
55. As a developer, I want to see when an approval comes from a subagent, so that I know which part of the work asks.

Plan mode

56. As a developer, I want to turn on Plan mode from a neutral chip or by typing /plan, so that entering planning is quick.
57. As a developer, I want plan questions to replace the composer with "Waiting for your answers", so that I answer them before planning starts.
58. As a developer, I want the plan stored as a record with versions, so that the plan is not lost in chat history.
59. As a developer, I want the plan in the thread overview, opening in the right panel, so that it has one home.
60. As a developer, I want to edit the plan in a live-preview editor where my first change creates a version marked as mine, so that edits are tracked.
61. As a developer, I want to highlight plan text and leave a comment, so that I can ask for changes precisely.
62. As a developer, I want open comments to ride my next message as a removable chip, so that the agent revises with my notes.
63. As a developer, I want a follow-up in Plan ready to revise the plan, not rerun the questions, so that iteration is fast.
64. As a developer, I want Implement to send exactly the version on screen and mark it Accepted and read-only, so that I know what the agent was told to build.
65. As a developer, I want to implement in a new thread from the same menu, so that I can start with a clean context.
66. As a developer, I want Ctrl+Shift+Enter and the command palette to implement without opening the panel, so that the keyboard path is complete.
67. As a developer, I want a clear state when a provider does not return a structured plan, so that I know why there is nothing to edit.
68. As a developer, I want the plan file path passed to the agent, so that it keeps track of the plan even across providers.

Finished turn and turn endings

69. As a developer, I want a finished turn to fold its work and show one meta line, so that the answer is what I read first.
70. As a developer, I want an end-of-turn changes bar listing every changed file with a neutral Review button, so that I can open the diff from where I am.
71. As a developer, I want to revert a whole turn with a confirmation and an Undo, so that I can throw away an agent's attempt safely.
72. As a developer, I want a "Since you looked" review scope, so that I see only what changed since I last opened the thread.
73. As a developer, I want a stopped turn to say "You stopped" quietly, so that my own action is not shown as an error.
74. As a developer, I want an interrupted turn to offer Resume, so that a closed app does not lose the agent's work.
75. As a developer, I want a failed turn to name the cause in plain words, show the raw error under Details, and offer Retry, so that I can recover in one click.
76. As a developer, I want a usage-limit failure to offer "Retry at" the reset time and Switch model, so that I do not have to watch the clock.
77. As a developer, I want a signed-out provider to offer Sign in, which then becomes Retry, so that the fix is in place.
78. As a developer, I want a quiet line while the provider retries ("attempt 2 of 10, next in 8s"), so that a transient error does not look like a failure.

Review

79. As a developer, I want Review's view picker to list Turn, All turns, Unstaged, Staged, Commit and Branch, with unavailable views dimmed and a reason on hover, so that I know what each view can show.
80. As a developer, I want Unstaged to include untracked files, so that new files the agent created are not hidden.
81. As a developer, I want Review to show "Couldn't load" with Details and Retry, "Too many files", and "This turn's changes are gone" instead of "No changes", so that I am never misled.
82. As a developer, I want a commit sheet where I pick files, edit a generated message, and commit or commit and push, so that committing is a real action I control.
83. As a developer, I want commit failures from hooks shown in the sheet, so that I can fix them without guessing.
84. As a developer, I want to pick both sides of a Branch comparison and search all commits on the server, so that I can review any range.
85. As a developer, I want to revert one file from the Turn view, so that I can keep the rest of a turn.
86. As a developer, I want the file list docked when the panel is wide and a popover when it is narrow, with the active file following my scroll, so that I always know where I am.
87. As a developer, I want my Review comments to survive a reload until I send them, so that I never lose a review in progress.

Browser

88. As a developer, I want Browser tabs in the panel's top row and back, forward, reload, URL, Design, Screenshot and More in the second row, so that nothing covers the page.
89. As a developer, I want each project to have its own browser profile, so that signing in to staging in one project does not leak into another.
90. As a developer, I want `localhost:5173` to open over http, so that my dev server loads without typing the scheme.
91. As a developer, I want a new page to show my project's dev servers and recent pages, so that I can open the app in one click.
92. As a developer, I want to click an element in Design mode and attach a note, so that I can point the agent at exactly what to change.
93. As a developer, I want my design notes to ride the composer as one tile per page or a stacked tile for several pages, so that they go with my next message.
94. As a developer, I want to see when the agent is driving the page and take control, and the agent not to take it back until I hand it back, so that I am in charge of my browser.
95. As a developer, I want plain error pages ("Can't reach localhost:5173") with Start web and Retry, so that I can recover from a stopped server.
96. As a developer, I want a device toolbar with presets, custom sizes and rotate, so that I can check layouts at other sizes.

Right panel, Terminal, Files, Subagents, Project settings

97. As a developer, I want the right panel's rail to list tools and each tool's items as tabs in its top row, so that the panel is predictable.
98. As a developer, I want project actions to run in real terminals I can type into, so that a failed command can be fixed in place.
99. As a developer, I want an action's terminal to show its status, exit code, detected port, Restart and Stop, so that dev servers are easy to manage.
100. As a developer, I want shared actions from the repo to ask before running, so that a cloned repo cannot run commands without my consent.
101. As a developer, I want exited terminals to stay open until I close them, so that I can read the output.
102. As a developer, I want running terminals listed in the thread overview, so that I know what is still running.
103. As a developer, I want to mark an action "Run on startup" or "Run on cleanup", so that setup and teardown are just actions.
104. As a developer, I want each action to have an icon picked from its command, so that test, build and serve are recognisable at a glance.
105. As a developer, I want Project settings to save with a save bar, keep my draft across tab switches, and resolve conflicts with Keep mine or Reload, so that I never lose an edit.
106. As a developer, I want to set a project's name and icon file, with automatic detection as the default, so that projects are easy to tell apart in the sidebar.
107. As a developer, I want a Files tool with a tree, file tabs, Go to file, find in file, rendered markdown and images, so that I can read the code without leaving Mcode.
108. As a developer, I want to comment on a line in Files and send it with my next message, so that I can point the agent at code.
109. As a developer, I want one Subagents list for every provider, with the message the parent sent and as much of the child's work as the provider shares, so that I can follow delegated work honestly.
110. As a developer, I want to open a subagent in its own tab and stop it where the provider supports it, so that I can inspect and control delegated work.

Cleanup and quality

111. As a maintainer, I want every replaced component deleted in the ticket that replaces it, with a proof command, so that no old code survives the redesign.
112. As a maintainer, I want lint rules that block ellipsis truncation, raw colours, arbitrary text sizes and numeric z-index, so that the design system holds after this program.
113. As a maintainer, I want a dead-code check in CI, so that unused files and exports fail the build from now on.
114. As a maintainer, I want a token parity test against the Paper export, so that design drift shows up in CI.

## Implementation Decisions

Design system

- The Paper file is the source of truth for visual values. Web tokens are regenerated from Paper's export and checked by a parity test. Code adopts Paper's role names (`ink`, `muted`, `panel`, `selected`, `control-border`), which removes the collision where `muted` meant a surface in code and text in Paper.
- Primitives come first and every section builds on them: fade truncation (never an ellipsis), the button set (with the round 32px icon button and the split button), the names-only menu, the picker (search row, tabs, flat list, server paging with "Showing x of y"), overlay surfaces that can open beside a card, the toast lane, the provider icon and disc stack, status marks, tooltip, and form controls. Icons are Lucide at 1.5px; Phosphor is removed.
- DESIGN.md has been rewritten to match the style guide and the screen-pass rules. PRODUCT.md gains the product principles the screen pass relied on.

Thread attention (one model for every section)

- The server owns a thread attention record: what the thread waits on (approval, answers, plan ready), how the last turn ended, and what the user has seen. One write path records turn endings. One seen marker (a time and a message sequence) serves both the sidebar Finished state and Review's Since you looked.
- The sidebar row state is a pure function of that record, with a fixed priority: needs-you, then failed, then finished, then running.
- Attention updates are pushed to every client. Approvals and plan states for background threads load without opening the thread.

Contracts and server services (new or changed)

- **Approval v2.** Two urgent bugs are fixed first (an unreadable request hangs the agent; Cursor deny can pick an allow option). Each request then carries a kind, the tool call id, the provider, a diff where one exists, its origin (thread or subagent), and every genuine choice with its stated scope. Routing identity stays outside the display payload. Answers report resolved, no longer pending, or failed. Invalid requests are denied upstream and leave a receipt only after the provider acknowledges. Scope is never truncated into a misleading grant. Thread-operation approvals belong to the thread that asked. Receipts and deny-note delivery persist.
- **Turn endings.** The error event carries a classified failure (retryable, usage limit, auth, fatal) with status, retry-after and attempt detail, classified in each adapter. A first-provider-frame event marks when the provider actually started. New commands: retry, resume, schedule and cancel a retry.
- **Startup record v2.** It adds per-step times and arguments, a fetch phase, and an attached-worktree kind. The project action runner is the only startup executor; the trail is a projection of the frozen action and run ids. Retry reruns from the first failed action. A startup action is ready only when it exits 0; a detected port is shown to the user but never releases Setup, because another process can answer on the same port.
- **Plan record v2.** A bounded investigation of all six providers' plan protocols comes first. The record adds versions with authorship and status (draft, ready, accepted, superseded), comments anchored to text ranges, the thread's plan phase, and a materialized plan file. Saves send a base revision the server checks. One plan service owns user writes. Implement is a durable request; the version becomes Accepted in the same transaction that admits the turn, so Accepted never exists without an admitted turn. Plan capture is one seam with a fenced fallback for every provider, plus native capture where the provider has it; native plan mode turns on only together with its question handling. Mcode touches a provider's own plan file only when it can prove the file belongs to the session. Old plan fences in historic messages still render.
- **Turn revert.** It is a preview, apply and undo operation on the working tree only. A preview token is a precondition over each path's presence, type, mode and content; a client request id is the operation identity, so a retry replays and a new click acts again. Recovery material is persisted and pinned before the first write, and unfinished operations recover on startup. It holds the per-repo git lock. Revert this turn and Revert file share it.
- **Review comparisons.** They return ready, too many files, unavailable, or failed with details. Unstaged includes untracked files via a temporary index (an empty one when the repo has no index yet). A branch comparison takes both refs from the user. Commit, commit search and message generation are server operations. A commit request is durable: its identity, inputs, original HEAD, result SHA and push outcome survive a lost response or restart.
- **Snapshot pinning.** Turn snapshots, dirty pre-turn baselines and revert safety material are pinned under `refs/mcode/<storeId>/` so `git gc` cannot prune them before they expire. Each database sweeps only its own namespace.
- **Drafts.** Everything that rides the next message (Review comments, design notes, file comments, plan comment chip selection) lives in the persisted composer draft, including durable snapshot references. Plan comments themselves are records.
- **Paged targets.** One qualified-ref listing with a purpose filter, paged with a total and a typed error, serves the new-thread picker (which may group local and origin twins) and Review's Branch picker (which keeps them separate).
- **Environment document 0.1.0.** Actions gain icons and startup and cleanup flags. Setup migrates to a startup action on read. Unknown keys are preserved, and files stay readable by older builds when no new field is used.
- **Action runs.** They run in real terminals, which execute the approved script and then keep an interactive shell. Runs carry a trigger and a port detected from the current run's output and probed on its real host (IPv6 included). They lose the full transcript push. Exited terminals stay until closed, up to eight terminal records per scope. One terminal backend remains.
- **Project icon.** A workspace-relative `icon_path`, a resolver with bounded probes and a cache, and an authenticated image route restricted to image files inside the workspace.
- **Files.** A capped tree listing, change marks from one git status, and a typed file read (text with encoding and changed lines, image, binary, too large), with path checks per segment.
- **Subagent roster.** One contract every adapter fills: title, provider, status, times, detail tier (transcript, steps, or meta), the parent's prompt, and stop capability. It is pushed instead of polled.
- **Provider status.** Each adapter reports its sign-in state and CLI version, with a shared version comparison, an update runner, and stored new-model sightings.
- **Browser.** One profile per project, with each page bound exactly to its own project's partition when it is prepared, attached or adopted. Partitions are deleted when the project is removed. User control holds until Hand back, enforced in the broker. The design-note payload moves to v2 (one snapshot per page), and old messages still render.

Provider decisions

- Each section's brief has a per-adapter table for Claude, Codex, Cursor, Copilot, Devin and OpenCode. Notable decisions:
  - Deny notes are native for Claude and Copilot, a steer for Codex, and queued for the others.
  - Reasoning becomes its own event for every adapter.
  - Codex plan mode uses collaboration mode.
  - Subagent detail tiers: transcript for Codex and Copilot, steps for Claude and Devin, meta only for Cursor.
  - Browser control and revert need no adapter changes.

Right panel

- One panel shell: row 1 (48px, sharing the window caption overlay) holds a tool's tabs plus expand and toggle; row 2 (40px) holds the tool's controls; nothing floats over content. The rail lists tools. Terminals, browser pages and opened files are row-1 tabs inside their tool, and subagent details are rail tabs. One new ADR records this and supersedes ADR-0020. The Coordination tab is removed; server thread control stays.

## Testing Decisions

- Test behavior at the highest seam: a contract round trip through the server service for backend tickets, and a component or store test for UI state. Do not test class names or mocked internals.
- Prior art to follow (see each brief):
  - Provider conformance fixtures for adapter changes.
  - Existing server service tests for git and turns.
  - The `components/ui` tests for primitives.
  - The oxlint plugin rule tests for new lint rules.
  - Store tests with fake timers for toasts and the sidebar state.
- Every provider-shaped ticket adds or updates a conformance fixture per adapter it changes.
- Every UI ticket has a live check on the Electron app through the live-testing harness, on the fixture repo, in dark and light, with before and after screenshots in the PR.
- The token parity test and the new lint rules are the long-term guards; F-99 adds the dead-code check to CI.

## Out of Scope

- Paper sections 13 to 17: the pull request inbox and detail, global settings, project settings beyond General and Actions, and system states.
- New project, Git URL and GitHub clone sources in Add project, until they have boards (S02-04 waits on that).
- Live streaming of shell output inside tool rows.
- Switching providers mid-thread (Switch model offers the same provider's models only).
- Native rewind features of Claude and Codex; revert is git-level.

## Further Notes

- Section briefs are in `sections/`; the ticket graph is `tickets.md`; open questions with defaults are in `decisions.md`.
- The briefs found several code facts that corrected the screen-pass notes:
  - `experimentalApi` is already on for Codex.
  - The auto-download setting already exists.
  - Codex already checks its CLI version.
  - The Copilot SDK carries a deny reason.
  - A `file.read` RPC already exists.
  - Thread-control approvals already reach threads as ordinary permission requests.
- Bugs found along the way are folded into the tickets that touch them:
  - A user Stop is saved as "interrupted".
  - Cursor deny can pick an allow option.
  - Removing the notes chip also deletes Review comments.
  - OpenCode drops native errors.
  - Devin reports quota and sign-out as interruptions.
