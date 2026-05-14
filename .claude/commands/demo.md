---
description: Boot the dev web app and prepare a Playwright MCP session for demoing a feature
argument-hint: [feature-name]
---

Goal: demo the feature `$ARGUMENTS` end-to-end in the running app.

1. Run `node scripts/agent/demo.mjs`. It boots `bun run dev:web` (if not already running), polls the dev URL until ready, and prints the URL + a Playwright MCP entry point.
2. Use the Playwright MCP tools to drive the feature:
   - `mcp__playwright__browser_navigate` to the printed URL
   - `mcp__playwright__browser_snapshot` to read the accessibility tree
   - `mcp__playwright__browser_take_screenshot` to capture state to `apps/web/e2e/screenshots/demo/`
   - `mcp__playwright__browser_console_messages` to surface any errors
3. Walk the golden path for `$ARGUMENTS`, then 1–2 edge cases.
4. Report screenshot paths so the user can review without re-running the app.

See `docs/agents/demo.md` for the full runbook.
