---
description: Boot the dev web app and drive it via Playwright MCP for a feature demo
---

Goal: demo a feature end-to-end in the running web app.

1. Run `node scripts/agent/demo.mjs`. It boots `bun run dev:web` (if not already running), polls the dev URL until ready, and prints a Playwright MCP entry point.
2. Use the Playwright MCP tools (registered in `.mcp.json`) to drive the feature: navigate, snapshot, screenshot to `apps/web/e2e/screenshots/demo/`, check console messages.
3. Walk the golden path, then 1–2 edge cases.
4. Report screenshot paths.

See `docs/agents/demo.md` for the full runbook.
