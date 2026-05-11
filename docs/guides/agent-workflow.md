# Agent Development Workflow

When implementing features, follow this workflow. Steps 1-2 are interactive
with the developer. Steps 3-7 are autonomous.

## 1. Understand
Read AGENTS.md, ARCHITECTURE.md, and any relevant code before proposing
changes. Ask clarifying questions if the scope is unclear.

## 2. Plan
Write an implementation plan listing files to create/modify. Include test
files in the plan. Get developer approval before proceeding.

## 3. Implement
Write code and tests per the plan.

## 4. Verify (mandatory)
Run `scripts/agent/verify-tests.sh` (or `bun run verify`) and fix all failures:
- Typecheck must pass with zero errors
- Lint must pass with zero errors
- Unit tests must pass

## 5. Visual Verify (when Playwright MCP is available)
If the change has UI impact and Playwright MCP is connected:
1. Ensure dev server is running (`bun run dev:web` or check localhost:5173)
2. Use `browser_navigate` to open the affected page
3. Use `browser_snapshot` to read the accessibility tree
4. Use `browser_take_screenshot` to capture visual state
5. Check `browser_console_messages` for errors
6. Verify: feature renders, interactive elements work, no regressions

If visual issues are found, fix and re-run from step 4.

## 6. E2E Tests (when applicable)
If the change warrants E2E coverage:
1. Write a Playwright spec in `apps/web/e2e/`
2. Run `scripts/agent/verify-e2e.sh` (or `bun run verify:e2e`)
3. Fix any failures

## 7. Deliver
Commit with a conventional commit message. Show verification results.

## Verification Checklist
Before declaring any task complete:
- [ ] `scripts/agent/verify-tests.sh` passes
- [ ] No TypeScript errors
- [ ] No ESLint errors
- [ ] All unit tests pass
- [ ] UI changes verified visually (if Playwright MCP available)
- [ ] E2E tests pass (if applicable)
- [ ] No browser console errors on affected pages

## Enforcement Hooks

Each agent has a Stop hook that runs `verify-tests.sh` before the agent can
finish a conversation turn. If verification fails, the agent must fix the
errors before it can stop.

| Agent | Config file | How it blocks |
|-------|------------|---------------|
| **Claude Code** | `.claude/settings.json` | exit code 2 |
| **Cursor** | `.cursor/hooks.json` | exit code 2 via `scripts/agent/hooks/cursor-stop.sh` |
| **Codex** | `.codex/hooks.json` | JSON `{"decision":"block"}` via `scripts/agent/hooks/codex-stop.sh` |

Each agent also has a PreToolUse hook that blocks direct `.env` file edits.

The wrapper scripts in `scripts/agent/hooks/` translate the exit code from
`verify-tests.sh` into each agent's expected response format.

## Playwright MCP Setup

The project uses Playwright MCP for visual verification during development.

- **Claude Code:** reads `.mcp.json` automatically
- **Cursor:** reads `.cursor/mcp.json` automatically
- **Other agents:** run `npx @playwright/mcp@latest` and connect via MCP
