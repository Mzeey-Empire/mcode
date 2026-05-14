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

1. Checks whether `http://127.0.0.1:5173` already responds
2. If not, spawns `bun run dev:web` detached and polls (default 60s timeout)
3. Prints the URL, the screenshot directory, and a copy-pasteable Playwright MCP entry point

Override defaults with env vars:

```sh
MCODE_DEMO_URL=http://127.0.0.1:5174 MCODE_DEMO_TIMEOUT_MS=120000 node scripts/agent/demo.mjs
```

## Driving the app

Once the script exits 0, drive the app via Playwright MCP tools:

```ts
mcp__playwright__browser_navigate({ url: "http://127.0.0.1:5173" })
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
