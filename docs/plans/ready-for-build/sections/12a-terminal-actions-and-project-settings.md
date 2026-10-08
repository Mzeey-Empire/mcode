# 12a · Terminal, project actions and Project settings: build brief

When this section ships, every shell and every project action lives in one Terminal tab with two header rows and real xterm terminals. Running an action opens a terminal that shows its command, its output, a green or clay status, the detected port, and stays open as a shell afterwards. Shared actions from `.mcode/environment.json` ask for approval inside the terminal. Setup stops being a separate thing: actions can run on startup (before the first turn of a thread that starts in a worktree) and on cleanup (before the worktree is removed). Mcode keeps one terminal backend. The thread overview gains a Terminals section and a names-only actions menu. Project settings becomes a sectioned tab (General: name, icon, location; Actions), with drafts that survive tab switches, a save bar, and plain validation copy. Projects get an icon (a chosen image file, an automatically found favicon, or a monogram) in the sidebar, breadcrumb and project picker.

Surfaces: contracts (`workspace-environment.ts`, legacy terminal wire, workspace, thread startup), server (legacy terminal service, project actions, workspace environment, cleanup worker, a new project icon service on the shared S12P-03 image route, DB migrations), web (Terminal tab, thread overview, Project settings, sidebar and picker, the S04 steps trail's setup step), desktop (none beyond the existing bridge). Files, Subagents and the panel shell are the sibling brief "S12P".

## Boards

All on page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0

| Board | Node | Shows |
|---|---|---|
| 12a · Terminal · Shell open · Two rows · Dark | `22UJ-2` | Full window. Right panel 584 (536 + 48 rail). Row 1 (48, padding-right 98): terminal tabs `pwsh` (prompt glyph) and `web` (14px action icon + 8px green status badge), round +, expand, toggle. Row 2 (40): working-folder pill, round Search, Clear, More. Surface inset. Rail keeps one Terminal icon. No composer terminal chip. |
| 12b · Terminal · Actions and states · Dark | `2FWV-2` | Action running (`2FX0-2`): command pill, port pill `:5173`, Restart, Stop, More. Action failed (`2FZ3-2`): clay dot on tab, `Exit 1` pill, Run again replaces Stop and Restart, shell prompt after the output. Needs approval (`2G11-2`): hollow amber ring on the tab, "Run web?" card with the command and Run / Cancel. Close while running (`2G2H-2`): hover swaps the dot for ×, "Stop web?" popover (`2G4L-2`) with Stop and close / Cancel. |
| 12d · Project settings · Actions only · Dark | `2GT5-2` | States: Actions list (`2GTA-2`), General automatic icon (`2GWA-2`), Choose file popover (`2GXN-2`), icon file chosen (`2GZU-2`), new action unsaved with save bar (`2H1A-2`), In repo changed on disk (`2H4J-2`), icon picker open (`2H7R-2`). |
| 12h · Project settings full window | `23RB-2` | Actions section in context; rail Project settings tab active. |
| 12i · Thread overview · Project actions · Dark | `2HLW-2` | Overview Terminals section: default (`2HM1-2`), actions menu open (`2HQ7-2`, menu `2HUD-2`), expanded with row hover (`2HVK-2`, section `2HYE-2`), nothing running (`2HZX-2`). |
| 12j · Overview with Terminals · full window | `258G-2` | Overview card in context, Terminals section between Activity and Recap. No composer terminal chip. |
| 12k · Project icon in the sidebar | `242M-2` | Project icon in the sidebar row (`243W-2`, 16px, radius 4, 24 slot), breadcrumb (`249N-2`, 14px, radius 3), Project settings General with a chosen icon. |

Exact values read from Paper (use these, not screenshots):

- Row-1 terminal tab: height 32, radius `--radius-control`, padding 10/12, gap 8; 14px glyph; label 14/20 weight 500, ink when active (with `--color-selected` fill), muted when inactive. Action tab glyph: 14px action icon with an 8px status badge at bottom-right (-3, -3), 2px ring in `--color-page`; success = running, error = failed. Approval tab: 8px hollow ring, 1.5px `--color-primary`, no icon (`2G18-2`). Round + and header buttons: 32px circle, `--color-selected` fill, 16px ink glyph.
- Row 2: height 40, padding-inline 8, gap 8. Working-folder and command pills: height 32, radius `--radius-18`, `--color-selected`, padding-inline 12, 14px muted glyph, 12px mono text (folder: parent muted, name ink; command: ink), 24px right-edge fade. Exit pill: 32 tall, radius 999, padding 10/12, gap 6, 8px `--color-error` dot, "Exit 1" 12/16 weight 500 `--color-error` (`2FZV-2`).
- Terminal surface: 8px inset (bottom and sides), `--color-page`, radius 10, padding 12/14, `--font-mono` 13/20; prompt `--color-muted`, command `--color-ink`, ANSI green `--color-success`, yellow/modified `--color-primary`, red `--color-error`, links `--color-link` (`2324-2`).
- Approval card (`2G25-2`) and close confirm (`2G4L-2`): `--color-panel`, 1px `--color-border`, radius `--radius-14`, padding 14, gap 12; title 14/20 weight 600 ink; body 13/20 muted; command block `--color-page`, radius 8, padding 10/12, mono 12/18; primary button ink fill with `--color-background` text 13/18 weight 600, secondary `--color-selected` 13/18 weight 500, both 32 tall radius 999 padding-inline 14. Popover: width 280, shadow `#00000080 0 16px 40px` (F-07).
- Overview Terminals (`2HYE-2`): label row 24 tall, 12/16 weight 500 muted. Rows 32 tall, gap 8: 16px icon slot, name 14/20 ink, meta 12/16 muted (mono for ports, sans for words). Hover: `--color-hover`, radius 8, row widened by 8px each side (margin-left -8, width calc(100% + 16px), padding 8/4), 24px round Stop with `--color-selected` and an 8px ink square (radius 2). "N more" / "Show less": 14px chevron, 14/20 muted. Section gap 4.
- Actions menu (`2HUD-2`): width 232, `--color-panel`, 1px border, radius 14, padding 6, same shadow. Rows 36 tall, radius 8, padding-inline 10, gap 10, 16px icon, 14/20 ink. Running badge 9px `--color-success` with 2px `--color-panel` ring at (-3, -3). Hovered idle row: `--color-hover` plus right-aligned muted "▶ Run" (10px glyph, 12/16). Dividers: 1px `--color-border` inside 4/6 padding.
- Sidebar project icon 16px radius 4 in a 24 slot (`243W-2`); breadcrumb 14px radius 3 (`249N-2`).

Board discrepancy: 12b draws the running action tab as a bare green dot, 12a as the action icon with a green badge. The action-icon decision (2026-10-08, second pass) came after 12b, so build 12a's version. Overview rows in 12i read "test · watch"; that is sample text (decision T4).

## Locked decisions

From `source/screen-pass-todo.md` and `source/implementation-notes.md` ("Right panel tabs (12)"), user decisions dated:

- 2026-10-07: project actions run in real terminals; starting an action opens a normal interactive terminal tab and runs the command in it. Same for setup output. One renderer for everything (xterm).
- 2026-10-07: Project settings is actions only. Setup becomes an action marked "Run on startup" (hint "When a thread starts in a worktree", decision T10, because existing worktrees also run setup after S04-07); "Run on cleanup" runs "Before the worktree is removed". The server runs startup actions in setup order and cleanup actions before worktree removal.
- 2026-10-07 (approved 12a/12b): Terminal uses the two-row header like Review and Browser. Row 1: terminal tabs, round +, expand, toggle. Row 2 for a shell: working-folder pill (click copies; menu opens in editor or file manager), Search (Ctrl F), Clear (Ctrl K), More. Row 2 for an action: command pill, detected port pill (opens in the Browser tab), Restart, Stop (Ctrl C, then kill), More. Failed: clay status, "Exit N" pill, Run again in place of Stop; the shell stays open. The tab strip replaces the per-terminal rail entries; the rail keeps one Terminal icon. Surface uses tokens. Web URLs become clickable.
- 2026-10-07: shared actions from `.mcode/environment.json` wait in the terminal for approval before anything runs ("Run web?", command block, Run / Cancel); the tab gets the amber needs-you ring; approval sticks until the command changes.
- 2026-10-07: Close: hover swaps the tab's glyph or dot for a close icon. Closing asks only when a process is still running ("Stop web?", Stop and close / Cancel), wiring the existing Confirm on kill setting. Idle shells and finished runs close at once. Exited terminals stay until closed.
- 2026-10-08 (12i/12j approved): the ⋯ beside the overview gear stays the actions entry (tooltip "Actions", selected fill while open), never moves, shows whether or not anything runs. Menu: every action with its icon (running ones carry a green badge; an idle one starts in a new terminal, a running one opens its terminal), divider, New terminal, divider, Edit actions. A "Terminals" section sits between Activity and Recap with the Recap/Usage label style and hides with its divider when nothing runs. Rows list only terminals that are running now, newest first, at most 3, then "N more" which expands in place and becomes "Show less". Clicking a row opens its terminal; hover shows a 24px round Stop. No status badges in rows. When a terminal exits it leaves the section. The separate Setup card goes away. In the full window the overview caps at window height and scrolls with a bottom fade.
- 2026-10-08: action icons come from the vscode-icons set the diff view uses (24 tool icons: bun, npm, pnpm, node, docker, vite, vitest, jest, playwright, storybook, eslint, biome, prettier, typescript, turbo, prisma, pgsql, git, makefile, shell, powershell, python, rust, go) plus 12 Lucide glyphs tinted from the `getFileIconColor` palette (play, hammer, flask, sliders, rocket, globe, database, bug, refresh, zap, key, trash). Stored as an icon id, never SVG. Default from the command's first word (bun, npm, pnpm, node, docker, make, python, cargo→rust, go, pwsh→powershell, else play). Plain shells use their shell's icon. 16px everywhere an action appears, 14px in row-1 tabs.
- 2026-10-08 (12d/12h approved): Project settings is sectioned; row 2 holds a section pill (General | Actions) and the section's action ("+ Action"). General: Icon (40px tile, label, source line, Choose file, reset "Use automatic" only when a file is chosen), Name ("Defaults to the folder name", same value as `workspace.rename`), Location (mono path, open-folder button). Actions: "Saved on: This computer | In repo" first; rows with icon, name, command (mono, fade), "On startup"/"On cleanup" chips, play; expanded row with icon picker, name, play, More (duplicate, delete), Command with All / macOS / Linux / Windows (dot = override), mono editor, the two toggles. New actions append at the bottom; Save stays off until there is a command, hint "Add a command to save this action.". Save bar only with unsaved changes (amber dot, Discard, Save). Drafts kept per project in memory. Revision conflict: "…changed on disk" with Keep mine / Reload.
- 2026-10-08: project icon follows T3 Code: explicit path wins, else automatic detection (well-known paths, then `<link rel="icon">`), else a monogram (first letter on amber). Project files only, stored workspace-relative, so every worktree shows the same icon. No Lucide/emoji/colour choices, no files outside the project. A deleted chosen file falls back to automatic and says the file is missing. Icon replaces the folder glyph in the sidebar project row, breadcrumb and project picker.
- 2026-10-07: Coordination tab removed (S12P owns it).
- 2026-10-07: truncation is a 24px right-edge fade, never an ellipsis (F-02). Dev-terse copy, no explanatory captions.

## How it works today

Paths are relative to the repo root. Verified by reading the code unless marked "(inferred)".

### Terminal backend

- Two backends. `legacy` is the default; `MCODE_TERMINAL_BACKEND=modern` opts into `modern` (`apps/server/src/features/terminal/backends/terminal-backend-selector.ts:15`). No product code sets the variable; only the composition (`apps/server/src/features/terminal/composition/register-terminal.ts:122`) and tests read it. Both share the Node PTY host. The modern path adds a v1 wire (`terminal.session.*`, `packages/contracts/src/ws/terminal.ts`), a web client picked from `terminal.capabilities` (`apps/web/src/features/terminal/adapters/terminal-client-selector.ts`), controller leases with input acknowledgement, and retained exit tombstones (`packages/contracts/src/models/terminal.ts:202-230`). The legacy wire is described as "frozen version 0" (`packages/contracts/src/ws/terminal-legacy.ts:4`): `terminal.create {threadId} → {ptyId, shell}`, `terminal.exit {ptyId, code}` push, `terminal.listActive → [{ptyId, threadId}]`.
- Legacy caps shells at 4 per scope, counting headless action PTYs too (`apps/server/src/features/terminal/backends/legacy/terminal-service.ts:32,216`). The web mirrors 4 for shells only (`apps/web/src/features/terminal/state/terminalStore.ts:70,384`).
- On exit, the server removes the session and deletes its replay buffer at once (`terminal-service.ts:681,707-728`), so no client can replay an exited shell. The web removes the terminal from its store 2s after `terminal.exit` (`apps/web/src/transport/ws-events.ts:194-201`), which cuts off the "This terminal exited with code N" tombstone (`apps/web/src/features/terminal/surfaces/TerminalView.tsx:477,526`). Verified.
- Closing a Terminal tab kills with no confirm and no error handling (`.then` without `.catch`) (`apps/web/src/components/panels/RightPanel.tsx:942-951`). `confirmOnKill` (`never | withChildProcesses | always`, default `withChildProcesses`, `packages/contracts/src/models/terminal-settings.ts:49,179`) is read only by `TerminalPanel` (`apps/web/src/features/terminal/surfaces/TerminalPanel.tsx:56,128-148`), which nothing mounts. `TerminalPanel`, `TerminalToolbar`, `TerminalList` and `TerminalKillConfirmDialog` are dead outside their own tests. Verified.
- Theme is hardcoded (`TerminalView.tsx:69` `#0a0a0f`, `:676-677` `#e4e4e7`). The link provider only matches file paths (`apps/web/src/features/terminal/surfaces/terminalLinkProvider.ts:45,83`).
- Each shell is its own rail tab `terminal:<ptyId>` (ADR-0020); `mod+j` focuses the most recently created terminal (interview, not re-verified).
- The composer chip "N active terminals" counts every terminal in the store, always spins and pulses (`apps/web/src/components/chat/TerminalStatusIndicator.tsx`, mounted at `apps/web/src/features/conversation/composer/ComposerStatusStrip.tsx:91`). Verified.

### Project actions

- An action is `{id, name, command}` where `command` has `default` and per-OS scripts (`packages/contracts/src/models/workspace-environment.ts:63-91,644-650`). The action schema and document are `.strict()`, and the document version must equal `"0.0.1"` (`:6,656-669`), so any new key or version is rejected by current builds.
- Runs: `ProjectActionService.start` resolves the command, checks approval, then calls `TerminalBackend.startPreparedCommand` (`apps/server/src/features/projects/environment/project-action-service.ts:198-206`). Legacy runs it as a **headless** PTY with the shell's noninteractive form (`pwsh -NoLogo -NonInteractive -Command <script>`, `bash -lc <script>`, `cmd /d /s /c`, `wsl --exec sh -lc`; `apps/server/src/features/terminal/commands/terminal-command-service.ts:365-380`; `terminal-service.ts:327-378`). Headless sessions are hidden from `listActive` and `killByThread` (`terminal-service.ts:511,623`) and never push `terminal.exit` (`:689-693`). The base class rejects prepared commands (`apps/server/src/features/terminal/backends/terminal-backend.ts:119-121`), but both backends override it: legacy at `legacy-terminal-backend.ts:131-166`, modern as a hidden prepared session at `modern/modern-terminal-backend.ts:651-657`. Actions therefore run on either backend today.
- Stop sends Ctrl C, waits 5s, then kills (`terminal-service.ts:379-397`); the run becomes `interrupted` (`project-action-run-lifecycle.ts:109`). One run per `{threadId, actionId}` slot (`project-action-service.ts:171,370`, DB unique index `apps/server/src/runtime/persistence/sqlite/schema.ts:445-468`).
- Output is kept as a 512KB `transcript` on the run (`workspace-environment.ts:18,332-349`), persisted and re-sent whole inside `workspace.environment.action.updated` on each update (`packages/contracts/src/ws/channels.ts:81-86`; `project-action-run-lifecycle.ts:20-28`). The tab renders it in a read-only `<pre>` with a hand-rolled ANSI parser (`apps/web/src/features/projects/environment/ProjectActionControl.tsx:357-629`), opened as the system-managed `action-terminal` panel tab (`apps/web/src/lib/panel-tabs.ts:69-75`; `RightPanel.tsx:773,1010-1027`). Completed/failed icons vanish after 2s (`ProjectActionControl.tsx:30`). No port detection anywhere. Verified.
- Approval: shared (In repo) commands need a content-bound approval. The fingerprint hashes project id, command identity (`setup` or `action:<id>`), OS, the resolved script and the terminal executable and arguments (`workspace-environment-service.ts:2104-2128`). So an approval already "sticks until the command changes". Approval runs show a dialog (`ProjectActionControl.tsx:322`).

### Setup

- Document field `setup` (`workspace-environment.ts:659`) and a command target `{kind: "setup"}` (`:104-110`).
- Automatic Setup: a managed New worktree thread queues its first turn behind a Setup gate; the service reads `document.setup` and runs it through `TerminalCommandService` (a plain child process, not a PTY) with output capped at 512KB on the attempt (`workspace-environment-service.ts:1190-1240`; attempt schema `workspace-environment.ts:470-485`). Only `managed-worktree` startups get a setup phase (`apps/server/src/features/agents/turns/thread-creation-coordinator.ts:430-433`; phases `packages/contracts/src/thread-startup.ts:107-111`). The web polls the gate snapshot every second (`apps/web/src/features/projects/environment/ProjectAutomaticSetupControl.tsx:83`) and asks for approval in a dialog (`apps/web/src/features/conversation/messages/chat-view/ChatViewSurface.tsx:589`).
- Manual Setup: "Run Setup" in the overview actions menu and a `ProjectSetupAttemptCard` under the overview masthead (`apps/web/src/components/chat/ThreadOverview.tsx:2563-2607`), output in `TerminalBlock` (`apps/web/src/features/projects/environment/ProjectSetupControl.tsx:228-229,270`).
- `openAutomaticSetupTerminal` opens a recovery shell; no UI calls it (`apps/web/src/transport/types.ts:344`; server `workspace-environment-service.ts:537`). Verified by grep.
- Worktree removal happens in `CleanupWorker.removeLockedWorktree` under a per-repository mutation lock, after the retention policy decides and linked thread runtimes are torn down (`apps/server/src/features/thread-control/cleanup/cleanup-worker.ts:309-345`). Nothing runs before removal today.

### Project settings

- `ProjectEnvironmentPanel` edits Setup and actions, explicit Save/Reload, revision-checked (`workspace-environment-service.ts:929-967`, error "Workspace environment changed since it was loaded"). New actions start with an empty command (`apps/web/src/features/projects/environment/ProjectEnvironmentPanel.tsx:39-45`), so Add then Save fails `empty_script`. Raw `path (reason): message` errors (`:112`). Storage switch radio reads the other document and overwrites the draft (`:294-340`). "Clear shared command approvals" clears all, no confirm (`:364-366`). Drafts live in component state and are lost on tab or thread switch. Verified.
- Storage: This computer is a file at `<mcodeDir>/projects/<workspaceId>/environment.json` (`workspace-environment-service.ts:568`), not a DB row. In repo is `.mcode/environment.json` in the base checkout, or in the thread's worktree when a thread is given (`:716,731`). Storage mode lives in `workspace_environment_storage_settings` and is auto-detected from a valid shared file (`:747`).

### Project icon

- `WorkspaceSchema` and the `workspaces` table have no icon (`packages/contracts/src/models/workspace.ts:5-21`; `schema.ts:12-26`). The sidebar project row's glyph is a lifecycle toggle button that swaps `FolderOpen`/`FolderCheck` on hover (`apps/web/src/features/projects/ProjectTree.tsx:2589-2593`). The project picker uses `Folder` (`apps/web/src/components/chat/NewThreadProjectPicker.tsx:55,91`). No breadcrumb exists in code today (inferred from grep; the canvas header owner adds it).
- Prior art for serving files to the renderer: authenticated `GET /attachments/<threadId>/<file>` with a CSP header and `?token=` support (`apps/server/src/application/transport/ws-server.ts:438-482`; `apps/server/src/application/transport/auth.ts:21-36`). Path containment: `FileService` realpath check (`apps/server/src/features/projects/files/file-service.ts:196-212`).
- Icons: vscode-icons via jsDelivr with blob cache and Lucide fallback (`apps/web/src/lib/vscode-icons.ts:11-21,51`); colour palette `getFileIconColor` (`apps/web/src/lib/file-icons.tsx:157`).

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| One terminal backend | `legacy` default, `modern` opt-in through an env variable | Keep `legacy`; delete `modern`, its selector, env option, v1 session wire, web client, tests and docs (decision T11) | contracts, server, web, docs |
| One Terminal rail tab with row-1 terminal tabs | One rail tab per shell; actions a separate tab type | S12P-01 moves terminals into row-1 tabs and writes the ADR; this section styles the strip and row 2 | web |
| Exited terminals stay until closed | Server drops replay on exit; web removes after 2s | Server keeps exited records (bounded replay) until `terminal.kill`; web drops the timer | contracts (additive), server, web |
| Terminals rebuilt after reconnect | Rail tabs not rebuilt | Web hydrates the strip from `terminal.listActive` metadata | contracts, server, web |
| Cap | 4 shells (headless actions count on server only) | 8 terminal records per scope: pending, running and exited, shells and action terminals together, enforced on server | contracts, server, web |
| Action runs in a real terminal, shell stays open | Headless PTY, `<pre>` transcript | Command phase then shell phase in one attachable terminal | server, contracts, web |
| Running / failed / Exit N / Run again | Statuses exist; no exit pill; icons fade after 2s | Row-2 controls from the run record; interrupt exit codes read as Stopped | web, server |
| Approval inside the terminal | Dialog; no approve button on the tab | Pending terminal record with the approval card; amber ring | server, web |
| Port pill, Browser tiles | None | `port` on runs from the current run's command output, TCP probe of the printed host (IPv4 and IPv6); display only, never Setup readiness | contracts, server, web; S11-09 consumes |
| Close confirm | Kill without confirm; setting unused | Popover wired to `confirmOnKill` | web |
| Token theme, mono 13/20, inset | Hardcoded colours | Theme from CSS tokens | web |
| Clickable web URLs | File paths only | Link provider matches http(s) URLs | web |
| Working-folder pill | None | Pill from terminal `cwd`; copy; open in editor / file manager | contracts (additive), web |
| Overview Terminals section | None (composer chip instead) | New section over S03 overview shell; chip retired | web |
| Actions ⋯ menu | Unlabelled menu with status glyphs, Run Setup, 2s fades | Names-only `ActionRunMenu`, shared with row-1 + | web |
| Action icons | None | `icon` id on actions, default from command, registry and picker | contracts, web |
| Run on startup / cleanup | `setup` command; nothing on cleanup | `runOnStartup` / `runOnCleanup` flags; the action runner is the only startup executor, awaits each startup action to exit 0, and the S04 trail projects its frozen action and run ids; cleanup runner before removal | contracts, server, web |
| Setup migration | n/a | 0.0.1 `setup` upgrades on read into a startup action; approvals re-asked once | contracts, server, DB |
| Settings save model | Component state, raw errors, empty-command failure | Per-project draft store, save bar, conflict banner, plain copy | web |
| Project icon | None | `icon_path` column, resolver, `ProjectIcon` served through S12P-03's scoped image route | contracts, server, DB, web |

## Backend architecture

### Per-provider decisions

Terminals, actions, startup and cleanup are run by Mcode, not by a provider. Providers keep running their own commands in their own processes.

| Adapter | Decision |
|---|---|
| Claude | No change |
| Codex | No change |
| Cursor | No change |
| Copilot | No change |
| Devin (ACP) | No change |
| OpenCode | No change |

### A. One backend, and terminal records outlive their process (S12T-01)

Decision (T11): keep `legacy` and delete `modern`. Reasons:

- `legacy` is what every user runs today. `modern` runs only when `MCODE_TERMINAL_BACKEND=modern` is set, and no product code sets it.
- Everything in this section (exited retention, scope listing, action terminals, the cap) is specified against legacy `TerminalService`. The legacy web client is 130 lines (`adapters/legacy/legacy-terminal-client.ts`); the modern client is 539.
- Actions do not decide it. Both backends run prepared commands today.
- What deleting `modern` gives up: controller leases, attachment epochs and input acknowledgement (`docs/internals/runtime/terminal-lifecycle.md`, "Modern attachment and input ownership"), which stop a stale client from writing into a reattached shell, plus its retained tombstones, which S12T-01 rebuilds in legacy. See R1.

S12T-01 deletes, in one ticket:

- Server: `backends/modern/` and its tests; `sessions/terminal-session-runtime.ts`, `sessions/terminal-session-service.ts` and their tests; the `TerminalSessionPolicyError` and `TerminalSessionRuntimeError` handling in `apps/server/src/application/transport/ws-router.ts:120-121`; `TerminalBackendSelector` and its test; the modern registration and `MCODE_TERMINAL_BACKEND` reads in `register-terminal.ts`; the modern branch of the diagnostics factory; the v1 members of `TerminalBackend` (`routeV1`, `handleV1Frame`, the `terminal.session.create` branch of `cleanupDisconnectedCreate`). Keep `sessions/terminal-scope.ts` and `sessions/terminal-replay-buffer.ts`, which `terminal-command-service.ts:8-19` imports.
- Contracts: the `terminal.session.*` methods in `packages/contracts/src/ws/terminal.ts` and `methods.ts:464-471`, with their tests. Keep `terminal.capabilities` and the `terminal.diagnostics.*` methods, which legacy diagnostics use (`terminal-diagnostics-service.ts:44,76`, `TerminalPoolHost.tsx:39,259`); the capabilities `backend` enum becomes `"legacy"` only.
- Web: `adapters/modern/`, `TerminalClientSelector` and their tests, and the v1 frame routing in `ws-transport.ts`. The legacy client becomes the only client.
- Docs: in `docs/internals/runtime/terminal-lifecycle.md`, the selector paragraph, the "Modern attachment and input ownership" section, and every other sentence about the modern runtime.

Retention: the legacy `TerminalService` keeps a terminal record after its process exits, with its replay buffer and exit code, until the user closes it (`terminal.kill`) or the scope is torn down (`killByThread`, thread or workspace deletion). The server is the source of truth for the strip, so the web rebuilds tabs after a reconnect.

Legacy wire, additive optional fields (optional because a running packaged server can be older than the client):

```ts
// packages/contracts/src/ws/terminal-legacy.ts
"terminal.create": { result: z.object({ ptyId, shell, cwd: z.string().max(32_768).optional() }) },
"terminal.listActive": {
  result: z.array(z.object({
    ptyId: z.string(),
    threadId: z.string(),                         // terminal scope id, name kept for compatibility
    shell: z.string().max(64).optional(),
    cwd: z.string().max(32_768).optional(),
    kind: z.enum(["shell", "action"]).optional(),
    actionId: z.string().max(256).optional(),
    state: z.enum(["pending", "running", "exited"]).optional(),
    exitCode: z.number().int().nullable().optional(),
    createdAt: z.string().datetime().optional(),
  })),
},
// packages/contracts/src/models/terminal.ts
export const TERMINAL_MAX_PER_SCOPE = 8;
```

- Cap (decision T2): 8 terminal records per scope. Pending, running and exited records all count, shells and action terminals together, so users close what they no longer need. `TERMINAL_MAX_PER_SCOPE` replaces `MAX_PTYS_PER_THREAD = 4` (`terminal-service.ts:32`) and the web's `MAX_TERMINALS_PER_SCOPE = 4` (`terminalStore.ts:70`, also read by `RightPanel.tsx:40,895` and `lib/ensure-terminal.ts:42,73`). The app-wide `terminal.behavior.sessionLimit` stays. Reason for 8: the overview already designs for "N more" past 3 rows, and a typical thread runs web + test + typecheck + a shell. S12P-01 writes the one right-panel ADR, which records this cap; it is blocked by this ticket and reads the constant from here.
- Memory bound: each exited record keeps only its replay buffer, already capped by `replayCapBytesForScrollback(terminal.behavior.scrollback)`.
- `terminal.write`/`resize` to an exited record fail with the existing "PTY not found"-style error; the web never sends them because the view shows the exited state.
- Docs: rewrite the exit paragraph of `terminal-lifecycle.md` and the CONTEXT "Terminal tab" sentence that says an exited tab "closes automatically".

### B. Action terminals: a command phase, then a shell phase (S12T-05)

Decision: an action run is one terminal record whose process changes over time:

```
pending (approval card, no process) ─Run─▶ command ─exit─▶ shell ─exit─▶ exited
                                        ▲      │Stop: Ctrl C, 5s, kill     │
                                        └──────┴── Restart / Run again ────┘
```

1. **Command phase.** The server writes a synthesized echo line into the terminal stream (muted prompt, ink command: `PS C:\src\mcode-7f3a21> bun run dev` for PowerShell, `C:\...>` for cmd, `$ bun run dev` for POSIX shells; continuation lines indented two spaces), then starts the exact approved script with today's `noninteractiveLaunch` in a PTY attached to the same record. The exit code is the process's real exit code. The terminal service writes the echo into the record's stream itself, so it reaches the replay and the screen but never `onCommandOutput`, which carries only what the command process writes. A URL in the command's own text therefore never reaches port detection.
2. **Shell phase.** When the command process exits for any reason, the server starts the profile's interactive shell in the same record and cwd. Its real prompt follows the output, which is what 12b "Action failed" shows.
3. **Restart / Run again** stop whatever runs (Ctrl C, 5s, kill), write a new echo line and start a new command phase in the same record. A new `runId` is minted; `terminalSessionId` stays.
4. **Close** (`terminal.kill`) kills the current process and drops the record; a run still in its command phase becomes `interrupted`, and `terminalSessionId` becomes null.

Why not literally type the command into an interactive shell (the boards' wording)? Typing changes what runs: multi-line scripts execute line by line with a prompt between them, PSReadLine and readline expand tabs, aliases and `!` history, and getting an exit code needs shell-integration hooks injected into every shell family (PowerShell 5.1/7, bash, zsh; none exist for cmd or WSL) that user prompt frameworks can clobber. It would also change the approved launch arguments, so every existing approval would be asked again. The phase model runs exactly the script the user approved, with an exact exit code, on every certified profile (`apps/server/src/features/terminal/profiles/terminal-profile-service.ts:28-36`), and reuses today's Stop, approval binding and launch-mismatch checks. Two differences from typing the command, both accepted in decision T1 and both stated in the CONTEXT "Action terminal" entry:

- The command is not in the shell's history. Run again covers rerunning it.
- Working-folder and environment changes made by the script (`cd`, `export`, `$env:X = ...`, `set`) do not carry into the shell that follows, because the shell is a new process in the action's original folder.

Seam (replaces `startPreparedCommand` and `PreparedTerminalCommandSession`):

```ts
// apps/server/src/features/terminal/backends/terminal-backend.ts
export interface ActionTerminalRequest {
  readonly threadId: string;
  readonly actionId: string;
  readonly echo: string;                                   // the script as displayed
  readonly launch: PreparedActionLaunch | "pending-approval";
}
export interface PreparedActionLaunch {
  readonly script: string;
  readonly expectedLaunch?: PreparedTerminalCommandExpectation; // unchanged approval binding
}
export interface ActionTerminal {
  readonly terminalSessionId: string;                      // ptyId the web attaches to
  run(launch: PreparedActionLaunch): Promise<WorkspaceEnvironmentActionLaunchSnapshot>; // pending → command, or restart
  stopCommand(): Promise<void>;                            // Ctrl C, 5s, kill; shell phase follows
  /** Bytes the command process writes, from start to exit; never the synthesized echo line. Feeds port detection (S12T-08) and the startup tail (S12T-11). */
  onCommandOutput(listener: (bytes: Uint8Array) => void): () => void;
  onCommandExit(listener: (exit: { readonly exitCode: number | null }) => void): () => void;
  onClosed(listener: () => void): () => void;              // record dropped by terminal.kill or teardown
}
export abstract class TerminalBackend {
  // ...existing legacy members; startPreparedCommand removed
  abstract openActionTerminal(input: ActionTerminalRequest): Promise<ActionTerminal>;
}
```

Inside legacy `TerminalService`: a record keeps its web-facing id, replay buffer, flow control and an output sequence counter; each phase gets its own host session id, and host output sequence numbers are offset so the record's sequence stays monotonic across phases. Host events route by host session id to the record. Action records are ordinary attachable terminals (normal flow control: paused until a client attaches, output always lands in the replay buffer). The `headless` flag, `headlessOutput` and `completedHeadlessSessions` go away.

`ProjectActionService` changes:

- `start` reserves the slot, resolves the command, then calls `openActionTerminal` with either the prepared launch or `"pending-approval"`. If a terminal already exists for the slot (its tab is open), `start` returns the run and the web focuses that tab; it does not open a second one.
- `stop` calls `stopCommand`. `restart` calls `run` again. Both work in either phase.
- Interrupt exit codes map to `interrupted`: 130 on POSIX and `0xC000013A` (signed `-1073741510`) on Windows, in addition to the existing Stop path. Other non-zero codes are `failed` with the code.
- Run updates publish only on lifecycle changes (status, exit code, port, terminal id), never on output.

Run contract:

```ts
// packages/contracts/src/models/workspace-environment.ts
export const WorkspaceEnvironmentActionRunTriggerSchema = z.enum(["manual", "startup"]);
export const WorkspaceEnvironmentActionRunSchema = lazySchema(() => z.object({
  threadId, workspaceId, actionId, runId, revision,
  terminalSessionId: z.string().min(1).max(256).nullable(), // null once its terminal is closed
  actionName, status, snapshot, createdAt, startedAt, finishedAt, exitCode,
  trigger: WorkspaceEnvironmentActionRunTriggerSchema,
  port: WorkspaceEnvironmentActionPortSchema().nullable(),  // S12T-08; null until then. May belong to an earlier run (port.runId).
}).strict().superRefine(validateWorkspaceActionRun));
// removed: transcript, transcriptTruncated, WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES
```

DB (Drizzle migration, `apps/server/drizzle/`): `project_action_runs` drops `transcript`, `transcript_truncated`; adds `trigger TEXT NOT NULL DEFAULT 'manual'`, `port_json TEXT` (S12T-08 may add `port_json` instead if it lands later; one migration per ticket).

Failure modes: launch failure keeps today's compensation (`project-action-launch-compensation.ts`); approval mismatch at launch renews `awaiting-approval` (existing `resolveApprovalAfterLaunchMismatch`); server restart turns running runs `interrupted` (existing `recoverStaleRuns`) and terminals do not come back (same as shells). Cap reached: `start` throws a new `WORKSPACE_ENVIRONMENT_TERMINAL_CAP` error ("8 terminals are open. Close one to run web.").

### C. Approval in the terminal (S12T-07)

A shared action without a stored approval opens a `pending` record (no process) and a run with `awaiting-approval` whose snapshot carries `{target, fingerprint}` (unchanged). The web renders the approval card in that terminal's surface. Run → `workspace.environment.command.approve({threadId, target, fingerprint})` then `workspace.environment.action.start`. Cancel → `terminal.kill(ptyId)`; the run becomes `interrupted` with no start time (valid under today's refinements) and the tab closes. The approval persists by fingerprint, so it holds until the script, OS or terminal profile changes. The tab shows the hollow amber ring while pending.

### D. Port detection and reachability (S12T-08)

S12T-08 owns port detection for every consumer. The port pill, the overview Terminals rows (S12T-10) and section 11's project server tiles, Start web and overview row all read the same `run.port`. A port is a display fact. It never makes a startup action ready and never releases the Setup gate or the first turn; only exit 0 does (Backend F).

```ts
export const WorkspaceEnvironmentActionPortSchema = lazySchema(() => z.object({
  runId: z.string().min(1).max(256),                                 // the run whose output printed the URL
  port: z.number().int().min(1).max(65_535),
  host: z.enum(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]),  // as printed, lowercased, brackets removed
  url: z.string().url().max(2_048),                                  // URL to open; wildcard hosts become localhost
  reachable: z.boolean(),
  detectedAt: z.string().datetime(),
}).strict());
```

- Plain-text decoder (`apps/server/src/features/terminal/output/terminal-plain-text.ts`, pure, new here). A streaming decoder that removes CSI, OSC (including OSC 8 hyperlinks), DCS and other escape sequences, drops C0 controls except `\n` and `\t`, and applies `\r` overwrites. It decodes UTF-8 in stream mode and carries an incomplete escape sequence into the next chunk. Vite, for example, prints `http://localhost:\x1b[1m5173\x1b[22m/`, so the port only reads correctly after decoding. The S12T-11 startup tail reuses this decoder.
- Detector (`apps/server/src/features/projects/environment/action-port-detector.ts`, pure). It reads the current run's decoded command output (`onCommandOutput`, Backend B), which excludes the synthesized echo line, so a URL in the command's own arguments, such as `--open http://localhost:5173/`, never becomes a candidate. It collects `http(s)://` URLs with an explicit port and a host of `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` or `[::]`. LAN and public hosts, and URLs without a port, are ignored, so `https://bun.sh/docs` never counts. Candidates are deduplicated by host and port, at most 8 per run. Scanning stops after 1MB of output or once a candidate is confirmed. A printed URL stays a candidate until the probe answers.
- Probe (`action-port-probe.ts`). A TCP connect with a 500ms timeout to the host the URL names. `127.0.0.1` and `0.0.0.0` probe `127.0.0.1`; `[::1]` and `[::]` probe `::1`; `localhost` probes both `::1` and `127.0.0.1`, and either answering counts. A new candidate is probed at once, then every second until one answers. The first candidate that answers becomes `run.port` with `reachable: true`. After that the server probes it every 5s while the run is `running` and publishes only when `reachable` changes. When the run leaves `running`, probing stops and the server publishes `reachable: false`, keeping the port as history.
- Current run only. `run.port` is set only from the current run's output. When a new run starts in the slot, the server stops probing the old port, sets its `reachable` to false and keeps it as display history with the old `runId`. A port is live only when `run.port.runId === run.runId` and `reachable` is true. A previous run's port never shows as live for a new run, even when another process now listens on it.
- What reachable means. Something accepts TCP connections on that host and port. It does not prove that the app is healthy, that it serves HTTP, or that this run's process owns the socket. A server that prints its URL and then fails with "address in use" looks reachable through the other listener until the action exits. That is why a port is display only and never startup readiness. Copy claims only the TCP fact: the port pill tooltip reads "Accepting connections on localhost:5173" or "Not accepting connections on localhost:5173".
- Why not OS socket enumeration: it needs per-OS process-tree-to-socket mapping (netstat, lsof, /proc), misses nothing that matters for dev servers that print their URL, and the desktop-only `detectLocalPorts` it would feed is unimplemented and unavailable to web clients. Output plus a probe is portable and server-side.
- Contract for **section 11** (S11-09 project server tiles, S11-10 Start web, S11-11 overview row): read `run.port` from `workspace.environment.action.list({threadId})` and the `workspace.environment.action.updated` push. An action is a project server in this thread when its run carries a `port`, from this run or an earlier one. Actions that never confirmed a port are not servers. Section 11 uses these tile states with the same names and conditions (its Backend architecture section 3):

  | Tile | Run condition |
  |---|---|
  | Running | `status === "running"`, `run.port.runId === run.runId` and `reachable: true` |
  | Starting | `status === "running"` without a reachable port from this run: the port is an earlier run's history, or this run's port stopped answering |
  | Stopped | Any other status. The port shows as history. |

  Start on a Stopped tile, and Start web on an error page, call `workspace.environment.action.restart` while the run's terminal is still open (`terminalSessionId` set, so Backend B reruns in place) and `workspace.environment.action.start` once it is closed. The startup runner follows the same rule. The states are display only; Running is not Setup readiness. S11-09 removes its own `servers.list` sketch and deletes `detectLocalPorts` and its consumers (section 11 ledger).

### E. Environment document 0.1.0 (S12T-04, S12T-11)

Decision: bump the version, write the lowest version that can represent the document, and preserve unknown keys from now on.

```ts
export const WORKSPACE_ENVIRONMENT_VERSION = "0.1.0";
export const WORKSPACE_ENVIRONMENT_LEGACY_VERSION = "0.0.1";
/** One id bound shared by the document, action runs and the startup record (S12T-11). */
export const WorkspaceEnvironmentActionIdSchema = z.string().min(1).max(256);
export const WorkspaceEnvironmentActionIconIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const WorkspaceEnvironmentActionSchema = lazySchema(() => z.object({
  id: WorkspaceEnvironmentActionIdSchema, name, command,
  icon: WorkspaceEnvironmentActionIconIdSchema.optional(),   // absent = derive from the command
  runOnStartup: z.boolean().optional(),
  runOnCleanup: z.boolean().optional(),
}).passthrough());                                           // keys from newer Mcode survive a save
// Document: version ∈ {"0.0.1", "0.1.0"}; `setup` allowed only in 0.0.1; `.passthrough()` at top level.
```

- Why both: today's builds reject any unknown key (`.strict()`) and any version other than `"0.0.1"`, so no choice made now can make already-shipped builds read new fields. A version bump makes them fail with a clear "Unsupported workspace environment version" instead of an unknown-key error. Preserving unknown keys from 0.1.0 on means the next additive field needs no bump. Unknown keys are carried, never interpreted, and still count toward the 128KB document cap.
- Lowest-version writer `encodeEnvironmentDocument`: if no action sets `icon`, `runOnStartup` or `runOnCleanup` and there are no preserved unknown keys, write `"0.0.1"` so teammates on older builds keep working. Otherwise write `"0.1.0"`. Default icons are derived, not stored, so most documents stay readable by older builds until someone uses startup, cleanup or a custom icon.
- Icon ids are lenient strings, not an enum: an unknown id renders the command-derived default, so a newer icon set does not break older readers.
- Startup count (S12T-11): at most `WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX = TERMINAL_MAX_PER_SCOPE` (8) actions may set `runOnStartup`. Each startup action needs its own terminal record in a new thread's scope, so a ninth could never run. A ninth fails validation with `too_many_startup_actions`. The startup record uses the same constant (Backend F), so every document that validates also fits the record.
- Migration of `setup` (S12T-11), both storage modes: `upgradeEnvironmentDocument` (its own file, `apps/server/src/features/projects/environment/workspace-environment-upgrade.ts`) runs on every read. A 0.0.1 document with `setup` gains a first action `{id: "setup", name: "setup", command: <setup>, runOnStartup: true}` (id suffixed `-2`, `-3` if taken) and loses `setup`. The file is not rewritten on read: Mcode never silently edits a tracked repo file, and This computer files use the same path for one code path. The next Save writes 0.1.0. Thread reads in In repo mode go through the same function, so a branch with an old file behaves the same.
- Approvals: the setup command's identity changes from `setup` to `action:setup`, which is part of the fingerprint. In repo projects with a setup command will ask once, in the startup action's terminal. A migration deletes the dead `workspace_environment_command_approvals` rows with `command_id = 'setup'`. Accepted in decision T5.
- Validation copy (web, from `reason`; server keeps its codes):

| Reason | Copy (under the field) |
|---|---|
| `empty_script` | Add a command to save this action. |
| `script_too_large` | This command is too long. The limit is 32 KB. |
| `command_too_large` | These commands are too long together. The limit is 64 KB. |
| `document_too_large` | Too many actions to save. The limit is 128 KB. |
| `null_byte` | Commands can't contain null characters. |
| `too_many_startup_actions` | At most 8 actions can run on startup. |
| `unsupported_version` | This file was saved by a newer Mcode. Update Mcode to edit it. |
| name empty (`invalid_value` at `name`) | Add a name. |
| `duplicate_action_id` | Not shown; ids are generated. Log it. |

### F. Startup actions replace Setup (S12T-11)

S12T-11 makes the action runner the only startup executor. It converts the runner and every consumer of the old single-script setup in one ticket. Those consumers are the Setup gate, the S04 steps trail (`04-08f` section E), manual Setup in the overview, the Setup section of the old settings panel, the setup approval dialog and the recovery terminal. The Setup gate stays (CONTEXT "Setup gate"); only its executor changes. Which threads get a gate stays a thread-startup decision (managed worktrees, and attached worktrees after S04-07); the runner takes a `threadId` and does not decide.

Runner, in `WorkspaceEnvironmentService`:

1. **Freeze.** On a gate attempt, resolve the actions with `runOnStartup` in list order. For each, compute `scriptHash`, the sha256 of the resolved script for this platform. Write the list to the setup step's `actions` (`04-08f` section E) with `outcome: "pending"` and `runId: null`. The record holds ids and hashes only; scripts stay in the environment document and the run's launch snapshot.
2. **Run** one action at a time through `ProjectActionService.start({threadId, actionId}, {trigger: "startup"})`, each in its own action terminal. When the action's terminal is already open (a retry), `restart` reruns it in place instead. Record the `runId` and `outcome: "running"`.
3. **Ready.** An action is ready only when its current run exits 0. The entry becomes `outcome: "ready"`, and the next action starts. The attempt passes when every entry is ready or skipped, and the gate releases. A detected port never makes an action ready, even one from the current run that answers. Reachability proves only that some process accepts connections (Backend D), and another process can answer while this one is about to fail with address-in-use. The runner does not read `run.port`.
4. **Actions that keep running.** A startup action that never exits, such as `bun run dev` or `bun test --watch`, holds Running setup and the first turn until it exits or the user picks Skip setup, even while its port pill shows a live port. Mcode does not infer readiness from ports, elapsed time or command names. Dev servers therefore stay manual actions, started from the ⋯ menu. A per-action "Keeps running" toggle (start the action without awaiting it) is not part of this program. Decision T3 decides whether a follow-up ticket adds it, and S12T-11 adds no document field, editor control or runner branch for it.
5. **Failure.** The first non-zero exit marks its entry `failed`, writes the setup step's `exitCode`, sets `failedActionId` on the attempt and blocks the gate with `SETUP_FAILED`. The block `detail` is the last non-empty line of the tail. Later actions do not start. The failed action's terminal stays open in its shell phase, which replaces the recovery terminal. A launch failure or the terminal cap (`WORKSPACE_ENVIRONMENT_TERMINAL_CAP`, for example when the user opened shells during setup) blocks the same way, with the error text as `detail`.
6. **Approval.** A shared action without a stored approval opens its pending terminal (Backend C). The attempt goes `awaiting-approval` and the gate blocks with `SETUP_APPROVAL_REQUIRED`. Approving from the terminal card or from the trail's Run setup calls `command.approve`, then `action.start`, for that run. When the run starts, the runner resumes the step and continues. Each shared action asks once, in order.
7. **Retry** (`retryAutomaticSetup`). A new attempt freezes the current list again, so an edit made through Edit script takes effect. It reruns from the first failed action. Actions that exited 0 earlier in this startup are skipped (`outcome: "skipped"`, previous `runId` kept), unless their `scriptHash` changed.
8. **Skip setup** (`continueAutomaticSetup`). Releases the gate. Actions still running keep running.
9. **Cancel** (`stopAutomaticSetup`, called by `thread.startup.cancel`). Stops the sequence and the command phase of every startup run still running in this attempt. Each terminal keeps its shell.
10. **No startup actions.** The gate releases as not required (today's `releaseAutomaticSetupWithoutCommand`).
11. **Restart.** Existing reconciliation turns in-flight attempts `interrupted`, and `recoverStaleRuns` turns their runs `interrupted`. Retry starts a new attempt.

Startup tail. When a startup run starts, the runner appends `$ <first script line>` from the run's launch snapshot as its own entry (the ink command line on board 04b). It then subscribes to the run's command output (`ActionTerminal.onCommandOutput`, which excludes the synthesized echo line), converts the bytes with the S12T-08 plain-text decoder and appends the text to `ThreadStartup.transcript` through the existing bounded store. Writes are coalesced to at most four a second per startup, plus one on exit. The tail keeps the locked 32-entry, 16KB caps and is read-only; the terminal stays the full view. Cursor-movement redraws are dropped, so multi-line progress output can repeat lines in the tail. This replaces today's raw-chunk `appendStartupOutput` (`workspace-environment-service.ts:1479-1489`).

Bounds. `WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX` (Backend E) bounds both the document's startup actions and the record's `actions`, and both use `WorkspaceEnvironmentActionIdSchema`. Scripts never enter the record, so the record has no command bounds of its own.

Attempt contract:

```ts
export const WorkspaceEnvironmentAutomaticSetupAttemptSchema = lazySchema(() => z.object({
  id, state, reason, createdAt, startedAt, finishedAt,
  failedActionId: WorkspaceEnvironmentActionIdSchema.nullable(),
}).strict().superRefine(validateAutomaticSetupAttempt));
// removed: snapshot, outcome, exitCode, output, outputTruncated
```

The frozen list lives in one place, the setup step's `actions`; only the runner writes it.

DB: `workspace_environment_automatic_setup_attempts` drops `launch_snapshot_json`, `outcome`, `exit_code`, `output`, `output_truncated`; adds `failed_action_id TEXT`. Existing finished rows keep their state; in-flight rows are already turned `interrupted` by startup reconciliation.

No new push. The trail reads `thread.startup.updated` for the record and `workspace.environment.action.updated` for runs; S04-04 already removed the 1s polling. After this ticket nothing on the web reads the gate snapshot, so the client `getAutomaticSetup` and the `workspace.environment.automaticSetup.get` method go. The server's `getAutomaticSetup` stays for turn admission (`turn-admission-dispatch-coordinator.ts:585`).

### G. Cleanup actions (S12T-12)

- Where: `CleanupWorker.removeLockedWorktree`, after the policy decides "remove" and linked thread runtimes are torn down, before `gitWorktrees.removeWorktree` (`cleanup-worker.ts:309-345`).
- How: actions with `runOnCleanup`, in list order, run headless through the existing `TerminalCommandService.prepare` in the worktree checkout (cwd from the thread scope), each bounded to 120s with a 64KB output cap for logs. No terminal, no UI: the thread is being torn down.
- Policy: best effort. A failing or timed-out action is logged with its exit code and the removal continues; blocking removal would leak worktrees. Shared actions without a stored approval are skipped and logged (never run an unapproved repo command headless). Not run when the worktree is retained or for Direct/Local threads.
- Lock: these run inside the repository mutation lock, so a slow cleanup delays other worktree operations for that repository by up to 120s per action. See R3.

### H. Project icon (S12T-14, S12T-15)

```ts
// packages/contracts/src/models/workspace.ts
icon_path: z.string().max(1_024).nullable(),   // workspace-relative POSIX path chosen by the user

// packages/contracts/src/models/project-icon.ts (new)
export const ProjectIconSchema = lazySchema(() => z.object({
  workspaceId: z.string(),
  source: z.enum(["chosen", "automatic", "none"]),
  path: z.string().max(1_024).nullable(),       // file actually shown; null for the monogram
  chosenMissing: z.boolean(),                   // chosen file no longer exists; automatic took over
  version: z.string().max(64).nullable(),       // sha256(path, mtime, size) prefix; changes the image URL when the file changes
}).strict());
// RPCs
"workspace.icon.resolve":    { params: { workspaceIds: string[] (max 256) }, result: { icons: ProjectIcon[] } },
"workspace.icon.set":        { params: { workspaceId, iconPath: string | null }, result: ProjectIcon },
"workspace.icon.candidates": { params: { workspaceId, query?: string, limit?: number (≤ 200) },
                               result: { files: string[], total: number } },
// push
"workspace.iconChanged": { workspaceId, icon: ProjectIcon },
// HTTP: none here. Image bytes come from S12P-03's scoped image route.
```

- DB: `workspaces.icon_path TEXT` (nullable). Rename stays `workspace.rename`.
- Resolver `ProjectIconService` (`apps/server/src/features/projects/icons/`), against the workspace root (`workspace.path`), never a worktree: (1) `icon_path` if set and valid; if missing, mark `chosenMissing` and fall through. (2) Probe a fixed root-level list (T3 Code's approach; exact list inferred): `favicon.svg`, `favicon.ico`, `favicon.png`, `public/favicon.svg`, `public/favicon.ico`, `public/favicon.png`, `public/icon.svg`, `public/icon.png`, `public/logo.svg`, `public/logo.png`, `app/favicon.ico`, `app/icon.svg`, `app/icon.png`, `src/app/favicon.ico`, `src/app/icon.png`, `static/favicon.ico`, `static/favicon.png`, `assets/icon.png`, `assets/logo.svg`, `assets/logo.png`, `logo.svg`. (3) Read `<link rel="icon" | "shortcut icon" href>` from `index.html`, `public/index.html`, `src/index.html` (first 256KB, regex, no HTML parser); resolve `/x` against `public/` then the root, relative hrefs against the HTML file's folder; ignore `http(s):` and `data:` hrefs. (4) Else `none` (monogram). At most 32 filesystem probes per resolve. Results cached in memory per workspace for 60s and dropped on `workspace.icon.set`. The Mcode repo itself resolves to `none` (icons live under `apps/`), which the 12d board shows on purpose.
- Path safety: `set` and the resolver call S12P-03's path validator (per-segment checks, no absolute, drive-letter, UNC or `..` paths, realpath containment under the root). The icon rules add only an extension allowlist (`svg, png, ico, webp, jpg, jpeg, gif, avif`, case-insensitive) and the 2MB icon cap. `set` stores the normalized POSIX form. Do not copy the validator.
- Candidates: image files under the root by extension, excluding `.git`, `node_modules` and gitignored files (use the same file index as `file.list`), sorted by depth then name, case-insensitive substring filter on `query`, `limit` default 50, with `total` for "Showing x of y" (F-04).
- Serving: S12P-03 owns the one authenticated, scoped image route used by Files and by project icons. It defines the URL shape, auth, path checks, SVG headers (`nosniff`, a sandboxing CSP) and each caller's size cap and caching. `ProjectIcon` builds its URL on that route with the workspace-root scope, the 2MB icon cap, and `ProjectIcon.version` so the URL changes when the file changes and the icon can be cached for long. The picker's 20px thumbnails use the same route. The renderer loads icons only in `<img>`, so SVG scripts never run.
- Monogram: first letter of the project name (first grapheme, uppercased), ink on `--color-primary`, radius as the icon slot.

### I. Project settings drafts (S12T-13)

- Store `projectSettingsDraftStore` keyed by `workspaceId`: `{ base: WorkspaceEnvironmentReadResult; draft: WorkspaceEnvironmentDocument; expandedActionId: string | null; issues: ValidationIssue[]; conflict: boolean }`. In memory only (locked decision): survives tab, thread and panel switches, not an app restart; cleared on Save, Discard or Reload.
- Dirty = draft differs from base (deep compare). The save bar shows only when dirty. Save is disabled while any action has no non-empty script (client check mirrors `empty_script`).
- Conflict: Save gets `WORKSPACE_ENVIRONMENT_STALE`, or reopening the tab re-reads and finds a new revision while dirty: show the banner. Keep mine re-reads the revision and saves the draft over it. Reload replaces the draft with the fresh document. Not dirty and changed: adopt silently.
- Storage pill (This computer | In repo) is disabled while dirty with tooltip "Save or discard changes first." (fixes the overwrite bug). Switching while clean reads the other location (today's `storage.set`).
- General (name, icon) applies immediately and is not part of the draft: name on Enter or blur via `workspace.rename` (empty reverts to the folder name), icon on pick via `workspace.icon.set`.
- Approval revoke: per action, In repo only, in the expanded row's More menu: "Forget approval" → new `workspace.environment.command.forget({workspaceId, actionId})`; replaces "Clear shared command approvals" (decision T6).

## Components

### New

| Component | Where | Notes |
|---|---|---|
| `TerminalTabStrip` | `apps/web/src/features/terminal/surfaces/` | Row 1: one tab per terminal record in scope (creation order), hover swaps glyph for ×, round + (`ActionRunMenu` in a thread with actions, else new shell), expand, toggle (F-05 row). |
| `ShellControls` / `ActionControls` | same | Row 2 for the active terminal. Shell: `WorkingFolderPill`, Search, Clear, More. Action: command pill, port pill, Exit pill, Restart, Stop or Run again, More. |
| `WorkingFolderPill` | same | Parent path muted, folder name ink, fade; click copies the full path ("Copied" tooltip); menu: Open in editor, Open in file manager (existing open-in bridge). |
| `TerminalCloseConfirm` | same | Popover under the tab ("Stop web?", "Stop and close" / "Cancel"). Replaces `TerminalKillConfirmDialog`. |
| `ActionApprovalCard` | `apps/web/src/features/projects/actions/` | Card inside the terminal surface. |
| `ActionRunMenu` | same | Shared by the overview ⋯ and the row-1 +. Built on F-04 menu primitives. |
| `OverviewTerminalsSection` | `apps/web/src/components/chat/overview/` (inferred home; S03 owns the shell) | Rows, "N more" / "Show less", hover Stop. |
| `ActionIcon`, `action-icons.ts` | `apps/web/src/features/projects/actions/` | Registry: 24 tool ids → vscode-icons file names, 12 glyph ids → Lucide + tint; `defaultActionIconId(command)`; shell icons for pwsh/powershell/bash/zsh/cmd/wsl. |
| `ActionIconPicker` | same | 32px trigger left of the name field; popover with Tools and General groups. |
| `ProjectSettingsPanel`, `ActionsSection`, `ActionRow`, `ActionEditor`, `SettingsSaveBar`, `EnvironmentConflictBanner`, `GeneralSection` | `apps/web/src/features/projects/settings/` | Replace `ProjectEnvironmentPanel`. |
| `ProjectIcon`, `ProjectIconPicker`, `projectIconStore` | `apps/web/src/features/projects/icons/` | `ProjectIcon size={14|16|20|40}` renders image, or monogram. |
| Server: action terminal phases in legacy `TerminalService`; `terminal-plain-text.ts`; `action-port-detector.ts`; `action-port-probe.ts`; startup runner and startup tail in `WorkspaceEnvironmentService`; `cleanup-action-runner.ts`; `ProjectIconService`; `workspace-environment-upgrade.ts` (`upgradeEnvironmentDocument`), `encodeEnvironmentDocument` | as named in Backend architecture | |

### Changed

- `apps/server/src/features/terminal/backends/legacy/terminal-service.ts`, `legacy-terminal-backend.ts`, `terminal-backend.ts`: exited retention, cap 8, metadata in `listActive`, action phases.
- `apps/server/src/features/terminal/composition/register-terminal.ts`, `diagnostics/`, `transport/terminal-rpc.ts`, `apps/server/src/application/transport/ws-server.ts`, `ws-router.ts`: one backend, no v1 session routing (S12T-01).
- `apps/server/src/features/projects/environment/project-action-*.ts`, `persistence/project-action-run-*.ts`: terminal-backed runs, no transcript, trigger, port.
- `apps/server/src/features/projects/environment/workspace-environment-service.ts`: upgrade on read, lowest-version write, the gate calls `StartupActionRunner` (new `startup-action-runner.ts`), setup and manual-setup removal, `command.forget`.
- `packages/contracts/src/thread-startup.ts`: the setup step's `actions` (S12T-11, shape in `04-08f` section E).
- `apps/server/src/features/thread-control/cleanup/cleanup-worker.ts`: cleanup runner hook.
- `apps/server/src/runtime/persistence/sqlite/schema.ts` and `apps/server/drizzle/*`: migrations listed above.
- `apps/web/src/features/terminal/state/terminalStore.ts`: entries carry `kind`, `actionId`, `state`, `exitCode`, `cwd`, `createdAt`; active terminal per scope drives `mod+j`.
- `apps/web/src/features/terminal/adapters/`: the legacy client is the only client (S12T-01).
- `apps/web/src/features/terminal/surfaces/TerminalView.tsx`, `terminalLinkProvider.ts`, `TerminalSearchShelf.tsx`: tokens, URLs, find bar under row 2.
- `apps/web/src/components/chat/ThreadOverview.tsx`: ⋯ menu, Terminals section, setup card removed.
- `apps/web/src/features/thread-startup/`: the trail's setup step reads startup action runs (S12T-11).
- `apps/web/src/features/projects/ProjectTree.tsx`, `apps/web/src/components/chat/NewThreadProjectPicker.tsx`: `ProjectIcon`.
- `CONTEXT.md`: rewrite Terminal tab, Platform command, Setup gate, Setup attempt; add Action terminal, Startup action, Cleanup action, Project icon.
- `docs/internals/runtime/terminal-lifecycle.md`, `docs/internals/projects/environment.md`: rewrite affected sections in the ticket that changes the behavior.

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| Modern terminal backend on the server: `ModernTerminalBackend`, `TerminalSessionRuntime`, `TerminalSessionService`, their errors in the router, their tests | `apps/server/src/features/terminal/backends/modern/`, `sessions/terminal-session-runtime.ts`, `sessions/terminal-session-service.ts`, `ws-router.ts:120-121`, `register-terminal.ts` | Legacy `TerminalService` (decision T11) | S12T-01 | `rg -n "ModernTerminalBackend\|terminal-session-runtime\|terminal-session-service" apps/server/src` returns nothing |
| Backend selector and its env option: `TerminalBackendSelector`, `MCODE_TERMINAL_BACKEND` | `backends/terminal-backend-selector.ts` and its test, `register-terminal.ts:116-131`, `container-terminal-resolution.test.ts`, `terminal-diagnostics-container.test.ts`, `terminal-lifecycle.md:15-18` | One backend, no selection | S12T-01 | `rg -n "TerminalBackendSelector\|MCODE_TERMINAL_BACKEND" apps packages docs/internals` returns nothing |
| Terminal v1 session wire and the modern web client: `terminal.session.*` methods and routing, `ModernTerminalClient`, `TerminalClientSelector`, their tests | `packages/contracts/src/ws/terminal.ts`, `methods.ts:464-471`, `terminal-rpc.ts:202`, `terminal-backend.ts:124-146`, `ws-server.ts:689`, `apps/web/src/features/terminal/adapters/modern/`, `adapters/terminal-client-selector.ts`, `ws-transport.ts` | Legacy wire and `LegacyTerminalClient`; `terminal.capabilities` and `terminal.diagnostics.*` stay | S12T-01 | `rg -n "terminal\.session\.\|ModernTerminalClient\|TerminalClientSelector" apps packages` returns nothing |
| Modern backend text in the terminal lifecycle doc | `docs/internals/runtime/terminal-lifecycle.md`: the selector paragraph, "Modern attachment and input ownership", modern replay and tombstone sentences | A legacy-only account | S12T-01 | `rg -n -i "modern" docs/internals/runtime/terminal-lifecycle.md` returns nothing |
| 2s terminal removal after exit | `apps/web/src/transport/ws-events.ts:197-201` | Server-retained exited records | S12T-01 | `rg -n "removeTerminal\(payload.ptyId\)" apps/web/src/transport` returns nothing |
| `MAX_PTYS_PER_THREAD`, web `MAX_TERMINALS_PER_SCOPE` | `terminal-service.ts:32`, `terminalStore.ts:70`, `RightPanel.tsx:40,895`, `lib/ensure-terminal.ts:3,42,73` | `TERMINAL_MAX_PER_SCOPE` in contracts | S12T-01 | `rg -n "MAX_PTYS_PER_THREAD\|MAX_TERMINALS_PER_SCOPE" apps` returns nothing |
| CONTEXT "Terminal tab" sentence saying an exited tab "closes automatically" | `CONTEXT.md:893-894` | Exited terminals stay until closed | S12T-01 | `rg -n "closes automatically" CONTEXT.md` returns nothing |
| Dead `TerminalPanel`, `TerminalToolbar`, `TerminalList`, their tests and exports; `terminalPanelByThread`, `toggle/show/hideTerminalPanel` | `apps/web/src/features/terminal/surfaces/`, `terminalStore.ts:80-83,231-260` | Nothing (dead) | S12T-02 | `rg -n "TerminalPanel\b\|TerminalToolbar\|TerminalList\b\|terminalPanelByThread" apps/web/src` returns nothing |
| `TerminalKillConfirmDialog` | `apps/web/src/features/terminal/surfaces/TerminalKillConfirmDialog.tsx` | `TerminalCloseConfirm` | S12T-02 | `rg -n "TerminalKillConfirmDialog" apps` returns nothing |
| Hardcoded terminal theme | `TerminalView.tsx:69,676-677` | Token theme | S12T-03 | `rg -n "#0a0a0f\|#e4e4e7" apps/web/src` returns nothing |
| Headless prepared-command path: `startPreparedCommand`, `stopPreparedCommand`, `PreparedTerminalCommandSession`, `PreparedTerminalCommandExit`, `headless`, `headlessOutput`, `completedHeadlessSessions` | `terminal-backend.ts:49-95,119-121`, `legacy-terminal-backend.ts:131-166`, `terminal-service.ts:54-58,327-397,511,623,659-693` | `openActionTerminal` | S12T-05 | `rg -n "startPreparedCommand\|headlessOutput\|completedHeadlessSessions\|PreparedTerminalCommandSession" apps/server/src` returns nothing |
| Action `<pre>` view `ProjectActionTerminalView` and its ANSI transcript parser (S12P-01 removes the `action-terminal` rail type) | `ProjectActionControl.tsx:357-629` | Action terminals in `TerminalTabStrip` | S12T-06 | `rg -n "ProjectActionTerminalView\|parseAnsiTranscript" apps/web/src` returns nothing |
| Run `transcript`, `transcriptTruncated`, `WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES`, transcript persistence, `project_action_runs.transcript*` columns | `workspace-environment.ts:18,161-168,347-348`, `project-action-run-lifecycle.ts:20-28,120-135`, `schema.ts:461-462` | Terminal replay | S12T-06 | `rg -n "transcriptTruncated\|ACTION_TRANSCRIPT_MAX_BYTES" apps packages` returns nothing |
| `ProjectActionApprovalDialog` | `ProjectActionControl.tsx:322-356` | `ActionApprovalCard` | S12T-07 | `rg -n "ProjectActionApprovalDialog" apps` returns nothing |
| `ProjectActionMenu`, `ProjectActionMenuDropdown`, `ProjectActionMenuItem`, pointer helpers, `ActionStatus*`, `ACTION_RESULT_DISPLAY_MS`, "Edit project actions" | `ProjectActionControl.tsx:30-321,630-695`; `ThreadOverview.tsx:2563-2580` | `ActionRunMenu` | S12T-10 | `rg -n "ProjectActionMenu\|ACTION_RESULT_DISPLAY_MS\|Edit project actions" apps/web/src` returns nothing |
| Composer chip `TerminalStatusIndicator` (decision T9) | `apps/web/src/components/chat/TerminalStatusIndicator.tsx`, `ComposerStatusStrip.tsx:91`, its test | Overview Terminals section (boards 12a and 12j show no chip) | S12T-10 | `rg -n "TerminalStatusIndicator" apps` returns nothing |
| Manual Setup: "Run Setup", `ProjectSetupMenuItem`, `getThreadOverviewSetupMenuItem`, `ProjectSetupAttemptCard`, `useProjectSetupAttempt`, `TerminalBlock` (whole `ProjectSetupControl.tsx`), `workspace.environment.setup.start/get`, `WorkspaceEnvironmentSetupAttempt*`, `WorkspaceEnvironmentSetupStatusSchema`, manual setup bookkeeping in the service | `ProjectSetupControl.tsx`, `ThreadOverview.tsx:243-246,2570-2607`, `workspace-environment.ts:126-296`, `workspace-environment-rpc.ts`, `workspace-environment-service.ts:1001-1036` and the manual-attempt maps it uses (keep `beginThreadDeletion` and the cancellation barriers, which teardown also needs) | Run the startup action from the ⋯ menu | S12T-11 | `rg -n "ProjectSetupControl\|environment\.setup\.\|WorkspaceEnvironmentSetupAttempt\b\|TerminalBlock" apps packages` returns nothing |
| Single-script automatic setup launcher: resolve, prepare and launch of `document.setup` through `TerminalCommandService` | `workspace-environment-service.ts:1199-1391` | `StartupActionRunner` | S12T-11 | `rg -n "startAutomaticSetupAttempt\|launchPreparedAutomaticSetup" apps/server/src` returns nothing |
| Recovery shell: `openAutomaticSetupTerminal`, `WorkspaceEnvironmentTerminalRecoveryExecutor`, `WorkspaceEnvironmentAutomaticSetupTerminal*`, the `terminalRecovery` option, ws method `workspace.environment.automaticSetup.openTerminal` and its transport method | `transport/types.ts:344`, `ws-transport.ts:1101`, `workspace-environment-rpc.ts:98`, `workspace-environment-service.ts:124-127,153,537-549`, `workspace-environment.ts:624-641`, `methods.ts:518,564`, `register-projects.ts` | The startup action's own terminal behind Open terminal | S12T-11 | `rg -n "openAutomaticSetupTerminal\|AutomaticSetupTerminal\|TerminalRecoveryExecutor\|terminalRecovery\|automaticSetup\.openTerminal" apps packages` returns nothing |
| `document.setup` outside the upgrade function, the `{kind: "setup"}` command target, the `commandIdentity` setup branch, `setup` approval rows, and the Setup section of the old `ProjectEnvironmentPanel` | `workspace-environment.ts:104-110,659`, `workspace-environment-service.ts:205-212,779,1237-1238,1399,1788,2104-2106,2265`, `ProjectEnvironmentPanel.tsx:271-273,385-390,486`, `ProjectActionControl.tsx:532`, DB | Startup actions | S12T-11 | `rg -n "document\.setup\|\{ kind: \"setup\"\|kind: \"setup\" as const\|kind: z\.literal\(\"setup\"\)" apps/server/src packages/contracts/src apps/web/src/features/projects -g "!**/workspace-environment-upgrade*"` returns nothing |
| Automatic attempt single-command fields and columns (`snapshot`, `outcome`, `exitCode`, `output`, `outputTruncated`; `launch_snapshot_json`, `outcome`, `exit_code`, `output`, `output_truncated`) and `WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES` | `workspace-environment.ts:16,152-159,470-546`, `schema.ts:385-400`, `workspace-environment-automatic-store.ts`, `workspace-environment-service.ts` | `failedActionId`, the setup step's `actions`, run records | S12T-11 | `rg -n "SETUP_OUTPUT_MAX_BYTES\|launchSnapshotJson\|launch_snapshot_json" packages/contracts/src apps/server/src/features apps/server/src/runtime/persistence/sqlite/schema.ts` returns nothing |
| Web reads of the gate snapshot: client `getAutomaticSetup` and ws method `workspace.environment.automaticSetup.get` (the server's `getAutomaticSetup` stays for turn admission) | `transport/types.ts:334`, `ws-transport.ts:1076-1079`, `methods.ts:513,544`, `workspace-environment-rpc.ts:37` | `thread.startup.updated` and action-run pushes | S12T-11 | `rg -n "automaticSetup\.get\"\|getAutomaticSetup\(threadId" apps/web/src packages/contracts/src apps/server/src/features/projects/environment/transport` returns nothing |
| Command approval dialog `ProjectCommandApprovalDialog` (manual Setup is its last caller after S04-04 and S12T-07) | `ProjectCommandApprovalDialog.tsx`, `ProjectSetupControl.tsx:14,258` | `ActionApprovalCard` in the action's terminal | S12T-11 | `rg -n "ProjectCommandApprovalDialog" apps` returns nothing |
| `ProjectEnvironmentPanel` and its test; "Environment storage" radio; `ClearSharedApprovals`; raw `issueText`; empty-command `newAction`; catalog blurb "Edit Project environment"; "Loading environment..." | `ProjectEnvironmentPanel.tsx`, `panel-tabs.ts:98-104` | `ProjectSettingsPanel` | S12T-13 | `rg -n "ProjectEnvironmentPanel\|Edit Project environment\|Clear shared command approvals" apps` returns nothing |
| `workspace.environment.command.clearApprovals` | contracts, `workspace-environment-rpc.ts`, service `clearApprovals` | Per-action `command.forget` (decision T6) | S12T-13 | `rg -n "clearApprovals" apps packages` returns nothing |
| Project folder glyphs | `NewThreadProjectPicker.tsx:55,91`; folder glyph in the sidebar project row (`ProjectTree.tsx:2589-2593`, lifecycle toggle placed by S01-02) | `ProjectIcon` | S12T-14 | `rg -n "<Folder " apps/web/src/components/chat/NewThreadProjectPicker.tsx` returns nothing |

## Proposed tickets

Cross-section ids: F-01..F-07 (foundation), S03-02 (overview card shell), S04-03 and S04-04 (steps trail), S04-07 (existing worktree setup), S11-09 (project server tiles), S12P-01 (rail, row-1 tabs and the one right-panel ADR), S12P-03 (scoped image route).

### S12T-01 Terminals survive exit and are listed by the server

- **Blocked by:** None (can start immediately).
- **Reconciled:** Chooses the one terminal backend to keep (decision T11) and deletes the other backend, its selector and env option, its tests and docs. Defines `TERMINAL_MAX_PER_SCOPE = 8`.
- **Boards:** 12a `22UJ-2` (strip rebuilt from server state)
- **Delivers:** Mcode runs one terminal backend, `legacy`; `MCODE_TERMINAL_BACKEND` no longer exists. A shell that exits keeps its tab and output, with the existing "exited with code N" view, Retry terminal and Close working, until the user closes it. After a reconnect or a client reload against a running server, the scope's terminals come back. The scope holds up to 8 terminal records.
- **Build notes:**
  - Backend A, decision T11. Delete the modern backend, its selector and env option, the `terminal.session.*` wire, the modern web client and selector, their tests, and the modern text in `terminal-lifecycle.md`, as listed there. Keep `sessions/terminal-scope.ts`, `sessions/terminal-replay-buffer.ts`, `terminal.capabilities` (with `backend: "legacy"` only) and the `terminal.diagnostics.*` methods. Do this first, so the rest of the ticket touches one backend.
  - Legacy `TerminalService` keeps exited records with replay and `exitCode`; `kill` drops them; `killByThread` and deletion drop all records of the scope. `listActive` and `create` return the optional metadata.
  - `TERMINAL_MAX_PER_SCOPE = 8` in `packages/contracts/src/models/terminal.ts`, counting pending, running and exited records. S12P-01 reads it for the + button and records it in its ADR; this ticket writes no ADR.
  - Web: remove the 2s timer; `terminalStore` entries gain `state`, `exitCode`, `cwd`, `createdAt`, `kind`; hydrate per scope from `listActive` on connect (extend the reconnect path in `apps/web/src/transport/ws-transport.ts`); label rebuild uses the shell name, not "Terminal N".
  - Docs: rewrite the exit paragraph of `terminal-lifecycle.md` and the CONTEXT "Terminal tab" sentence about tabs that close automatically.
- **Deletes:** ledger rows "Modern terminal backend on the server", "Backend selector and its env option", "Terminal v1 session wire and the modern web client", "Modern backend text in the terminal lifecycle doc", "2s terminal removal after exit", "`MAX_PTYS_PER_THREAD`, web `MAX_TERMINALS_PER_SCOPE`" and "CONTEXT Terminal tab sentence".
- **Acceptance criteria:**
  - [ ] Every row this ticket owns in the ledger passes `node tools/graph.mjs ledger-run S12T-01`.
  - [ ] Terminal diagnostics still load in the Terminal tab through `terminal.capabilities`.
  - [ ] `exit` in a shell leaves the tab with the exited view; Retry terminal starts a new shell in that slot; Close removes it.
  - [ ] Switching threads and back replays the exited terminal's output.
  - [ ] Reloading the web client while the server runs restores the scope's terminals in creation order with their names.
  - [ ] A ninth terminal record in one scope (exited ones included) is refused by the server; the web disables New terminal at 8 with tooltip "8 terminals are open. Close one to open another."
- **Verify:** `bun run --cwd apps/server test -- src/features/terminal/backends/legacy/__tests__/terminal-service.test.ts src/features/terminal/composition/__tests__/register-terminal.test.ts src/features/terminal/diagnostics/__tests__/terminal-diagnostics-container.test.ts` (add exit-retention, cap and list-metadata cases; in-memory host from `src/features/terminal/testing/in-memory-pty-host-adapter.ts`); `bun run --cwd apps/web test -- src/features/terminal/state/__tests__/terminalStore.test.ts src/features/terminal/adapters/__tests__/legacy-terminal-client.test.ts`. Live: `agent:up`, open a terminal in a `.dev/fixture-repo` thread, run `exit`, confirm the tab stays; reload the page, confirm tabs return.

### S12T-02 Terminal tab with two rows and row-1 terminal tabs

- **Blocked by:** S12T-01 Terminals survive exit and are listed by the server; S12P-01 Rail lists tools; terminals and browser pages become row-1 tabs; F-01b Token vocabulary rename; F-02 Fade truncation primitive; F-03 Button primitives; F-05 Right panel shell: two-row header, right-edge rail, panel controls; F-07a Overlay surfaces and side placement.
- **Reconciled:** Builds on the S12P-01 ADR; do not write a second ADR.
- **Boards:** 12a `22UJ-2`; 12b close confirm `2G2H-2`, `2G4L-2`
- **Delivers:** S12P-01 has already put the scope's terminals into row-1 tabs under one Terminal rail entry. This ticket gives that strip the 12a look and adds row 2. Row 1: one tab per terminal record (prompt glyph + shell name, hover swaps the glyph for ×), round +, expand, toggle. Row 2 for a shell: working-folder pill (click copies; menu Open in editor, Open in file manager), Search (opens the find bar under row 2), Clear, More (Copy diagnostics, Open in external terminal, Close terminal; decision T8). Closing a tab with a running process asks "Stop pwsh?" per `confirmOnKill` (`withChildProcesses` checks `terminal.hasChildren`; `always` always asks; `never` never). Close failures show "Couldn't close pwsh. Try again." `mod+j` focuses the scope's active terminal.
- **Build notes:** `TerminalTabStrip` builds on S12P-01's `PanelTabStrip`; active terminal per scope lives in `terminalStore`. One xterm view still (ADR-0010). S12P-01 owns the right-panel ADR, the rail entries and their retirement; this ticket writes no ADR and edits no ADR status. Add the close-confirm rule to CONTEXT "Terminal tab".
- **Deletes:** ledger rows "Dead `TerminalPanel` ..." and "`TerminalKillConfirmDialog`".
- **Acceptance criteria:**
  - [ ] Two shells show as two row-1 tabs; the rail shows one Terminal icon with the amber active bar.
  - [ ] Closing an idle shell closes at once; closing one running `ping -t localhost` (Windows) or `sleep 100` asks, and Stop and close kills it.
  - [ ] The working-folder pill shows the thread's worktree folder, fades on overflow, copies the full path on click.
  - [ ] `mod+j` focuses the last active terminal, not the newest.
- **Verify:** `apps/web/src/features/terminal/surfaces/__tests__/TerminalTabContent.test.tsx` (extend for strip, close confirm with mocked `terminalHasChildren`); live in Electron with the electorn-live-testing skill, before/after screenshots against 12a.

### S12T-03 Terminal surface on tokens with clickable web URLs and Clear

- **Blocked by:** S12T-02 Terminal tab with two rows and row-1 terminal tabs.
- **Boards:** 12a `22UJ-2`, surface `2FYE-2`
- **Delivers:** the terminal sits in an 8px `--color-page` inset (radius 10, padding 12/14), mono 13/20, and follows the light and dark tokens; ANSI roles map to tokens. `http(s)://` URLs are links (click opens in the Browser tab for loopback hosts, the system browser otherwise; decision T7). Clear (Ctrl K) clears the view and the retained output.
- **Build notes:** build the xterm `ITheme` from computed CSS custom properties and rebuild it on theme change. Font size setting keeps its 11 to 19 range; default becomes 13 (inferred, confirm against `terminal.presentation` defaults). URL matching in `terminalLinkProvider.ts` alongside file paths. Clear writes the xterm clear and then `terminal.checkpoint` with the cleared serialized state so a cold remount stays cleared.
- **Deletes:** hardcoded theme constants.
- **Acceptance criteria:**
  - [ ] Switching app theme recolours an open terminal without remount.
  - [ ] `echo http://localhost:5173/` renders a clickable link; file-path links still work.
  - [ ] After Clear and a thread switch, the terminal returns empty except new output.
- **Verify:** `__tests__/terminalLinkProvider.test.ts` (URL cases), `__tests__/TerminalView.keyhandler.test.ts` (Ctrl K); live screenshot vs 12a in dark and light.

### S12T-04 Environment document 0.1.0

- **Blocked by:** None (can start immediately).
- **Boards:** none (contract prefactor)
- **Delivers:** actions can carry `icon`, `runOnStartup` and `runOnCleanup`; documents written without them stay version 0.0.1 so teammates on older builds are unaffected; unknown keys from newer builds survive a save.
- **Build notes:** Backend E, without the `setup` migration and the startup count rule (both S12T-11). Add `WorkspaceEnvironmentActionIdSchema` and use it for the action id. `encodeEnvironmentDocument` used by `save` and `writeEnvironmentDocument`; `hasValidSharedDocument` accepts both versions. 0.1.0 with `setup` is invalid ("Move Setup into an action first."), reachable only by hand-editing until S12T-11.
- **Deletes:** the single-version equality check.
- **Acceptance criteria:**
  - [ ] A 0.0.1 file round-trips byte-identical in meaning and stays 0.0.1 when no new field is set.
  - [ ] Setting `runOnStartup` on one action saves version 0.1.0.
  - [ ] A 0.1.0 file with an unknown action key saves with the key intact.
  - [ ] A 0.2.0 file fails with `unsupported_version`.
- **Verify:** `bun run --cwd packages/contracts test -- src/models/__tests__/workspace-environment.test.ts`; `bun run --cwd apps/server test -- src/features/projects/environment/__tests__/workspace-environment-service.test.ts`.

### S12T-05 Action terminals on the server

- **Blocked by:** S12T-01 Terminals survive exit and are listed by the server.
- **Boards:** 12b `2FX0-2`, `2FZ3-2` (behavior)
- **Delivers:** starting an action creates a real, attachable terminal that runs the command and then leaves an interactive shell open. Stop sends Ctrl C, then kills, and the shell stays. Restart and Run again rerun in the same terminal. Closing the terminal stops the run. Until S12T-06 the existing action tab keeps working from the transcript, which this ticket still fills from command-phase output.
- **Build notes:** Backend B (phases, `openActionTerminal`, `onCommandOutput` carrying only the command process's output with the echo line kept out of it, interrupt exit mapping, cap error, run `trigger`, terminal id stays across reruns). `listActive` reports action records with `kind: "action"` and `actionId`. Rewrite "Actions retain results beyond process exit" in `docs/internals/projects/environment.md`. Add the CONTEXT "Action terminal" entry, stating both differences from typing the command (no shell history; `cd` and environment changes do not carry into the shell).
- **Deletes:** ledger row "Headless prepared-command path".
- **Acceptance criteria:**
  - [ ] `action.start` returns a run whose `terminalSessionId` appears in `terminal.listActive` and can be attached with `terminal.reattach`.
  - [ ] A command exiting 2 yields `failed`, `exitCode: 2`, then an interactive prompt in the same terminal.
  - [ ] Stop during a long command yields `interrupted` and a live shell; `terminal.kill` during the command yields `interrupted` and `terminalSessionId: null`.
  - [ ] Restart keeps `terminalSessionId` and changes `runId`.
  - [ ] The terminal replay holds the echo line and the command's output, while `onCommandOutput` delivers only the output, also for a command whose text contains a URL.
  - [ ] Approved shared commands still launch without asking; a changed script asks again.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/environment/__tests__/project-action-service.test.ts src/features/terminal/backends/legacy/__tests__/terminal-service.test.ts`; one real-PTY case beside `src/features/terminal/host/__tests__/pty-host-runtime.real.test.ts` covering phase hand-off on the host platform.

### S12T-06 Action runs open in the Terminal tab

- **Blocked by:** S12T-02 Terminal tab with two rows and row-1 terminal tabs; S12T-05 Action terminals on the server.
- **Boards:** 12a `22UJ-2`; 12b running `2FX0-2`, failed `2FZ3-2`, close while running `2G2H-2`
- **Delivers:** starting an action opens (and focuses) its terminal as a row-1 tab: action icon placeholder (play glyph until S12T-09) with a green badge while running, clay when failed. Row 2: command pill (play glyph, first line, fade), Exit pill when failed, Restart, Stop while running, Run again after it ends, More (Edit action, Copy command, Close terminal). Closing while the command runs asks "Stop web?" / "bun run dev is still running. Closing the tab stops it."; after it ends, the shell follows `confirmOnKill` like any shell. Exit codes mapped to `interrupted` show no pill.
- **Build notes:** strip entries for `kind: "action"` join the run from `project-action-store` by `actionId`. Run contract drops `transcript*`; migration drops the columns and adds `trigger`.
- **Deletes:** ledger rows "Action `<pre>` view ..." and "Run `transcript` ...". S12P-01 already removed the `action-terminal` rail type.
- **Acceptance criteria:**
  - [ ] Starting `bun --version` from the current menu opens a tab showing the echo line, the version, then a prompt, with no badge (completed).
  - [ ] `exit 1` shows the clay badge, `Exit 1` pill and Run again; Run again reruns in the same tab.
  - [ ] No `workspace.environment.action.updated` push is sent per output chunk (assert in the service test).
- **Verify:** `apps/web/src/features/projects/environment/__tests__/ProjectActionControl.test.tsx` replaced by tests for `ActionControls`; server test from S12T-05 extended for publish counts; live Electron screenshots vs 12b running and failed.

### S12T-07 Shared actions ask in the terminal

- **Blocked by:** S12T-06 Action runs open in the Terminal tab.
- **Boards:** 12b needs approval `2G11-2`, `2G18-2`, `2G25-2`
- **Delivers:** an In repo action without an approval opens its tab with the hollow amber ring and the "Run web?" card ("This action comes from .mcode/environment.json in the repo. It runs once you approve it.", command block, Run, Cancel). Nothing runs until Run. Cancel closes the tab. Later runs of the same command start without asking.
- **Build notes:** Backend C. Pending records count toward the cap. Row 2 while pending shows only the command pill and More.
- **Deletes:** ledger row "`ProjectActionApprovalDialog`".
- **Acceptance criteria:**
  - [ ] With In repo storage, the first start shows the card and no process exists (`terminal.hasChildren` reports none; no echo line).
  - [ ] Run starts the command in the same tab; a second start does not ask.
  - [ ] Editing the command in `.mcode/environment.json` makes the next start ask again.
  - [ ] Cancel leaves the run `interrupted` and removes the tab.
- **Verify:** `project-action-service.test.ts` (pending record, approve then run, cancel); web component test for the card; live check with a fixture-repo `.mcode/environment.json`.

### S12T-08 Detected port on action runs

- **Blocked by:** S12T-06 Action runs open in the Terminal tab.
- **Reconciled:** Owns port detection for every consumer. Parse candidate URLs from the current run's output (ANSI and chunk safe), normalize the host (IPv4, IPv6, localhost) and probe that host. A previous run's port is display history only, never readiness. TCP reachability is not app health and never releases Setup; say so in copy. The synthesized command echo is excluded from detector input. The Browser (S11-09) reads `run.port`; S11-09 deletes the unimplemented `detectLocalPorts` declaration.
- **Boards:** 12b `2FXY-2` (port pill); 12i rows `2HOY-2`
- **Delivers:** when an action's current run prints a loopback URL and that host and port accept a connection, the run gets a port. Row 2 shows a port pill (globe, `:5173`, mono) that opens the URL in the Browser tab, with a tooltip that claims only that the port accepts connections. The server keeps tracking whether the port answers. A previous run's port is shown as history and never counts for the current run. Section 11 and the overview Terminals rows read the same `run.port`. The port is for display only. It never releases Setup or the first turn, and the startup runner does not read it.
- **Build notes:** Backend D: the shared plain-text decoder, candidate detection on command output only (the echo line is not detector input), the per-host probe, the `runId` rule and the section 11 contract with its three tile states. Port pill uses the Browser's open-URL entry owned by S11 (until it exists, call the current preview open path). Migration adds `port_json` if S12T-05 did not.
- **Deletes:** nothing. S11-09 owns removing `detectLocalPorts` and its consumers (section 11 ledger).
- **Acceptance criteria:**
  - [ ] Decoder tests: an escape sequence split across two chunks inside a URL (Vite's bold port, `http://localhost:\x1b[1m5173\x1b[22m/`), an OSC 8 hyperlink, a UTF-8 character split across chunks, and `\r` progress overwrites.
  - [ ] Detector tests: `0.0.0.0` and `[::]` normalized, LAN and public URLs ignored, URLs without a port ignored, at most 8 candidates.
  - [ ] Misleading output: `http://localhost:<dead port>/help` printed before the real URL leaves `run.port` on the real URL once it answers; a URL nothing listens on never sets `run.port`.
  - [ ] Echoed URL: an action whose command text contains `http://localhost:<port>/` while another listener holds that port, and whose process prints nothing, never sets `run.port`.
  - [ ] IPv6: a server listening only on `::1` is reachable when the run prints `http://[::1]:<port>/` and when it prints `http://localhost:<port>/`.
  - [ ] Stale occupied port: the previous run reported a port that another listener now holds; the new run prints nothing, and its `run.port.runId` is the old run with `reachable: false`.
  - [ ] Print then fail: a run prints its URL while another listener holds the port, so `reachable: true` is published; when the process exits 1, `reachable: false` is published and the pill shows history.
  - [ ] Starting `bun run dev` in the fixture repo sets `port` and `reachable: true` within 10s; stopping it publishes `reachable: false` and keeps the port.
  - [ ] Clicking the pill opens the run's URL in the Browser tab.
- **Verify:** `bun run --cwd apps/server test -- src/features/terminal/output/__tests__/terminal-plain-text.test.ts src/features/projects/environment/__tests__/action-port-detector.test.ts src/features/projects/environment/__tests__/action-port-probe.test.ts src/features/projects/environment/__tests__/project-action-service.test.ts`. The first three are new; the probe, stale-port and print-then-fail cases use real `net.createServer` listeners on port 0, IPv4 and IPv6. The echoed-URL case runs in `project-action-service.test.ts` with the in-memory PTY host. Live click-through.

### S12T-09 Action icons

- **Blocked by:** S12T-04 Environment document 0.1.0; S12T-06 Action runs open in the Terminal tab.
- **Boards:** 12d icon picker `2H7R-2`; 12a tab `2324-2`; 12i menu `2HUD-2`
- **Delivers:** every action shows a coloured icon: the one the user picked, or one derived from its command's first word. Shells show their shell's icon. Icons appear in row-1 tabs (14px) and, as later tickets land, in menus, overview rows and settings rows (16px).
- **Build notes:** `action-icons.ts` maps ids to vscode-icons file names (resolve the exact `file_type_*.svg` names against the `vscode-icons-js` mapping already in `apps/web/src/lib/vscode-icons.ts`) and glyph ids to Lucide components plus `getFileIconColor`-palette tints. Add a by-name resolver beside `resolveIcon`; reuse its blob cache and Lucide fallback. `defaultActionIconId`: first word, ignoring env assignments (`FOO=1 bun …`) and `npx`/`bunx` prefixes (use the next word); mapping per Locked decisions. `ActionIconPicker` component lands here; S12T-13 places it.
- **Deletes:** play-glyph placeholder from S12T-06.
- **Acceptance criteria:**
  - [ ] `bun run dev` → bun, `cargo test` → rust, `pwsh -File x.ps1` → powershell, `./run.sh` → play.
  - [ ] An unknown stored id renders the derived default.
  - [ ] Offline, icons fall back to Lucide without layout shift (16px slot fixed).
- **Verify:** `bun run --cwd apps/web test -- src/features/projects/actions/__tests__/action-icons.test.ts` (new); screenshot of the picker vs `2H7R-2`.

### S12T-10 Actions menu and overview Terminals section

- **Blocked by:** S12T-06 Action runs open in the Terminal tab; S12T-08 Detected port on action runs; S12T-09 Action icons; S03-02 Overview card shell; F-04a Menu primitive.
- **Boards:** 12i `2HLW-2` (all states), 12j `258G-2`
- **Delivers:** the ⋯ beside the overview gear (tooltip "Actions", selected fill while open) opens a names-only menu: each action with its icon and a green badge when running; hovering an idle one shows "▶ Run"; picking an idle one starts it and opens its terminal; picking one whose terminal is open focuses it; divider; New terminal; divider; Edit actions (opens Project settings › Actions). The row-1 + uses the same menu in a thread with actions. A Terminals section lists terminals whose process is alive (command or shell), newest first, three rows then "N more" / "Show less"; meta is the port (mono) for actions with one and "Shell" for shells; clicking opens the tab; hover Stop kills the terminal's process (the tab keeps its output) and the row leaves. The section and its divider hide when nothing runs. In a scope at the cap, New terminal and idle actions are disabled with the cap tooltip. Threadless: + opens a shell directly.
- **Build notes:** `ActionRunMenu` on F-04 primitives; overview section on the S03 shell; selectors over `terminalStore` and `project-action-store`. Plain copy only.
- **Deletes:** ledger rows "`ProjectActionMenu` ..." and "Composer chip `TerminalStatusIndicator`". The new menu has no "Run Setup" item; S12T-11 deletes the rest of manual Setup, whichever of the two lands first.
- **Acceptance criteria:**
  - [ ] Four running terminals show three rows and "1 more"; expanding shows four and "Show less".
  - [ ] Stop on a row removes the row and leaves the tab with its output.
  - [ ] With no running terminals the overview has no Terminals label or divider.
  - [ ] The ⋯ menu shows a badge only on actions whose run is `running`.
- **Verify:** `apps/web/src/components/chat/ThreadOverview.branchless-pr.test.tsx` and `HeaderActions.test.tsx` updated (button name "Actions"); new `OverviewTerminalsSection` test; live screenshots vs 12i states.

### S12T-11 Startup actions replace Setup

- **Blocked by:** S12T-04 Environment document 0.1.0; S12T-05 Action terminals on the server; S12T-07 Shared actions ask in the terminal; S12T-08 Detected port on action runs; S04-04 Trail decisions and failures replace the in-chat setup card; S04-07 Existing worktree runs setup, skipped while a thread is live there.
- **Reconciled:** Absorbs S04-08. The S12 action runner is the only startup executor; the startup trail is a projection of the frozen action and run ids. Retry reruns from the first failed action and skips actions that succeeded in this attempt. The trail shows a bounded read-only tail of the run's terminal output plus Open terminal. Scripts stay out of the startup record (ids plus a content hash), so the record has no separate command bounds. Converts the runner and every old-setup consumer in one ticket. Readiness: a startup action is ready only when it exits 0. A detected port is a display fact for the Browser and the terminal, never Setup readiness. The per-action "Keeps running" toggle (start without awaiting) is excluded from this ticket until the user answers decision T3; if approved it becomes its own ticket.
- **Boards:** 12d rows with "On startup" `2H2C-2` (data); trail consumer boards `04b · Thread starting · New worktree · Setup output` (`29YX-2`) and `04f · Thread starting · Step states` states 2, 5 and 6 (`2BW7-2`)
- **Delivers:**
  - Existing setup commands keep working as a `setup` action marked Run on startup, in both storage modes, with no manual step.
  - A thread that starts in a worktree (new or existing) runs its startup actions in list order, each in a real terminal tab, before the first turn. Each action must exit 0 before the next one starts and before the first turn. A detected port shows in the terminal and the Browser but never counts as ready, so an action that keeps running, such as a dev server, holds the first turn until the user picks Skip setup.
  - The trail's setup step lists one `$ command` line per started action. Its tail follows the running action. Open terminal shows that action's terminal, and Edit script opens Project settings.
  - A failing action stops the rest and shows Setup failed with its exit code. Its terminal stays open for fixing, and Retry setup reruns from it.
  - "Run Setup", the setup card, the setup approval dialog and the recovery shell are gone.
- **Build notes:**
  - Server: Backend E (setup migration in `workspace-environment-upgrade.ts`, approvals, the startup count rule) and Backend F (`StartupActionRunner`, readiness, retry, skip, cancel, the startup tail, the attempt contract and its migration). The runner is the only startup executor.
  - Contracts: the setup step's `actions` and `ThreadStartupActionSchema` (`04-08f` section E), `WORKSPACE_ENVIRONMENT_STARTUP_ACTIONS_MAX`, the attempt contract.
  - Web, the trail consumer (`04-08f` section E): header lines, step argument and the collapsed row come from the entries joined with `project-action-store`; Open terminal focuses the entry's terminal; Run setup approves and starts the pending run. Remove the trail's pre-switch reads of `getAutomaticSetup` and its `openAutomaticSetupTerminal` call.
  - Every other old-setup consumer moves in this ticket: manual Setup in the overview (Run Setup item, setup attempt card), the Setup section of the old `ProjectEnvironmentPanel` (S12T-13 replaces the panel later), and the setup approval dialog.
  - Readiness is exit 0 only (Backend F step 3). The runner never reads `run.port`, and never infers readiness from time or command names. The per-action "Keeps running" toggle is out of scope, with no document field, editor control or runner branch. Decision T3 decides whether a follow-up ticket adds it.
  - Docs: CONTEXT "Setup gate", "Setup attempt", "Platform command"; add "Startup action", saying that a startup action is done only when it exits 0 and that a detected port never counts. Rewrite the Setup sections of `docs/internals/projects/environment.md`.
- **Deletes:** ledger rows "Manual Setup", "Single-script automatic setup launcher", "Recovery shell", "`document.setup` ...", "Automatic attempt single-command fields ...", "Web reads of the gate snapshot" and "Command approval dialog `ProjectCommandApprovalDialog`".
- **Acceptance criteria:**
  - [ ] A This computer 0.0.1 file with `setup: {default: "bun install"}` reads as one action `setup` with `runOnStartup: true`, and the file on disk is unchanged until Save.
  - [ ] In repo setup asks once after the upgrade, in its terminal and in the trail.
  - [ ] A ninth `runOnStartup` action fails validation with `too_many_startup_actions`. Eight startup actions with 32 KB scripts pass both document and startup-record validation.
  - [ ] Two startup actions run in order, each in its own terminal tab that stays open after its run, and show as two header lines in the trail.
  - [ ] A port never releases the gate. In each case below the gate stays `blocked` and the first turn stays `queued` (gate and queued-turn states at `packages/contracts/src/models/workspace-environment.ts:425-430,447-453`), checked while the action runs, after any port is published, and again just before the process exits:
    - Occupied port: another listener holds port P. The startup action prints `http://localhost:P/`, so `run.port` reports P reachable, then exits 1 with address-in-use. The trail ends at Setup failed with exit 1, and the first turn never starts.
    - Echoed URL: the action's command text contains `http://localhost:P/` while a listener holds P, and the process prints nothing, then exits 0. `run.port` stays null, and the first turn starts only after the exit 0.
    - IPv6: the action serves only on `::1`, prints `http://[::1]:P/` and keeps running. `run.port` is reachable and the port pill shows it, yet the trail stays at Running setup until Skip setup.
    - Print then fail: the action prints `http://localhost:P/`, listens until the probe answers, then exits 1. The first turn never starts, and the trail shows Setup failed with exit 1.
  - [ ] A startup action that keeps running, with or without a live port, holds Running setup until Skip setup. Skip setup starts the first turn and leaves the action running.
  - [ ] `exit 3` in the first startup action shows Setup failed with "exit 3", sets `failedActionId`, and does not start the second.
  - [ ] After the failed command is fixed, Retry setup reruns from the failed action and skips the earlier action that exited 0.
  - [ ] Stop during setup ends in the trail's Cancelled state and stops every running startup command; the terminals keep their shells.
  - [ ] Open terminal focuses the running action's terminal, else the failed one's.
  - [ ] The tail shows each started action's `$ <first script line>` once, then its command output as plain text with no escape sequences, within 32 entries and 16 KB, and survives a reload.
  - [ ] No code path creates a recovery shell, and `node tools/graph.mjs ledger-run S12T-11` passes.
- **Verify:**
  - Server: `bun run --cwd apps/server test -- src/features/projects/environment/__tests__/startup-action-runner.test.ts src/features/projects/environment/__tests__/workspace-environment-automatic-setup.test.ts src/features/projects/environment/__tests__/workspace-environment-service.test.ts src/features/projects/environment/__tests__/workspace-environment-upgrade.test.ts`. The runner tests use a fake `ProjectActionService` that emits exits and port updates and assert that only an exit 0 advances an entry. The four port cases (occupied port, echoed URL, IPv6, print then fail) run in `workspace-environment-automatic-setup.test.ts` through the real runner, `ProjectActionService`, detector and probe, with the command phase driven by the in-memory PTY host (`emitOutput`, plus an exit-with-code helper added beside it) and real `net.createServer` listeners on port 0 for IPv4 and `::1`. They assert the gate and queued-turn states.
  - Contracts: `bun run --cwd packages/contracts test -- src/__tests__/thread-startup.test.ts src/models/__tests__/workspace-environment.test.ts` (record bounds and the startup count).
  - Web: `bun run --cwd apps/web test -- src/features/thread-startup/__tests__/StartupStepsTrail.test.tsx` (the projection from entries and runs).
  - Live: in `.dev/fixture-repo`, configure `install` and `check` (`bun --version`) as startup actions and start a New worktree thread. Capture the trail against 04b and the two terminal tabs. Make `install` exit 3, confirm Setup failed, fix it through Edit script, and Retry setup. Then mark a `web` action that serves and prints its URL (`bun -e "Bun.serve({ port: 4321, fetch: () => new Response('ok') }); console.log('http://localhost:4321/')"`) as a startup action and start another thread: its port pill turns live while the trail stays at Running setup, and Skip setup starts the first turn with `web` still running.

### S12T-12 Cleanup actions before worktree removal

- **Blocked by:** S12T-04 Environment document 0.1.0.
- **Boards:** 12d row "On cleanup" `2H2U-2` (data)
- **Delivers:** actions marked Run on cleanup run in the worktree before Mcode removes it, in list order, each limited to two minutes. Failures are logged and do not keep the worktree.
- **Build notes:** Backend G. Add "Cleanup action" to CONTEXT.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] A cleanup action writing a marker file outside the worktree runs before `removeWorktree` (assert call order).
  - [ ] A failing cleanup action still lets the worktree be removed; the log carries the action id and exit code.
  - [ ] An unapproved In repo cleanup action is skipped and logged.
  - [ ] Retained worktrees and Direct threads run nothing.
- **Verify:** cleanup worker tests beside `apps/server/src/features/thread-control/cleanup/` (prior art in its `__tests__`), with a fake `TerminalCommandService`.

### S12T-13 Project settings: Actions section and save model

- **Blocked by:** S12T-04 Environment document 0.1.0; S12T-09 Action icons; S12T-11 Startup actions replace Setup; F-03 Button primitives; F-04a Menu primitive; F-05 Right panel shell: two-row header, right-edge rail, panel controls; F-12 Form controls.
- **Boards:** 12d `2GTA-2`, `2H1A-2`, `2H4J-2`, `2H7R-2`; 12h `23RB-2`
- **Delivers:** Project settings opens with row 1 the project title pill and row 2 the section pill (General | Actions) plus "+ Action". Actions: "Saved on: This computer | In repo"; rows with icon, name, command (fade), "On startup"/"On cleanup" chips, play; one expanded row at a time with icon picker, name, play, More (Duplicate, Delete, Forget approval for approved In repo actions), Command with All / macOS / Linux / Windows (dot marks an override), mono editor, the two toggles with their hints ("Run on startup": "When a thread starts in a worktree", decision T10; "Run on cleanup": "Before the worktree is removed"). "+ Action" appends a row named "action" with the name selected; Save stays off with "Add a command to save this action." under the editor. The save bar (amber dot "Unsaved changes", Discard, Save) appears only when dirty; drafts survive tab and thread switches. A conflict shows ".mcode/environment.json changed on disk" / "A pull or another thread edited it." (This computer: "Actions changed in another window.") with Keep mine and Reload. Validation errors use the copy table. Play is disabled with "Open a thread to run actions." when threadless.
- **Build notes:** Backend I. `projectEnvironment.open` keeps its id; Edit actions deep-links to Actions. Plain copy, no captions beyond the board's.
- **Deletes:** ledger rows "`ProjectEnvironmentPanel` and its test ..." and "`workspace.environment.command.clearApprovals`" (decision T6). S12T-11 already removed the old panel's Setup section.
- **Acceptance criteria:**
  - [ ] Add action, type a command, Save: saved; no `empty_script` path is reachable from the UI.
  - [ ] Turning on Run on startup for a ninth action shows "At most 8 actions can run on startup." and Save stays off.
  - [ ] Edit, switch thread, come back: draft and save bar still there.
  - [ ] Edit, then change the file on disk, Save: banner; Keep mine saves the draft; Reload shows the disk version.
  - [ ] Storage pill disabled while dirty.
- **Verify:** new `apps/web/src/features/projects/settings/__tests__/ProjectSettingsPanel.test.tsx` (draft persistence, conflict, validation copy) replacing `ProjectEnvironmentPanel.test.tsx`; server `workspace-environment-rpc.test.ts` for `command.forget`; live screenshots vs 12d and 12h.

### S12T-14 Project icon resolution and display

- **Blocked by:** S01-02 Sidebar frame, resize, footer strip, empty workspace drop; F-01b Token vocabulary rename; S12P-03 Files backend: capped list, change marks, structured read, image route.
- **Reconciled:** Reuses the S12P-03 image route; no second route. The sidebar project row's icon slot is a lifecycle toggle today; S01-02 decides where that toggle goes before this ticket swaps the slot to the project icon.
- **Boards:** 12k `242M-2`, `243W-2`, `249N-2`
- **Delivers:** every project shows an icon in the sidebar row (16px, radius 4), breadcrumb (14px, radius 3) and project picker: its chosen file, else a favicon Mcode found in common places, else the first letter on amber.
- **Build notes:** Backend H server side (column and migration, `ProjectIconService`, `workspace.icon.resolve`, `workspace.iconChanged`), web `ProjectIcon` and `projectIconStore` (batch resolve on workspace list load, refresh on push). Image bytes come from S12P-03's scoped image route with the workspace-root scope and the 2MB icon cap; this ticket adds no route and copies no path, auth or SVG validation. Breadcrumb: render `ProjectIcon` where the canvas header owner builds it.
- **Deletes:** ledger row "Project folder glyphs" (the sidebar row glyph once S01-02 has placed the lifecycle toggle).
- **Acceptance criteria:**
  - [ ] Fixture repo with `public/favicon.svg` shows it; removing it shows the monogram after the cache window or a settings visit.
  - [ ] `workspace.icon.set` rejects `..`, absolute, drive-letter, UNC and backslash paths, a symlink escaping the root, `.exe`, and files over 2MB, through S12P-03's validator plus the icon rules.
  - [ ] An SVG icon loads through the S12P-03 route with that route's `nosniff` and CSP headers, and a changed file gets a new URL through `ProjectIcon.version`.
  - [ ] `<link rel="icon" href="/brand.svg">` in `index.html` resolves to `public/brand.svg` when present.
- **Verify:** `bun run --cwd apps/server test -- src/features/projects/icons/__tests__/project-icon-service.test.ts` (new; resolver, icon rules, URL building). Traversal and header tests for the route itself live with S12P-03. Live sidebar screenshot vs 12k.

### S12T-15 Project settings: General section

- **Blocked by:** S12T-13 Project settings: Actions section and save model; S12T-14 Project icon resolution and display; F-04b Picker primitive.
- **Boards:** 12d `2GWA-2`, `2GXN-2`, `2GZU-2`; 12k `242M-2`
- **Delivers:** General shows Icon (40px tile, "Icon", source line "Automatic · public/favicon.svg" / "Automatic · no icon file found" / the chosen path in mono, or "apps/x.svg is missing · using automatic"), Choose file, and a reset button (tooltip "Use automatic") only when a file is chosen; Name (field, "Defaults to the folder name"); Location (mono path, open-folder button). Choose file opens a popover under the button with a focused "Search image files" field and rows of 20px thumbnail, file name and muted folder; Enter or click saves.
- **Build notes:** Backend H `workspace.icon.set`, `workspace.icon.candidates`; name via `workspace.rename`; picker on F-04 with "Showing x of y".
- **Deletes:** none beyond S12T-13.
- **Acceptance criteria:**
  - [ ] Picking `apps/desktop/build/icon.svg` in the Mcode repo updates sidebar, breadcrumb and picker without reload.
  - [ ] Reset returns to automatic; deleting the chosen file shows the missing line and automatic icon.
  - [ ] Clearing the name field and leaving it restores the folder name.
- **Verify:** component test for `GeneralSection` and `ProjectIconPicker`; live screenshots vs 12d General states and 12k.

## Tests

- Highest seams: `ProjectActionService` with the in-memory PTY host (`apps/server/src/features/terminal/testing/in-memory-pty-host-adapter.ts`) for phases, approval, cap and publish counts; legacy `TerminalService` tests for retention and metadata; one real-PTY test for the command-to-shell hand-off (prior art `apps/server/src/features/terminal/host/__tests__/pty-host-runtime.real.test.ts`; `terminal-session-runtime.real.test.ts` is deleted with the modern backend in S12T-01).
- Environment document: contract tests for versions, passthrough, the lowest-version writer and the startup count; service tests for upgrade-on-read in both storage modes (system file under a temp `mcodeDir`, shared file in a temp checkout) and approval identity change.
- Startup runner: `startup-action-runner.test.ts` with a fake `ProjectActionService` that emits exits and port updates. It covers order, readiness by exit 0 only, failure, the retry skip rule, approval, skip, cancel and an action that keeps running. The gate-level port cases (occupied port, echoed URL, IPv6, print then fail) run in `workspace-environment-automatic-setup.test.ts` and assert that the first turn stays queued until exit 0. The trail side is tested in `StartupStepsTrail.test.tsx` (section 04).
- Plain-text decoder and port detector: pure unit tests fed chunked ANSI and OSC input. Probe: real `net.createServer` listeners on port 0 for IPv4, IPv6-only `::1`, and a stale listener holding a previous run's port. Echo exclusion: `project-action-service.test.ts` asserts that `onCommandOutput`, and so the detector, never sees the echo line.
- Project icon: service tests with a temp directory tree (resolver, icon rules). The image route's traversal, symlink and header tests belong to S12P-03.
- Web: store tests (`terminalStore`, draft store), component tests for strip, controls, approval card, menu, overview section, settings sections. Replace, do not weaken, the existing `ProjectActionControl`, `ProjectEnvironmentPanel`, `ProjectSetupControl` and `TerminalPanel` tests.
- Live: `bun run --shell system agent:up --desktop`, `bun run agent:ready`, a thread on `.dev/fixture-repo` with a `.mcode/environment.json` holding `install` (startup), `web` (`bun run dev` or a small HTTP server script) and `fail` (`exit 1`). Capture before/after per board with the electorn-live-testing skill.

## Risks and open questions

Product calls, recorded in `decisions.md` (T1 to T11):

- **Decided.** T1: actions run as command, then shell; the command is not in shell history, and `cd` and environment changes do not carry into the shell (Backend B). T2: 8 terminal records per scope. T4: "watch" in 12i overview rows is sample text; rows show the port for actions with one, "Shell" for shells, and nothing otherwise. T5: In repo setup commands ask for approval once after the upgrade. T6: per-action Forget approval replaces "Clear shared command approvals". T7: loopback URLs open in the Browser tab, others in the system browser. T8: undrawn More menus use this brief's defaults (shell: Copy diagnostics, Open in external terminal, Close terminal; action: Edit action, Copy command, Close terminal). T9: retire the composer terminal chip. T10: the Run on startup hint is "When a thread starts in a worktree". T11: one terminal backend, chosen in S12T-01 (Backend A).
- **Open, T3 "Keeps running" toggle (user; does not block S12T-11).** S12T-11 builds exit-0-only readiness. A listening port never counts, because another process can answer on it. Consequence: a startup action that keeps running, such as a dev server or `bun test --watch`, holds the first turn until it exits or the user picks Skip setup, so dev servers stay manual actions. The possible follow-up is a per-action "Keeps running" toggle that starts an action without awaiting it. If the user approves it, it becomes its own ticket that defines its field, editor control, approval and upgrade rules, and tests. This program adds none of them, and Mcode never guesses readiness from ports, elapsed time or command names.

Risks (who decides):

- **R1 Deleting the modern backend (user, before S12T-01 starts).** S12T-01 keeps `legacy` and deletes `modern` (Backend A). This loses modern's controller leases, attachment epochs and input acknowledgement, so two clients (desktop and a browser) can still both type into one legacy shell, and legacy has no guard against input resent across a reconnect (inferred from the protocol difference, not reproduced). Keeping `modern` instead would mean redesigning Backend A and B on `TerminalSessionRuntime` and flipping the default for every user; the brief does not recommend it, but the user can choose it before S12T-01 starts.
- **R2 Legacy wire is "frozen".** This brief adds optional fields to `terminal.create` and `terminal.listActive` instead of a new protocol. Old clients ignore them; new clients tolerate their absence (fact, checked against the zod objects, which are not `.strict()`).
- **R3 Cleanup inside the repository lock** can delay other worktree operations on that repository by up to 120s per cleanup action. Moving it outside the lock needs a re-check after the policy decision (engineering call in S12T-12 if it shows up in practice).
- **R4 Ownership seams.** S12P-01 owns the rail, row-1 tabs, the rail-entry retirements and the one right-panel ADR; S12P-03 owns the image route; S03-02 owns the overview shell; S04-04 deletes `ProjectAutomaticSetupCard` and the 1s polling; S12T-11 converts the S04 trail's setup step; S11-09 consumes `run.port` and deletes `detectLocalPorts`. Land in graph order and name the other section's ticket in each PR.
- **R7 Startup tail from a PTY.** The tail is plain text decoded from terminal output. Progress bars that redraw with cursor movement can repeat lines in the 16KB tail; the terminal stays the faithful view (engineering, S12T-11).
- **R5 Sidebar project row glyph** is today a lifecycle toggle (hover swaps FolderOpen/FolderCheck, `ProjectTree.tsx:2589-2593`). The icon replaces the glyph; S01-02 decides where the lifecycle toggle goes before S12T-14 swaps the slot.
- **R6 Writing 0.0.1 when possible** keeps old teammates working only until someone uses a new field. Teams on mixed versions then see "Unsupported workspace environment version" on old builds. Expected; the 12d banner copy covers the new-build side.
