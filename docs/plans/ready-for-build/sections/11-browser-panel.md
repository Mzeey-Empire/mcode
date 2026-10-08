# 11 · Browser panel: build brief

The Browser tab gets the same two-row header as Review: row 1 holds the pages as horizontal tabs beside the window buttons, and row 2 holds navigation, the URL, Design, Screenshot and More. Nothing floats over the page. A new page lists the project's dev servers as tiles with the last view and the project's recent pages. Design notes go straight into the composer as one tile, so they ride the next message like Review comments and survive a reload. When the agent drives the page, the user sees which tab it is in, can take control, and keeps control until they press Hand back. Each project gets its own cookie jar. Errors read in plain words.

Surfaces: web (`apps/web` Browser panel, rail, composer, transcript, thread overview), desktop main (`apps/desktop/src/features/preview`: session partitions, kernel, history store), server (`apps/server` browser-automation broker and MCP gateway, message send path), contracts (`browser-automation.ts`, `browser-preview.ts`, `preview-page-status.ts`). Notes persist in the composer draft that S10-11 owns, and project servers come from S12T-08's action-run ports. Provider adapters do not change.

## Boards

All on page "05 · Ready for build" (`p-6-0`): https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0

| Board | Node | Shows |
|---|---|---|
| 11a · Browser · Page open · Two rows · Dark | `22JT-2` | Full window: Browser panel open beside a thread, two-row header, page in an 8px inset, rail with one Browser entry |
| 11b · Browser · States · Dark | `2EPF-2` | New page (server tiles, recent pages), design mode (tip, bubble, marker), agent in control, you took control, server not running |
| 11c · Browser · Nothing over the page · Dark | `2F1L-2` | URL hover with Open in browser, More menu open, agent acting (agent pill, amber URL ring), tabs hover and many tabs |
| 11d · Browser · Design mode and annotation · Dark | `24CB-2` | Full window: Design on, note bubble, composer tile "Billing · 1 note" with its hover card |
| 11e · Browser · Thread overview row · Dark | `2FBY-2` | Overview Browser row: open, several pages, agent acting, you took control, server not running |
| 11f · Browser · Multiple annotations · Dark | `2FDV-2` | A (rejected) vs B (chosen) stacked tile, hover card grouped by page, sent message compact tile and its read-only hover card |
| 11g · Browser · Device toolbar · Dark | `2FMT-2` | Device row as a third row, device menu, responsive drag handles |

Paper is the source of truth for values. Measured values (read with `get_computed_styles` / `get_jsx`):

- Row 1: 48 tall, padding-left 8, padding-right 98 (caption overlay), gap 8. Tab: 32 tall, padding 10/12, gap 8, `--radius-control`, title 14/20 weight 500; active tab `--color-selected` fill and ink title; inactive title `--color-muted`, favicon 14px radius 4 at opacity 0.6. Tabs gap 4. Hovered inactive tab: `--color-hover` fill, ink title, 14px close icon (stroke 2) in the favicon slot. Many tabs: inactive tabs fixed 96 wide with a 24px title fade; the strip clips with a 24px right-edge mask and scrolls; + stays pinned. +, expand and toggle are 32 round with `--color-selected` fill at rest (F-03 top-level variant).
- Row 2: 40 tall, padding 0/8, gap 8. Navigation pill: `--color-selected`, radius 999, padding 2, gap 2, three 28px round buttons with 14px icons (stroke 1.6); a disabled button sits at opacity 0.4. URL pill: grows, 32 tall, `--radius-18`, `--color-selected`, padding 14/12, text 13/20, origin `--color-muted` and path `--color-ink`, 24px fade. URL hover: fill `--color-border`, padding 8/3, a 26px round Open in browser icon at the right end. Design, Screenshot, More: 32 round, `--color-selected`, 16px icons. Design on: `--color-primary` fill.
- Page inset: padding 0/8/8, page radius 10.
- New page URL pill: `inset 0 0 0 1px var(--color-focus)`, placeholder "Search or enter URL" in `--color-muted`; row 2 shows only the URL pill and More.
- Agent acting: URL pill gets `inset 0 0 0 1px var(--color-primary)`; page gets `inset 0 0 0 2px var(--color-primary), inset 0 0 28px #E8A03C59`; agent tab shows a 14px filled `--color-primary` pointer instead of the favicon. Agent pill and Hand back pill: 32 tall, radius 999, `--color-selected`, padding-left 12 / right 3, gap 8, provider icon, then an inner 26-tall button (padding 0/10, radius full, `--color-border` fill, 13/18 weight 500 ink) reading "Take control" or "Hand back".
- Design picker: hovered element `0 0 0 2px #FFFFFF, 0 0 0 4px var(--color-primary)`; tip 24 tall, `--radius-6`, `--color-primary` fill, mono 11/14 weight 500, text `#14110D`, content `tag · label`. Saved element `0 0 0 2px #E8A03C8C`. Marker 20 round `--color-primary`, 11/14 weight 700 `#14110D`, shadow `0 2px 6px #00000040`. Note bubble 290 wide, `--color-panel`, `--radius-14`, padding 10, gap 8, shadow `0 8px 24px #00000059`, text 13/20 ink, footer "Enter to save" and a 28 round `--color-ink` send button.
- More menu: 232 wide, padding 6, `--radius-14`, `--color-panel`, 1px `--color-border`, shadow `0 16px 40px #00000080`. Zoom row 36 tall ("Zoom", 28 round minus, "100%" mono 12 in a 44 slot, 28 round plus). Items 36 tall, padding 0/10, `--radius-8`, label 14 ink, shortcut 12 muted. Dividers 1px `--color-border` with 4/6 padding.
- New page: page padding 28/16, gap 28. Tiles gap 12; tile padding 6, `--radius-14`, hover `--color-hover`; last view 96 tall, `--radius-10`; stopped tile is a 1px dashed `--color-border` frame with a 28-tall "Start" pill (`--color-selected`, radius 999). Label: 7px dot (`--color-success` running, 1.5px `--color-muted` ring stopped), name 13/18 weight 600 ink, port mono 11/16 muted. Recent row 36 tall, padding 0/10, gap 10, `--radius-10`, favicon 16 radius 4, title 13/18 weight 500 ink, "server path" 13/18 muted with fade, time 12/16 muted ("2m", "14m", "1h", "Yesterday").
- Error page: block 320 wide, gap 16, centred; headline 16/22 weight 600 ink; detail 13/20 muted; primary button 32 tall radius full `--color-ink` fill; secondary `--color-selected`.
- Device row: 40 tall, padding 0/8, gap 8. Device picker 32 tall, padding 0/10, `--radius-control`, `--color-selected`, 14px icon muted, name 13/18 weight 500 ink, 12px chevron. Size fields 52×28, `--radius-8`, `--color-selected`, mono 12 ink, "×" 12 muted, gap 6; field being dragged gets `inset 0 0 0 1px var(--color-primary)`. Rotate and close 32 round. Scale pill 32 tall, radius full, padding 12/10, gap 6, "Fit" 13/18 weight 500 plus "57%" mono 12 muted. Stage `--color-page`, radius 10, padding 12, page centred.
- Composer tile: existing attachment tile anatomy (184×140 focus frame, 176×132 body); stack edges only from two pages up: `6px -6px 0 var(--color-background), 6px -6px 0 1px var(--color-control-border), 12px -12px 0 var(--color-background), 12px -12px 0 1px var(--color-border)`. Hover card: 340 wide (320 on 11d), padding 6, `--radius-14`, `--color-panel`, 1px `--color-border`, shadow `0 16px 40px #00000080`; page header 28 tall; note row padding 6/10, gap 10, 18px marker (10/12 weight 700), label mono 11/16 muted, note 13/20 ink; hovered row `--color-hover` plus a 24 round remove.
- Sent compact tile: `--color-panel`, 1px `--color-border`, `--radius-10`, padding 10/14/10/10, gap 12; 64×44 thumbnail radius 6 with 4px and 8px offset stack edges; "4 notes" 13/18 ink after a 12px outlined `--color-primary` pointer; page names 12 muted.
- Overview row: rows 32 tall, gap 8, 16px icon; step 14 ink; page title 13/20 muted; "+2" muted at the right; "Hand back" and "Start web" are 13/20 weight 600 ink text buttons; server-down dot 8px `--color-error`.

## Locked decisions

From `source/screen-pass-todo.md` (section 11 approved by the user 2026-10-07, all boards two rows) and the "Browser (11)" section of `source/implementation-notes.md`.

- Two rows, nothing over the page (11c, approved 2026-10-07). Row 1: browser tabs (favicon and title, no chevron), round +, drag spacer, round expand and toggle. Row 2: back/forward/reload in one pill (same shape as Review's unified/split pill), URL pill, round Design, Screenshot, More. Hovering the URL pill lifts its fill and shows Open in browser. Rejected: a 48 lane under the page, a pill that shrinks to a dot, a pill that dodges the pointer.
- Superseded by 11c, do not build: the floating URL pill in one 48 row (old 11a), Design and Screenshot floating bottom-right, the floating tools pill with "N notes ⌄" and Send, the floating agent pill with the step text, and the "More menu (default)" list.
- Tabs (2026-10-07): hover swaps the favicon for a 14px close icon so the tab never changes width; an inactive tab also gets the hover fill. Many tabs: active keeps its full title, inactive shrink to 96 with a fade, the strip scrolls with a 24px right fade, + stays pinned. The agent's tab shows the amber pointer instead of the favicon.
- Pages are row-1 tabs, not rail entries. The rail keeps one Browser entry (F-05 rule from 12e, 2026-10-07: vertical tabs are rail entries, horizontal tabs are row-1 tabs inside a panel).
- More menu (11c): names only, dividers, muted shortcuts. Zoom stepper on top; then Device toolbar (Ctrl Shift M), Developer tools (F12), Force reload (Ctrl Shift R); then Clear cookies, Clear cache, acting on this project's session. New page lives on +. Region capture becomes Screenshot drag. Take control lives in the agent pill. Dump page content is removed.
- Screenshot: click captures the viewport, drag captures a region.
- Device toolbar (11g): a third 40 row under the URL, toggled from More and closed with its round ×. Device menu: Responsive, divider, iPhone 15 Pro, Pixel 8, iPad Air, Surface Pro 7, divider, Laptop, Desktop; sizes muted mono on the right, check on the current one. Responsive: right and bottom drag handles (4×32 pills); the dragged handle and page edge turn amber and the matching size field follows live.
- New page (11b): project servers as tiles showing the last page you saw there (running: thumbnail, green dot, name, port; stopped: dashed tile with Start, which runs the action), then recent pages for this project (favicon, title, server and path, relative time).
- Bare `localhost:port` and IPs open over http.
- Design mode (11b, 11d): Design turns amber; the rest of row 2 stays (no notes count or Send in the Browser, user 2026-10-07). Hover shows the amber box with a mono tip `tag · label`; click opens the note bubble under the element (Enter saves, mod+Enter saves and sends, Esc closes). Saved notes keep a dim amber outline and a numbered marker on the live page. No "Designing" header bar.
- Notes go straight into the composer (11d) as one attachment tile per page; with notes on two or more pages, one stacked tile (11f option B, chosen by the user 2026-10-07; A rejected). Stack: "4 notes · 2 pages", front card is the last annotated page, two offset edges behind. One page stays a plain tile ("Billing · 1 note"). Hover opens a card grouped by page with numbers matching each snapshot's markers and remove on row hover. Clicking a note shows it in the Browser. Removing the tile drops every note. The agent still receives one snapshot per page.
- Sent message (11f): the stack rides above the bubble as a compact tile (64×44 stacked thumbnail, amber pointer, "4 notes", page names muted), replacing today's chip and "Annotation N screenshot.png" files. Hover opens the same grouped list, read-only; clicking a note opens that page's snapshot with markers in the image viewer.
- Notes persist as drafts like Review comments (today memory only).
- Agent in control (11b, 11c): edge glow and amber pointer on the page; Design and Screenshot give way to the agent pill (provider icon, Take control); the URL pill gets a 1px amber ring. Shown only while the agent acts, so Take control is never offered for an idle agent.
- You took control (11b): clicking the page or Take control stops the agent; row 2 shows "Hand back". The agent does not reclaim the page until Hand back. Sending a message to the thread does not hand control back; only Hand back does (user, 2026-10-08, W1).
- Errors: plain copy, not the Chromium error name. Connection refused on a project port: "Can't reach localhost:5173", "Nothing is listening on this port. web in mcode usually runs here.", Start web and Retry. Still undrawn: 404/500, crash, certificate, discarded page (proposals below).
- Certificate errors (user, 2026-10-08, W5): a browser-style warning page with the error, details, Back to safety and "Proceed to {host} (unsafe)". Proceeding trusts that host and certificate fingerprint in the project's partition until Mcode quits. The agent never proceeds on its own; it sees the error. The address bar shows a "Not secure" mark while the exception is in use.
- Thread overview (11e): one Browser row in Activity, only while the thread has pages. States: open (globe, title, host), several pages (+N), agent acting (amber pointer, live step, page title), you took control (Paused, Hand back), server not running (clay dot, "web isn't running", Start web). Clicking the row opens the Browser on that page.
- Cookies: one session per project instead of the shared `persist:mcode-preview`, so Clear cookies clears one project. Marked "default" in the notes, not confirmed by the user (see Q4).

## How it works today

Paths under `apps/web/src` unless noted. Re-verified from `source/11-preview-interview.md`; claims below were spot-checked against code on 2026-10-08.

**Panel and tabs.** The right-panel tab is "Browser" (`lib/panel-tabs.ts:52-60`, `needsThread: false`). Pages are per thread (per workspace when threadless) in `features/preview/state/previewTabsStore.ts`, in memory only. The rail is the page switcher: `BrowserPageGroup`, `BrowserPageRailTab`, `BrowserPageRailGlyph`, `pageLabel` (`components/panels/ActivityRail.tsx:363-541`, rendered at `:786`); the comment at `:500-505` says "there is no horizontal strip". Closing the last page closes the Browser tab (`previewTabsStore.ts:182`). `PreviewPanel.tsx` is 4,301 lines and hosts the header wiring, page layer, design mode, the annotation bubble and a visual-proposal inspector.

**Header and menu.** `features/preview/surfaces/BrowserHeader.tsx` is one row: Back, Forward, Reload, URL field, Open in system browser, Design, Screenshot (`:111-347`), More (`BrowserOverflowMenu.tsx:128-260`: New page, Force reload, Dump page content, Region capture, Developer tools, Show/Hide device toolbar, Take control when the agent controls, zoom row, Clear cookies, Clear cache). Developer tools is bound to `mod+shift+y` (`config/default-keybindings.json:34-38`); Paper shows F12. Device toolbar and Force reload have no shortcut.

**Device toolbar.** `BrowserViewportToolbar.tsx` floats; presets match Paper (`automation/services/viewportCoordinator.ts:23-26`).

**Navigation.** `apps/desktop/src/features/preview/navigation/resolve-target.ts`: `looksLikeBareDomain` accepts `localhost`, `localhost:N` and IPv4 literals (`:53-54`), then `https://` is prefixed (`:81`), so dev servers fail unless typed with `http://` (verified). `*.localhost` also gets https; bare `[::1]` becomes a Google search. No test file exists for this module.

**Errors.** The webview adapter emits `load-failed` with Chromium's `errorDescription` (`ElectronWebviewBrowserSurfaceAdapter.ts:366-379`). `navigation/nav-errors.ts:104-123` turns a network failure into `{ kind: "network", message: error }`, so the headline is the raw name such as `ERR_CONNECTION_REFUSED` (verified). `apps/desktop/src/features/preview/navigation/load-result.ts` holds friendly copy and an HTTP classifier, but only its test imports it (verified by `rg classifyLoadResult`). HTTP status is never classified in production; the server's own error page shows. `render-process-gone` emits `surface-lost` (`:417-419`). Nothing handles certificate errors: `apps/desktop/src` has no `certificate-error` listener and no `setCertificateVerifyProc` (verified with `rg -i certificate`). Electron's default rejects the certificate, the load fails with a net error between -200 and -299, and the page shows its raw name. The agent's navigation fails with the generic "Browser navigation failed" (`apps/desktop/src/features/preview/automation/kernel.ts:1409,1438`).

**New page.** `LocalPortsEmptyState.tsx` lists `localhost:{port}` from `useLocalPorts.ts`, which polls `desktopBridge.preview.detectLocalPorts` every 5 s. That method is declared optional (`transport/desktop-bridge.d.ts:187,265`) and has no desktop implementation (verified), so the list is always empty. Nothing links project actions to ports: `WorkspaceEnvironmentActionRunSchema` has no port field (`packages/contracts/src/models/workspace-environment.ts:332-349`), and action runs are per `{threadId, actionId}` (`:386-388`).

**Session and storage.** Every guest uses `persist:mcode-preview` (`apps/desktop/src/features/preview/security/electron-session-policy.ts:8`), set in the renderer (`ElectronWebviewBrowserSurfaceAdapter.ts:142`) and forced in main at attach (`security/webview-attachment-policy.ts:37`). Adoption trusts a guest only if `guest.session === previewSessionAdapter.session` (`surfaces/registry.ts:207`). Clipboard and download policy is installed once on that session (`electron-session-policy.ts:68-75`), and the failed-request recorder once (`capture/handlers.ts:529-531`). Clear cookies and Clear cache wipe the whole shared jar (`navigation/handlers.ts:144-148`). `docs/internals/runtime/browser-v2-rollout.md:31-37` documents the shared partition.

**Design mode and notes.** Design auto-arms an element picker; the arming effect re-runs whenever the `capture` object changes (`PreviewPanel.tsx:3433-3458`). `usePreviewCapture` returns a fresh object each render (`capture/usePreviewCapture.ts:325-337`), and `onAddElementAnnotation` sets busy state as it starts (`:309-311`), so a re-arm loop is likely (inferred from code; not reproduced). The bubble has an "Open annotation visual controls" button (`PreviewPanel.tsx:4066`) that opens a style inspector (`PreviewPanel.tsx:397-1560`, about 1,100 lines). After the first save the header becomes `PreviewAnnotationHeader.tsx` ("Designing", Exit Design, Discard page annotations, `:46-80`). Each saved note gets its own snapshot PNG written to the OS temp folder (`apps/desktop/src/features/preview/capture/handlers.ts:584`). Display numbers are shared with Review diff comments in creation order (`state/previewAnnotationStore.ts:134-147`). The composer shows `PreviewAnnotationBundleChip` (`features/conversation/composer/ComposerContentSurface.tsx:331-361`), which truncates with "..." (`components/chat/PreviewAnnotationBundleChip.tsx`).

**Sending notes.** `buildBundle` emits `{ schemaVersion: 1, annotations }` (`previewAnnotationStore.ts:330-341`, schema `packages/contracts/src/models/browser-preview.ts:477-482`). The server appends it to the provider prompt as a fenced JSON block (`apps/server/src/features/agents/transport/agent-rpc.ts:111-112,249-250`) and persists each note's snapshot as a message attachment named "Annotation N screenshot.png" (`turn-admission-dispatch-coordinator.ts:596-601`, `browser-preview.ts:491-493`). The bundle is stored on `messages.preview_annotations` (`apps/server/drizzle/0017_message_preview_annotations.sql`). The transcript renders the chip (`features/conversation/messages/MessageBubble.tsx:675-677`) plus the snapshots as files.

**Agent control.** Providers with browser access: Claude (`packages/providers/src/private/claude/claude-provider.ts:72`), Codex (`codex/codex-provider.ts:1383`), Copilot (`copilot/copilot-provider.ts:202`), Cursor (`cursor/cursor-provider.ts:128`); Devin and OpenCode have no `mcode-browser` wiring (verified). Capability by mode: Plan is `observe` (inspect only), default is `interact` (open, inspect, act, tabs), Full access is `privileged` (adds evaluate) (`apps/server/src/features/browser-automation/access/access-service.ts:11-17`, `access/browser-automation-session-lease.ts:85-91`). Controller state is `{ controller: "none" | "human" | "agent", controlEpoch }` per tab (`packages/contracts/src/models/browser-automation.ts:616-630`). User input calls `interrupt`, which moves any non-human tab to "human", bumps the epoch and cancels queued work (`apps/desktop/src/features/preview/automation/kernel.ts:769-786,1150-1172`). Admission checks only the epoch (`kernel.ts:696-697,1221-1225`) and then marks the tab "agent" for every operation except `status`, including read-only inspect (`kernel.ts:704,1203`). The overflow menu's Take control stays while the controller is the agent, even when idle (`BrowserOverflowMenu.tsx:187-194`). The "Agent controls Browser" overlay draws a gradient edge and a pointer (`PreviewPanel.tsx:3900-3922`, `browser-surfaces/BrowserSurfaceControlIndicator.ts:1-14`).

**Control epoch check (the suspected stall).** Not a stall, but two real defects:
- The epoch is reachable. Inspect returns `tabs[]` built from host targets that carry `controller.controlEpoch` (`BrowserAutomationHost.tsx:1323-1328`, schema `browser-automation.ts:726-740`, broker passes them through at `broker.ts:453-458`), and the stale error message names the current epoch (`kernel.ts:697`). There is no top-level field, though: the MCP argument says "Control epoch returned by browser_inspect" (`transport/mcp-handler.ts:117`), and an omitted argument defaults to 0 (`mcp-handler.ts:588`). A model that misses the nested path gets `STALE_CONTROL_EPOCH` until it reads the message (verified by reading; not run against a live provider).
- The agent reclaims silently. Once it passes the new epoch, admission succeeds and the tab flips back to "agent" (`kernel.ts:1221-1225` then `:1203`). Nothing holds human control. This is the behavior the design removes.

**Thread overview and rail.** `ThreadOverviewBrowserSection` renders a "Browser" section with one row per tab, an amber pointer when the agent controls, and ellipsis truncation (`components/chat/ThreadOverview.tsx:1548-1610`, mounted at `:2874-2876`). The rail shows an amber pointer per page while the agent controls (`ActivityRail.tsx:401-425`).

**Other bugs found.**
- Removing the composer's annotation chip calls `clearThread`, which also deletes the thread's Review diff comments and their edit targets (`ComposerContentSurface.tsx:344-347`, `previewAnnotationStore.ts:285-297`). Verified by reading; the chip only displays visual notes (`useComposerSurfaceState.ts:83-95`).
- `BROWSER_AUTOMATION_ERROR_CODES` lists `CROSS_ORIGIN` twice (`browser-automation.ts:1230,1242`). Harmless, fix in S11-06.

## Gap table

| Design element | Today | Change | Layers |
|---|---|---|---|
| Row 1 page tabs (favicon, title, hover close, active fill, shrink 96, scroll, pinned +) | Rail sub-tabs per page | `BrowserTabStrip` in F-05 row 1; rail keeps one Browser entry | web |
| Row 2 nav pill, URL pill with hover Open in browser | One-row `BrowserHeader` | `BrowserToolbar` in F-05 row 2 | web |
| Round Design, Screenshot, More | In the one-row header | Same actions, new chrome; hidden on web runtime (no desktop bridge) | web |
| More menu (zoom, device, devtools, force reload, clear ×2) | Overflow with 10 items | `BrowserMoreMenu` on F-04; drop New page, Dump page content, Region capture, Take control | web, desktop (delete context capture IPC) |
| Shortcuts F12, Ctrl Shift M, Ctrl Shift R | `mod+shift+y` only | Rebind devtools, add two bindings | web |
| Screenshot click = viewport, drag = region | Two entry points | One button arms the capture overlay; click or drag in the page | web, desktop (`capture/overlay.ts`) |
| Device toolbar third row | Floating toolbar | 40 row under row 2; page on a `--color-page` stage | web |
| New page tiles from project actions with last view, Start | Local ports list, always empty | Tiles from this thread's action runs (`run.port`, S12T-08) plus desktop thumbnails | desktop, web |
| Recent pages for this project | None | Desktop per-project history store | desktop, web |
| http for localhost and IPs | https prefix | Scheme rule in `resolve-target.ts` | desktop |
| Plain error copy, Start web on project ports | Raw Chromium name | One renderer classifier; new kinds; project-port lookup | contracts, web; delete desktop `load-result.ts` |
| Certificate warning with Proceed, "Not secure" mark | Rejected by Electron's default; raw `ERR_CERT_*` name | Warning page; per-project, in-memory exceptions answered from main's `certificate-error` handler; the mark and a way to stop trusting | desktop, web |
| Per-project cookies and cache | One shared partition | Partition bound to exactly one workspace at prepare, attach and adopt; clear acts on the window's project; deletion follows the server's workspace removal | desktop, web, docs |
| Design: amber button, hover box, mono tip, bubble, markers on the live page | Picker plus "Designing" bar, markers only in snapshots | Explicit picker state; live markers per page; delete the bar | web, desktop (overlay) |
| Notes as one composer tile per page or a stack | Chip with "..." | Tile and stacked tile with hover card | web |
| One snapshot per page with matching numbers | One snapshot per note, numbers shared with diff comments | Bundle v2 with `pages[]`; numbers per page | contracts, server, web, desktop |
| Sent compact tile, read-only card, image viewer | Chip plus "Annotation N screenshot.png" files | Compact tile; snapshots filtered from the file row | web, contracts |
| Notes persist as drafts | Memory only | S10-11's persisted composer draft with durable snapshot staging, shared with Review comments | web |
| Agent pill (provider icon, Take control) only while acting | Overflow item while controller is agent | Pill derived from active effect requests | web |
| Glow, amber pointer, URL amber ring, agent tab pointer | Gradient overlay, rail pointer | Paper values; tab pointer in row 1 | web |
| You took control: Hand back; no silent reclaim | Next agent action reclaims | Sticky user hold per thread, Hand back IPC, broker refusal, `controlEpoch` on inspect | contracts, server, desktop, web, orchestration guide |
| Overview Browser row with five states | Section with one row per tab | One row in Activity | web |

## Backend architecture

### 1. Per-project browser profiles (desktop main)

One Electron partition per workspace replaces `persist:mcode-preview`. Workspace ids are UUIDs (`apps/server/src/features/projects/persistence/workspace-store.ts:54`), so the name needs no hashing.

The partition is a trust boundary. Today guest adoption trusts a guest because its session is the one Browser session (`apps/desktop/src/features/preview/surfaces/registry.ts:204-207`). With one session per project, "the session belongs to Mcode" is no longer proof: a valid partition of project B must never be adopted under a project-A surface. So the surface's validated workspace decides the partition, and every step checks that exact partition, not a name pattern.

```ts
// packages/shared/src/browser-preview/browser-partition.ts (renderer and desktop main share it)
/** "persist:mcode-browser-<uuid>". Throws on a non-UUID id, so no caller can build another shape. */
export function browserPartitionFor(workspaceId: string): string;

// apps/desktop/src/features/preview/security/browser-profiles.ts (replaces the single-session parts of electron-session-policy.ts)
export interface BrowserProfiles {
  /** The one session for this workspace. First use installs clipboard trust, will-download deny and the
   *  failed-request recorder before returning, so policy exists before any guest attaches. */
  sessionForWorkspace(workspaceId: string): Electron.Session;
  /** Clears one store of this workspace's session. */
  clear(workspaceId: string, store: "cookies" | "cache"): Promise<void>;
  /** Workspace removed: release its surfaces in every window, clear all storage and cache, delete history and thumbnails. Idempotent. */
  remove(workspaceId: string): Promise<void>;
  /** Removes every profile whose workspace is absent from the server's complete list. */
  reconcile(liveWorkspaceIds: ReadonlySet<string>): Promise<void>;
}
```

There is no "is this any Mcode browser session" check anywhere. Each step binds to one workspace:

| Step | Today | Change |
|---|---|---|
| Prepare (`registry.ts:374-388`) | Validates the surface against the window's workspace (`findOwnedTab`, `registry.ts:159-181`) and stores `{ surface, adoptionToken }` | Also stores `partition: browserPartitionFor(surface.identity.workspaceId)` on the pending record. The adoption token, the validated workspace and the partition are bound together from here on. |
| Renderer | Sets `partition="persist:mcode-preview"` and appends the webview without waiting for prepare (`apps/web/src/features/preview/browser-surfaces/ElectronWebviewBrowserSurfaceAdapter.ts:139-142,171-176`) | Sets `browserPartitionFor(identity.workspaceId)` and appends the webview only after prepare resolves `ok`, so attach always finds the pending record. |
| Attach (`apps/desktop/src/features/desktop-window/lifecycle/create-window.ts:130`) | `hardenPreviewWebviewAttachment` overwrites the partition with the shared one (`webview-attachment-policy.ts:37`) | Reads the adoption token from `params.src` (`about:blank#<token>`), finds this window's pending record for it, and requires `params.partition` to equal that record's partition. No pending record, a malformed partition, or a valid partition of another workspace calls `event.preventDefault()`. Before returning it calls `sessionForWorkspace`, so policy is installed before the guest exists. |
| Adopt (`guestMatchesPending`, `registry.ts:197-209`) | Trusts a guest only if `guest.session === previewSessionAdapter.session` | Trusts it only if `guest.session === sessionForWorkspace(pending.surface.identity.workspaceId)`, exact identity with that one workspace's session. |
| Clear (`clearPreviewStorage`, `navigation/handlers.ts:143-147`) | Clears the shared jar | Calls `profiles.clear(workspaceId, store)` for the window's workspace after checking the active guest's session is exactly that workspace's session. More reads "Clear cookies" and "Clear cache"; the scope is the project. |

- **Removal follows the server.** Today the renderer that deletes a project releases its browser state (`apps/web/src/features/projects/state/workspaceStore.ts:1162,1204`), which misses a project removed through another client. The server broadcasts `workspace.deleted` to every client after the hard delete (`apps/server/src/features/projects/lifecycle/transport/workspace-thread-rpc.ts:172`, `apps/server/src/features/thread-control/cleanup/cleanup-worker.ts:508`). The renderer's handler for that push (`apps/web/src/transport/ws-events.ts:544-552`) calls `desktopBridge.preview.profiles.remove(workspaceId)`, whichever client deleted it.
- **Reconcile on connect and reconnect.** After `workspace.list` succeeds (`workspaceStore.ts:1107-1115`) on desktop connect and reconnect, the renderer passes the complete id list to `profiles.reconcile`. Main removes every profile whose workspace is not in it, which catches removals that happened while this desktop was closed or disconnected. A failed or partial list never reconciles, because an empty list would delete every profile.
- Electron has no API to delete a partition while it is in use. `remove` clears all storage and cache at once; the next launch's reconcile deletes the partition directory before any session for it exists (directory name `Partitions/mcode-browser-<uuid>` inferred; verify against Electron's layout).
- Migration (one time, marker file in userData): clear and delete the old `persist:mcode-preview` partition. No cookie copy, because copying would carry every project's logins into every project (Q4).
- Failure modes: a rejected attach shows the existing "Preview is unavailable" error on that surface. `remove` and `reconcile` on a missing profile are no-ops.

### 2. Page history and last-view thumbnails (desktop main, same profile)

Owned by desktop main because it owns the partition and can capture guests directly. History and thumbnails need no upload. The web runtime shows server tiles without thumbnails and no recent pages.

```ts
// apps/desktop/src/features/preview/profiles/history-store.ts
interface BrowserHistoryEntry {
  url: string;            // userinfo and fragment stripped, ≤ 4096
  title: string | null;   // ≤ 240
  faviconUrl: string | null;
  lastVisitedAt: number;
}
interface BrowserServerThumbnail { origin: string; capturedAt: number; dataUrl: string } // JPEG, 320 wide, quality 70
// IPC
"preview:history.list"   (workspaceId) => { entries: BrowserHistoryEntry[]; thumbnails: BrowserServerThumbnail[] }
"preview:history.remove" (workspaceId, url) => void
```

- Storage: `userData/browser-profiles/<workspaceId>/history.json` (≤ 50 entries, deduplicated by preview page identity, atomic write) and `thumbnails/<sha1(origin)>.jpg`.
- Recording: main-frame `did-navigate` and title updates for every guest in that partition, including agent tabs.
- Thumbnails: only for loopback and IP origins (project servers). Capture with `webContents.capturePage()` 1.5 s after `did-finish-load` and when the tab is hidden or closed, at most once per 60 s per origin. No timers run while nothing loads.
- Reverse state: a recent row shows a remove × on hover (undrawn, Q9). `remove(workspaceId)` from section 1 deletes the folder.

### 3. Project servers and ports (owner: S12T-08)

S12T-08 owns port detection and the `run.port` contract (`WorkspaceEnvironmentActionPortSchema` in section 12a). S11 consumes it and adds no port field, no listening flag, no server-list RPC and no detector. Reasons: the design lists project servers, not every listening port, and action runs are server-owned PTYs, so the server sees their output first. OS port enumeration on desktop (`detectLocalPorts`) can do none of that, so S11 deletes the declaration and its consumers instead of implementing it.

A project server is an action whose run in this thread carries a `run.port`, from this run or an earlier one. S11 reads runs from `workspace.environment.action.list({ threadId })`, whose input requires a thread (`packages/contracts/src/models/workspace-environment.ts:386-388`), and from the `workspace.environment.action.updated` push (`packages/contracts/src/ws/channels.ts:81-86`). Nothing polls. The three states and their conditions are the ones S12T-08 defines (12a Backend D); the names match there.

| Tile | Run condition | Shows |
|---|---|---|
| Running | `status === "running"`, `run.port.runId === run.runId` and `reachable: true` | Last view thumbnail, green dot, name, port. Click opens `run.port.url`. |
| Starting | `status === "running"` without a reachable port from this run: the port is an earlier run's history, or this run's port stopped answering | Dashed frame and a muted "Starting" in place of Start (proposed; undrawn) |
| Stopped | Any other status. The port is history. | Dashed frame with Start; the port shows muted as history |

- A previous run's port is display history only. S11 never opens it and never shows it as live. After Start, the tile turns Running and the page opens only when S12T-08 reports a reachable port from the new run. `run.port.url` carries the normalized host, so an IPv6-only server opens as `http://[::1]:<port>/` (S11-02 handles the scheme).
- The green dot means a TCP connect succeeded, not that the app is healthy or that this run owns the port (S12T-08). No tile copy claims more. A port is a display fact, and nothing in S11 reads it as Setup readiness, which is exit 0 only (12a Backend F).
- Start on a Stopped tile or an error page calls `workspace.environment.action.restart` while the run's terminal is still open (`terminalSessionId` set; the action reruns in that terminal) and `workspace.environment.action.start` once it is closed. A stopped action usually keeps its terminal open in the shell phase, so `start` alone would only focus that terminal (12a Backend B).
- An action that has not run in this thread has no run to read, so it has no tile until it runs here. A threadless Browser has no action runs at all, so its New page shows recent pages only (Q11).
- Dev servers started outside Mcode get no tile. Typing the URL works, and the page then appears under recent pages.

### 4. Take control and Hand back (control hold contract)

The design makes user control sticky. The hold is per thread, because the overview shows one Browser row per thread and "Paused" means that thread's agent is paused in every tab. Epochs stay per tab.

```ts
// packages/shared/src/browser-preview/browser-control.ts (new; the one reducer used by the desktop kernel and the web executor)
export type BrowserHolder = "none" | "agent" | "user";
export interface BrowserThreadControl {
  readonly holder: BrowserHolder;
  readonly heldTabId: string | null;              // tab where the user took control
  readonly epochByTab: ReadonlyMap<string, number>;
}
export type BrowserControlEvent =
  | { type: "agent-effect"; tabId: string; expectedEpoch: number }
  | { type: "user-input"; tabId: string }          // pointer or key input in the page
  | { type: "take-control"; tabId: string }        // agent pill button
  | { type: "hand-back" }
  | { type: "agent-turn-ended" }
  | { type: "tab-closed"; tabId: string };
export type BrowserControlDecision =
  | { admitted: true; next: BrowserThreadControl }
  | { admitted: false; code: "HUMAN_INTERRUPTED" | "STALE_CONTROL_EPOCH"; next: BrowserThreadControl };
export function reduceBrowserControl(state: BrowserThreadControl, event: BrowserControlEvent): BrowserControlDecision;
```

| From | Event | To | Effect |
|---|---|---|---|
| none | agent-effect, epoch matches | agent | Admit |
| none | agent-effect, stale epoch | none | `STALE_CONTROL_EPOCH`, recovery inspect |
| none | user-input | none | Epoch +1 on the tab (invalidates observations, no hold) |
| agent | user-input or take-control | user | Epoch +1; cancel queued steps; receipts `interrupted`; chat reads "Stopped when you took control" |
| agent | agent-turn-ended | none | Today's `releaseAgentControl` |
| user | agent-effect (any tab in the thread) | user | Refuse `HUMAN_INTERRUPTED`, recovery `yield_to_user`, epoch unchanged |
| user | hand-back | none | Epoch +1 on the held tab; the agent re-inspects |
| user | agent-turn-ended | user | Hold stays; "Paused · Hand back" stays visible |
| user | tab-closed (held tab) | none | The hold ends with the tab |
| user | user sends a message to the thread | user | Not a control event; the reducer has no such event and nothing on the send path calls Hand back (user, 2026-10-08, W1). The new turn's first effect is refused as in the "agent-effect" row, and "Paused · Hand back" stays visible. |

Effect operations are `open`, `act`, `tabs` and `evaluate`. `inspect` and `status` never claim control, so Plan mode never shows the glow or pill.

Wire and contract changes:
- `BrowserAutomationResultSchema` inspect variant gains a required `controlEpoch` for the selected target (`browser-automation.ts:1145-1157`). The `expectedControlEpoch` description becomes "controlEpoch from the latest browser_inspect result" (`mcp-handler.ts:117`).
- `BrowserAutomationControllerState.controller === "human"` now means "held until Hand back"; update its docstring. No enum change.
- Desktop IPC `preview:automation.hand-back` `{ threadId }` returns `boolean` and is idempotent (false when nothing is held). `preview:automation.interrupt` becomes `take-control` semantics through the reducer. The web runtime gets the same action on `browserAutomationStore`.
- Broker: refuse effect operations before dispatch when the target's advertised controller is "human" (`broker.ts:1690-1702` already compares controllers). Change the inspect guidance (`broker.ts:464-467`) to: "The user has control of the Browser. Do not act until browser_inspect reports ready; the user hands control back."
- `packages/thread-orchestration/src/browser-operating-guide.ts:14`: same rule in the operating guide.
- Remove the duplicate `CROSS_ORIGIN` (`browser-automation.ts:1242`).
- Failure modes: if the desktop host disconnects, the hold is gone with the tabs. A Hand back that races an agent request is safe because the bumped epoch makes the in-flight request stale.

"Acting" for the UI is `holder === "agent"` and either an active effect request for the tab or one finished less than 3 s ago. A single timeout clears it, with no animation loop. The pill, glow, amber ring, tab pointer, rail glyph and overview step all read this one selector.

### 5. Agent capability by mode

No gateway change. Visible effect only:

| Mode | Operations (unchanged, `session-lease.ts:85-91`) | Claims control | What the user sees |
|---|---|---|---|
| Plan | inspect | Never | Tabs and overview "Open" only |
| Build, default permissions | open, inspect, act, tabs | On open, act, tabs | Agent pill, glow, pointer, amber URL ring while acting |
| Build, Full access | adds evaluate | Also on evaluate | Same; the step reads "Running a script" (`BrowserActivityRow` privileged line) |

### 6. Notes: annotation bundle v2 with one snapshot per page

```ts
// packages/contracts/src/models/browser-preview.ts
export const PreviewAnnotationPageSchema = lazySchema(() => z.object({
  pageIdentity: z.string().min(1).max(PREVIEW_ANNOTATION_STRING_MAX.pageIdentity),
  url: z.string().max(4096),
  title: z.string().max(240).nullable(),
  faviconUrl: z.string().max(4096).nullable(),
  snapshot: z.object({              // viewport capture with this page's markers drawn
    id: z.string(), name: z.string().max(255), mimeType: z.literal("image/png"),
    sizeBytes: z.number().int().nonnegative(), sourcePath: z.string().max(1024),
    capture: McodeBrowserCaptureV2Schema(),
    scroll: z.object({ x: z.number(), y: z.number() }),
  }),
}).strict());

export const PreviewAnnotationPayloadV2Schema = lazySchema(() => z.object({
  id: z.string().uuid(),
  pageIdentity: z.string().min(1).max(PREVIEW_ANNOTATION_STRING_MAX.pageIdentity),
  displayNumber: z.number().int().positive(),          // per page, matches the page snapshot's markers
  pageContext: McodeBrowserCaptureV2Schema(),
  targetContext: z.object({ label: ..., selectorHint: ..., bounds: BrowserPreviewBoundsSchema() /* document px */ }),
  note: z.string().trim().min(1).max(PREVIEW_ANNOTATION_STRING_MAX.note),
}).strict());

// writers emit v2 only; the union exists so persisted v1 messages still parse
export const PreviewAnnotationBundleSchema = lazySchema(() => z.union([
  bundleV1,
  z.object({ schemaVersion: z.literal(2), pages: z.array(PreviewAnnotationPageSchema()),
             annotations: z.array(z.union([PreviewAnnotationPayloadV2Schema(), DiffAnnotationPayloadSchema()])).min(1) }),
]));
export function readPreviewAnnotationBundle(bundle: PreviewAnnotationBundle): PreviewAnnotationBundleView;
// v1 → view: group notes by pageIdentity, page snapshot = that page's last note snapshot, keep v1 numbers (they match burned-in markers)
export function previewAnnotationPageSnapshotName(page): string; // "Notes on <title or host>.png", sanitized, ≤ 120
```

- Capture: on each save, desktop captures the viewport without the bubble and keeps it as the page's clean capture. Notes store document-space bounds. Whenever a page's notes change, the renderer redraws the marked PNG from the clean capture with an `OffscreenCanvas`, debounced 300 ms, so numbers stay correct after a removal. Send finishes a pending redraw before it records the page's snapshot in the submission (section 7), so it waits at most for one redraw and its staging. Notes scrolled outside the captured viewport get no marker in the image but keep selector and bounds in the payload (risk R3).
- Numbering: per page, in creation order among the page's current notes (section 7). Diff comment numbering is S10's; the shared renumbering (`previewAnnotationStore.ts:134-147`) splits.
- Server: `agent-rpc.ts` fences `mcode-preview-annotations:v2`. Turn admission persists `pages[].snapshot` as attachments named by `previewAnnotationPageSnapshotName`. `messages.preview_annotations` keeps the JSON; no migration.
- Transcript: `MessageBubble` hides attachments whose ids appear in the bundle (v1 per-note ids and v2 page ids) and renders the compact tile.
- Provider effect: the notes are message text and images, so every provider receives them, including Devin and OpenCode, which have no browser tools. No adapter change.

### 7. Draft persistence (owner: S10-11)

Browser notes ride the one persisted composer draft that S10-11 owns, beside Review comments and file comments. S11 adds no table and no RPC. S10-11's element revisions, submissions, staging, leases and retention rules apply as written there. This section applies them to Browser pages: a page is a container, and each note is an element.

- **Field.** S11-15 adds `browserNotePages?: DraftBrowserNotePage[]` to `ComposerDraft`, the field S10-11 reserves for it. Each entry is one page: a bundle v2 page (section 6) with `cleanCapture: StagedDraftImage`, `snapshot: StagedDraftImage` (the marked image of its current notes) and its notes, each carrying S10-11's `DraftElementMeta`. S11-15 adds `"browserNotePages"` to `DraftElementField`, so a `DraftSubmission` can name a note, and adds its serializer, its parser and a round-trip test, following S10-11's pattern (`apps/web/src/lib/composer-draft-storage.ts:42,126`). The parser validates each entry with the v2 page schema and drops one that fails, because stored JSON is untrusted. An open note bubble is not persisted; a reload closes it (proposed).
- **Current notes.** A page's current notes are the ones no pending submission holds. Only they are shown or edited: the tile, the hover card, the live markers and the note bubble read them. They are numbered per page in creation order, and `snapshot` is always drawn from them. A page whose notes are all held by pending submissions has no tile entry and no live markers, but stays in the draft.
- **Send.** For each page with current notes, Send first finishes any pending redraw and stages it, so `snapshot` shows exactly the notes being sent. S10-11's `DraftSubmission` then records those note revisions, and its `stagingIds` holds that page's `snapshot` and nothing else. Clean captures are never sent, so they never enter `stagingIds` or `stagedDraftImageIds`. Admission never leases a clean capture and does not need to, because no window deletes staged images (Snapshots below). Turn admission leases and copies the snapshots into message attachments named by `previewAnnotationPageSnapshotName` (S10-11).
- **Notes saved during a send.** A note saved on a submitted page while the submission is pending is a new current note on that page, numbered from 1 among its current notes. The save replaces the page's clean capture, as every save does (section 6), and redraws `snapshot` from the current notes. The submitted snapshot stays untouched, because the pending submission still references it. An edit that reaches a submitted note from another window becomes a newer revision of that note (S10-11).
- **Settling.** S10-11 decides success and failure, including a lost response and restart resolution. Afterwards each affected page renumbers its current notes in creation order and redraws `snapshot` from its latest clean capture. On success the submitted revisions are gone and later notes stay. On failure the submitted notes return as current notes beside any saved during the send. A page left with no notes is removed. A returned note outside the latest clean capture keeps its selector and bounds without a marker (risk R3).
- **Snapshots.** The composer draft lives in localStorage, which cannot hold images, and today's per-note snapshots sit in the OS temp folder (`apps/desktop/src/features/preview/capture/handlers.ts:584`). Both images of a page go through S10-11's `attachments.stageDraft`, and the draft keeps only the `StagedDraftImage` references. S10-11's retention rule governs both images. A window never deletes staged draft images on its own authority. Removing a page, a note or a comment from a draft only drops that draft's reference. Marked snapshots and clean captures alike stay on disk until the retention sweep finds them unreferenced by any persisted draft and not leased by an in-flight admission. An admission lease ending, whether the admission succeeded or failed, never deletes staged files. A redraw, removing the tile and a settled submission likewise only drop references. Thread deletion removes the staged files with the thread's attachments.
- **Other windows.** Windows do not share in-memory draft state (S10-11). A second window whose copy predates the send can remove the tile or a page. That drops only its own copy's references and deletes no file, so the message still carries its snapshot. If the admission then fails, window A's draft still references the page's marked snapshot and clean capture: its notes return, the page redraws from the clean capture, and sending again works without Retake.
- **Failure.** A failed draft write shows S10-11's "Draft not saved" notice; notes are never dropped silently. A staged snapshot that is gone at send fails the send with S10-11's `draft_image_missing`; the notes return, and the tile shows that page's snapshot as missing with Retake.
- **Dispatch guard.** S11-15 retires the Browser half of today's clear-everything dispatch guard (`apps/web/src/features/conversation/composer/submission/composer-submission-annotations.ts:13-38`).
- **Live store.** `previewAnnotationStore.byThread` stops owning preview notes; it reads and writes current notes through the draft, as S10-11 does for `diffByThread`.

### 8. Error classification and certificate exceptions

`nav-errors.ts` becomes the only classifier; `load-result.ts` and its test are deleted. `PreviewPageErrorSchema.kind` (`packages/contracts/src/models/preview-page-status.ts:31`) becomes `"network" | "connection-refused" | "certificate" | "crash" | "file-not-found" | "blocked"`. `"http"` is removed if Q5 keeps server-rendered HTTP errors. `ERR_CONNECTION_REFUSED` (-102) maps to `connection-refused`; codes -200 to -299 map to `certificate`; `surface-lost` maps to `crash`. To choose between "Start web" and Retry-only copy, the panel matches the failed URL's port against `run.port.port` on this thread's action runs, current or history; a match names the action. Copy is in S11-10.

**Certificate exceptions (desktop main, S11-10; decision W5).** New `apps/desktop/src/features/preview/security/certificate-exceptions.ts` holds the exceptions and answers Electron. Nothing handles certificates today (How it works today, Errors).

- **Hook.** One `app.on("certificate-error", (event, webContents, url, error, certificate, callback, isMainFrame))` listener in main. It finds the workspace by exact session identity through a reverse lookup that S11-10 adds to S11-03's `BrowserProfiles`: `workspaceForSession(webContents.session)`. A session that is not a project profile, such as the app's own windows, gets no answer from Mcode, so Electron's default rejects it.
- **Decision.** Exceptions live only in memory: `Map<workspaceId, Set<host + "\0" + fingerprint>>`, with `host` from `new URL(url).hostname` and `certificate.fingerprint`. A pair in the set gets `event.preventDefault()` and `callback(true)`. Any other gets `callback(false)`; for a main frame, the handler also records the failure for that guest `webContents`: `{ host, error, fingerprint, subjectName, issuerName, validStart, validExpiry }`, latest only. A subresource failure (`isMainFrame` false) never shows a warning page, as in browsers.
- **Why not `setCertificateVerifyProc`.** Electron documents that "the result of this procedure is cached by the network service" (Electron 35.7.5, `apps/desktop/package.json:41`; `Session.setCertificateVerifyProc` in its `electron.d.ts`), so Proceed and Stop trusting could keep a stale answer. The `certificate-error` event asks each time a certificate fails, so the in-memory set stays the only source of truth. Whether Chromium also remembers an allowed certificate per host after `callback(true)` is inferred not to happen in Electron; S11-10's revoke test proves it.
- **IPC** (renderer to main; only the warning page and the "Not secure" menu call it, on a user click):
  - `preview:certificate.state (surfaceId) → { failure: CertificateFailure | null; exceptionInUse: boolean }`. `exceptionInUse` is true when the guest's main-frame URL is https and its host has an exception in that workspace's set. The renderer reads it after each load failure and each committed navigation of the active tab; nothing polls.
  - `preview:certificate.proceed (surfaceId, fingerprint) → boolean`. It adds the pair only when it equals the failure recorded for that surface's guest, so a renderer cannot trust a certificate that never failed there. The renderer then reloads.
  - `preview:certificate.revoke (surfaceId) → void`. It removes the active host's pairs from the workspace's set and calls `session.closeAllConnections()` so an open TLS connection does not keep the old trust; the renderer reloads and the warning returns.
- **Lifetime.** Nothing is written to disk, so quitting Mcode clears every exception. `profiles.remove(workspaceId)` also drops that workspace's set. Clear cookies and Clear cache leave exceptions alone.
- **The agent never proceeds.** The warning page is Mcode chrome drawn above the surface, not guest content, so `browser_act` cannot press its buttons, and no automation operation or MCP tool adds an exception. When the agent's `open` hits a certificate failure, the kernel throws `NAVIGATION_FAILED` with "Certificate error for {host} ({error}). Only the user can proceed past it in the Browser." in place of the generic text (`kernel.ts:1409,1438`); `PreviewGuestLoadResult` already carries `errorNumber` (`navigation/guest-navigation.ts:4-11,57-63`). After the user proceeds, agent tabs in that project load the host too, because they share the partition.

### 9. Per-provider decisions

| Concern | Claude | Codex | Copilot | Cursor | Devin (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| Browser gateway and hold semantics | No adapter change; MCP schema and guide text come from contracts and orchestration | No change | No change (tool allow-list from `BROWSER_AUTOMATION_OPERATION_METADATA`, `copilot-provider.ts:202`) | No change | No browser access; no change | No browser access; no change |
| `controlEpoch` on inspect | Receives it through MCP | Same | Same | Same | n/a | n/a |
| Agent pill provider icon | Thread's provider via F-06 | Same | Same | Same | Never shown | Never shown |
| Design notes (bundle v2, page snapshots) | Fenced JSON plus images through the existing attachment path; no change | Same | Same | Same | Same; notes work without browser tools | Same |
| Per-project cookies | Agent tabs use the project partition; no change | Same | Same | Same | n/a | n/a |
| Certificate errors | No adapter change; `open` fails with `NAVIGATION_FAILED` naming the certificate error, and no tool can proceed. Agent tabs use exceptions the user made in that project. | Same | Same | Same | n/a | n/a |

The pill's provider icon comes from the thread's current provider; no contract field is added. After a mid-turn handoff it can show the new provider while the old session finishes its last step (risk R5).

## Components

### New

- `features/preview/surfaces/BrowserTabStrip.tsx`: row-1 tabs inside F-05 row 1 (favicon or agent pointer, title fade, hover close swap, active fill, inactive 96, scroll with right fade, pinned round +).
- `features/preview/surfaces/BrowserToolbar.tsx`: row 2 (navigation pill, `BrowserUrlPill`, Design, Screenshot, agent or Hand back pill, More).
- `features/preview/surfaces/BrowserUrlPill.tsx`: origin and path split, fade, hover lift with Open in browser, focus ring on a new page, amber ring while acting.
- `features/preview/surfaces/BrowserMoreMenu.tsx`: F-04 menu with the zoom stepper.
- `features/preview/surfaces/BrowserControlPill.tsx`: provider icon plus "Take control" or "Hand back".
- `features/preview/surfaces/BrowserDeviceRow.tsx`: third row; reuses the existing viewport coordinator.
- `features/preview/surfaces/BrowserNewPage.tsx`: server tiles and recent pages.
- `features/preview/surfaces/BrowserErrorPage.tsx`: replaces `PreviewErrorPanel.tsx` with the new copy and buttons, including the certificate warning variant.
- `features/preview/design/DesignLayer.tsx` and `design/designPickerMachine.ts`: picker states (off, picking, editing) with explicit transitions; live markers and outlines.
- `features/preview/notes/BrowserNotesTile.tsx`, `BrowserNotesHoverCard.tsx`, `SentBrowserNotesTile.tsx`, `notes/renderPageSnapshot.ts` (marker composite).
- `features/preview/state/useBrowserActing.ts`: the one "acting" selector.
- `components/chat/ThreadOverviewBrowserRow.tsx`.
- `packages/shared/src/browser-preview/browser-control.ts` (reducer), `browser-partition.ts`.
- Desktop: `security/browser-profiles.ts`, `profiles/history-store.ts`, `security/certificate-exceptions.ts` (S11-10).

### Changed

- `PreviewPanel.tsx`: split by S11-01, then hosts the new rows and layers.
- `ActivityRail.tsx`: the Browser entry's glyph swaps to the amber pointer while acting (undrawn, Q10). S12P-01 has already reduced the rail to one Browser entry.
- `ElectronWebviewBrowserSurfaceAdapter.ts` (workspace partition, append after prepare), `create-window.ts` and `webview-attachment-policy.ts` (attach binding), `registry.ts` (partition on the pending record, exact session at adopt), `navigation/handlers.ts`, `capture/handlers.ts` (per-session policy; snapshots handed to S10-11 staging), `capture/overlay.ts` (click or drag), `automation/kernel.ts`, `BrowserAutomationHost.tsx`, `browserAutomationStore.ts`, broker, `mcp-handler.ts`, `browser-operating-guide.ts`.
- `transport/ws-events.ts` (`workspace.deleted` calls `profiles.remove`) and `workspaceStore.ts` (`profiles.reconcile` after a successful `workspace.list`).
- `resolve-target.ts`, `nav-errors.ts`, `preview-page-status.ts`. For certificates (S11-10): `BrowserUrlPill` (the "Not secure" mark), `browser-profiles.ts` (`workspaceForSession`, and `remove` drops exceptions), `automation/kernel.ts` (the certificate failure message) and the desktop bridge (`preview.certificate.*`).
- `previewAnnotationStore.ts` (per-page numbering, v2 bundle, `clearPreviewNotes` separate from diff comments, notes read and written through the composer draft), `composer-draft-storage.ts` (`browserNotePages` field), `composer-submission-annotations.ts` (Browser half of the dispatch guard), `ComposerContentSurface.tsx`, `ComposerQueueList.tsx`, `MessageBubble.tsx`, `ImageAttachmentLightbox.tsx` (open a page snapshot), `agent-rpc.ts`, `turn-admission-dispatch-coordinator.ts`, `browser-preview.ts`.
- `ThreadOverview.tsx` (mount the row in Activity), `config/default-keybindings.json`.
- Docs: `CONTEXT.md` (Browser controller, Preview annotation mode, Annotation display number, Preview annotation set, Annotation bundle, Preview annotation snapshot: rewrite, do not append), `docs/internals/runtime/browser-v2-rollout.md:31-37`, two ADRs, each at the next free number at merge ("Browser control stays with the user until Hand back", "One browser profile per project").

### Retirement ledger

| Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
|---|---|---|---|---|
| One-row `BrowserHeader` | `features/preview/surfaces/BrowserHeader.tsx`, `__tests__/BrowserHeader.automation.test.tsx` | `BrowserToolbar` in F-05 row 2 | S11-04 | `rg -n "BrowserHeader\b" apps/web/src` returns nothing |
| Old overflow menu (New page, Dump page content, Region capture items) | `BrowserOverflowMenu.tsx` | `BrowserMoreMenu`, + tab, Screenshot drag | S11-04 | `rg -n "BrowserOverflowMenu\|More browser tools\|Dump page content\|Region capture" apps/web/src` returns nothing |
| Dump page content capture path | `usePreviewCapture.ts` `onAddPageContextOnly`, `contextBusy`; `apps/desktop/src/main/preload.ts:300`; `desktop-bridge.d.ts` `captureContextReference`; `capture/handlers.ts:667` `preview:capture-context-reference`; `preview/index.ts:6-9` `PreviewContextReferenceResult` | Removed (locked); agents use `browser_inspect` | S11-04 | `rg -n "capture-context-reference\|captureContextReference\|onAddPageContextOnly\|PreviewContextReferenceResult" apps packages` returns nothing. `isVirtualBrowserContextAttachment` stays because persisted messages still hold "Page context" rows. |
| `onRegionCapture` plumbing | `BrowserHeader.tsx:62,377,404`, `PreviewPanel.tsx:2466,3784` | Screenshot click or drag | S11-04 | `rg -n "onRegionCapture\|onDumpContent" apps/web/src` returns nothing |
| Developer tools `mod+shift+y` binding | `config/default-keybindings.json:34-38` | F12 | S11-04 | `rg -n "mod\+shift\+y" apps/web/src/config` returns nothing |
| Floating device toolbar layout | `BrowserViewportToolbar.tsx` (and its test) | `BrowserDeviceRow` | S11-05 | `rg -n "BrowserViewportToolbar" apps/web/src` returns nothing |
| Shared partition `persist:mcode-preview`, `PREVIEW_PARTITION`, single-session `previewSessionAdapter` | `electron-session-policy.ts:8,47-139`, `webview-attachment-policy.ts:37`, `ElectronWebviewBrowserSurfaceAdapter.ts:142`, `preview/index.ts:56-60`, `registry.ts:207` | `browser-profiles.ts` | S11-03 | `rg -n "mcode-preview\"\|PREVIEW_PARTITION\|previewSessionAdapter" apps packages` returns nothing (the annotation fence string `mcode-preview-annotations` is unrelated) |
| Shared-partition paragraph | `docs/internals/runtime/browser-v2-rollout.md:31-37` | Rewritten for per-project profiles | S11-03 | `rg -n "persist:mcode-preview" docs/internals CONTEXT.md` returns nothing (the new ADR may name the old partition; ADRs and plans are out of scope) |
| Overflow "Take control" item | `BrowserOverflowMenu.tsx:187-194`, carried into `BrowserMoreMenu` by S11-04 | Agent pill | S11-06 | `rg -n "Take control" apps/web/src/features/preview/surfaces --glob 'BrowserMoreMenu.tsx'` returns nothing |
| Silent reclaim (epoch-only admission, inspect claims control) | `kernel.ts:704,1203,1221-1225`; web executor equivalents | `reduceBrowserControl` | S11-06 | `bun run --cwd apps/desktop test -- src/features/preview/automation/__tests__/browser-automation-kernel.test.ts src/features/preview/automation/__tests__/browser-automation-kernel-races.test.ts` passes, including "agent effect while the user holds control is refused" and "inspect never claims control" (`emitController` stays, called only from the reducer-admitted path) |
| Duplicate `CROSS_ORIGIN` | `browser-automation.ts:1242` | One entry | S11-06 | `rg -U -n "\"CROSS_ORIGIN\",[\s\S]*\"CROSS_ORIGIN\"," packages/contracts/src/models/browser-automation.ts` returns nothing (it matches only while the code appears twice) |
| Gradient edge and old overlay | `BROWSER_CONTROL_EDGE_BACKGROUND_IMAGE`, `BROWSER_CONTROL_EDGE_BOX_SHADOW` (`BrowserSurfaceControlIndicator.ts:1-14`), overlay `PreviewPanel.tsx:3900-3922` | Paper glow and pointer | S11-07 | `rg -n "BROWSER_CONTROL_EDGE_" apps/web/src` returns nothing |
| `detectLocalPorts`, `DetectedLocalPort`, `useLocalPorts`, `LocalPortsEmptyState` | `desktop-bridge.d.ts:184-191,265`, `useLocalPorts.ts`, `LocalPortsEmptyState.tsx`, `PreviewPanel.tsx:52,4290` | `BrowserNewPage` with S12 servers | S11-09 | `rg -n "detectLocalPorts\|DetectedLocalPort\|useLocalPorts\|LocalPortsEmptyState" apps packages` returns nothing |
| Unused load classifier and copy | `apps/desktop/src/features/preview/navigation/load-result.ts`, `__tests__/load-result.test.ts` | `nav-errors.ts` classifier | S11-10 | `rg -n "classifyLoadResult\|load-result" apps` returns nothing |
| Raw Chromium headline | `nav-errors.ts:119-123` `message: error ?? ...` | Plain copy | S11-10 | `bun run --cwd apps/web test -- src/features/preview/navigation/__tests__/nav-errors.test.ts` passes; its table asserts no `ERR_` text in any headline or detail for every network code (the codes themselves stay as classifier input) |
| `PreviewErrorPanel` | `surfaces/PreviewErrorPanel.tsx` | `BrowserErrorPage` | S11-10 | `rg -n "PreviewErrorPanel" apps/web/src` returns nothing |
| `"http"` page error kind (if Q5 holds) | `preview-page-status.ts:31`, `PreviewErrorPanel` icon map, `apps/desktop/src/features/preview/state/__tests__/page-status.test.ts:5` | Server-rendered HTTP errors | S11-10 | `rg -n "kind: \"http\"\|\"http\", \"network\"" packages/contracts/src/models/preview-page-status.ts apps/desktop/src/features/preview apps/web/src/features/preview` returns nothing |
| Overview Browser section with per-tab rows | `ThreadOverview.tsx:1548-1610,2874-2876` | `ThreadOverviewBrowserRow` in Activity | S11-11 | `rg -n "ThreadOverviewBrowserSection\|thread-overview-browser-tab-" apps/web/src` returns nothing |
| "Designing" bar | `surfaces/PreviewAnnotationHeader.tsx` | Amber Design button, composer tile | S11-12 | `rg -n "PreviewAnnotationHeader\|Exit Design\|Discard page annotations" apps/web/src` returns nothing |
| Auto-arm effect keyed on the `capture` object | `PreviewPanel.tsx:3433-3458` (the `pickNext` effect) | `designPickerMachine` | S11-12 | `rg -n "pickNext" apps/web/src/features/preview` returns nothing |
| Composer `PreviewAnnotationBundleChip` and "..." truncation | `ComposerContentSurface.tsx:331-361` | `BrowserNotesTile` | S11-13 | `rg -n "PreviewAnnotationBundleChip" apps/web/src/features/conversation/composer` returns nothing (the component file and its transcript and queue uses go in S11-14) |
| Global numbering shared with diff comments | `previewAnnotationStore.ts:134-147` `renumberAnnotations` | Per-page numbering | S11-13 | `rg -n "renumberAnnotations" apps/web/src` returns nothing |
| `clearThread` wiping diff comments from the notes tile | `ComposerContentSurface.tsx:344-347` | `clearPreviewNotes(threadId)` | S11-13 | `bun run --cwd apps/web test -- src/features/preview/notes/__tests__/BrowserNotesTile.test.tsx` passes, including "removing the notes tile keeps Review comments" (`clearThread` stays for thread teardown) |
| Per-note snapshot and "Annotation N screenshot.png" naming | `browser-preview.ts:491-548` (`previewAnnotationSnapshotAttachmentName`, `...AttachmentMeta`, `...StoredAttachment`, `...Attachments`, `...StoredAttachments`), callers `turn-admission-dispatch-coordinator.ts:599`, `threadStore.ts:2958` | Page snapshots, `previewAnnotationPageSnapshotName` | S11-13 | `rg -n 'previewAnnotationSnapshot\|Annotation \$\{' apps packages` returns nothing |
| Transcript and queued-message chip, snapshot files in the attachment row | `components/chat/PreviewAnnotationBundleChip.tsx`, `MessageBubble.tsx:675-677`, `ComposerQueueList.tsx:296` | `SentBrowserNotesTile` | S11-14 | `rg -n "sent-preview-annotation-bundle-chip\|PreviewAnnotationBundleChip" apps/web/src` returns nothing |
| Memory-only notes | `previewAnnotationStore.ts` `byThread` as sole owner | S10-11's persisted composer draft and snapshot staging | S11-15 | `bun run --cwd apps/web test -- src/lib/composer-draft-storage.test.ts` passes, including the `browserNotePages` round trip and a dropped malformed page (`byThread` stays as the live view over the draft) |
| Visual proposal editor (only if Q7 confirms) | `PreviewPanel.tsx:397-1560,4066`; `proposedChanges`, `changeSummary` in the v2 payload; CONTEXT "Visual proposal", "Annotation change summary" | Note text only | S11-16 | `rg -n "Open annotation visual controls\|VisualProposal\|visualProposal\|proposedChanges\|^### Visual proposal\|^### Annotation change summary" apps/web/src CONTEXT.md` returns nothing (the v1 reader in `packages/contracts` keeps both fields for old messages; plan `changeSummary` is unrelated) |

Not retired here: the rail's per-page sub-tabs and their per-page agent pointer (`ActivityRail.tsx:363-541`). S12P-01 deletes them when Browser pages move to row 1 (12b ledger); S11-04 then restyles the strip.

## Proposed tickets

Foundation tickets: F-01 tokens, F-02 fade, F-03 round buttons, F-04 menus, F-05 right panel shell (section 12 panel author), F-06 provider icon.

### S11-01 Split PreviewPanel into chrome, page and design modules

- **Blocked by:** None (can start immediately).
- **Boards:** none (prefactor)
- **Delivers:** No user-visible change. `PreviewPanel.tsx` (4,301 lines) becomes a thin composition of `BrowserChrome` (header wiring), `BrowserPageLayer` (surfaces, overlays, error and empty states) and `DesignLayer` (picker, bubble, markers, visual inspector), so S11-04, S11-07, S11-10 and S11-12 can land without colliding.
- **Build notes:** Move code without changing it. Keep props explicit. No new state.
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] `PreviewPanel.tsx` under 800 lines; each new module has a TSDoc header.
  - [ ] All existing `features/preview/surfaces/__tests__/*` pass unchanged.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/surfaces/__tests__/PreviewPanel.test.tsx src/features/preview/surfaces/__tests__/browserVisibleConformance.test.tsx`; then open a page, toggle Design, take a screenshot in Electron and compare with main.

### S11-02 Localhost and IP addresses open over http

- **Blocked by:** None (can start immediately).
- **Boards:** 11b New page (`2EPK-2`)
- **Delivers:** Typing `localhost:5173`, `app.localhost:3000`, `127.0.0.1:8080`, `192.168.1.20` or `[::1]:5173` opens over http. Other bare domains keep https.
- **Build notes:** `resolve-target.ts:48-58,81`: return the scheme from one pure function, `http` for `localhost`, `*.localhost`, IPv4 literals and bracketed IPv6; accept bracketed IPv6 in `looksLikeBareDomain`.
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] New `apps/desktop/src/features/preview/navigation/__tests__/resolve-target.test.ts` covers the five inputs above, `example.com` → https, `foo bar` → search.
- **Verify:** `bun run --cwd apps/desktop test -- src/features/preview/navigation/__tests__/resolve-target.test.ts`. Live: run a static server on a free port from `.dev/fixture-repo`, type `localhost:<port>`, and the page loads.

### S11-03 One browser profile per project

- **Blocked by:** None (can start immediately).
- **Boards:** 11c More open (`2F47-2`)
- **Delivers:** Each project has its own cookies and cache, and a page can never run in another project's jar. Clear cookies and Clear cache act on the current project only. A project's browser data is deleted when the server removes the project, from any client, and on the next desktop connect if this desktop missed the removal. The old shared jar is cleared once.
- **Build notes:** Section 1 of Backend architecture. Shared `browserPartitionFor` in `packages/shared/src/browser-preview/browser-partition.ts`. Prepare stores the partition with the adoption token and validated workspace; the renderer appends the webview only after prepare succeeds; attach requires the requested partition to equal the pending record's and calls `sessionForWorkspace` before returning; adopt checks exact session identity; clear uses the window's workspace session. `profiles.remove` runs from the `workspace.deleted` push handler and `profiles.reconcile` after each successful `workspace.list` on connect and reconnect. One-time migration. Rewrite `browser-v2-rollout.md:31-37`. Add the ADR "One browser profile per project".
- **Deletes:** ledger rows "Shared partition" and "Shared-partition paragraph".
- **Acceptance criteria:**
  - [ ] For a surface prepared in project A, attach is refused when the guest requests project B's valid partition, a malformed partition, or carries no prepared token.
  - [ ] Adoption is refused for a guest whose session is not exactly its prepared workspace's session (registry test with two workspace sessions).
  - [ ] Clipboard trust, download denial and the failed-request recorder are installed on a workspace's session before its first guest attaches; popups work in a non-default project.
  - [ ] Cookies set in project A are absent in project B; Clear cookies in A leaves B's cookies.
  - [ ] `workspace.deleted` for A removes A's profile, history and thumbnails, also when another client removed A. Reconcile with a list missing A removes A's profile; a failed `workspace.list` reconciles nothing.
  - [ ] The old partition is gone after first launch; second launch does nothing.
- **Verify:** `bun run --cwd apps/desktop test -- src/features/preview/security/__tests__/electron-session-policy.test.ts src/features/preview/security/__tests__/webview-attachment-policy.test.ts src/features/preview/security/__tests__/browser-profiles.test.ts src/features/preview/surfaces/__tests__/registry.test.ts src/features/preview/__tests__/preview-feature.test.ts`; `bun run --cwd apps/web test -- src/transport/ws-events.test.ts src/features/projects/state/__tests__/workspace-behavior.test.ts`. Extend `electron-session-policy.test.ts` (policy installed on a workspace's session before its first guest; popups in a non-default project), `webview-attachment-policy.test.ts` (attach refused for another workspace's partition, a malformed one, or no prepared token), `registry.test.ts` (two workspace sessions; a cross-workspace partition rejected at adopt), and `preview-feature.test.ts`, which asserts the shared partition today. New `browser-profiles.test.ts`: `clear` per workspace, `remove` deleting the profile and its folder idempotently, `reconcile` removing only absent workspaces, and the one-time removal of the old partition, which does nothing on a second launch. Web: extend `ws-events.test.ts` so the `workspace.deleted` handler calls `profiles.remove`, and `workspace-behavior.test.ts` so only a successful `loadWorkspaces` calls `profiles.reconcile`. Live (Electron): the isolation check needs a second project, so it uses a second fixture workspace created for this check and removed after it. This is the one authorized exception to the `.dev/fixture-repo`-only rule; register no other folder. Steps: `git init .dev/fixture-repo-b` and add it as a project. Serve a cookie-setting page from a fixture-repo terminal without installing anything: `bun -e "Bun.serve({ port: 4321, fetch: () => new Response('ok', { headers: { 'Set-Cookie': 'fixture=1' } }) })"`. Open `localhost:4321` in a fixture-repo thread, then in a fixture-repo-b thread, and confirm the cookie is absent there. Press Clear cookies in fixture-repo-b and confirm fixture-repo keeps its cookie. Remove fixture-repo-b in Mcode, confirm its history folder is gone, then delete `.dev/fixture-repo-b`.

### S11-04 Two-row Browser header with page tabs

- **Blocked by:** S11-01 Split PreviewPanel into chrome, page and design modules; S12P-01 Rail lists tools; terminals and browser pages become row-1 tabs; F-01b Token vocabulary rename; F-02 Fade truncation primitive; F-03 Button primitives; F-04a Menu primitive; F-05 Right panel shell: two-row header, right-edge rail, panel controls.
- **Boards:** 11a (`22JT-2`), 11c URL hovered (`2F1Q-2`), More open (`2F47-2`), Tabs hover and many (`2F9S-2`), 11b New page and Server not running row-2 variants (`2EPK-2`, `2F00-2`)
- **Delivers:** Row 1 shows the thread's pages as tabs with hover close, active fill, shrink and scroll, and a pinned +. Row 2 holds the navigation pill, the URL pill (hover shows Open in browser), Design, Screenshot and More. A new page shows only the URL and More; an error page shows navigation, URL and More. More holds zoom, Device toolbar (Ctrl Shift M), Developer tools (F12), Force reload (Ctrl Shift R), Clear cookies and Clear cache; while the agent controls, it also carries the old Take control row until S11-06. Screenshot arms the capture overlay: click in the page captures the viewport, drag captures a region, Esc cancels. Design and Screenshot are hidden on the web runtime.
- **Build notes:** `BrowserTabStrip`, `BrowserToolbar`, `BrowserUrlPill`, `BrowserMoreMenu` (all values in Boards). `BrowserTabStrip` replaces the interim Browser strip S12P-01 mounted in row 1; S12P-01 already removed the rail's per-page entries. Close on the last tab keeps today's behavior (closes the Browser tab). `capture/overlay.ts` gains a click-means-viewport path. Keybindings in `default-keybindings.json` with a Browser-focused `when`; shortcuts pressed inside the guest page need forwarding through the guest preload (inferred, check `preload/guest-input.ts`).
- **Deletes:** ledger rows for `BrowserHeader`, old overflow menu, Dump page content path, `onRegionCapture` plumbing, `mod+shift+y`.
- **Acceptance criteria:**
  - [ ] Hovering a tab swaps the favicon for a close icon; tab width does not change (assert `getBoundingClientRect().width`).
  - [ ] With 8 tabs in a 536-wide panel, inactive tabs are 96 wide, the strip scrolls, and + stays visible.
  - [ ] The URL shows origin muted and path ink with a 24px fade only when it overflows.
  - [ ] Screenshot click attaches a viewport image; a drag attaches a region image; Esc attaches nothing.
  - [ ] F12, Ctrl Shift M and Ctrl Shift R work with focus in the Browser chrome.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/surfaces/__tests__/BrowserTabStrip.test.tsx src/features/preview/surfaces/__tests__/BrowserToolbar.test.tsx src/components/panels/ActivityRail.test.tsx src/features/preview/surfaces/__tests__/PreviewPanel.test.tsx src/features/preview/surfaces/__tests__/browserVisibleConformance.test.tsx src/features/preview/capture/__tests__/usePreviewCapture.test.ts`; `bun run --cwd apps/desktop test -- src/features/preview/capture/__tests__/overlay.test.ts src/features/preview/capture/__tests__/handlers.test.ts src/features/preview/__tests__/preview-feature.test.ts`. New: `BrowserTabStrip.test.tsx` (hover close at a fixed width, 96-wide inactive tabs with 8 tabs, scrolling, + visible) and `BrowserToolbar.test.tsx` (URL fade, More items, F12, Ctrl Shift M and Ctrl Shift R from the chrome, and the automation cases ported from `BrowserHeader.automation.test.tsx`, which this ticket deletes). Update `ActivityRail.test.tsx`, plus `PreviewPanel.test.tsx` and `browserVisibleConformance.test.tsx`, which render the old header. `overlay.test.ts` adds the click-means-viewport path: a click attaches the viewport, a drag a region, Esc nothing. `usePreviewCapture.test.ts`, `handlers.test.ts` and `preview-feature.test.ts` lose Dump page content. Live (Electron live-testing harness): open three pages, hover a tab, screenshot row 1 and row 2 against 11c; open More and compare with `2F47-2`.

### S11-05 Device toolbar as a third row

- **Blocked by:** S11-04 Two-row Browser header with page tabs.
- **Boards:** 11g (`2FMT-2`)
- **Delivers:** Device toolbar opens as a 40 row under row 2. The page sits centred on the dark stage at the fitted scale. The device menu, size fields, rotate, scale pill and close match 11g. Responsive mode drags the right and bottom handles; the dragged edge and the matching field turn amber and follow live.
- **Build notes:** `BrowserDeviceRow` on the existing `viewportCoordinator` and `BrowserViewportCanvas`. Menu on F-04 with check and muted mono sizes.
- **Deletes:** "Floating device toolbar layout".
- **Acceptance criteria:**
  - [ ] Toggling the row never moves rows 1 and 2.
  - [ ] Size fields clamp to 240-2560; "Fit" shows the computed percent.
  - [ ] Closing with × or Ctrl Shift M restores the full-width page.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/surfaces/__tests__/BrowserDeviceRow.test.tsx src/features/preview/surfaces/__tests__/BrowserViewportCanvas.test.tsx src/features/preview/surfaces/__tests__/browserVisibleConformance.test.tsx`. Port `BrowserViewportToolbar.test.tsx` to the new `BrowserDeviceRow.test.tsx` (rows 1 and 2 never move, size fields clamp to 240-2560, Fit shows the percent, × and Ctrl Shift M close it). Extend `BrowserViewportCanvas.test.tsx`, and update `browserVisibleConformance.test.tsx`, which renders the old toolbar. Live: choose iPhone 15 Pro, rotate, drag the responsive handle; compare with `2FMT-2`.

### S11-06 Take control and Hand back

- **Blocked by:** S11-04 Two-row Browser header with page tabs.
- **Boards:** 11b Agent in control (`2EUZ-2`), You took control (`2EXG-2`); 11c Agent acting (`2F7C-2`)
- **Delivers:** While the agent acts, row 2 shows the agent pill (provider icon, Take control) instead of Design and Screenshot. Clicking the page or Take control stops the agent; row 2 shows Design, Screenshot and a "Hand back" pill. The agent cannot act in any tab of that thread until Hand back. Sending a message does not hand control back (W1): only the explicit Hand back does. The pill disappears when the agent stops acting, so an idle agent never offers Take control.
- **Build notes:** Section 4 of Backend architecture: `reduceBrowserControl`, kernel and web executor wiring, `preview:automation.hand-back`, broker refusal and guidance, inspect `controlEpoch`, MCP description, operating guide line. `useBrowserActing`. `BrowserControlPill` with F-06 icon. Add the ADR "Browser control stays with the user until Hand back" (amends ADR-0018's control paragraph by reference).
- **Deletes:** "Overflow Take control item", "Silent reclaim", "Duplicate CROSS_ORIGIN".
- **Acceptance criteria:**
  - [ ] Reducer table in Backend architecture section 4 is covered row by row.
  - [ ] After a takeover, `browser_act` with the new epoch returns `HUMAN_INTERRUPTED` with recovery `yield_to_user`; after Hand back, an inspect then act succeeds.
  - [ ] Sending a message while the user holds control keeps the hold: the turn it starts gets `HUMAN_INTERRUPTED` on its first `browser_act`, and Hand back stays in row 2. Only Hand back admits the agent again.
  - [ ] `browser_inspect` result has a top-level `controlEpoch`.
  - [ ] Plan-mode inspect never shows the agent pill.
  - [ ] The agent pill hides within 3 s of the last effect.
- **Verify:** `bun run --cwd packages/shared test -- src/browser-preview/__tests__/browser-control.test.ts`; `bun run --cwd apps/desktop test -- src/features/preview/automation/__tests__/browser-automation-kernel.test.ts src/features/preview/automation/__tests__/browser-automation-kernel-races.test.ts`; `bun run --cwd apps/server test -- src/features/browser-automation/execution/__tests__/broker.test.ts src/features/browser-automation/transport/__tests__/mcp-conformance.test.ts`; `bun run --cwd apps/web test -- src/features/preview/automation/__tests__/BrowserAutomationHost.test.tsx src/features/preview/automation/__tests__/browserAutomationStore.test.ts src/features/preview/surfaces/__tests__/BrowserToolbar.test.tsx`. New: `browser-control.test.ts`, the section 4 reducer table row by row. Extend the kernel and races tests (user hold, `agent-turn-ended`, then a new turn's effect is refused; inspect never claims control), `broker.test.ts` (refusal and guidance while held), `mcp-conformance.test.ts` (inspect `controlEpoch`), `BrowserAutomationHost.test.tsx` (sending a message never calls `hand-back`), `browserAutomationStore.test.ts` (the web runtime's Hand back), and `BrowserToolbar.test.tsx` (the agent pill never shows for plan-mode inspect and hides within 3 s of the last effect). Live: in a fixture-repo thread with Codex or Claude, ask the agent to click through `apps/web/public/browser-automation-fixture.html`, click the page mid-run, confirm "Stopped when you took control" in chat and Hand back in row 2. Send "continue" and confirm the agent reports it cannot act and Hand back is still shown. Press Hand back and ask it to continue.

### S11-07 Agent acting on the page

- **Blocked by:** S11-06 Take control and Hand back.
- **Boards:** 11b Agent in control (`2EUZ-2`), 11c Agent acting (`2F7C-2`), Tabs (`2F9S-2`)
- **Delivers:** While the agent acts: amber inset glow on the page, the amber pointer at the agent's position, a 1px amber ring on the URL pill, the amber pointer in place of the favicon on the agent's tab in row 1, and on the rail Browser entry (Q10). An agent-opened background tab appears in row 1 without stealing focus.
- **Build notes:** Paper values in Boards. One overlay for webview and iframe surfaces (merge `BrowserSurfaceControlIndicator` and the `PreviewPanel` overlay). The pointer moves only on controller updates (no animation loop); respect reduced motion.
- **Deletes:** "Gradient edge and old overlay".
- **Acceptance criteria:**
  - [ ] Glow, ring and tab pointer appear and clear together, driven by `useBrowserActing`.
  - [ ] No `requestAnimationFrame` or CSS infinite animation runs while the agent idles.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/surfaces/__tests__/PreviewPanel.test.tsx src/features/preview/surfaces/__tests__/BrowserTabStrip.test.tsx src/components/panels/ActivityRail.test.tsx` (glow, URL ring and tab pointer appear and clear together from `useBrowserActing`; no `requestAnimationFrame` or infinite animation runs while the agent idles). Live: the S11-06 scenario; screenshot during a click step and compare with `2EUZ-2`.

### S11-08 Page history and last-view thumbnails

- **Blocked by:** S11-03 One browser profile per project.
- **Boards:** 11b New page (`2EPK-2`)
- **Delivers:** Desktop records each project's recent pages and a last-view thumbnail per project server origin, and serves them to the renderer.
- **Build notes:** Section 2 of Backend architecture. Bridge `preview.history.list/remove`. Thumbnails never captured for non-loopback origins.
- **Deletes:** nothing.
- **Acceptance criteria:**
  - [ ] History holds at most 50 entries, deduplicated by page identity, newest first; userinfo and fragments are stripped.
  - [ ] At most one capture per origin per 60 s; none while nothing loads.
  - [ ] `profiles.remove` deletes history and thumbnails.
- **Verify:** `bun run --cwd apps/desktop test -- src/features/preview/profiles/__tests__/history-store.test.ts src/features/preview/security/__tests__/browser-profiles.test.ts`. `history-store.test.ts` is new, with a fake clock and a fake `capturePage`. Extend S11-03's `browser-profiles.test.ts` so `remove` deletes history and thumbnails. Live: visit two fixture pages, quit and relaunch, then call `preview.history.list` from the renderer devtools and see both entries.

### S11-09 New page with project servers and recent pages

- **Blocked by:** S11-04 Two-row Browser header with page tabs; S11-08 Page history and last-view thumbnails; S12T-08 Detected port on action runs.
- **Boards:** 11b New page (`2EPK-2`)
- **Delivers:** + opens a new page tab whose URL pill is focused. The page shows one tile per project server in this thread in one of three states: Running shows the last view, a green dot, the name and the port; Starting (the action runs but has no reachable port from this run) shows a dashed tile with a muted "Starting"; Stopped shows a dashed tile with Start, which reruns the action in this thread and opens the page once the new run reports a reachable port. Below, recent pages for this project with favicon, title, server and path, and relative time; clicking opens the page; hover shows remove (Q9). A threadless Browser shows recent pages only.
- **Build notes:** `BrowserNewPage` reads this thread's action runs (`workspace.environment.action.list` and the `workspace.environment.action.updated` push) and `preview.history.list` (S11-08). Tile states and the Start call (`restart` while the run's terminal is open, else `start`) follow Backend architecture section 3, which uses S12T-08's state names and conditions. It reads `run.port` from S12T-08 and adds no port field, listening flag or server-list RPC. Map a recent URL to its server by `run.port.port`. Web runtime: tiles without thumbnails, no recents.
- **Deletes:** "`detectLocalPorts`, `DetectedLocalPort`, `useLocalPorts`, `LocalPortsEmptyState`".
- **Acceptance criteria:**
  - [ ] Starting a stopped server turns its tile Starting, then Running only after S12T-08 reports a reachable port from the new run, then opens `run.port.url`. A port kept from an earlier run never marks the tile Running and never opens the page.
  - [ ] A running action whose port from this run stops answering shows Starting, not Stopped, and offers no Start.
  - [ ] Start on a stopped server whose terminal is still open reruns the action in that terminal (`action.restart`); with the terminal closed it calls `action.start`.
  - [ ] A server whose `run.port.url` has a bracketed IPv6 host opens over http.
  - [ ] Tiles update from the push; no polling timer runs.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/surfaces/__tests__/BrowserNewPage.test.tsx` (new, with fixture runs: running with a reachable port from this run, running before detection, running with this run's port no longer reachable, stopped with a history port and an open terminal, stopped with a closed terminal; and history). Live: in the fixture repo, add a project action whose script prints its URL and serves on a free port without installing anything, for example `bun -e "Bun.serve({ port: 4321, fetch: () => new Response('ok') }); console.log('http://localhost:4321/')"`. Run it once from the ⋯ menu and see its tile turn from Starting to Running. Stop it and see a Stopped tile that keeps the port as history. Press Start on the tile: the action reruns in its open terminal, the tile turns Running again, and the page loads.

### S11-10 Error pages in plain words

- **Blocked by:** S11-04 Two-row Browser header with page tabs; S11-09 New page with project servers and recent pages.
- **Boards:** 11b Server not running (`2F00-2`)
- **Delivers:** Load failures read in plain words with the right next step. Copy:
  - Connection refused on a project port (drawn): "Can't reach localhost:5173" / "Nothing is listening on this port. web in mcode usually runs here." / **Start web**, Retry. Start web uses the tile's Start call (Backend architecture section 3) and loads the page once S12T-08 reports a reachable port from the new run.
  - Connection refused on another local port (proposed): "Can't reach localhost:3000" / "Nothing is listening on this port." / Retry.
  - DNS, offline, reset, other network errors (proposed): "Can't reach example.com" / "Check the address or your connection." / Retry.
  - Certificate (W5; proposed copy, no board), a browser-style warning:
    - Headline: "This connection isn't private".
    - Detail: "The certificate for {host} isn't trusted: {reason}. Someone could be posing as this site." `{reason}` by error: authority invalid, "it's self-signed or from an unknown issuer"; date invalid, "it has expired or isn't valid yet"; name invalid, "it was issued for another name"; revoked, "it was revoked"; anything else, "it's invalid".
    - Buttons: **Back to safety** (primary: back in the tab's history, or the New page when there is none) and Details (secondary).
    - Details expands in place, as a browser's Advanced does: the error code, subject, issuer, valid from and to, and the fingerprint, in mono with Copy, then the text button "Proceed to {host} (unsafe)". Proceed trusts that host and certificate in this project until Mcode quits (Backend architecture section 8) and reloads the page.
    - While the active page uses an exception, the URL pill shows a "Not secure" mark before the origin: a 14px alert icon and "Not secure", 13/20 in `--color-error` (proposed). Clicking it opens a one-item F-04 menu, "Stop trusting {host}", which removes the exception and reloads, so the warning returns.
  - Crash (proposed): "This page crashed" / "Reload to open it again." / Reload.
  - Blocked or missing local file: keep today's copy in the new layout.
  - HTTP 404 and 500 (proposed): no Mcode page; the server's own response shows, because dev servers put stack traces there (Q5).
  - Discarded tab (proposed): no page; activating a cold tab reloads behind the normal loading bar (ADR-0002).
  The failed tab shows a globe and `host:port` as its title.
- **Build notes:** Section 8 of Backend architecture. `BrowserErrorPage` with ink primary and selected-fill secondary buttons.
  - Certificates: `certificate-exceptions.ts` with the `certificate-error` hook, the three `preview:certificate.*` calls on the desktop bridge, `workspaceForSession` on `BrowserProfiles`, `profiles.remove` dropping the workspace's exceptions, the kernel's certificate failure message, and the "Not secure" mark in `BrowserUrlPill`.
  - Add one paragraph to `docs/internals/runtime/browser-v2-rollout.md`: exceptions are per profile and in memory, Mcode answers them from `certificate-error` because `setCertificateVerifyProc` results are cached, and only a user click adds one.
- **Deletes:** "Unused load classifier and copy", "Raw Chromium headline", "`PreviewErrorPanel`", "`http` page error kind".
- **Acceptance criteria:**
  - [ ] No `ERR_` string appears in any headline or detail. The certificate error code appears only inside Details.
  - [ ] Start web only shows when a thread is open and the failed port matches `run.port.port` on one of its action runs.
  - [ ] A main-frame certificate failure shows the warning with the host and its plain reason. Proceed reloads and the page loads.
  - [ ] After Proceed, another tab of the same project opens that host without a warning. The same host in another project still warns, and the same host with a different certificate warns again.
  - [ ] Main refuses `proceed` for a host and fingerprint that did not fail for that surface.
  - [ ] After quitting and relaunching Mcode, the warning shows again.
  - [ ] "Not secure" shows while the active page's host is trusted by an exception and hides on other hosts. Stop trusting removes the exception and the reload shows the warning again.
  - [ ] An agent `open` of the failing URL returns `NAVIGATION_FAILED` naming the certificate error and adds no exception. After the user proceeds, the agent's `open` loads the page.
  - [ ] A subresource certificate failure shows no warning page, and a session that is not a project profile never reads the exceptions.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/navigation/__tests__/nav-errors.test.ts src/features/preview/surfaces/__tests__/BrowserErrorPage.test.tsx src/features/preview/surfaces/__tests__/BrowserToolbar.test.tsx`; `bun run --cwd apps/desktop test -- src/features/preview/security/__tests__/certificate-exceptions.test.ts src/features/preview/automation/__tests__/browser-automation-kernel.test.ts src/features/preview/state/__tests__/page-status.test.ts`. Web: `nav-errors.test.ts` (table of codes to copy), new `BrowserErrorPage.test.tsx` (Start web only for a matching `run.port.port`, and the certificate variant: Details, Proceed then reload, Back to safety with and without history), `BrowserToolbar.test.tsx` (the "Not secure" mark and Stop trusting). Desktop: new `certificate-exceptions.test.ts` (the handler with fake events, sessions and certificates: a trusted pair, an untrusted main frame and subresource, a non-profile session, proceed only for a recorded failure, revoke, `remove`, two workspaces), `browser-automation-kernel.test.ts` (the certificate failure message), and `page-status.test.ts`, which loses the `"http"` kind. Live: open `localhost:<port>` for the stopped fixture action, see the drawn copy, press Start web, and the page loads. Then make a throwaway self-signed certificate in a scratch folder under `.dev/fixture-repo` (for example with the `openssl` that ships with Git), serve from there with `bun -e "Bun.serve({ port: 4443, tls: { cert: Bun.file('cert.pem'), key: Bun.file('key.pem') }, fetch: () => new Response('ok') })"`, open `https://localhost:4443`, see the warning, Proceed, see "Not secure", Stop trusting, and see the warning again. Delete the scratch folder afterwards.

### S11-11 Thread overview Browser row

- **Blocked by:** S11-06 Take control and Hand back; S11-07 Agent acting on the page; S11-10 Error pages in plain words; S03-02 Overview card shell.
- **Boards:** 11e (`2FBY-2`)
- **Delivers:** One Browser row in the overview's Activity group, only while the thread has pages. States, highest priority first: agent acting (amber pointer, live step such as "Clicking Update", page title); you took control (pointer outline, "Paused", page title, Hand back); server not running (clay dot, "web isn't running", Start web); open (favicon or globe, title, host, "+N" when several pages). Clicking the row opens the Browser on that page.
- **Build notes:** `ThreadOverviewBrowserRow` reads `useBrowserActing`, the control hold, the active page error and this thread's action runs (`run.port`, S12T-08). Start web uses the tile's Start call (Backend architecture section 3). Live step from the active request's current step: verb from `BrowserActivityRow` labels plus the target's accessible name when it is a role target; never persisted, since the narrative stays content-free.
- **Deletes:** "Overview Browser section with per-tab rows".
- **Acceptance criteria:**
  - [ ] Each of the five 11e states renders from store fixtures.
  - [ ] Hand back and Start web work from the row.
- **Verify:** `bun run --cwd apps/web test -- src/components/chat/__tests__/ThreadOverviewBrowserRow.test.tsx src/components/chat/ThreadOverview.branchless-pr.test.tsx`. The first is new: each 11e state from store fixtures, plus Hand back and Start web from the row. `ThreadOverview.branchless-pr.test.tsx` still passes. Live: run the S11-06 scenario with the overview open; screenshot each state.

### S11-12 Design mode on the live page

- **Blocked by:** S11-04 Two-row Browser header with page tabs.
- **Boards:** 11b Design mode (`2ES7-2`), 11d (`24CB-2`)
- **Delivers:** Design turns amber. Hovering an element shows the amber box and a mono `tag · label` tip; clicking opens the note bubble under the element (Enter saves, mod+Enter saves and sends, Esc closes the bubble, a second Esc leaves Design). Saved notes keep a dim amber outline and a numbered marker on the live page, numbered per page. Clicking a marker reopens its note for editing. The picker re-arms once after each save. Design is disabled in a threadless Browser with a tooltip (Q11).
- **Build notes:** `designPickerMachine` (off → picking → editing → picking) drives `capture/overlay.ts`; no effect keyed on an object identity. Markers render in the renderer layer above the surface from document-space bounds and scroll. Rewrite CONTEXT "Preview annotation mode" and "Annotation display number".
- **Deletes:** "\"Designing\" bar", "Auto-arm effect keyed on the `capture` object".
- **Acceptance criteria:**
  - [ ] One element pick request per arming (machine test and an IPC call counter).
  - [ ] Markers stay on their elements while scrolling and hide on other pages.
  - [ ] Esc order: bubble, then Design.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/design/__tests__/designPickerMachine.test.ts src/features/preview/capture/__tests__/usePreviewCapture.test.ts src/features/preview/surfaces/__tests__/PreviewPanel.test.tsx`; `bun run --cwd apps/desktop test -- src/features/preview/capture/__tests__/overlay.test.ts`. `designPickerMachine.test.ts` is new: one pick request per arming, the Esc order, one re-arm after a save. `usePreviewCapture.test.ts` counts the pick IPC calls. `PreviewPanel.test.tsx` drops the Designing bar and checks that markers follow scrolling and hide on other pages. `overlay.test.ts` covers the picker in main. Live: annotate two elements on a fixture page, scroll, reload, and compare with `2ES7-2`.

### S11-13 Notes ride the composer

- **Blocked by:** S11-12 Design mode on the live page.
- **Boards:** 11d (`24CB-2`), 11f B (`2FGA-2`, `2FHY-2`)
- **Delivers:** Each saved note lands in the composer at once. One page gives a plain tile "Billing · 1 note" with that page's snapshot and markers; two or more pages give one stacked tile "4 notes · 2 pages" fronted by the last annotated page. Hovering opens the card grouped by page with numbered rows and remove on row hover. Clicking a note opens or activates that page in the Browser and scrolls to the element. Removing the tile drops every note and leaves Review comments alone. On send, the agent gets one marked snapshot per page and the notes as structured JSON.
- **Build notes:** Section 6 of Backend architecture: v2 schema plus v1 reader, per-page numbering, clean capture plus `renderPageSnapshot`, `agent-rpc.ts` v2 fence, turn admission page attachments. `clearPreviewNotes` separate from diff comments. Rewrite CONTEXT "Annotation bundle", "Preview annotation set", "Preview annotation snapshot".
- **Deletes:** "Composer `PreviewAnnotationBundleChip`" (composer use), "Global numbering shared with diff comments", "`clearThread` wiping diff comments", "Per-note snapshot and naming".
- **Acceptance criteria:**
  - [ ] Removing a row renumbers that page and redraws its snapshot within 300 ms.
  - [ ] The sent provider prompt contains `mcode-preview-annotations:v2` and one image per page.
  - [ ] A v1 bundle still parses and renders.
- **Verify:** `bun run --cwd packages/contracts test -- src/models/__tests__/preview-annotation.test.ts`; `bun run --cwd apps/web test -- src/features/preview/state/__tests__/previewAnnotationStore.test.ts src/features/preview/notes/__tests__/BrowserNotesTile.test.tsx`; `bun run --cwd apps/server test -- src/application/transport/__tests__/ws-router.validation.test.ts src/features/agents/orchestration/__tests__/agent-service-turn-cleanup.test.ts`. Contracts: both bundle versions and `readPreviewAnnotationBundle`. Web: per-page numbering, a removal that renumbers and redraws within 300 ms, `clearPreviewNotes`, and the new `BrowserNotesTile.test.tsx`. Server: these two tests assert today's v1 fence and `Annotation 1 screenshot.png` attachment names; extend them for the v2 fence, one image per page, and `previewAnnotationPageSnapshotName`. Live: notes on two fixture pages, hover the stack, remove one note, send; check the stored message's attachments in `.dev/db/app.sqlite`.

### S11-14 Sent notes tile and snapshot viewer

- **Blocked by:** S11-13 Notes ride the composer.
- **Boards:** 11f Sent message (`2FKN-2`, `2FL9-2`)
- **Delivers:** A sent message with notes shows the compact stacked tile above the bubble ("4 notes", page names). A queued follow-up with notes shows the same tile. Hover opens the read-only grouped card. Clicking a note opens that page's snapshot with markers in the image viewer. The snapshots no longer appear as separate files. Old messages (v1) render the same way.
- **Build notes:** `SentBrowserNotesTile`, filter in `MessageBubble`, the queued-row use (`ComposerQueueList.tsx:296`), open `ImageAttachmentLightbox` on the page snapshot attachment.
- **Deletes:** "Transcript and queued-message chip, snapshot files in the attachment row", which removes the last `PreviewAnnotationBundleChip`.
- **Acceptance criteria:**
  - [ ] A v1 message shows one card per page with its original numbers.
  - [ ] The image viewer opens on the clicked note's page.
- **Verify:** `bun run --cwd apps/web test -- src/features/conversation/messages/__tests__/MessageBubble.test.tsx` (v1 and v2 fixtures: one card per page with v1's original numbers, page snapshots out of the attachment row, and the image viewer opening on the clicked note's page). Live: open a thread with a pre-existing v1 message in the `.dev` snapshot (if any) and the S11-13 message; compare with `2FL9-2`.

### S11-15 Notes persist as drafts

- **Blocked by:** S11-13 Notes ride the composer; S10-11 Comment drafts persist, one limit, mentions kept.
- **Reconciled:** Uses the S10-11 draft store. Delete the `thread_annotation_drafts` table and its two RPCs from this brief.
- **Boards:** 11d (`24CB-2`)
- **Delivers:** Notes and their tile survive a reload, a thread switch and an app restart. Send hides the notes it submits until the message is admitted. A note added to the same page meanwhile shows on its own with a fresh snapshot, and the sent message keeps exactly the notes and snapshot it was sent with. Notes clear only when their message is admitted or the user removes them.
- **Build notes:** Section 7 of Backend architecture. Add `browserNotePages` to S10-11's persisted composer draft (pages as containers, notes carrying `DraftElementMeta`) and to `DraftElementField`, with its serializer, parser and round-trip test. Stage each page's clean capture and marked snapshot through `attachments.stageDraft` and keep only `StagedDraftImage` references. Number, show and draw only current notes. At Send, finish the page's pending redraw, then record the note revisions and the page's `snapshot` in S10-11's `DraftSubmission`; a clean capture never enters `stagingIds`. When a submission settles, renumber and redraw each affected page, or remove it when no notes remain. Settling, redraws and removals only drop references; no window deletes a staged image (S10-11's retention rule). `previewAnnotationStore` reads and writes current notes through the draft. Retire the Browser half of the dispatch guard in `composer-submission-annotations.ts:13-38`. No table and no RPC.
- **Deletes:** "Memory-only notes".
- **Acceptance criteria:**
  - [ ] Reload and app restart restore notes, per-page numbers and snapshots; the snapshots survive OS temp cleanup.
  - [ ] Removing a note redraws and re-stages the page snapshot, and the draft drops its reference to the old one. Neither that nor removing the tile deletes a staged file; the files remain until the retention sweep finds them unreferenced. Deleting the thread removes them.
  - [ ] Removing a note and pressing Send within the 300 ms redraw delay sends a snapshot whose markers match the sent notes.
  - [ ] The submission's `stagingIds`, and so `stagedDraftImageIds`, hold page snapshots only, never a clean capture.
  - [ ] Same page during a send: while page A's notes are in a pending submission, saving a note on A shows A with only the new note, numbered 1, and a new snapshot. The submission's note revisions and snapshot staging id do not change. On success the submitted notes are gone and the new note stays as 1. On failure A shows all its notes renumbered in creation order with a redrawn snapshot. Either way the draft drops its reference to each replaced snapshot, and no staged file is deleted.
  - [ ] Another window: a second window whose draft copy predates the send removes the notes tile. No staged file is deleted, and the admitted message still carries A's snapshot.
  - [ ] Admission fails after staging: A's notes return with their snapshot readable, and sending again works without Retake.
  - [ ] Stale window plus failed admission: window A sends page A. A second window whose draft copy predates the send removes page A, and A's admission then fails after staging. In window A the notes return, page A redraws from its clean capture, and sending again succeeds, all without Retake. Page A's clean capture and marked snapshot remain until the retention sweep finds them unreferenced.
  - [ ] Lost success response: when the RPC result is lost but the user message arrives on the stream, or a restart finds the message, the submitted notes are deleted once and later notes stay. When a restart does not find the message, the submitted notes return.
  - [ ] A failed draft write shows "Draft not saved"; a missing staged snapshot fails the send with `draft_image_missing` and shows Retake on that page. No note disappears silently.
- **Verify:** `bun run --cwd apps/web test -- src/lib/composer-draft-storage.test.ts src/features/preview/state/__tests__/previewAnnotationStore.test.ts` (round trip of `browserNotePages` with note revisions, a malformed entry dropped, release on redraw and removal, Send with a pending redraw, snapshot-only `stagingIds`, a same-page note during a send on success and on failure, a second store instance over the same storage removing the tile during a send, that removal followed by a failed admission, a redraw and a successful resend, admission failure, lost success response and restart resolution). The server lease and the copy into message attachments are covered by S10-11's tests. Live: add notes on two fixture pages, quit Electron, relaunch, see the tile, and open a page snapshot from the hover card.

### S11-16 Retire the visual proposal editor (only if Q7 confirms)

- **Blocked by:** S11-12 Design mode on the live page.
- **Boards:** 11b Design mode (`2ES7-2`) and 11d (`24CB-2`): the bubble has no style inspector
- **Delivers:** The note bubble holds text only. Notes always carry note text.
- **Build notes:** Remove the inspector, `proposedChanges` and `changeSummary` from the v2 payload (v1 reader keeps them for old messages), and the CONTEXT entries "Visual proposal" and "Annotation change summary".
- **Deletes:** "Visual proposal editor".
- **Acceptance criteria:**
  - [ ] The ledger proof command returns nothing.
- **Verify:** `bun run --cwd apps/web test -- src/features/preview/surfaces/__tests__/PreviewPanel.test.tsx src/features/preview/state/__tests__/previewAnnotationStore.test.ts`; `bun run --cwd packages/contracts test -- src/models/__tests__/preview-annotation.test.ts`. The contracts test proves v2 rejects `proposedChanges` while the v1 reader keeps it. Both web tests reference the proposal editor today and drop it.

## Tests

- Pure seams first: `resolve-target.test.ts` (new), `nav-errors.test.ts`, the `reduceBrowserControl` table test in `packages/shared`, `readPreviewAnnotationBundle` in contracts, `designPickerMachine.test.ts`, `history-store.test.ts`.
- Desktop main: `security/__tests__/electron-session-policy.test.ts`, `webview-attachment-policy.test.ts`, `surfaces/__tests__/registry.test.ts` (two workspace sessions, cross-workspace partition rejected at attach and adopt), `automation/__tests__/browser-automation-kernel.test.ts` and `-races.test.ts`, `capture/__tests__/overlay.test.ts`, `security/__tests__/certificate-exceptions.test.ts` (new, S11-10).
- Server: `browser-automation/execution/__tests__/broker.test.ts`, `transport/__tests__/mcp-conformance.test.ts` (inspect `controlEpoch`, refusal while held), the agent-rpc fence and turn admission attachment names.
- Web: `PreviewPanel.test.tsx`, `ActivityRail.test.tsx`, `BrowserAutomationHost.test.tsx`, `previewAnnotationStore.test.ts` (current notes and a pending submission through a send), `composer-draft-storage.test.ts` (`browserNotePages`), `BrowserActivityRow.test.tsx`, the `workspace.deleted` and reconcile bridge calls, plus the new component tests named in tickets.
- Live checks use the Electron live-testing harness (`.agents/skills/electorn-live-testing/SKILL.md`) against `.dev/fixture-repo` only. The one exception is S11-03's isolation check, which creates `.dev/fixture-repo-b`, registers it, and removes both the project and the folder afterwards. Agent scenarios use `apps/web/public/browser-automation-fixture.html` or a server started by a fixture-repo project action with a `bun -e` one-liner, so no package is installed. PRs attach before and after captures with `gh pr create --attach`.
- Run per workspace: `bun run --cwd <workspace> test -- <files>`, never `bun test`.

## Risks and open questions

Product calls go to the user; contract shapes go to the named section author.

- **Q1.** Does sending a new message to the thread hand control back? Decided (user, 2026-10-08): no. Only Hand back returns control. A forgotten Hand back therefore blocks the next turn's browser work; the agent is refused with `HUMAN_INTERRUPTED` and told the user has control, and "Paused · Hand back" stays in row 2 and on the overview row.
- **Q2 (user).** The board node "Agent paused · Hand back resumes the queued steps" suggests Hand back replays the interrupted steps. Proposed no replay: the user changed the page, observations are stale, and the operating guide forbids automatic replays (`browser-operating-guide.ts:15`). The agent re-inspects after Hand back.
- **Q3 (user).** Should an agent wait inside its turn for Hand back (a bounded wait on `browser_inspect`)? Proposed no for now; it yields and usually ends its turn. Revisit if paused turns feel abandoned.
- **Q4 (user).** Per-project cookies is marked "default" in the notes, not confirmed. Migration proposal: clear the old shared jar once, so everyone signs in again per project. The alternative, copying the shared cookies into each project, keeps logins but carries the cross-project leak forward.
- **Q5 (user).** HTTP 404 and 500: proposed to show the server's response (dev error overlays matter) and drop the `http` error kind. The alternative is Mcode pages "Page not found" and "The site had an error".
- **Q6.** Certificate errors. Decided (user, 2026-10-08): the user can proceed, as browsers allow. S11-10 builds the warning page, the per-project exception that lasts until Mcode quits, and the "Not secure" mark. The agent never proceeds on its own.
- **Q7 (user).** The visual proposal style inspector (about 1,100 lines) is not on any approved board. Proposed retire (S11-16). If kept, the bubble needs a drawn entry point.
- **Q8 (user).** Screenshot interaction reads as: press Screenshot, then click in the page for the viewport or drag for a region. Today's one-click viewport capture becomes two clicks. Confirm, or make a plain click on the button capture at once and a drag from the button draw a region.
- **Q9 (user).** Recent pages need a way out: proposed row-hover remove, undrawn. No "Clear history" item is proposed.
- **Q10 (user).** Rail Browser entry while the agent acts (undrawn): proposed swap the globe for the amber pointer, the same rule as tabs.
- **Q11 (user).** Threadless Browser: Design needs a thread. Proposed disabled with the tooltip "Open a thread to add notes". Action runs belong to threads, so a threadless New page has no server tiles and shows recent pages only.
- **Q12 (user).** Developer tools moves from `mod+shift+y` to F12 per Paper. F12 may collide with the app's own devtools in dev builds.
- **S10 author.** Diff comment numbering after the per-page split (section 6) is S10's to define.
- **F-03 author.** Paper's header round buttons carry `--color-selected` at rest (the top-level variant), not ghost.
- **Thread overview section author.** S11-11 mounts in the Activity group; confirm its slot and row anatomy.
- **R1.** `PreviewPanel.tsx` churn: S11-01 must land first or parallel tickets collide.
- **R2.** Per-project partitions multiply Chromium storage on disk (one folder per project). Bounded by project count; removal clears it at once and the next launch's reconcile deletes the folder, because Electron cannot delete a partition in use.
- **R3.** A page snapshot covers the viewport at the last save. Notes scrolled out of view carry selector and bounds but no marker in the image. A full-page capture is possible later if agents miss them.
- **R4.** Moving `inspect` out of "claims control" changes which receipts show "Stopped when you took control". A user typing while the agent only reads no longer interrupts it.
- **R5.** The agent pill uses the thread's provider; after a mid-turn handoff it may briefly show the new provider while the old session's last step finishes.
- **R6.** Shortcuts pressed while focus is inside the guest page reach the guest, not Mcode, unless the guest preload forwards them (inferred; check `apps/desktop/src/features/preview/preload/guest-input.ts`).
