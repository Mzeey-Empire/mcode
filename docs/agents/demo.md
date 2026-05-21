# Demoing a feature

How an agent demos a feature in the running Mcode web app. Works the same from Claude Code, Cursor, Codex, or OpenCode — only the entry point differs.

## Prerequisites

```sh
bun install          # once per checkout
bun run doctor       # verify prerequisites
```

Playwright MCP must be connected (configured in `.mcp.json`, `.cursor/mcp.json`, and `.opencode/opencode.json`).

## Entry points

| Harness | Command |
|---------|---------|
| Claude Code | `/demo <feature-name>` |
| Cursor / Codex / OpenCode | `node scripts/agent/demo.mjs` |

Both ultimately run `scripts/agent/demo.mjs`, which:

1. Checks whether `http://localhost:5173` already responds
2. If not, spawns `bun run dev:web` detached and polls (default 60s timeout)
3. Prints the URL, the screenshot directory, and a copy-pasteable Playwright MCP entry point

Override defaults with env vars:

```sh
MCODE_DEMO_URL=http://localhost:5174 MCODE_DEMO_TIMEOUT_MS=120000 node scripts/agent/demo.mjs
```

## Driving the app

Once the script exits 0, drive the app via Playwright MCP tools:

```ts
mcp__playwright__browser_navigate({ url: "http://localhost:5173" })
mcp__playwright__browser_snapshot()       // a11y tree — readable state
mcp__playwright__browser_click({ ref: "<from-snapshot>" })
mcp__playwright__browser_take_screenshot({ filename: "apps/web/e2e/screenshots/demo/<step>.png" })
mcp__playwright__browser_console_messages()  // must be error-free
```

## What to demo

For every feature, walk:

1. **Golden path** — the primary intended flow
2. **One or two edge cases** — empty state, error state, or boundary condition
3. **Regression check** — touch one adjacent feature to confirm nothing nearby broke

Capture a screenshot at each meaningful state so the user can review without re-running the app.

## Reporting

Report back:

- The URL the agent drove
- The list of screenshot paths under `apps/web/e2e/screenshots/demo/`
- Any console errors from `browser_console_messages`
- A one-line verdict per scenario (pass / fail / partial)

## Cleanup

The dev server stays running after `demo.mjs` exits — `dev:web` is intentionally detached so a follow-up `/demo` call is instant. To shut it down:

```sh
# unix-ish
pkill -f "bun run dev:web"

# windows powershell
Get-Process | Where-Object { $_.CommandLine -match "dev:web" } | Stop-Process
```

Or simply close the terminal that spawned it.

## Promoting demos to E2E specs

If a demo flow becomes a regression risk (interactive components, keyboard nav, focus, responsive layout, a11y, floating overlays, persisted state — see `docs/guides/agent-workflow.md`), promote it to a Playwright spec in `apps/web/e2e/` and add it to `bun run verify:e2e`.

## Demoing the Desktop App

The web demo above covers ~95% of features because the React tree is identical under Electron. Use the desktop path **only** when the change touches an Electron-specific surface:

- Native menus or tray
- BrowserView preview pane
- contextBridge IPC (`desktopBridge`, `getPathForFile`)
- Window chrome, multi-window, deep links
- Auto-updater behavior

### Entry points

| Harness | Command |
|---------|---------|
| Claude Code | `/demo-desktop <feature>` |
| Cursor / Codex / OpenCode | `node scripts/agent/demo-desktop.mjs` |

Both:

1. Require `cd apps/desktop && bun run build` to have produced `dist/main/main.cjs` (and `dist/server/server.cjs` for the spawned child).
2. Launch Electron via Playwright's `_electron.launch()` (not the Playwright MCP — the MCP does not support Electron).
3. Wait for the first window, screenshot it to `apps/web/e2e/screenshots/demo-desktop/`, dump renderer console errors.
4. (**Optional**) Pass `--tour` to record `tour-*.png` snapshots (`tour-02b-active-chat.png` opens a sidebar or Recent thread row when present, then captures Changes / Terminal / Preview hotkeys plus `tour-06-changes-header-button.png`).
5. Exit and close the window by default. Pass `--keep-open` to leave Electron running for further interactive driving.

### Driving the running app

Inside a Playwright Node script you can drive the same `BrowserWindow` programmatically:

```ts
import { _electron as electron } from "@playwright/test";
const app = await electron.launch({ args: ["."], cwd: "apps/desktop" });
const win = await app.firstWindow();
await win.click('[data-testid="threads-new"]');
await win.screenshot({ path: "apps/web/e2e/screenshots/demo-desktop/new-thread.png" });
await app.close();
```

See `apps/desktop/e2e/electron-smoke.spec.ts` for the working baseline.

### Promoting desktop demos to E2E specs

Any Electron-only regression risk (window state persistence, tray behavior, IPC roundtrip) goes in `apps/desktop/e2e/` as a new `*.spec.ts` and gets covered by `/verify-e2e-desktop` (`cd apps/desktop && bun run e2e`). Renderer-only flows stay in `apps/web/e2e/` — they run an order of magnitude faster under Vite.
