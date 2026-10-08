# 12 Right panel tabs: codebase interview (2026-10-07)

Read-only investigation before designing section 12 (Plan excluded, already designed in 07). Three explorers (terminal and project actions, subagents and coordination, panel shell plus Project settings and Files), synthesized and spot-checked. Paths under `apps/web/src` unless noted.

Spot-checked myself: exited terminals are removed from the store 2s after exit (`transport/ws-events.ts` `terminal.exit` handler); `confirmOnKill` is read only by `TerminalPanel`, which is exported but never mounted; Coordination cards print raw `workspaceId` (`CoordinationPanel.tsx:161`); `openThreadCoordinationPanel` has no non-test caller; a new action starts with an empty command (`ProjectEnvironmentPanel.tsx:39-45`); terminal cap is 4 per scope (`terminalStore.ts:70`); `detectLocalPorts` is still unimplemented in `apps/desktop`.

## Panel shell

- Tabs (`lib/panel-tabs.ts`): Browser, Terminal (repeatable, max 4 per scope), Project Action (system-managed, one per action, needs thread), Files (coming soon, never opens), Review, Project settings, Plan, Subagents, Coordination. Thread-only: Plan, Subagents, Coordination, Project Action. Shortcuts: Browser `mod+shift+b`, Terminal `mod+j`, Review `mod+d`, Plan `mod+t`, panel `mod+alt+b`; Project settings, Subagents, Coordination have none.
- Rail (`ActivityRail.tsx`): 48 collapsed, 160 expanded on hover (140ms in, 250ms out), floating over content. Tabs in creation order, drag or Alt+Shift+↑/↓ to reorder. Active = amber inner-edge bar. Close × only when expanded. Only Review has a badge. Browser shows one favicon per page. Add control only once a tab is open; a single creatable type opens directly, more open a menu. At the terminal cap the add control is disabled with a screen-reader-only reason.
- Empty state (`PanelEmptyState.tsx`): "Open a tool" / "Pick one to open it in this panel.", one-column list with icon, label, blurb, keycap; Files disabled "Soon".
- State: everything per thread with a workspace fallback copied on first write; an untouched thread inherits the fallback's tabs except terminals. Nothing persists across restart except Review's files-pane visibility. Width min 384, default 440, wide 680; auto-sizes to half the row on first open; maximizes when there is no room and hides chat. Closing the last tab leaves the empty state (CONTEXT says the panel should close).
- Drift: ADR-0004 per-workspace width/tabs vs code's per-thread (ADR-0012 still "proposed"); dead `ScopeProgress`; drag-to-collapse supported but not wired.

## Terminal

- Surface: xterm v6 (fit, search, serialize; WebGL off in Electron), hardcoded `#0a0a0f`/`#e4e4e7` theme that ignores tokens, `p-3`, JetBrains Mono 11 to 19px. No header or toolbar inside the tab; everything is on the rail.
- Naming: shell basename ("pwsh"), duplicates "pwsh (2)", rebuilt after reconnect "Terminal N". No running or exited status on the tab.
- States: hidden until replay finishes (no spinner); exited/failed box "This terminal exited with code N. Its completed output is retained." with Retry terminal, Close terminal, Copy diagnostics; inline "[Process exited with code N]", "[Reconnected - some output may be missing]", "[Earlier output beyond the scrollback limit was trimmed]". Search shelf on Ctrl/Cmd+F (case, word, regex). Copy on Ctrl+C with selection, paste Ctrl+Shift+V or right-click (no context menu). Only absolute file paths are links; web URLs are not clickable. Scrollback 100 to 5000 (default 1000).
- Lifecycle: cwd is the thread worktree, else workspace root. Shell from certified profiles (PowerShell 5.1/7, Git Bash, zsh/bash). PTY survives thread switch and panel hide (detach and replay). Packaged server keeps running after quit and replays on reconnect, but rail tabs are not rebuilt. Closing a tab kills the PTY with no confirm and no error on failure. `mod+j` focuses the most recently created terminal, not the last active.
- Agents: providers run commands in their own processes; no link to these PTYs, no "send output to agent".
- Bugs: exited terminals vanish from the store after 2s, cutting off the Retry tombstone, and the rail tab falls back to "Terminal"; Retry/Close don't update rail tabs; `confirmOnKill` setting does nothing; starting/exiting/failed states never occur on the default (legacy) backend; composer chip "N active terminals" counts exited ones and always spins; dead `TerminalPanel`/`TerminalToolbar`/`TerminalList` with "Kill all"; `openAutomaticSetupTerminal` has no UI caller.

## Project Action

- An action is `{id, name, command}` (per-platform scripts) in the workspace environment. Run from the thread overview's Project Actions menu. Starting adds a rail tab but does not open it.
- Tab: not xterm; a read-only `<pre>` with basic ANSI colour. Header: name, Restart, Stop (while running). Footer "Exit code: N". "No output", spinner, "This Project Action result is unavailable.". States: awaiting-approval, running, completed, failed, interrupted, unavailable. Transcript capped at 512KB, re-sent whole on each update. Running actions become interrupted on server start.
- Gaps: closing the tab does not stop the action; completed/failed icon disappears after 2s; no approve button for awaiting-approval; truncation never shown; no port or URL detection, no link to the Browser.
- Three separate terminal-like renderers exist: xterm, the action `<pre>`, the setup `TerminalBlock`.

## Project settings

- Edits setup command and project actions only (each with Default plus macOS/Linux/Windows scripts). No env vars, ports or secrets. Storage: System (this computer) or Shared (`.mcode/environment.json`, needs command approval; "Clear shared command approvals" without confirm).
- Explicit Save and Reload, no dirty indicator, revision-checked ("Workspace environment changed since it was loaded", no reload CTA). Server validation only (empty script, size caps, duplicate id, name 1 to 256); errors shown as raw `path (reason): message`.
- Reached from the thread overview settings button, "Edit project actions", and the command palette; not on the Settings page; no shortcut; opens differently from other tabs.
- Bugs: Add action then Save fails with `empty_script`; switching storage overwrites the draft; drafts lost on tab switch or thread switch with no guard; stale errors linger; naming drifts ("Project settings", "Edit Project environment", "Environment storage", "Loading environment...").

## Files

- Teaser only. `FilesPanel.tsx` is a generic navigator used by Review's changed-files pane and PR detail. `listWorkspaceFiles` exists (composer autocomplete) and could feed it (inferred). Name clashes with Review's "Files".

## Subagents

- Opens from rail/empty state, chat chips (`openSubagentDetail`, `openSubagentsRoster`), thread overview row. No shortcut.
- Data: canonical roster polled every 1.5s (Codex child threads only, with stop) merged with a narrative roster from `Agent` tool calls (Claude Task, Cursor heuristics, Devin). Copilot children never appear (inferred). Only Codex can be stopped.
- UI: "Active N" and "Done N" sections; rows show animated identity glyph, title, lineage, identity, model · reasoning, "Active descendant", status and relative time. No provider icon, no duration. Detail: full transcript for canonical children, output plus activity tree for narrative ("Earlier activity is truncated."). Stop, "Stop all" (2+ stoppable) with confirm. No jump to chat.
- Copy: "Loading subagents…", "Could not load subagents" / "The canonical roster is unavailable.", "Sub-agents will appear here when this thread delegates work.".
- Bugs: elapsed time, steps, file effects computed but never shown; cancelled children show as Failed (inferred); status words differ across surfaces (Errored/Cancelled/Finished vs Interrupted/Completed); detail status is screen-reader only; overview (narrative only, comma copy "1 active, 2 done") and panel can disagree; polling runs for providers that never have canonical children.

## Coordination

- A coordinator thread delegates work to other Mcode threads, possibly in other projects, which outlive it; only a human approves requests (ADR-0021). Server is real (thread-control service plus MCP tools).
- UI (`CoordinationPanel.tsx`): header with provider icon, "Coordination", thread title, status; "Delegated from"; "Delegated threads (N)" cards (provider, title, status, provider · raw workspaceId, Open thread, Send follow-up, Stop); "Approval requests" (Allow, Deny); "Message origins". Statuses: Created, Running, Idle, Waiting for approval, Waiting for user, Failed, Stopped, Completed.
- Opens only from rail and empty state; no chat presence.
- Bugs: raw workspaceId, approvalId, threadId shown; no empty state; send/stop failures swallowed; `hasMoreMessages` ignored; store can hang loading (inferred).

## Design inputs already decided

Two-row panel header from Review and Browser (row 1 beside window buttons, row 2 tab-specific controls, nothing floating over content); round 32 icons; names-only menus with dividers; 24px fade truncation; provider icons; dev-terse copy.
