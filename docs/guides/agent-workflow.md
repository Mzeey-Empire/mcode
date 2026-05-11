# Agent Workflow: Implement, Verify, Deliver

Use this workflow after a plan has been approved. Every step below is
autonomous; do not pause for human input unless you are blocked.

## Implement

Write code and tests per the approved plan. Follow existing patterns in the
codebase. Do not restructure files outside your task scope.

## Verify (mandatory, enforced by Stop hooks)

Run verification and fix every failure before moving on:

```
node scripts/agent/verify-tests.mjs   # or: bun run verify
```

This runs typecheck, lint, and unit tests. All three must pass with zero
errors. The Stop hook runs this automatically when you try to finish a turn,
so you cannot skip it.

If a check fails: read the error output, fix the issue, re-run. Do not
declare a task complete until verification passes.

## Visual Verify (when Playwright MCP is available)

If the change has UI impact and Playwright MCP is connected:

1. Ensure dev server is running (`bun run dev:web` or check localhost:5173)
2. `browser_navigate` to the affected page
3. `browser_snapshot` to read the accessibility tree
4. `browser_take_screenshot` to capture visual state
5. `browser_console_messages` to check for errors
6. Confirm: feature renders correctly, interactive elements work, no regressions

If visual issues are found, fix and re-run from the Verify step.

If Playwright MCP is not connected, skip this step and note it.

## E2E Tests (when applicable)

If the change warrants E2E coverage:

1. Write a Playwright spec in `apps/web/e2e/`
2. Run `node scripts/agent/verify-e2e.mjs` (or `bun run verify:e2e`)
3. Fix any failures

## Deliver

Commit with a conventional commit message. Show verification output as
evidence that all checks passed.

## Before You Declare Done

- [ ] `bun run verify` passes (typecheck + lint + unit tests)
- [ ] UI changes verified visually (if Playwright MCP available)
- [ ] E2E tests pass (if applicable)
- [ ] No browser console errors on affected pages

## Enforcement

Stop hooks run `verify-tests.mjs` before the agent can finish a turn. If
verification fails, the agent receives the error output and must fix it.

| Agent | Config | Block mechanism |
|-------|--------|-----------------|
| Claude Code | `.claude/settings.json` | exit code 2 |
| Cursor | `.cursor/hooks.json` | exit code 2 via `scripts/agent/hooks/cursor-stop.mjs` |
| Codex | `.codex/hooks.json` | JSON `{"decision":"block"}` via `scripts/agent/hooks/codex-stop.mjs` |

PreToolUse hooks also block direct `.env` file edits across all agents.

## Playwright MCP

- **Claude Code:** reads `.mcp.json` automatically
- **Cursor:** reads `.cursor/mcp.json` automatically
- **Other agents:** run `npx @playwright/mcp@latest` and connect via MCP
