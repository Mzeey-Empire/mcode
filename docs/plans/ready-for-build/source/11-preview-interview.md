# 11 Preview: codebase interview (2026-10-07)

Read-only investigation before designing section 11. Three explorers (browser core, design mode and capture, agent automation), synthesized and spot-checked. Paths under `apps/web/src` unless noted.

## Overview

The right-panel tab is labelled "Browser" (`lib/panel-tabs.ts:54-60`, singleton, works without a thread). On desktop each page is an Electron `<webview>` in the renderer DOM, positioned by renderer math, all sharing one session `persist:mcode-preview`. On plain web it falls back to an iframe behind `VITE_MCODE_WEB_AUTOMATION=1`, same-origin only. Tabs are per thread (per workspace when threadless), in memory only, and do not survive a restart; cookies and cache do. It has three jobs: browse, design mode (pick elements and annotate them for the agent), and agent automation (an MCP gateway that lets Claude, Codex, Copilot and Cursor drive the browser).

## Browser

- Header (`surfaces/BrowserHeader.tsx`): Back, Forward, Reload (only once loaded), URL field (placeholder "Search or enter URL"), Open in system browser (on hover), Design (only with a loaded page and a thread), Screenshot, More browser tools.
- Overflow (`BrowserOverflowMenu.tsx`): New page, Force reload, Dump page content, Region capture, Developer tools, Show/Hide device toolbar, Take control (agent only), zoom row (− n% + reset, 25% to 500%), Clear cookies, Clear cache.
- Device toolbar (`BrowserViewportToolbar.tsx`): Responsive plus six presets (iPhone 15 Pro, Pixel 8, iPad Air, Surface Pro 7, Laptop 1280×800, Desktop 1440×900), width and height fields (240 to 2560), rotate, scale (Fit to panel, Actual size, 50 to 200%), close.
- Pages: rail sub-tabs per page ("New page" fallback label), New tab, close page; closing the last page closes the Browser tab. No cap on desktop. Popups become new pages. Memory Saver discards idle background pages and rewarms them on activation.
- Opening: rail or `mod+shift+b`; Ctrl/Cmd+click a chat link opens in the Browser (plain click goes to the system browser); empty state lists local servers.
- Input rules (`apps/desktop/src/features/preview/navigation/resolve-target.ts`): http, https and file only. Bare `localhost:3000` or an IP gets `https://` prefixed (verified, `resolve-target.ts:53,81`), so local dev servers fail unless typed with `http://`. Anything else becomes a Google search. Local files under `.env*`, `.git`, `.ssh`, keys, credentials are blocked; a folder opens its `index.html`.
- States: loading bar ("Page loading"); error page with Retry and Go back (file not found, not a regular file, folder without index, blocked file). Network errors show the raw Chromium error name as the headline (the friendly copy in `load-result.ts` is unused). No copy for HTTP 404/500, crash, certificate errors, or a discarded page. Inline URL errors: "Only http, https URLs and local file paths are supported.", "Enter a URL or file path.", "Open a workspace to use relative file paths."
- Empty state: "Local" list of `localhost:{port}` with Online/Offline. `detectLocalPorts` is declared but not implemented on desktop (verified), so it always says "No local servers detected." No link from project actions or dev servers to the Browser.
- Downloads are cancelled silently. One shared cookie jar across all projects; Clear cookies wipes all of it.

## Design mode and capture

- Design (toggle in header): auto-arms an element picker inside the page (amber 2px box, tip "<label> · click to attach"). Click an element, a note bubble opens; Enter saves, Ctrl/Cmd+Enter saves and sends; the picker re-arms for the next element. Esc closes the bubble, then exits. Clicking blank page area or navigating exits silently or with "Click an element on the page."
- After the first saved annotation the header becomes a "Designing · <page>" bar with Exit Design, Discard page annotations, and Send.
- An annotation carries: page URL and title, selector, bounds, an 8,000-char HTML excerpt, 28 computed styles, visible text, heading outline, console tail, failed requests, the note (max 4,000), optional proposed style changes (stored as text and drawn in the snapshot, never applied to the page), and a snapshot PNG with numbered markers taken at save.
- Separate captures (composer attachments, not annotations): Screenshot (viewport), Region capture, Dump page content ("Page context", no image). Max 10 composer attachments.
- Sending: annotations and captures are appended to the message as fenced JSON; the transcript shows a chip and "Annotation N screenshot.png" attachments. Annotations live in memory only and are lost on reload (unlike Review comments, which now persist as drafts per 10).
- Redaction: emails and 13+ digit runs in page text; the note is not redacted.
- Desktop only: design, screenshot, region and page context are no-ops on web.
- Suspected bug (unverified): the auto-arm effect depends on an unmemoized `capture` object and may re-arm in a loop.

## Agent automation

- Providers with browser access: Claude, Codex, Copilot, Cursor (not Devin, OpenCode). Capability by mode: Plan = inspect only; default = open, inspect, act, tabs; Full access = plus evaluate (run script).
- Agent opens its own background tab (does not focus the panel), inspects, acts in batches of up to 8 steps (navigate, back, forward, reload, wait, click, type, press, scroll), and should close its tabs before replying.
- User sees: an "Agent controls Browser" overlay with an animated pointer and edge glow, an amber pointer glyph on the rail page and in the thread overview, chat rows "Using the browser" / "Used the browser" with steps ("Clicking the page", "Entering text") and receipts ("Stopped when you took control", "Stopped at action N of M").
- Control: no per-action approval. Clicking or typing in the page takes control and cancels queued agent work; "Take control" in the overflow menu does the same. There is no "give control back"; the agent's next action silently reclaims it. The menu item stays visible while the controller is the agent even when idle.
- Risks: after a takeover the agent may not learn the new control epoch (inspect does not return it), so it could be stuck (unverified); two recovery vocabularies disagree; some declared states are never produced; recording steps have no indicator.

## Gotchas for the design

- Name: the tab is "Browser" in code; the todo calls the section "Preview".
- Shared session across projects is a privacy and confusion risk (logged in to staging in one project, same cookies in another).
- Agent runs in a background tab the user may never see; the only live signal is the rail glyph and the chat rows.
- Annotation scope differs: discard acts on the current page, send and the composer chip act on the whole thread.
