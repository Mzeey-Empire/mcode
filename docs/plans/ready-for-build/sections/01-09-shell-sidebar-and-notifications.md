# 01 · 09 · Shell, sidebar and in-app notifications: build brief

The window loses its separate title bar, and on Windows and Linux its in-app File, Edit, View and Help menu: the sidebar header and the canvas header share one 48px strip, with the native caption buttons (Windows, Linux) or traffic lights (macOS) inside it. The sidebar becomes 304 wide and resizable, starts composer-first with a project slot when there are no projects, accepts a dropped folder, and ends in an icon footer with a notifications bell and a ten-state update button. Every thread row reads one state model: running rows fade, threads that need the user get an amber ring and a visible label, finished and failed turns leave a dot and a line until the thread is opened. Thread events also raise a toast in one lane at the top centre of the conversation column, and an OS notification when Mcode is in the background. The bell opens a Providers popover that lists only providers that need something (signed out, rate limited, CLI update, new model) and stays quiet otherwise.

Surfaces: web (`apps/web`), desktop shell (`apps/desktop`), server (`apps/server`), contracts (`packages/contracts`), provider adapters (`packages/providers`, `apps/server/src/features/providers/adapters`).

## Boards

Page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0. Components page `p-5-0`.

| Board | Node | Shows |
|---|---|---|
| 01 · Empty workspace · Dark | `1ZDG-2` | No title bar; sidebar 304 (header 48, Search + New thread, Projects header with +, empty drop well, footer icons + update); canvas header 48 with caption overlay `width=env(titlebar-area-width)`; resize seam 1px (2px focus ring on hover/focus, 220 to 340); heading "What should we build in [choose a project]?", "Select project" tab on the composer, "Pick a project to work in code, or start a chat without a project." The "or start a chat without a project" clause is not built (N9). |
| 01 · Sidebar · Drag over · Dark | `2BMJ-2` | Drop well while a folder is dragged over: `--color-hover` fill, 1px `--color-control-border`, "Drop to add project". Header (44) and footer (no bell, no update button) are stale; use `1ZDG-2` and `2CF0-2`. |
| 01 · Sidebar header · macOS · Dark | `2BO9-2` | Traffic lights in a 68px slot (padding-left 2, gap 8, 12px lights), toggle, logo mark only (no wordmark), spacer, back, forward. |
| 01 · Sidebar footer · Notifications and updates · Dark | `2CF0-2` | Ten states: rest, checking, up to date (3s), available, downloading, ready, install dialog, failed, unread (bell dot), nightly (tooltip with full version). |
| 09a · Toast · Another thread finished · Dark | `25IT-2` | Toast top centre of the conversation column, 8px under the header; sidebar row "Finished". |
| 09b · Toast · Events and stacking · Dark | `2DN0-2` | Finished (green dot), Approval required (amber ring), Failed (clay dot); stack of 3, newest on top, gap 10. |
| 09c · Bell open · Live status (direction A) · Dark | `25RF-2` | Providers popover above the bell (380 wide). |
| 09d · Bell · Providers · States · Dark | `2DPF-2` | Needs you (Sign in, Update, Try, quiet ready row with usage); Working (spinner, "Updating to 0.48.0"). The quiet ready row with usage is not built (N2). |
| 09e · Update button hover · Release notes · Dark | `2DRR-2` | "What's new" card above the footer, 5 items, "Full release notes" link. |
| 09f · Toast motion · Click, hover, swipe away · Dark | `2DSS-2` | Enter, hover and click, swipe away, stack closes up. |
| 08d · Finished in the background · Dark | `207O-2` | Sidebar Finished row (8px green dot, green "Finished" line, no fill) and the OS-drawn notification ("Finished: <title>", "Changed 2 files · mcode-3f2a"). |
| 08f · Turn did not finish | `2C3A-2` | Sidebar Interrupted (amber ring + line) and Failed (clay dot + line); stopped shows nothing. |
| 05a · Running · Tools streaming | `213P-2` | Running row at opacity 0.55 with spinner, no status text (node `2156-2`). |
| 06a · Needs approval · Command / 06f · Another thread needs approval | `27P2-2` / `200I-2` | "Approval required" stays on the open (selected) row; full brightness. |
| Components · Navigation · Threads and projects · Dark | `CW1-0` (p-5-0) | Row interaction states `CYU-0` (hover actions ✓ and ⋯ trailing), thread context lines `DFT-0` (PR checks, CLI not found, Worktree unavailable, Cleanup), project rows `DUA-0`. The "Activity states" frame `D66-0` labels ("Action required", "Turn failed", "Recovery needed", amber running spinner) are superseded by the screen-pass labels below. |

## Locked decisions

- Sidebar 304 (`--container-sidebar`), resizable 220 to 340. Paper wins over DESIGN.md's 256 (screen-pass todo, Open decisions).
- No title bar. Windows/Linux caption overlay 48 high; read its width from `env(titlebar-area-width)`, never hard-code. macOS traffic lights at y=18, hidden in full screen (implementation notes, Shell and sidebar).
- No in-app menu on Windows and Linux (user, 2026-10-08, N1). File, Edit, View, Help and their Alt mnemonics are removed, with no replacement menu. Every item keeps another way in, a shortcut or a command palette entry (Backend architecture F). macOS keeps its native menu bar (`application-menu.ts:49-106`): the OS draws it, and its Edit roles carry Cmd+C, V, X, A and Z.
- Truncation is a 24px right-edge fade, never an ellipsis (2026-10-07). F-02.
- Row states (2026-10-07): running fades to ~55% with a spinner and no text; needs-you is never faded, amber ring and a visible label ("Approval required", "Answers required", "Plan ready", "Interrupted"); Finished is an 8px green dot plus a green "Finished" third line, no file count, no fill; Failed is a clay dot plus "Failed"; stopped shows nothing; outcome states clear when the thread is opened; needs-you outranks finished. Rename visible "Errored" to "Failed" everywhere, toasts included (08f).
- Live conditions stay while the thread is open: 06a shows "Approval required" on the selected row.
- Footer: bell plus a right-aligned update button with ten states; neutral icons, no colour coding; filled button from "available" to "ready"; filled hover uses `--color-button-secondary-hover`; nightly shows the channel name with the full version (`0.13.0-nightly.YYYYMMDD.N`) in tooltip and dialog; install dialog when agents run with "When they finish" (2026-10-07).
- Toast lane (09, approved 2026-10-07): top centre of the conversation column, 8px under the 48 header, slides down from under it. 340 wide, `--color-selected` fill, radius 18, no border, shadow `#00000066 0 8px 24px`, padding 12/10/12/16, status mark, title (fade), meta `Label · HH:MM`, close ×. Whole toast is the button; hover lifts the fill to `--color-border`; click opens the thread and dismisses. Enter 240ms `cubic-bezier(.2,0,0,1)`; swipe past 35% width or flick slides off in 160ms, else springs back; the stack closes the gap in 200ms; × and auto-hide reverse the enter. Finished auto-hides after 8s, paused on hover; needs-you and Failed stay until opened or closed. At most 3, newest on top. No toast for the thread on screen.
- Thread events never go to the bell; their memory is the sidebar row (user, 2026-10-07). This overrides the 09b caption "the rest go straight to the bell".
- Bell = provider and model setup, direction A (2026-10-07): one "Providers" popover, rows derived from live checks; the one stored thing is a per-announcement seen flag. No "all ready" state.
- The bell shows only what needs the user (user, 2026-10-08, N2). The popover lists only providers that are signed out, rate limited (with the reset time, N7), have a CLI update, or have a new model. No quiet ready rows and no usage rows: Mcode never shows information it is not sure of. With nothing to list, the popover shows its header only, the bell has no dot, and its tooltip is just its name. The dot shows while the popover has a row.
- Release notes on hover of Download / Install after 300ms: "What's new", first five items, "Full release notes".
- OS notification on finish only when notifications are on and Mcode is not focused; click opens the thread (08d).

## How it works today

### Window chrome

- Desktop renders a separate full-width `DesktopTitleBar` above everything (`apps/web/src/app/App.tsx:340-347`): logo, toggle sidebar, back, forward, and an in-app File/Edit/View/Help menu with Alt mnemonics on Windows/Linux (`apps/web/src/components/desktop/DesktopTitleBar.tsx:156-165,180-195`). It reserves a hard-coded `pr-[138px]` for caption buttons (`DesktopTitleBar.tsx:205`).
- Windows/Linux: `titleBarStyle: "hidden"`, `titleBarOverlay { color: transparent, symbolColor: "#8a8a92", height: 48 }`; macOS: `hiddenInset`, `trafficLightPosition { x: 14, y: 12 }` (`apps/desktop/src/features/desktop-window/lifecycle/create-window.ts:84-101`). No full-screen signal reaches the renderer (the window bridge exposes only `platform`, `isDevelopment`, `onCommand`, `perform`, `apps/web/src/transport/desktop-bridge.d.ts:438-448`).
- Non-macOS has no native menu (`application-menu.ts:35-39` sets it to null), so the title bar menu is the only File/Edit/View/Help on Windows/Linux. Its items call `executeCommand` or the allowlisted native actions (`window-actions.ts:6-39`). The title bar is the only caller of `window.perform` (`DesktopTitleBar.tsx:34-36`), and its zoom, full-screen, reload and developer-tools items are the only way to reach those actions on Windows/Linux: no keybinding exists for them (`default-keybindings.json`), and Electron binds those keys only through menu roles (inferred).
- `--desktop-title-bar-height: 3rem` drives `.app-viewport-fixed` (dialog, palette, lightbox backdrops) and `.app-panel-top-inset` (floating sidebar) (`apps/web/src/index.css:11-12,70-86`). `ConnectionBanner` renders full width under the title bar (`App.tsx:348`).

### Sidebar

- Fixed width `w-72` (288px) in two places: `apps/web/src/components/sidebar/Sidebar.tsx:87` and `SIDEBAR_WIDTH_PX = 288` (`apps/web/src/lib/composer-layout.ts:9`), which drives the inline-vs-floating decision. Not resizable.
- Body is a list of three text buttons (New thread, Search threads, Pull requests, `Sidebar.tsx:53-56`) above `ProjectTree`; footer is `UpdateIndicator` plus a full-width "Settings" text button (`Sidebar.tsx:61-64`). Web shows a separate `SidebarTitle` (`Sidebar.tsx:39-44`).
- Empty state: centred "No projects yet" in mono caps plus an "Open a folder" button that opens the add-project palette (`apps/web/src/features/projects/ProjectTree.tsx:1136-1160,668-670`). No OS folder drop exists; dnd-kit handles reorder only. The desktop bridge already has `getPathForFile` (`desktop-bridge.d.ts:515`).
- Thread row: one line, `min-h-8`, 13px, leading slot with the complete/reopen circle and a 12px provider icon, title with `truncate` (ellipsis), state marker on the right (`ProjectTree.tsx:1866-1871,1907-1964,2016-2033,2113-2120`). Startup and client-preparing rows dim to 0.72 (`ProjectTree.tsx:1603`).

### Thread row state

- `getThreadStateMarker` (`apps/web/src/components/sidebar/ThreadStateMarker.tsx:46-68`) ranks: pending permission ("Action required", the only needs-you case, `:63`), setup awaiting response, setup running, running (amber spinner), CI failing/pending, then `thread.status` (completed green dot, errored red dot, interrupted amber dot) or relative time. Labels are `aria-label` only, never visible (`:88`).
- Seen is a status flip today (verified). `thread.status === "completed"` maps to the green dot (`ThreadStateMarker.tsx:29-30`). Opening a completed thread flips it to `paused` locally and calls `thread.markViewed` after a 150ms debounce (`apps/web/src/features/projects/state/workspaceStore.ts:188-205, 1747-1767`). The server repeats the flip and returns nothing (`thread-control/lifecycle/thread-service.ts:180-183`, contract `methods.ts:814-817`). When a turn ends on the active thread, the client calls `markThreadViewed` regardless of window focus (`apps/web/src/stores/threadStore.ts:2473-2476`), so a turn that finishes while Mcode is in the background counts as seen. Errored and interrupted outcomes never clear, and the flip records no turn identity, so Review cannot tell which turns finished since the last look. No seen column exists.
- Bug (verified): a user Stop is persisted as thread status `interrupted`. `provider-event-publication.ts:25-29` maps every non-completed, non-errored outcome (including `cancelled`) to `interrupted`, and the semantic writer does the same (`canonical-execution-semantic-writer.ts:768`). The row cannot tell "You stopped" (nothing) from "Interrupted" (amber).
- Bug (verified): `status-pulse` runs a continuous animation on every waiting and interrupted dot (`ThreadStateMarker.tsx:82-86`, `index.css:431`), which AGENTS.md forbids for idle chrome.
- Gap (verified): pending approvals are known only for loaded thread records. `ProjectTree.tsx:520-531` scans `records`; `permission.listPending` is per thread (`packages/contracts/src/ws/methods.ts:1163-1166`, `agent-rpc.ts:198-201`). Live `permission.request` pushes are broadcast (`server-bootstrap.ts:899-900`), so only boot and reconnect miss background approvals.
- Interrupted marker comes from the client recovery incident store (`ProjectTree.tsx:1462-1464`), dismissible per app session.
- Plan states have no row representation (`ThreadStateMarker.tsx:63`).
- Running comes from `threadStore.runningThreadIds` (optimistic for new threads, `workspaceStore.ts:841`) hydrated from `agent.listRunning` (`methods.ts:1105-1108`); startup from `pendingStartupByThreadId` (`ProjectTree.tsx:1450`); setup from a per-row `useProjectAutomaticSetup` hook (`ProjectTree.tsx:1451-1461`).
- Push routing: `thread.status` and `permission.request` are broadcast to every client; only four channels are thread-scoped (`apps/server/src/application/transport/push.ts:17-22`).

### Updates

- Desktop updater (`apps/desktop/src/features/application-updates/lifecycle/updater.ts`) publishes `UpdateStatus` idle | checking | available | not-available | downloading | downloaded | error (`state/update-status.ts:5-12`, mirrored in `desktop-bridge.d.ts:14-21`). `releaseNotes` is sent on available and downloaded (`updater.ts:220-224,253-257`) and never rendered. GitHub provider feed `mzeey-empire/mcode` (`apps/desktop/package.json:81-85`); electron-updater's GitHub provider delivers release notes as HTML from the release feed (inferred).
- `autoDownload` defaults to true (`configuration/settings.ts:49-55`) and already has a user-facing switch in Settings › About (`apps/web/src/components/settings/sections/AboutSection.tsx:47`). The screen-pass note calling it new is stale.
- `UpdateIndicator` renders nothing at rest, checking, not-available or error; shows "Update available · Download ×", a progress bar, or "Restart to update" (`apps/web/src/components/sidebar/UpdateIndicator.tsx:19-125`). Errors become a toast (`App.tsx:614-620`). Dismissing hides it for the session (`apps/web/src/stores/updateStore.ts`).
- Install stops the server through a before-install hook and quits (`lifecycle/installation.ts:96-115`); no check for running agents. The window close guard already counts them via `ServerRuntime.getActiveAgentCount()` reading `/health.activeAgents` (`apps/desktop/src/features/server-runtime/index.ts:271-290`, `desktop-window/lifecycle/close-guard.ts:43-60`). The renderer can read the same count with `agent.activeCount` (`methods.ts:1101-1104`).
- On download the updater fires its own OS notification "Mcode update ready" without checking any setting (`updater.ts:259-266`).

### Toasts and OS notifications

- `toastStore` (`apps/web/src/stores/toastStore.ts`): levels `error | info`, title + message, max 5, 5s auto-dismiss. `Toast.tsx` renders them bottom-right, rising from below, with a tinted icon chip (`apps/web/src/components/Toast.tsx:30-42,86-101`). 21 non-test modules call it (`rg -l "useToastStore|toastStore" apps/web/src`). No thread events toast today.
- The composer has its own local "Queue full" toast (`stores/queueStore.ts:136`, `Composer.tsx:97`); it is not an app toast and stays.
- Electron `Notification` is used for server recovery (`server-runtime/recovery/notifications.ts:73-89`, factory at `apps/desktop/src/main/main.ts:319-322`) and update ready. Bug (verified): the `notifications.enabled` setting (`packages/contracts/src/models/settings.ts:207-213`, switch in `NotificationsSection.tsx:11-29`) has no consumer.

### Provider status

- `providers.listAvailability` returns `enabled`, `hasAdapter`, capabilities and `cli { status: found | not_found | unchecked, resolvedPath, configuredPath }` (`apps/server/src/features/providers/availability/provider-availability-service.ts:72-97`). No version, auth, or update data.
- Version checks exist for two providers, not one: Codex (`packages/providers/src/private/codex/codex-version.ts`, floor `CODEX_MIN_VERSION = "0.37.0"` at `codex-provider.ts:98`, enforced at `:835`) and Copilot (`copilot-cli-resolver.ts:86,288`). Neither knows the latest version. ADR 0001 says discovery stays per provider and the version policy is promoted to a shared module once a second provider needs the update prompt; that moment is now.
- Claude runs the SDK-bundled CLI unless the user sets a custom command (`claude-provider.ts:1807-1814`), so its CLI version moves with Mcode releases.
- Sign-in state is never queried. Facts that exist: Claude OAuth token presence and 401 handling (`private/claude/usage/oauth-usage-source.ts:32-34,57-62`); Codex `account/read` result type with no caller (`codex-types.ts:237-238`); Devin credentials from env or `credentials.toml` with the hint "Run `devin auth login`" (`private/devin/devin-credentials.ts:20-37`).
- Usage: Claude, Codex (`account/rateLimits/read`, `codex-app-server.ts:883`) and Copilot implement `getUsage`; Cursor, Devin and OpenCode do not. Rate limits exist only as a per-thread `RateLimited` agent event (`packages/contracts/src/events/agent-event.ts:256-267`).
- Model lists: every adapter implements `listModels`; `ModelCacheService` caches them in `provider_model_cache` (`apps/server/src/features/providers/models/model-cache-service.ts:46`, `schema.ts:930-936`).
- Devin maps `auth_required` and `quota_exhausted` stop reasons to `interrupted` (`devin-provider.ts:119-124`), which the new model would show as amber "Interrupted". 08f's error kind fixes the classification.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| No title bar, shared 48 strip | Separate `DesktopTitleBar` | Sidebar header + canvas header; caption reserve from `env(titlebar-area-*)`; lights (14,18); full-screen signal | web, desktop |
| No app menu on Windows/Linux (N1) | Title bar menus with Alt mnemonics | Remove the menu; each item keeps a shortcut or palette command; add zoom, full-screen, development reload and DevTools, Keyboard settings and About commands (F) | web, desktop |
| Sidebar 304, resizable 220 to 340 | Fixed 288 in two places | Width store (localStorage), seam with keyboard support, layout reads live width | web |
| Search field + New thread icon, footer icons | Three text buttons, Settings text button | Go zone and footer strip | web |
| Empty drop well, drop a folder | Mono "No projects yet" + button; no drop | Drop well, drag-over state, path via `getPathForFile`, hand-off to add-project palette | web, desktop |
| Three-line row, status lane, fade | One line, end marker, ellipsis | New row anatomy (Components `CYU-0`, `DFT-0`) | web |
| One row state model | `getThreadStateMarker` with visual-only labels | `deriveThreadRowState` pure function + presentation table | web |
| Finished and Failed until seen | Status flip on open; counts unfocused turn ends as seen; no turn identity | One seen marker (settled sequence plus time) acknowledged by the client, and the last turn outcome, on the server | contracts, server, web |
| Stopped vs Interrupted | Both persist as `interrupted` | `last_turn_outcome` keeps `cancelled` | server |
| Background approvals at boot | Only after opening the thread | Attention list RPC + broadcast push | contracts, server, web |
| Answers required, Plan ready | Not represented | Waiting sources registered by S07 | server (S07), web |
| Toast lane top centre | Bottom-right app toasts | One lane; app toasts move in | web |
| Thread-event toasts | None | Transition detector + lane entries | web |
| OS notification on finish | None; setting unused | Desktop notify bridge, click opens thread, gated by `notifications.enabled` | web, desktop |
| Update button 10 states | Indicator hidden at rest, error toast | `UpdateButton` state map, Up to date flash, Failed + Retry, nightly label | web, desktop |
| Install while agents run | Installs immediately | Dialog with live count; "When they finish" arms install-when-idle in desktop main | web, desktop |
| Release notes hover | Data unused | Plain-text parser + hover card | web |
| Bell + Providers popover | None | Provider status contract and service; popover lists only providers that need something, no usage (N2) | contracts, server, providers, web |
| CLI update available + Update | Floors only (Codex, Copilot) | Shared version policy, latest-version feed, update runner | server, providers |
| New model announcement | None | Model sightings table, seen flag, Try | server, web |

## Backend architecture

### A. Thread attention (server facts behind every row state)

One read model, owned by the server, carries the facts a row needs that the client cannot know on its own. It also owns the thread's single seen marker, which the sidebar's Finished and Failed states and Review's Since you looked (S08-08) both read.

A **settled sequence** is the `sequence` of an assistant message whose `outcome` is set (`messages.sequence` and `messages.outcome`, `apps/server/src/runtime/persistence/sqlite/schema.ts:326, 356-357`; contract `packages/contracts/src/models/message.ts:80, 94-95`). The seen marker is the settled sequence the user has had on screen, plus the server time it advanced.

```ts
// packages/contracts/src/models/thread-attention.ts
export const ThreadWaitingKindSchema = z.enum(["approval", "questions", "plan"]);

export const SeenMarkSchema = z.object({
  sequence: z.number().int().nonnegative().nullable(), // null when never seen
  at: z.string().nullable(),                           // ISO UTC, server clock of the last advance
}).strict();

export const ThreadAttentionSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
  /** Live condition blocking the agent on the user; null when none. */
  waiting: z.object({ kind: ThreadWaitingKindSchema, since: z.string() }).nullable(),
  /** Last terminal turn; null before any turn ended. */
  lastTurn: z.object({
    outcome: TurnOutcomeSchema,              // completed | cancelled | interrupted | errored
    endedAt: z.string(),                     // ISO UTC, server clock
    sequence: z.number().int().nonnegative(),// settled sequence of the message that carries the outcome
    changedFileCount: z.number().int().nonnegative().nullable(), // null until the snapshot lands
  }).nullable(),
  seen: SeenMarkSchema,
}).strict());
```

The last turn is unseen when `seen.sequence` is null or lower than `lastTurn.sequence`.

Wire (all in `packages/contracts/src/ws/methods.ts` / `channels.ts`):

- `thread.listAttention` `{}` → `ThreadAttention[]`. Returns only threads with `waiting !== null` or an unseen `lastTurn`. Called at boot and on every reconnect, next to `agent.listRunning`.
- `thread.acknowledgeSeen` `{ threadId, throughSequence }` → `{ previous: SeenMark, current: SeenMark }`. This is the only write to the seen marker, and it replaces `thread.markViewed` (`methods.ts:814-817`). `throughSequence` is the highest settled sequence the client has rendered for that thread, never the server's latest, so Mcode never acknowledges a turn the client has not received.
  - The server reads the marker and the thread's newest settled sequence and writes the advance in one transaction through the database writer.
  - `throughSequence` above the newest settled sequence is rejected with `sequence_ahead` and changes nothing.
  - `throughSequence` at or below the stored sequence is a no-op: no write, no push, and `previous` equals `current`.
  - Otherwise it sets `seen_through_sequence = throughSequence` and `seen_at = now`, returns the old and new marks, and broadcasts `thread.attention` so other clients clear too.
  - The same transaction applies today's `completed → paused` status flip (`thread-service.ts:180-183`), so `thread.status` and the sidebar status filter keep their current meaning.
- Push `thread.attention`: one `ThreadAttention` per change. Broadcast; do not add it to `SUBSCRIPTION_SCOPED_CHANNELS` (`push.ts:17-22`), since background threads are the point.
- Since you looked (S08-08) reads the seen sequence from `acknowledgeSeen` and owns the `afterSequence` parameter on the cumulative diff methods; this section adds no comparison changes.

Persistence (`apps/server/src/runtime/persistence/sqlite/schema.ts` `threads`, one Drizzle migration):

- `seen_through_sequence INTEGER NULL`, `seen_at TEXT NULL`, `last_turn_outcome TEXT NULL`, `last_turn_ended_at TEXT NULL`, `last_turn_sequence INTEGER NULL`.
- Backfill `seen_through_sequence` with each thread's newest settled sequence and `seen_at = now`, so the upgrade does not paint every old thread "Finished". Leave `last_turn_*` null for history.
- Replace the terminal `updateStatus` calls with one `ThreadStore.recordTurnOutcome(threadId, outcome, endedAt)` that writes the legacy status mapping unchanged plus the `last_turn_*` columns in one statement, through the database writer (register it beside `threadWriteOperations.updateStatus`, `thread-write-handlers.ts:11`). It reads the thread's newest settled sequence inside the same transaction for `last_turn_sequence` (inferred: the terminal batch runs after the finalizer sets `messages.outcome`; the integration test asserts the two match). Known sites: `canonical-execution-semantic-writer.ts:767-768`, `agent-event-publication-service.ts:67-73` (via `provider-event-publication.ts:18-31`), `canonical-parent-turn-write.ts:211` (restart interruption). The `errored` writes in `thread-control-service.ts:726,773,1388,1808` need a check: record an outcome only where a turn actually ended (inferred). Guard against late replays: ignore an `endedAt` older than the stored one.

Service: `ThreadAttentionService` in `apps/server/src/features/thread-control/attention/`.

- `get(threadId)`, `listInteresting()`, `invalidate(threadId)` (recompute, compare with last sent, broadcast on change), `acknowledgeSeen(threadId, throughSequence)`.
- Waiting comes from registered sources so each owner plugs in its own facts:

```ts
interface ThreadWaitingSource {
  readonly kind: ThreadWaitingKind;
  /** Threads currently waiting on the user for this kind, with the time the wait began. */
  listWaiting(): ReadonlyMap<string, string>;
}
```

  S01-03 ships the `approval` source. It reads `ApprovalService.listPending()` from S06-01, which already merges provider and ThreadControl approvals; it never reads the old permission service. Each request counts on its own `threadId`, which for a thread operation is the owner thread: the source thread when an Mcode agent asked, the target only for an external integration with no source thread (06 Backend 3). A supervised `thread_send` from A to B therefore marks A, not B, matching the dock. `since` is the earliest `requestedAt` among the thread's pending requests. S07 ships `questions` and `plan` sources; `plan` must rely on S07 marking plan versions accepted or superseded, because `plan.updateStatus` is never called today and every plan would stay "ready" forever. Precedence when several apply: approval, questions, plan.
- Invalidation sites: `ApprovalService` publish and resolve, `recordTurnOutcome`, turn snapshot write (to fill `changedFileCount` from `turn_snapshots.file_effects.fileCount`), `acknowledgeSeen`, and the S07 plan and question writes.

Failure modes: a lost push is repaired by the reconnect list. A failed `acknowledgeSeen` leaves the client's optimistic mark in place for the session; the row may reappear after a reload (acceptable, logged), and the next on-screen acknowledgement repeats it safely because repeats are no-ops. A `sequence_ahead` rejection means the client is ahead of the server's settled history, which is a bug; it is logged and not retried. A thread deleted while waiting drops out because the list joins live threads.

Per provider: attention is provider-blind. The adapters already emit the inputs.

| Provider | Approval input | Outcome input | Change |
|---|---|---|---|
| Claude | `approval_request` (S06-01) | `turnComplete` / `ended` | No change |
| Codex | `approval_request` (S06-01) | `turnComplete` / `ended` | No change |
| Cursor | ACP `request_permission` → `approval_request` | `ended` | No change here; S06-00 fixes the deny fallback |
| Copilot | SDK permission → `approval_request` | `ended` | No change |
| Devin (ACP) | ACP `request_permission` → `approval_request` | `ended`, but `auth_required` and `quota_exhausted` arrive as `interrupted` (`devin-provider.ts:119-124`) | Reclassify as `errored` with an error kind (S08, 08f error-kind ticket). Until then Devin sign-in failures show amber "Interrupted". |
| OpenCode | permission events (inferred) → `approval_request` | `ended` | No change |

### B. The row state model (one pure function)

Lives in `apps/web/src/features/thread-attention/thread-row-state.ts`. Sections 04, 05, 06, 07 and 08 feed it facts; nobody else ranks states.

```ts
export type NeedsYouLabel = "Approval required" | "Answers required" | "Plan ready" | "Interrupted" | "Setup failed";

export type ThreadRowState =
  | { kind: "needs-you"; label: NeedsYouLabel }
  | { kind: "running" }
  | { kind: "failed" }
  | { kind: "finished" }
  | { kind: "quiet" };

export interface ThreadRowFacts {
  attention: ThreadAttention | undefined;   // server (A)
  running: boolean;                         // client: isThreadExecuting || startup pending
  setup: "running" | "awaiting-approval" | "failed" | null; // client, until S04/S12 move it server-side
  onScreen: boolean;                        // active thread in a focused, visible window
}

export function deriveThreadRowState(f: ThreadRowFacts): ThreadRowState {
  const waiting = f.attention?.waiting?.kind;
  if (waiting === "approval" || f.setup === "awaiting-approval") return needsYou("Approval required");
  if (waiting === "questions") return needsYou("Answers required");
  if (f.running || f.setup === "running") return { kind: "running" };
  if (waiting === "plan") return needsYou("Plan ready");
  if (f.setup === "failed") return needsYou("Setup failed");
  const turn = f.attention?.lastTurn;
  if (!turn || f.onScreen || isSeen(turn.sequence, f.attention?.seen.sequence)) return { kind: "quiet" };
  switch (turn.outcome) {
    case "interrupted": return needsYou("Interrupted");
    case "errored": return { kind: "failed" };
    case "completed": return { kind: "finished" };
    case "cancelled": return { kind: "quiet" };
  }
}
```

Why this order: approval and questions block a turn that is still alive, so they beat the fade (06a). Plan ready only exists once the planning turn is over. Outcomes are memories of the last turn, so a new run hides them and opening the thread clears them. Live conditions do not clear on open.

Presentation, one table (`threadRowPresentation(state)`), consumed by the sidebar row, the palette thread search, and the toast:

| State | Status lane (16px slot) | Third line | Row opacity | Toast mark |
|---|---|---|---|---|
| needs-you | 8px ring, 1.5px `--color-primary`, static | label, `--color-primary` | 1 | same ring |
| running | `Spinner`, neutral | context line (below) | 0.55, whole row | none (no toast) |
| failed | 8px dot `--color-error` | "Failed", `--color-error` | 1 | clay dot |
| finished | 8px dot `--color-success` | "Finished", `--color-success` | 1 | green dot |
| quiet | empty | context line | 1 | none |

Context line (when the state gives no label): the existing third-line facts from Components `DFT-0` in this order: Cleanup blocked, Cleanup queued, Worktree unavailable, CLI not found / Provider disabled, PR checks (passing, pending, failing, merged). `isUserCompleted` keeps its strike-through title.

On-screen and seen, client side (`threadAttentionStore`):

- `onScreen(threadId)` = `activeThreadId === threadId && document.visibilityState === "visible" && document.hasFocus()`. Recomputed on `focus`, `blur`, `visibilitychange` and thread switches.
- Whenever a thread has been on screen for 150ms and the highest settled sequence the client has rendered for it is above `seen.sequence`, call `thread.acknowledgeSeen({ threadId, throughSequence })` with that rendered sequence and set the mark optimistically. The 150ms dwell keeps today's debounce rule for fast sidebar navigation (`workspaceStore.ts:188-205`). This covers opening a finished thread, returning focus to it, and a turn ending while it is watched. A turn that ends in an unfocused window is acknowledged on the next focus, never before.
- When the response's `previous.sequence` is below `current.sequence`, hand `previous.sequence` to Review as this visit's Since-you-looked baseline (S08-08) before applying `current`, which clears the row. Apply the legacy `completed → paused` flip locally at the same moment; it moves here from `setActiveThread` (`workspaceStore.ts:1747-1767`).
- Opening a thread clears Finished, Failed and Interrupted, because they are memories of the last turn. It never clears a live condition: a pending approval keeps "Approval required" until it is answered.
- Hover prefetch (`scheduleThreadRowPrefetch`) must not acknowledge.
- `markThreadViewed` has no callers left. The debounced call in `setActiveThread` and the unfocused end-of-turn call in `synchronizeTerminalStatus` (`threadStore.ts:2473-2476`) both go; `synchronizeTerminalStatus` applies the status to the active thread like any other.

### C. Notification lane and OS notifications (client and desktop)

The lane itself is F-07b's: the toast primitive, its store, kinds (finished, needs-you, failed, info), lifetimes, the cap of 3, motion, and moving today's app toasts into it (S09-01 merged there). This section adds only the thread-event producer and the OS bridge.

- One entry per thread: the producer sets `dedupeKey` to the thread id, so a newer state for the same thread replaces the entry and moves it to the top.
- Thread entries also leave when their thread becomes on screen or their row state stops matching (approval answered elsewhere, thread opened on another client and seen). The producer dismisses them by `dedupeKey` (inferred: F-07b exposes dismissal by key; add it there if missing).

Transition detector (`apps/web/src/features/thread-attention/thread-event-detector.ts`): subscribes to `threadAttentionStore` and running state, keeps the previous `ThreadRowState` per thread, and on a change into `finished`, `failed`, or `needs-you` with label Approval required / Answers required / Plan ready, for a thread that is not on screen, emits one event. Snapshot hydration (`thread.listAttention`) never emits. Interrupted and Setup failed never toast (they happen while Mcode was closed or during startup).

The event goes to the lane, and, when the window is not focused and `settings.notifications.enabled` is true, to the desktop:

```ts
// desktop-bridge.d.ts (new)
notifications?: {
  show(input: { tag: string; title: string; body: string }): Promise<void>;
  onClick(callback: (tag: string) => void): (...args: unknown[]) => void;
  offClick(listener: (...args: unknown[]) => void): void;
};
```

Main process (`apps/desktop/src/features/desktop-window/notifications/`, new): validates length (title ≤ 200, body ≤ 300 chars) and creates `new Notification({ title, body })`; on click restores and focuses the main window and sends `notifications:clicked` with the tag (the thread id); the renderer selects that thread through the normal navigation path. One live notification per tag (close the previous one). Copy: title `Finished: <thread title>`, `Approval required: <title>`, `Failed: <title>`; body `Changed N files · <worktree or branch>` when the count is known, else `<worktree or branch>`. Web without the bridge gets the lane only.

Lane position: rendered once inside the main surface, centred on the conversation column (the composer's centre line, which excludes the overview reserve), `top: 56px` (48 header + 8). Outside the chat surface (Settings, Pull requests) it centres on the main surface. z-index stays at the DESIGN.md toast layer.

### D. Updates (desktop + web)

Update button display is a pure map from `UpdateStatus` plus two renderer flags:

| # | Condition | Button |
|---|---|---|
| 1 Rest | idle, not-available (after the flash) | round 32 ghost, refresh icon, tooltip "Check for updates"; click → `checkForUpdates()` |
| 2 Checking | checking | same slot, spinner |
| 3 Up to date | a user-started check resolved `not-available` | ghost text button, check icon + "Up to date" muted, 3s then rest. Background checks never flash. |
| 4 Available | available | filled `--color-selected`, download icon, "Download", version mono muted; click → `downloadUpdate()` |
| 5 Downloading | downloading | filled, progress ring icon, "v0.10.0 · 42%" mono muted; not clickable |
| 6 Ready | downloaded | filled, arrow-up icon, "Install", version; click → `agent.activeCount`; 0 → `installUpdate()`; >0 → dialog 7 |
| 7 Install dialog | user clicked Install with agents running | 384 card: "Install update", full version mono, "N agents are running. Installing restarts Mcode and stops them.", ghost "Restart now", amber "When they finish" |
| 8 Failed | error | ghost text button, alert icon, "Retry update"; tooltip carries `friendlyUpdateError(message)`; Retry repeats the failed step (check, download or install) |
| 9 Unread | the Providers popover has any row (N2) | bell shows a 6px `--color-ink` dot ring `--color-page` (bell, not the update button) |
| 10 Nightly | version contains `-nightly.` | "nightly" replaces the version text in states 4 to 6; tooltip `Install 0.13.0-nightly.20260812.1`; dialog shows the full version |

Filled hover uses `--color-button-secondary-hover`. Values: `2CF0-2` nodes `2CJ0-2`, `2CJQ-2`, `2CIC-2`, `2CKN-2`.

Install when idle (desktop main, `lifecycle/installation.ts`):

```ts
installWhenIdle(): void;        // arm; idempotent
cancelInstallWhenIdle(): void;  // disarm
```

- Armed: poll `getActiveAgentCount()` every 5s; after two consecutive zero readings run the existing `quitAndInstallSafely()`. A turn that starts in the gap is stopped by the before-install hook and resumes after restart, the same promise the close guard makes.
- Status: `downloaded` gains `installWhenIdle: boolean` in both `update-status.ts` and `desktop-bridge.d.ts`. New IPC channels `app:install-when-idle` and `app:cancel-install-when-idle` (`ipc/handlers.ts:27-34`).
- Not persisted: a quit while armed falls to `autoInstallOnQuit`.

Release notes: `parseReleaseNotes(notes: string): { items: string[]; fallback: string | null }` in `apps/web/src/features/updates/`. Accept HTML (`<li>`) or markdown list items, strip all markup to plain text, keep the first five; fall back to the first paragraph. Render as text, never as HTML: the feed is external input. "Full release notes" opens `https://github.com/mzeey-empire/mcode/releases/tag/v<version>` externally.

### E. Provider status (bell)

```ts
// packages/contracts/src/models/provider-status.ts
export const ProviderAuthSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed_in") }),
  z.object({ state: z.literal("signed_out"), signIn: ProviderSignInSchema }),
  z.object({ state: z.literal("unknown") }),
]);
export const ProviderSignInSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), argv: z.array(z.string()).min(1).max(8) }),
]);
export const ProviderCliStatusSchema = z.object({
  installed: z.string().nullable(),              // raw version from the adapter's own discovery
  managedBy: z.enum(["mcode", "user"]),          // "mcode" = bundled (Claude default): no update row
  latest: z.string().nullable(),                 // from the release feed, null when unknown
  update: z.discriminatedUnion("state", [
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("available"), target: z.string() }),
    z.object({ state: z.literal("running"), target: z.string() }),
    z.object({ state: z.literal("failed"), target: z.string(), reason: z.string().max(240) }),
  ]),
});
export const ProviderRateLimitSchema = z.object({
  resetsAt: z.string().nullable(),               // ISO UTC; null when the provider gave no reset time
  limitType: z.string().max(64).nullable(),      // "five_hour", "seven_day"; labels as in 04-08f section J
});
export const ProviderStatusSchema = lazySchema(() => z.object({
  providerId: ProviderIdSchema,
  auth: ProviderAuthSchema,
  cli: ProviderCliStatusSchema.nullable(),
  rateLimit: ProviderRateLimitSchema.nullable(), // latest active RateLimited event; null when none
  newModels: z.array(z.object({ modelId: z.string(), label: z.string() })).max(5),
  checkedAt: z.string(),
}).strict());
```

No `usage` field (N2). The bell was the only planned reader of provider usage in this contract; the thread overview's Usage rows keep reading `provider.getUsage` (`methods.ts:1470-1472`, called at `threadStore.ts:4253`), so that method stays and the bell never calls it.

Wire: `providers.listStatus {}` → `ProviderStatus[]` (enabled providers only); push `providers.statusChanged` (one status); `providers.signIn { providerId }`; `providers.updateCli { providerId }`; `providers.acknowledgeModels { providerId }`.

Service: `ProviderStatusService` in `apps/server/src/features/providers/status/`. Refresh on boot (deferred off the startup path), every 6 hours, on bell open if older than 10 minutes, and after sign-in or update finishes. Each adapter exposes raw facts through an optional provider method (`describeStatus?(): Promise<ProviderStatusFacts>`); the service adds:

- Version policy (ADR 0001): extract `meetsMinVersion` from `codex-version.ts:130` into `packages/providers/src/version-policy.ts` with `isNewer(latest, installed)`. Discovery stays in each adapter.
- Latest-version feed: a provider-blind npm registry reader (`GET https://registry.npmjs.org/<pkg>/latest`, 5s timeout, cached 24h, failure = `latest: null`, no row). Each adapter names its package; the feed never runs a binary.
- Update runner: fixed argv from the adapter, no shell, 5-minute timeout, output captured and trimmed to a 240-char reason on failure. Runs only when the adapter can state how the CLI was installed; otherwise no Update row.
- Sign in: `providers.signIn` opens a Terminal tab running `signIn.argv` in the right panel, scoped to the active project and no thread, so the user signs in calmly (N6). With no project open, it opens an external terminal (ADR 0006). When it exits, re-check auth.
- Announcements: new table `provider_model_sightings (provider_id, model_id, first_seen_at, acknowledged_at NULL, PK(provider_id, model_id))`. On each successful `ModelCacheService` refresh, insert unseen ids. The first refresh for a provider with no rows inserts everything already acknowledged (baseline, so upgrades do not announce the whole catalog). `acknowledgeModels` sets `acknowledged_at` for that provider's open sightings. Try selects the newest announced model for the next thread and acknowledges.
- Rate limit (N7): the server keeps the latest `RateLimited { active: true }` event per provider in memory (`agent-event.ts:256-268`), with `resetsAt` = receipt time + `retryAfterMs`. It clears on `active: false`, when `resetsAt` passes, or after a restart. No reset time known means no time is shown, never a guess.
- Update checks can be turned off (N10): a `settings.updates.providerCliChecks` boolean, default on (S09-05).

Rows (web), one per provider that needs something; the most urgent condition wins: signed out (amber detail "Signed out · threads on X can't start", Sign in) › rate limited ("5-hour limit reached · resets 16:00", or "Rate limited" with no time; no action) › CLI update available ("CLI 0.48.0 available · you have 0.41.2", Update; Working shows the spinner and "Updating to 0.48.0"; failure shows the reason and Retry) › new model ("Fable 5.1 is new in the model menu", Try). A provider with nothing to report has no row. With no rows, the popover shows its header only. The bell dot shows while any row exists. The bell tooltip is its name, "Providers", and never carries a status (proposed; no board draws the tooltip).

| Provider | Sign-in state | Sign in | Installed version | Latest / Update | Rate limit | Announcements |
|---|---|---|---|---|---|---|
| Claude | signed in when the OAuth token reader (`oauth-usage-source.ts:32`) returns a token or `ANTHROPIC_API_KEY` is set; 401 → signed out | terminal: bundled CLI login (inferred; Q7) | bundled → `managedBy: "mcode"`, no update row; custom command → `--version` | custom command only: npm `@anthropic-ai/claude-code`, `claude update` (inferred) | the only `RateLimited` emitter (`claude-event-mapper.ts:569-575`); active on `rejected` only after S05-03 | yes (static catalog, `claude-static-fallback.ts`) |
| Codex | app-server `account/read` (`codex-types.ts:237`, add the call; empty result → signed out, inferred) | `codex login` (inferred) | `checkCodexVersion` | npm `@openai/codex`; update only when the resolved path sits under the npm global prefix (inferred) | no `RateLimited` emitter today; no row until one exists | yes (`model/list`, ADR 0018) |
| Cursor | `cursor-agent status` (inferred) | `cursor-agent login` (inferred) | `cursor-agent --version` (inferred) | none: no feed; cursor-agent updates itself (inferred) | no signal; no row | yes (ACP model list) |
| Copilot | SDK auth status call (inferred name, SDK `^0.2.2`) | `copilot` login flow (inferred) | `copilot-cli-resolver` version + source | npm `@github/copilot` when source is npm-global | no signal (inferred); no row | yes (SDK `listModels`) |
| Devin (ACP) | credentials present via `resolveDevinAcpCredentials` (`devin-credentials.ts:26`) | `devin auth login` (`devin-credentials.ts:22`) | unknown → `cli: null` | no row | no signal; no row | yes (`listModels`) |
| OpenCode | `unknown` (it fronts many upstream providers) | no row | `opencode --version` | npm `opencode-ai`, `opencode upgrade` (inferred) | no signal; no row | no: its list mirrors every configured upstream model and would announce noise |

### F. Windows and Linux menu removal (S01-01)

The in-app File, Edit, View and Help menu and its Alt mnemonics go, with no replacement (N1). Every item of today's Windows and Linux menu (`DesktopTitleBar.tsx:57-153`) keeps another way in. The macOS native menu (`application-menu.ts:49-106`) is unchanged.

| Menu item | Today | Other way in after S01-01 | S01-01 adds |
|---|---|---|---|
| File › New project | `workspace.new` | Ctrl+Shift+N (`default-keybindings.json:7`), palette "New Project" (`App.tsx:734-745`), the Projects + in the sidebar (S01-02) | nothing |
| File › New thread | `thread.new` | Ctrl+N (`default-keybindings.json:5`), palette "New Thread" (`App.tsx:718-725`), the sidebar New thread icon (S01-02) | nothing |
| File › Close window | `perform("closeWindow")` | the caption close button; Alt+F4 on Windows (drawn and handled by the OS) | nothing |
| File › Quit | `perform("quit")` | the same as Close window: closing the only window quits on Windows and Linux (`main.ts:580-584`) | nothing |
| Edit › Undo, Redo, Cut, Copy, Paste, Select all | `perform(...)` calling `webContents.undo()` and the rest (`window-actions.ts:46-51`) | Chromium's own editing keys in text fields: Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z, Ctrl+X, Ctrl+C, Ctrl+V, Ctrl+A. Outside macOS they need no menu (inferred; the live check proves it) | nothing |
| View › Back, Forward | `navigateHistory` | the header back and forward buttons, Alt+Left and Alt+Right, Ctrl+[ and Ctrl+] (`default-keybindings.json:14-17`), palette "Back" and "Forward" (`App.tsx:661-672`) | nothing |
| View › Toggle sidebar | `sidebar.toggle` | the header toggle, Ctrl+\ (`default-keybindings.json:13`), palette "Toggle Sidebar" | nothing |
| View › Toggle right panel | `rightPanel.toggle` | Ctrl+Alt+B (`default-keybindings.json:18`), the chat header toggle (`HeaderActions.tsx:42-46`), palette "Toggle Right Panel" | nothing |
| View › Zoom in, Zoom out, Actual size | `perform("zoomIn")`, `perform("zoomOut")`, `perform("zoomReset")` | none | commands `window.zoomIn` "Zoom In" (Ctrl+= and Ctrl+Plus), `window.zoomOut` "Zoom Out" (Ctrl+-), `window.zoomReset` "Actual Size" (Ctrl+0) |
| View › Toggle full screen | `perform("toggleFullScreen")` | none | command `window.toggleFullScreen` "Toggle Full Screen" (F11) |
| View › Reload, Developer tools (development builds only, `DesktopTitleBar.tsx:130-140`) | `perform("reload")`, `perform("toggleDevTools")`, both no-ops outside development (`window-actions.ts:68-76`) | none: development builds open DevTools once at load (`create-window.ts:153-158`) and cannot reopen them | development-only palette commands `window.reload` "Reload Window" and `window.toggleDevTools` "Toggle Developer Tools", with no shortcut |
| Help › Keyboard shortcuts | opens Settings › Keyboard | Settings (Ctrl+, at `default-keybindings.json:20`, or the footer Settings icon, S01-02), then Keyboard; the shortcut sheet `shortcuts.help` (Ctrl+Shift+?, `default-keybindings.json:21-25`) | palette command `settings.keyboard` "Keyboard Settings" |
| Help › About Mcode | opens Settings › About | Settings, then About | palette command `settings.about` "About Mcode" |
| Alt+F, Alt+E, Alt+V, Alt+H, and the menu button below 721px wide (`DesktopTitleBar.tsx:156-195,268-290`) | open the menus | not needed: the menus are gone | nothing; the keys become free |

Rules for the new commands:

- They register with the other commands in `App.tsx` (`App.tsx:650-858`), on desktop only (`window.desktopBridge` present). The palette lists every registered command with its shortcut (`RootView.tsx:63-78`), so each one is reachable by name.
- Zoom and full-screen keybindings apply on Windows and Linux only; on macOS the native menu roles stay their one owner. The bindings have no `inputFocused` guard, so zoom works while typing. The keybinding parser splits on `+` (`keybinding-manager.ts:31-41`), so Ctrl+Plus needs a `plus` key name that matches `event.key === "+"`.
- `settings.keyboard` and `settings.about` become registered commands. The macOS menu already sends those ids (`renderer-commands.ts:4-10`), so the special case in the desktop command listener (`App.tsx:870-879`) goes and every menu command runs through `executeCommand`.
- The window action allowlist keeps only what the commands use: `zoomIn`, `zoomOut`, `zoomReset`, `toggleFullScreen`, `reload` and `toggleDevTools`. `closeWindow`, `quit`, `undo`, `redo`, `cut`, `copy`, `paste` and `selectAll` lose their only caller and leave `window-actions.ts:6-39` and `desktop-bridge.d.ts:536-550`, which shrinks the IPC surface.
- Mouse-only Cut, Copy and Paste go away on Windows and Linux. Mcode has no right-click edit menu (`rg -n "context-menu" apps/desktop/src` finds none), and N1 adds none.

## Components

### New

- `apps/web/src/components/shell/SidebarHeader.tsx`: toggle, logo mark (22 in a 32 frame), wordmark (not on macOS), drag spacer, back, forward; macOS 68px lights slot that collapses in full screen.
- `apps/web/src/components/shell/CanvasHeader.tsx`: the 48 strip frame for the main surface: drag region, content slots (breadcrumb, top actions) owned by their sections, caption reserve.
- `apps/web/src/components/shell/caption-reserve.css`: `--caption-reserve: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))`; macOS `--traffic-lights-reserve: 68px` (0 in full screen). F-05 uses `--caption-reserve` for the panel's row 1.
- `apps/web/src/components/sidebar/SidebarResizeSeam.tsx` + `sidebarWidthStore.ts` (localStorage, clamp 220 to 340, default 304, double-click resets, arrow keys ±8, `role="separator"`).
- `apps/web/src/components/sidebar/SidebarFooter.tsx`: Settings, Pull requests (selected fill when that surface is active, F-03), Bell, update button.
- `apps/web/src/features/projects/ProjectDropWell.tsx`: empty well and drag-over state; desktop only accepts drops (`getPathForFile`), web copy reads "Use + to add a project."
- `apps/web/src/features/thread-attention/` : `threadAttentionStore.ts`, `thread-row-state.ts`, `thread-row-presentation.ts`, `thread-event-detector.ts`, `ThreadStatusLane.tsx`.
- `apps/web/src/components/sidebar/UpdateButton.tsx`, `ReleaseNotesCard.tsx`, `InstallUpdateDialog.tsx`; `apps/web/src/features/updates/release-notes.ts`.
- `apps/web/src/components/sidebar/ProvidersBell.tsx`, `ProvidersPopover.tsx`; `apps/web/src/stores/providerStatusStore.ts`.
- Server: `features/thread-control/attention/thread-attention-service.ts`, approval waiting source (reads `ApprovalService`); `features/providers/status/provider-status-service.ts`, `npm-release-feed.ts`, `cli-update-runner.ts`, `model-sightings-repo.ts`.
- Desktop: `features/desktop-window/notifications/thread-notifications.ts`; full-screen events forwarded on the window bridge (`onFullScreenChange`).

### Changed

- `create-window.ts`: `trafficLightPosition { x: 14, y: 18 }`; overlay `symbolColor` matches `--color-muted`; forward `enter-full-screen` / `leave-full-screen`.
- `App.tsx` `AppLayout`: drops the title bar row; sidebar and main each own their 48 header; `ConnectionBanner` moves under the canvas header (17 redesigns it). The command list gains the window, `settings.keyboard` and `settings.about` commands (F).
- `default-keybindings.json`: zoom and full-screen keys for Windows and Linux (F). `window-actions.ts` and its tests, and `desktop-bridge.d.ts`: the narrowed action allowlist (F).
- `Sidebar.tsx`: new zones, gap 16, padding 12, no border lines; width from `sidebarWidthStore`.
- `composer-layout.ts`: replaces `SIDEBAR_WIDTH_PX` with the live width.
- `ProjectTree.tsx` `ThreadRow`: three-line anatomy (Components `CYU-0` / `DFT-0`, values from `207O-2` node `2095-2`: min-height 64, padding 12/8/12/4, gap 8, radius 8, title 14/20 500 with fade, mono 12/16 branch line with a 52px trailing time and mode slot, 12/16 third line), trailing hover actions ✓ and ⋯; presentation from `deriveThreadRowState`.
- `ThreadSearchView.tsx`: renders `ThreadStatusLane` from the same state.
- `installation.ts`, `update-status.ts`, `ipc/handlers.ts`, `desktop-bridge.d.ts`, `preload.ts`: install-when-idle, notifications bridge, full-screen event.
- `thread-store.ts` / thread writer: `recordTurnOutcome`, `acknowledgeSeen` (replaces `thread-service.ts` `markViewed` and its route at `workspace-thread-rpc.ts:58, 106`).
- `workspaceStore.ts` (`setActiveThread`, `scheduleMarkThreadViewed`) and `threadStore.ts` (`synchronizeTerminalStatus`): stop calling `markThreadViewed`; the attention store acknowledges instead. Transport `markThreadViewed` (`ws-transport.ts:1183`, `transport/types.ts:498`, test mock `__tests__/mocks/transport.ts:229`) becomes `acknowledgeThreadSeen`.
- `ModelCacheService`: records sightings after a successful refresh.
- `NotificationsSection.tsx` hint: "Notify when a thread finishes, fails or needs you while Mcode is in the background." (S15 owns the page layout.)

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| `DesktopTitleBar` and its File, Edit, View and Help menus, including the narrow-window menu button | `apps/web/src/components/desktop/DesktopTitleBar.tsx`, `App.tsx:341-347` | `SidebarHeader`, `CanvasHeader`; each menu item's shortcut or palette command (F) | S01-01 | `rg -n "DesktopTitleBar\|desktop-title-bar\|Application menu" apps packages` empty |
| Alt mnemonics: `MENU_LABELS`, the `handleMnemonic` keydown listener, `aria-keyshortcuts` Alt+F/E/V/H | `DesktopTitleBar.tsx:156-165,180-195,255` | Nothing (N1); the keys become free | S01-01 | `rg -n "MENU_LABELS\|handleMnemonic\|mnemonic" apps/web/src` empty |
| Window actions left without a caller: `closeWindow`, `quit`, `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll`, their handlers and tests | `window-actions.ts:6-39,44-51`, `desktop-bridge.d.ts:536-544`, `actions/__tests__/window-actions.test.ts`, `actions/__tests__/handlers.test.ts`, `__tests__/desktop-window-feature.test.ts:154` | The OS caption close and Chromium's editing keys (F) | S01-01 | `rg -n '"closeWindow"\|"quit"\|"undo"\|"redo"\|"cut"\|"copy"\|"paste"\|"selectAll"' apps/desktop/src apps/web/src/transport` empty |
| Special case for `settings.keyboard` and `settings.about` in the desktop command listener | `App.tsx:870-879` | Registered `settings.keyboard` and `settings.about` commands (F) | S01-01 | `rg -n 'command === "settings.keyboard"' apps/web/src` empty |
| Title bar CSS | `index.css:11-12,70-86` (`--desktop-title-bar-height`, `--z-desktop-title-bar`, `.app-viewport-fixed`, `.app-panel-top-inset`) | `inset-0` / `top-1.5` at the 6 call sites | S01-01 | `rg -n "desktop-title-bar-height\|app-viewport-fixed\|app-panel-top-inset" apps/web/src` empty |
| Hard-coded caption padding | `DesktopTitleBar.tsx:205` | `--caption-reserve` | S01-01 | `rg -n "138px\|146px" apps/web/src` empty |
| `SidebarTitle` | `Sidebar.tsx:39-44` | `SidebarHeader` on every platform | S01-01 | `rg -n "SidebarTitle" apps/web/src` empty |
| Sidebar text nav and Settings text button | `Sidebar.tsx:53-56,61-64` | Go zone + footer icons | S01-02 | `bun run --cwd apps/web test -- src/components/sidebar/Sidebar.test.tsx` passes with a case asserting no text nav buttons (the palette keeps the "Search threads" label, so the text is not searched) |
| `SIDEBAR_WIDTH_PX` | `composer-layout.ts:9` | `sidebarWidthStore` | S01-02 | `rg -n "SIDEBAR_WIDTH_PX" apps/web/src` empty |
| "No projects yet" empty state | `ProjectTree.tsx:1136-1160` | `ProjectDropWell` | S01-02 | `rg -n "No projects yet" apps/web/src` empty |
| `ThreadStateMarker`, `getThreadStateMarker`, `ThreadStateMarkerModel` | `components/sidebar/ThreadStateMarker.tsx` | `deriveThreadRowState` + `ThreadStatusLane` | S01-04 | `rg -n "ThreadStateMarker" apps` empty |
| Leading lifecycle circle | `ProjectTree.tsx:1907-1964` | trailing ✓ hover action | S01-04 | `rg -n "ThreadLifecycleButton" apps/web/src` empty |
| Recovery store read in rows | `ProjectTree.tsx:1462-1464` | `lastTurn.outcome === "interrupted"` | S01-04 | `rg -n "hasRecoveryEntry" apps/web/src/features/projects` empty (store stays for ChatView; S08 decides its fate) |
| `status-pulse` in the project tree | `ThreadStateMarker.tsx:82-86`, PR checks pending dot `ProjectTree.tsx:2369`, project running dot `ProjectTree.tsx:2614-2617` | static ring; static PR mark per `DFT-0`; project roll-up per Q9 (N8) | S01-04 | `rg -n "status-pulse" apps/web/src/features/projects apps/web/src/components/sidebar` empty |
| Bottom-right toast container, level chips, `MAX_TOASTS = 5`, `.app-toast-stack` | `Toast.tsx`, `toastStore.ts:15`, `index.css:84-86`, mount at `App.tsx:41, 384` | F-07b toast lane | F-07b | `rg -n "app-toast-stack\|MAX_TOASTS = 5\|components/Toast\b" apps/web/src` empty |
| `thread.markViewed` and every caller: the server status-flip handler, its route, the transport method, the debounced open call and the unfocused end-of-turn call | `methods.ts:814-817`; `thread-service.ts:180-183`; `workspace-thread-rpc.ts:58, 106`; `ws-transport.ts:1183`; `transport/types.ts:498`; `__tests__/mocks/transport.ts:229`; `workspaceStore.ts:188-205, 1766`; `threadStore.ts:2473-2476` | `thread.acknowledgeSeen` from the attention store | S01-03 | `rg -n "markViewed\|markThreadViewed\|MARK_VIEWED" apps packages -g '!*.ndjson'` empty |
| `UpdateIndicator` | `components/sidebar/UpdateIndicator.tsx` | `UpdateButton` | S01-05 | `rg -n "UpdateIndicator" apps` empty |
| Session dismiss of update notice | `updateStore.ts` `bannerDismissed`, `dismissBanner` | none (the button is always present) | S01-05 | `rg -n "bannerDismissed\|dismissBanner" apps/web/src` empty |
| Update error toast | `App.tsx:614-620` | Failed state tooltip | S01-05 | `rg -n "friendlyUpdateError\|useToastStore" apps/web/src/app/App.tsx` empty |

## Proposed tickets

Order: S01-01 can start first. S01-03 starts once S06-01 lands, because its approval waiting source reads `ApprovalService`. The toast lane is F-07b's (S09-01 merged there); S09-02 adds thread events to it.

### S01-01 Window chrome without a title bar

- **Blocked by:** F-01b Token vocabulary rename; F-03 Button primitives.
- **Boards:** 01 · Empty workspace (`1ZDG-2`), 01 · Sidebar header · macOS (`2BO9-2`)
- **Delivers:** On desktop the separate title bar is gone. The sidebar header (toggle, logo, wordmark, back, forward) and the canvas header share one 48 strip; on Windows/Linux the native caption buttons sit at its right edge and nothing overlaps them at any display scale; on macOS the traffic lights sit at (14,18) inside the sidebar header and their slot collapses in full screen. Empty header space drags the window. On Windows and Linux there is no in-app File, Edit, View or Help menu and no Alt mnemonic; every former menu item still works by shortcut or command palette (N1), and macOS keeps its native menu.
- **Build notes:** web shell components, `create-window.ts` (position, symbol colour, full-screen events), preload + bridge (`onFullScreenChange`). Caption reserve via `env(titlebar-area-*)`; F-05 reuses `--caption-reserve` when the right panel owns the top-right. Collapsed sidebar: the canvas header gains the toggle and back/forward (and the macOS lights reserve). Move `ConnectionBanner` under the canvas header. Rewrite the 6 `.app-viewport-fixed` / `.app-panel-top-inset` users. Menu removal per Backend architecture F: register `window.zoomIn`, `window.zoomOut`, `window.zoomReset`, `window.toggleFullScreen`, the development-only `window.reload` and `window.toggleDevTools`, `settings.keyboard` and `settings.about`; add the zoom and full-screen keys for Windows and Linux (with the `plus` key name); route every desktop menu command through `executeCommand`; narrow the window action allowlist on both sides of the IPC boundary. Leave `application-menu.ts` unchanged.
- **Deletes:** DesktopTitleBar and its menus, Alt mnemonics, the window actions left without a caller, the `settings.*` special case in the desktop command listener, title bar CSS, hard-coded caption padding, `SidebarTitle`.
- **Acceptance criteria:**
  - [ ] No element with `data-testid="desktop-title-bar"` renders.
  - [ ] Windows at 100%, 125%, 150% scaling: caption buttons fully visible, top actions end left of them.
  - [ ] macOS: lights centred on the 48 row at x=14; entering full screen removes the 68px slot.
  - [ ] Dragging empty header space moves the window; every button still clicks.
  - [ ] Web build renders the same headers with no reserve.
  - [ ] On Windows and Linux no in-app menu renders at any window width, and Alt+F, Alt+E, Alt+V and Alt+H open nothing.
  - [ ] Each row of the table in F reaches its action by the listed other way in: Ctrl+= and Ctrl+Plus zoom in, Ctrl+- zooms out, Ctrl+0 resets, F11 toggles full screen, including while a text field has focus; "Keyboard Settings" and "About Mcode" in the palette open those Settings sections.
  - [ ] In a text field, Ctrl+Z, Ctrl+X, Ctrl+C, Ctrl+V and Ctrl+A work with no app menu.
  - [ ] "Reload Window" and "Toggle Developer Tools" appear in the palette only in a development build.
  - [ ] The IPC handler rejects `closeWindow`, `undo` and the other removed actions as invalid.
  - [ ] macOS: the native menu template is unchanged, and its Keyboard Shortcuts and About Mcode items still open those Settings sections.
- **Verify:** unit test for the reserve calc and full-screen attribute; `create-window.test.ts` (prior art) for options. `bun run --cwd apps/web test -- src/__tests__/keybinding-manager.test.ts src/__tests__/shortcuts.test.ts src/__tests__/App.test.tsx` (the `plus` key, the platform-scoped bindings, the new commands and the desktop command listener). `bun run --cwd apps/desktop test -- src/features/desktop-window/actions/__tests__/window-actions.test.ts src/features/desktop-window/actions/__tests__/handlers.test.ts src/features/desktop-window/menu/__tests__/application-menu.test.ts src/features/desktop-window/__tests__/desktop-window-feature.test.ts`. Live: Electron live-testing skill (`.agents/skills/electorn-live-testing/SKILL.md`); screenshot the 48 strip on Windows; drag the window by the spacer; on Windows press each shortcut in the F table and open each new palette command, and cut, copy and paste text in the composer.

### S01-02 Sidebar frame, resize, footer strip, empty workspace drop

- **Blocked by:** S01-01 Window chrome without a title bar; F-01b Token vocabulary rename; F-03 Button primitives.
- **Boards:** `1ZDG-2`, 01 · Sidebar · Drag over (`2BMJ-2`), footer strip of `2CF0-2` (rest state)
- **Delivers:** Sidebar opens at 304, drags between 220 and 340, remembers the width, resets on double-click. Search field and New thread icon at the top; Projects header with +; footer with Settings, Pull requests, Bell (inert until S09-04) and the update button slot. With no projects, a drop well says "No projects / Drop a folder here or use + to add one."; dragging a folder over it lights it and reads "Drop to add project"; dropping opens the add-project flow with that path.
- **Build notes:** `sidebarWidthStore` feeds `composer-layout.ts` (inline vs floating sidebar). Drop path: `desktopBridge.getPathForFile(file)` then `useCommandPaletteStore.getState().open({ intent: "addProject", path })` (S02 adds the `path` parameter and lands on 02d). Reject non-directories in the existing add-project validation, not in the renderer. Values from `1ZDG-2` nodes `1ZDI-2`, `1ZE9-2`, `1ZEJ-2`, `1ZEP-2`, `1ZFJ-2`; drag-over `2BNR-2`.
- **Deletes:** sidebar text nav and Settings button, `SIDEBAR_WIDTH_PX`, "No projects yet" empty state.
- **Acceptance criteria:**
  - [ ] Width clamps at 220 and 340; keyboard arrows on the focused seam resize; seam shows the 2px focus ring on hover and focus.
  - [ ] Width persists across reloads.
  - [ ] Dropping a folder on desktop reaches the add-project flow with the path; dropping a file does not.
  - [ ] Pull requests icon shows the selected fill while the PR surface is open.
- **Verify:** `bun run --cwd apps/web test -- src/components/sidebar/Sidebar.test.tsx src/features/projects/__tests__/ProjectTree.test.tsx` (prior art) for zones, the empty well, the drop handler and the width store. Live: drag the seam to both limits and reload to check the width persists. The runtime database snapshot holds other projects, and removing them would break the fixture-only rule, so the empty well and folder drop are proved by the component tests rather than live.

### S01-03 Thread attention facts on the server

- **Blocked by:** S06-01 Approval v2 contract, ApprovalService, fail-closed path.
- **Reconciled:** Owns the single seen marker and its one write: `thread.acknowledgeSeen({ threadId, throughSequence })`, where `throughSequence` is the settled message sequence the client has actually rendered. Returns `{ previous: { sequence, at }, current: { sequence, at } }` atomically; a repeat is a no-op; a sequence beyond the thread's settled history is rejected. Replaces `thread.markViewed` and every caller (including the unfocused call in the thread store) in this ticket. Waiting sources read ApprovalService (S06-01), never the old permission service. `recordTurnOutcome` is the one write path for turn endings; S08F-01 extends it. Opening a thread clears Finished and Failed, never a live pending approval.
- **Boards:** 06f (`200I-2`), 08d (`207O-2`), 08f (`2C3A-2`)
- **Delivers:** After a reload, background threads that wait for approval, finished or failed while unseen, or were interrupted are known without opening them. Stop and Interrupted are distinguishable. The thread has one seen marker: viewing a thread in a focused window acknowledges exactly what the client has rendered, and every client clears together. Opening a thread clears Finished, Failed and Interrupted, but never a live pending approval. Review can ask for the changes made after a given settled sequence, which Since you looked (S08-08) uses. This ticket absorbs S08-07.
- **Build notes:**
  - Contract and wire (A): `ThreadAttention` with `lastTurn.sequence` and `seen { sequence, at }`; `thread.listAttention`; `thread.acknowledgeSeen({ threadId, throughSequence })` returning `{ previous, current }`; broadcast `thread.attention`.
  - Migration: `seen_through_sequence`, `seen_at` and the three `last_turn_*` columns, backfilling the marker to each thread's newest settled sequence.
  - Server: `recordTurnOutcome` at every terminal-status site. `ThreadAttentionService` with the `ThreadWaitingSource` seam for S07 and the `approval` source, which reads `ApprovalService.listPending()` (S06-01) and counts each request on its owner thread. `acknowledgeSeen` runs validate, compare and write in one database-writer transaction and keeps today's `completed → paused` flip inside it.
  - Replace `thread.markViewed` and every caller in this ticket (ledger row): the contract method, `thread-service.ts:180-183`, the route at `workspace-thread-rpc.ts:58, 106`, the transport method and mock, the debounced call in `setActiveThread`, and the unfocused end-of-turn call in `synchronizeTerminalStatus` (`threadStore.ts:2473-2476`). The web `threadAttentionStore` is hydrated with `agent.listRunning` at boot and reconnect, and owns the on-screen acknowledgement rule (B) with a 150ms dwell constant named for the new rule (not `MARK_VIEWED_*`).
- **Deletes:** the `thread.markViewed` ledger row. The cancelled→interrupted loss is fixed for row purposes; `thread.status` semantics are unchanged.
- **Acceptance criteria:**
  - [ ] Stop a turn: `last_turn_outcome = "cancelled"`; kill the server mid-turn and restart: `"interrupted"`. `last_turn_sequence` equals the settled message's sequence.
  - [ ] A background approval appears in `thread.listAttention` after a client reload.
  - [ ] Owner thread: a supervised `thread_send` from thread A to thread B lists A as waiting with kind `approval`, and B is not waiting.
  - [ ] `acknowledgeSeen` with a sequence above the stored one advances the marker, returns the old and new `{ sequence, at }`, and pushes once.
  - [ ] A repeat, or any sequence at or below the stored one, is a no-op: no write, no push, `previous` equals `current`.
  - [ ] A sequence beyond the thread's newest settled sequence is rejected with `sequence_ahead` and the marker is unchanged.
  - [ ] Two concurrent acknowledgements with different sequences leave the higher one stored, and each response is internally consistent.
  - [ ] Opening a thread with three unseen settled turns returns the sequence before them as `previous`.
  - [ ] A turn that ends while its window is unfocused does not move the marker until the window regains focus.
  - [ ] Opening a thread with a pending approval acknowledges its outcome but leaves `waiting` set.
  - [ ] Existing threads after migration have the marker set and appear nowhere in the list.
- **Verify:** `bun run --cwd apps/server test -- src/features/thread-control/attention/__tests__/thread-attention-service.integration.test.ts src/features/thread-control/lifecycle/__tests__/thread-service.test.ts src/features/projects/diffs/transport/__tests__/snapshot-rpc.test.ts src/features/agents/events/__tests__/provider-event-publication.test.ts` (the first is new, against a real SQLite file; prior art `src/features/thread-control/persistence/__tests__/thread-writer.integration.test.ts`). Web: `bun run --cwd apps/web test -- src/features/thread-attention/__tests__/thread-attention-store.test.ts` for the dwell, focus and baseline hand-off. Live: start two threads in `.dev/fixture-repo`, reload the web client while one awaits approval, and check the response of `thread.listAttention`; then focus another app while a turn ends and confirm the marker does not move until Mcode regains focus.

### S01-04 Thread row state model and the three-line row

- **Blocked by:** S01-02 Sidebar frame, resize, footer strip, empty workspace drop; S01-03 Thread attention facts on the server; F-02 Fade truncation primitive; F-06 Provider icon and disc stack; F-10 Status marks, spinner, badges and notices.
- **Boards:** 08d (`207O-2`), 08f sidebar rows (`2C3A-2`), 05a (`213P-2`), 06a (`27P2-2`), 06f (`200I-2`), Components `CYU-0`, `DFT-0`
- **Delivers:** Every row shows its state: running rows fade with a spinner; Approval required / Answers required / Plan ready / Interrupted rows get the amber ring and label at full brightness; unseen finished turns show the green dot and "Finished"; failures the clay dot and "Failed"; a stopped turn shows nothing; outcomes clear when the thread is opened in a focused window. Palette thread search shows the same lane marker.
- **Build notes:** `deriveThreadRowState` + presentation table (B); `onScreen` and the automatic acknowledgement come from S01-03's attention store; row anatomy per Changed › ProjectTree; trailing hover actions per `CYU-0`; `Answers required` and `Plan ready` light up when S07 registers its sources (until then they are unreachable, not stubbed).
- **Deletes:** ThreadStateMarker and its types, leading lifecycle circle, recovery store read in rows, row `status-pulse`.
- **Acceptance criteria:**
  - [ ] Table-driven test covers every precedence pair in B, including approval while running, plan ready over finished, cancelled → quiet, on-screen → quiet.
  - [ ] Opening a Finished thread clears the row on a second connected client.
  - [ ] Opening a thread whose approval is pending keeps "Approval required".
  - [ ] A supervised `thread_send` from thread A to thread B marks A's row "Approval required" and leaves B's row unchanged, matching the dock on A (S06-04).
  - [ ] No visible "Errored" string remains in the sidebar or palette.
  - [ ] Titles fade at 24px, never ellipsis.
- **Verify:** `bun run --cwd apps/web test -- src/features/thread-attention/__tests__/thread-row-state.test.ts src/features/projects/__tests__/ProjectTree.test.tsx`. Live: in `.dev/fixture-repo` run a turn in thread A, switch to thread B before it ends, check A's row reads Finished, open A, check it clears.

### S01-05 Update button: ten states, install when idle, release notes

- **Blocked by:** S01-02 Sidebar frame, resize, footer strip, empty workspace drop; F-03 Button primitives; F-07a Overlay surfaces and side placement.
- **Boards:** `2CF0-2`, 09e (`2DRR-2`)
- **Delivers:** The footer always shows the update control: check, checking, "Up to date" for 3s after a manual check, Download, progress, Install, Retry update, nightly labels. Installing with agents running asks first; "When they finish" installs once no agent runs, and the user can cancel that. Hovering Download or Install for 300ms shows "What's new" with up to five items and a link.
- **Build notes:** (D). Count from `agent.activeCount` at click; arming lives in desktop main; `downloaded.installWhenIdle` drives the armed look (Q3, default stands): the button reads "Installs when idle", and clicking it opens a menu (F-04) with "Cancel scheduled install" (proposed copy, no board). Release notes parser in plain text.
- **Deletes:** UpdateIndicator, `bannerDismissed` / `dismissBanner`, update error toast.
- **Acceptance criteria:**
  - [ ] Each of the ten states renders from a fixture status.
  - [ ] Background checks never show "Up to date".
  - [ ] With one running agent, Install opens the dialog with "1 agent is running…"; "When they finish" installs within 10s of the agent ending.
  - [ ] Release notes containing `<script>` or markdown links render as inert text.
- **Verify:** `lifecycle/__tests__/installation.test.ts` (prior art) with fake timers for install-when-idle; `release-notes.test.ts` for HTML and markdown inputs; web test for the state map. Live: set the dev update feed (`apps/desktop/dev-app-update.yml`), turn off Auto-download in Settings › About, walk 4 → 5 → 6 → 7.

### S09-01 One notification lane (merged)

- **Blocked by:** Not a ticket. Merged into F-07b (same toast lane; app toasts move into it there).
- Everything this ticket held (the lane store and mount, moving app toasts in, the cap, hover pause, swipe and reduced motion) is specified in F-07b in `00-foundation.md`. This section adds only the thread-event producer (S09-02) and OS notifications (S09-03).

### S09-02 Thread-event toasts

- **Blocked by:** S01-04 Thread row state model and the three-line row; F-07b Toast lane.
- **Boards:** 09a (`25IT-2`), 09b (`2DN0-2`), 09f (`2DSS-2`)
- **Delivers:** When a thread that is not on screen finishes, fails, or starts needing the user (approval, answers, plan), a toast says so with title and `Label · HH:MM`; click opens the thread; Finished hides after 8s; the others stay until opened, closed, or resolved.
- **Build notes:** `thread-event-detector.ts` (C) produces F-07b toasts with `kind` from the row state, `dedupeKey` = thread id (one entry per thread) and `onOpen` selecting the thread. Entries are dismissed by key when their thread comes on screen or the state no longer matches; hydration never toasts. An approval's toast belongs to the owner thread, the same thread whose row and dock show it.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] No toast for the thread on screen; a toast when the same thread finishes while the window is focused on another thread.
  - [ ] Answering an approval from the sidebar removes its toast.
  - [ ] Reconnecting does not replay toasts.
- **Verify:** detector unit tests with scripted attention snapshots and pushes. Live: two threads in `.dev/fixture-repo`, watch thread B while A finishes; click the toast and confirm A opens and the row clears.

### S09-03 OS notification while Mcode is in the background

- **Blocked by:** S09-02 Thread-event toasts.
- **Boards:** 08d (`207O-2`)
- **Delivers:** With notifications on and Mcode unfocused, a finished, failed, or needs-you thread raises an OS notification; clicking it brings Mcode forward on that thread. Turning the setting off stops them.
- **Build notes:** bridge `notifications` (C); main-process validation and click routing; reads `settings.notifications.enabled`; the notification set is Finished, Failed and the needs-you labels that toast (Q5, default stands). Optional, not part of that decision: gate the updater's "update ready" notification on the same setting.
- **Deletes:** none (wires the dead setting).
- **Acceptance criteria:**
  - [ ] Unfocused + enabled → notification; focused → toast only; disabled → neither OS notification.
  - [ ] Click focuses or restores the window and selects the thread.
  - [ ] Body omits the file count when unknown.
- **Verify:** desktop test beside `server-runtime/recovery/__tests__/notifications.test.ts` (prior art) with a fake Notification factory. Live: start a turn, focus another app, wait for the Windows toast, click it.

### S09-04 Provider status contract and the bell

- **Blocked by:** S01-02 Sidebar frame, resize, footer strip, empty workspace drop; F-06 Provider icon and disc stack; F-07a Overlay surfaces and side placement.
- **Boards:** 09c (`25RF-2`), 09d (`2DPF-2`), footer state 9 (`2CF0-2`)
- **Delivers:** The bell opens a Providers popover that lists only providers that need something: signed out with Sign in, and rate limited with its reset time. A provider with nothing to report has no row and no usage is shown (N2). With no rows, the popover shows its header only, the bell has no dot, and its tooltip is just its name. The dot shows while any row exists. Signing in clears the row. The 08f "Sign in" end notice calls the same action.
- **Build notes:** contract and service (E) with `auth` and `rateLimit`, and no `usage` field; the bell never calls `provider.getUsage`. Per-adapter `describeStatus` for the auth column of the table. The rate-limit store keeps the latest active `RateLimited` per provider in memory (E). `providers.signIn` opens a Terminal tab in the right panel scoped to the project and no thread, or an external terminal with no project open (N6). Popover values from `25ZO-2` (380 wide, radius 18, padding 6, header 36, rows padding 8/6/8/10, action pill 28 radius full); the rate-limited row reuses that row with no action pill.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] With no Devin credentials in its environment, Devin's row shows "Signed out" with Sign in; once credentials are present and status refreshes, the row clears.
  - [ ] With every provider signed in, not rate limited and up to date, the popover shows only its header, the bell has no dot, and hovering the bell shows only its name.
  - [ ] No popover row shows usage, and opening the bell makes no `provider.getUsage` request (spy test).
  - [ ] A Claude `RateLimited { active: true }` with `retryAfterMs` shows "5-hour limit reached · resets 16:00" and the dot; `active: false`, or the reset time passing, removes the row. Without `retryAfterMs` the row reads "Rate limited" with no time.
  - [ ] A status refresh failure for one provider leaves the others intact.
- **Verify:** service tests with fake adapters next to `provider-availability-service.test.ts`, including a Devin adapter fed an empty environment and then a placeholder key, and a scripted `RateLimited` sequence for the rate-limit store; web popover test for the empty state, the tooltip and the no-usage spy. Live, in an isolated provider home only:
  1. Stop the runtime with `agent:down`. From a shell where `HOME`, `USERPROFILE`, `APPDATA` and `XDG_DATA_HOME` point at an empty directory under `.dev/verification/provider-home/`, and where `WINDSURF_API_KEY` and `DEVIN_API_KEY` are unset, run `agent:up`. `agent:up` passes the shell environment to the server (`scripts/agent/agent-up.mjs:237-238`) and still pins Mcode's own data to `.dev/` (`scripts/agent/runtime-contract.mjs:74-75`), so only provider lookups move.
  2. Devin now finds no credentials (`packages/providers/src/private/devin/devin-credentials.ts:20-53`). Open the bell and confirm its Signed out row with Sign in. Other providers may also read Signed out in this home; that is expected.
  3. Write a placeholder `devin/credentials.toml` with a dummy `windsurf_api_key` (`devin-credentials.ts:63`) into the scratch home, never a real key. Restart the runtime from the same shell and confirm the row clears.
  4. `agent:down`, delete the scratch home, and start the runtime from a normal shell. Never run `devin auth logout`, touch the real credential files, or change global configuration.

### S09-05 Provider CLI updates

- **Blocked by:** S09-04 Provider status contract and the bell.
- **Boards:** 09c (`25RF-2`), 09d Working (`2DPF-2`)
- **Delivers:** When a newer CLI exists for a provider Mcode can update, the row reads "CLI 0.48.0 available · you have 0.41.2" with Update; Update shows progress in place, success removes the row, failure says why and offers Retry.
- **Build notes:** shared version policy (ADR 0001 consequence), npm feed, update runner (E); per-provider decisions from the table. The runner decides npm ownership by comparing the resolved CLI path with `npm prefix -g` evaluated in the server's own environment, and runs `npm install -g <package>@<target>` in that same environment. A scratch prefix set for the server process is therefore honored by construction, and the runner never reaches outside the prefix it detected. The registry is read at most once a day per provider (N10). Add `settings.updates.providerCliChecks` (boolean, default true) beside `autoDownload`, with a switch in Settings › About next to Auto-download (`AboutSection.tsx:47`), label "Provider CLI checks", hint "Ask the npm registry once a day for newer provider CLIs." (proposed copy). Off means no registry request and no update rows.
- **Deletes:** Codex-private `meetsMinVersion` export moves (`packages/providers/src/availability.ts` re-exports the shared one).
- **Acceptance criteria:**
  - [ ] Claude with the bundled CLI never shows an update row.
  - [ ] Registry timeout → no row, no error surfaced.
  - [ ] Two refreshes within 24 hours make one registry request per provider; with Provider CLI checks off, none, and no update row shows.
  - [ ] A failing update shows a reason of at most 240 chars and Retry.
  - [ ] A CLI whose resolved path is outside the detected npm prefix shows no Update action.
- **Verify:** unit tests for `isNewer` (including prerelease) and the runner with a fake process host, including a CLI outside the detected prefix. Live, with a scratch CLI prefix only:
  1. Install an older Codex into a scratch npm prefix under `.dev/verification/npm-prefix/` (`npm install -g --prefix <scratch> @openai/codex@<older>`). Never install into or update the global prefix.
  2. `agent:down`, then run `agent:up` from a shell with `NPM_CONFIG_PREFIX=<scratch>`, so `npm prefix -g` resolves to the scratch prefix for the server. In Settings, point Codex's CLI path (`provider.cli.codex`, read at `provider-availability-service.ts:81`) at the scratch binary. The runtime's settings file lives in `.dev/` (`settings-service.ts:215` under `MCODE_DATA_DIR`), so nothing global changes.
  3. Open the bell, run Update, and confirm the scratch binary reports the target version while the global `codex --version` is unchanged.
  4. `agent:down`, delete the scratch prefix, clear the CLI path setting, and start the runtime from a normal shell.

### S09-06 New-model announcements

- **Blocked by:** S09-04 Provider status contract and the bell.
- **Boards:** 09c (`25RF-2`), 09d (`2DPF-2`)
- **Delivers:** After a provider gains a model, its row reads "<Model> is new in the model menu" with Try; Try starts the next thread on that model and the row leaves. Upgrading Mcode does not announce every existing model.
- **Build notes:** `provider_model_sightings` table and baseline rule (E); hook after successful `ModelCacheService` refresh; OpenCode excluded.
- **Deletes:** none.
- **Acceptance criteria:**
  - [ ] First run seeds every current model as acknowledged.
  - [ ] Adding a model id to the Claude static catalog yields one announcement; Try acknowledges it.
- **Verify:** integration test with `model-cache-integration.test.ts` (prior art). Live: add a fake model to a dev catalog, open the bell.

## Tests

- Highest seams: `deriveThreadRowState` (pure, table-driven); `ThreadAttentionService` against a real SQLite file (integration, prior art `thread-writer.integration.test.ts`), covering `acknowledgeSeen` advance, no-op repeat, `sequence_ahead` rejection, concurrent advances and the owner-thread approval source; desktop `installation.test.ts` with fake timers; detector tests fed by scripted pushes; `provider-event-publication.test.ts` for outcome recording.
- Web tests: `ProjectTree.test.tsx`, `Sidebar.test.tsx`, and the attention store's dwell, focus and baseline hand-off. Lane store and swipe tests belong to F-07b.
- Fixtures: only `.dev/fixture-repo` for live runs (AGENTS.md "Test data"). Provider status checks use an isolated provider home and CLI updates a scratch npm prefix (S09-04, S09-05); never sign out, install globally or edit global configuration. Report a provider that is not available locally as pending, not passed.
- Live surfaces: Electron (Windows caption overlay, drag regions, OS notification click) via `.agents/skills/electorn-live-testing/SKILL.md`; web for lane placement with the overview open and closed.

## Risks and open questions

1. **App menu on Windows/Linux.** Decided (user, 2026-10-08, N1): remove File, Edit, View, Help and the Alt mnemonics entirely, with no replacement menu; every item keeps a shortcut or palette command (Backend architecture F); macOS keeps its native menu. Consequence: Cut, Copy and Paste become keyboard-only on Windows and Linux, because there is no right-click edit menu.
2. **Bell with nothing to report.** Decided (user, 2026-10-08, N2): no dot, nothing on hover, no usage rows, no quiet ready rows. The popover lists only providers that need something; with none it shows its header only.
3. **Armed install look.** Decided (user, 2026-10-08, default stands): the button reads "Installs when idle" and its menu holds "Cancel scheduled install". Not drawn; the copy is proposed.
4. **App toast lifetimes and marks.** Decided (user, 2026-10-08, default stands): info hides after 8s, paused on hover; errors stay until closed. F-07b builds it (its rule already says failed persists).
5. **Notification set.** Decided (user, 2026-10-08, default stands): Finished, Failed and needs-you all notify the OS while Mcode is unfocused. Gating the updater's "update ready" notification on `notifications.enabled` stays optional in S09-03.
6. **Where Sign in runs.** Decided (user, 2026-10-08, N6): a Terminal tab in the right panel scoped to no thread, so the user can sign in calmly. With no project open there is no right panel, so it opens an external terminal (ADR 0006).
7. **Claude sign-in with the bundled CLI (check).** The login command for the SDK-bundled CLI is unverified; confirm the SDK exposes a runnable entry, else fall back to "Sign in with `claude` in a terminal" when a system CLI exists.
8. **Rate limits in the bell.** Decided (user, 2026-10-08, N7 with N2): on the provider's own row with the reset time, as a row type of its own, because quiet rows no longer exist.
9. **Collapsed project row roll-up.** Decided (user, 2026-10-08, default stands): a collapsed project row shows the highest-priority mark among its threads, ranked as in B (needs-you ring, then a neutral running spinner, then the failed and finished dots). Today a pulsing amber dot marks a project with running threads (`ProjectTree.tsx:2614-2617`); Components `DUA-0` shows "2 running" with an amber spinner (superseded colour).
10. **Setup failed label (S04 author / user).** Proposed "Setup failed" as a needs-you label; S04 and S12 own setup's future.
11. **"Start a chat" without a project.** Decided (user, 2026-10-08, N9): out of this program; the empty workspace asks for a project first, and S01 renders no "start a chat" link. A standalone epic, "Start a chat without a project (needs scoping)", holds it. `threads.workspace_id` is required (`schema.ts:83-85`), so a projectless thread is new backend work.
12. **Plan ready forever (S07).** Until S07 marks plan versions accepted or superseded, a `plan` waiting source would keep every planned thread amber. S07 must ship status wiring with its source.
13. **Docs (implementer).** CONTEXT.md "Turn outcome" says canonical persistence lacks `Cancelled`, but `canonical-agent-store.ts:856` queries it; check and fix the note. Add glossary terms "Thread attention" and "Needs you" once S01-03 lands, and define the seen marker as an acknowledged settled sequence. F-07b updates the `docs/internals/renderer/ui-components.md` toast rows for the lane.
14. **Electron `env(titlebar-area-*)` on Linux (check).** Works with `titleBarOverlay` on Windows; confirm on Linux before removing the fallback (inferred).
15. **npm registry calls.** Decided (user, 2026-10-08, N10): once a day per provider is acceptable and can change later. Settings › About gets a "Provider CLI checks" switch that turns the checks off (S09-05).
