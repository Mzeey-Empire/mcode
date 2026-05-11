# Agent End-to-End Feature Workflow

Design spec for infrastructure that lets any AI agent (Claude Code, Cursor, Copilot, Codex) implement, test, verify, and debug features autonomously after the developer approves a plan.

## Problem

Today, AGENTS.md tells agents to run tests and typecheck, but nothing enforces it. An agent can skip verification entirely. There is no way for an agent to visually verify UI changes -- it writes code blind and hopes the output is correct. When tests fail, there is no structured loop that forces the agent to fix and retry before declaring done.

## Goals

1. Any MCP-capable agent can visually verify UI changes through a shared Playwright MCP configuration
2. Shared shell scripts provide a single verification pipeline any agent can call
3. Claude Code hooks enforce verification as a hard gate (cannot stop without tests passing)
4. AGENTS.md documents the workflow so all agents follow the same process
5. The system supports interactive brainstorming followed by autonomous execution

## Non-Goals

- Fully headless CI mode (GitHub Actions triggering agents from issues) -- future work
- Custom MCP server wrapping Vitest/ESLint into unified tools -- overkill for now
- Agent-specific plugins for Cursor/Copilot beyond shared docs and MCP config

## Architecture

### Workflow Phases

```text
Phase 1: BRAINSTORM (interactive)
  Developer describes feature
  Agent reads AGENTS.md, ARCHITECTURE.md, relevant code
  Agent asks clarifying questions
  Agent writes spec/plan

Phase 2: PLAN (interactive)
  Agent proposes implementation plan with file list
  Developer reviews and approves

Phase 3: IMPLEMENT (autonomous)
  Agent creates/modifies files per the plan
  Agent writes tests alongside implementation

Phase 4: TEST (autonomous, enforced)
  Agent runs scripts/agent/verify-tests.mjs
  Pipeline: typecheck -> lint -> unit tests
  On failure: agent reads error output, fixes, re-runs

Phase 5: VERIFY (autonomous, best-effort)
  Agent uses Playwright MCP to open localhost
  Takes screenshots, reads accessibility tree
  Checks for console errors, visual correctness
  Runs E2E tests: bun run e2e
  On failure: agent fixes and loops back to Step 4

Phase 6: DELIVER (autonomous)
  Agent commits with conventional commit message
  Shows verification results to developer
```

### Infrastructure Pieces

#### 1. Shared Verification Scripts

Location: `scripts/agent/`

**`scripts/agent/verify-tests.mjs`** -- runs static analysis and unit tests:
```bash
#!/bin/bash
set -euo pipefail

# Skip verification if no code changes exist (e.g., brainstorming-only sessions)
if git diff --quiet HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null && \
   git diff --cached --quiet HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null && \
   [ -z "$(git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null)" ]; then
  echo "=== No code changes detected, skipping verification ==="
  exit 0
fi

echo "=== Typecheck ==="
bun run typecheck

echo "=== Lint ==="
bun run lint

echo "=== Unit Tests ==="
bun run test
```

**`scripts/agent/verify-e2e.mjs`** -- runs Playwright E2E tests:
```bash
#!/bin/bash
set -euo pipefail

echo "=== E2E Tests ==="
cd apps/web && bun run e2e
```

**`scripts/agent/verify-all.mjs`** -- runs the full pipeline:
```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/verify-tests.mjs"
"$SCRIPT_DIR/verify-e2e.mjs"

echo ""
echo "=== All verification passed ==="
```

Scripts are split so agents can run partial verification (e.g., just typecheck during iteration) or the full pipeline before delivering.

#### 2. Playwright MCP Configuration

**`.mcp.json`** at project root (agent-agnostic standard):
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

This file is read by:
- Claude Code (natively supports `.mcp.json`)
- Cursor (reads `.cursor/mcp.json`, we symlink or document)
- Other MCP-capable agents

The Playwright MCP server exposes browser automation tools:
- `browser_navigate` -- open a URL
- `browser_click` -- click elements
- `browser_type` -- fill form fields
- `browser_take_screenshot` -- capture visual state
- `browser_snapshot` -- read the accessibility tree (token-efficient)
- `browser_console_messages` -- read console output for errors

Agents use these to open `http://localhost:5173`, interact with the UI, and verify their changes visually.

#### 3. Claude Code Stop Hook

**`.claude/settings.json`** addition:
```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/agent/verify-tests.mjs"
          }
        ]
      }
    ]
  }
}
```

When Claude tries to stop (finish a conversation turn), the hook runs `verify-tests.mjs`. If it fails, Claude receives the error output and must fix the issue before it can stop. This is a hard gate -- the agent cannot declare "done" with failing tests.

The hook runs `verify-tests.mjs` (typecheck + lint + unit tests) rather than `verify-all.mjs` because E2E tests require the dev server running and take longer. E2E verification is guided by AGENTS.md instructions rather than enforced by hook.

#### 4. AGENTS.md Workflow Section

New section added to AGENTS.md:

```markdown
## Agent Development Workflow

When implementing features, follow this workflow. Steps 1-2 are
interactive with the developer. Steps 3-6 are autonomous.

### 1. Understand
Read AGENTS.md, ARCHITECTURE.md, and any relevant code before
proposing changes. Ask clarifying questions if the scope is unclear.

### 2. Plan
Write an implementation plan listing files to create/modify.
Include test files in the plan. Get developer approval before proceeding.

### 3. Implement
Write code and tests per the plan.

### 4. Verify (mandatory)
Run `scripts/agent/verify-tests.mjs` and fix all failures:
- Typecheck must pass with zero errors
- Lint must pass with zero errors
- Unit tests must pass

### 5. Visual Verify (when Playwright MCP is available)
If the change has UI impact and Playwright MCP is connected:
1. Ensure dev server is running (`bun run dev:web` or check localhost:5173)
2. Use `browser_navigate` to open the affected page
3. Use `browser_snapshot` to read the accessibility tree
4. Use `browser_take_screenshot` to capture visual state
5. Check `browser_console_messages` for errors
6. Verify: feature renders, interactive elements work, no regressions

If visual issues are found, fix and re-run from step 4.

### 6. E2E Tests (when applicable)
If the change warrants E2E coverage:
1. Write a Playwright spec in `apps/web/e2e/`
2. Run `scripts/agent/verify-e2e.mjs`
3. Fix any failures

### 7. Deliver
Commit with a conventional commit message. Show verification results.

### Verification Checklist
Before declaring any task complete:
- [ ] `scripts/agent/verify-tests.mjs` passes
- [ ] No TypeScript errors
- [ ] No ESLint errors
- [ ] All unit tests pass
- [ ] UI changes verified visually (if Playwright MCP available)
- [ ] E2E tests pass (if applicable)
- [ ] No browser console errors on affected pages
```

#### 5. Agent-Specific Configuration Bridges

For agents that don't read `.mcp.json` from the project root:

**`.cursor/mcp.json`** (Cursor reads this path):
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

**Documentation in AGENTS.md** for manual setup:
```markdown
### Playwright MCP Setup

The project uses Playwright MCP for visual verification.

Claude Code: reads `.mcp.json` automatically.
Cursor: reads `.cursor/mcp.json` automatically.
Other agents: run `npx @playwright/mcp@latest` and connect via MCP.
```

## File Changes Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/agent/verify-tests.mjs` | Create | Typecheck + lint + unit tests |
| `scripts/agent/verify-e2e.mjs` | Create | Playwright E2E runner |
| `scripts/agent/verify-all.mjs` | Create | Full verification pipeline |
| `.mcp.json` | Create | Shared Playwright MCP config |
| `.cursor/mcp.json` | Create | Cursor-specific MCP bridge |
| `.claude/settings.json` | Modify | Add Stop hook for test enforcement |
| `AGENTS.md` | Modify | Add workflow section + visual verify instructions |
| `package.json` | Modify | Add `verify` script alias |

## Example: Agent Implements "Browser Preview Panel"

1. Developer: "Add a browser preview panel to the chat view, side-by-side with resizable drag handle"
2. Agent reads AGENTS.md, ARCHITECTURE.md, chat component structure
3. Agent asks: "Should the iframe be sandboxed? Should it persist across thread switches?"
4. Developer answers, agent writes plan
5. Developer approves plan
6. Agent creates:
   - `apps/web/src/components/chat/BrowserPreview.tsx`
   - `apps/web/src/components/chat/ChatLayout.tsx` (modified)
   - `apps/web/src/components/ui/ResizeHandle.tsx`
   - `apps/web/e2e/browser-preview.spec.ts`
7. Agent runs `scripts/agent/verify-tests.mjs`:
   - Typecheck passes
   - Lint fails (unused import) -- agent fixes, re-runs -- passes
   - Unit tests pass
8. Agent uses Playwright MCP:
   - Opens localhost:5173, navigates to a thread
   - Screenshots show preview panel renders correctly
   - Drag handle is visible and interactive
   - No console errors
9. Agent runs `scripts/agent/verify-e2e.mjs` -- all specs pass
10. Agent commits: `feat(chat): add resizable browser preview panel`

## Smoke Test: Simulate the Workflow

After all infrastructure is in place, run a live simulation to prove the system works end-to-end. Pick a small, real UI change and execute the full workflow:

### Test Scenario

**Feature:** Add a subtle visual indicator (e.g., a colored dot or icon) to the sidebar thread list showing which threads have active agents.

This is a good smoke test because it:
- Touches a UI component (tests visual verification via Playwright MCP)
- Requires reading existing code (tests the "Understand" phase)
- Is small enough to complete in one session
- Has clear success criteria (dot visible, correct color, no regressions)

### Expected Simulation Steps

1. Developer prompts: "Add an active-agent indicator dot to the sidebar thread list"
2. Agent reads AGENTS.md workflow, explores sidebar components
3. Agent asks clarifying questions (color, position, animation)
4. Agent writes implementation plan, developer approves
5. Agent implements the component change
6. Agent runs `scripts/agent/verify-tests.mjs` -- typecheck, lint, tests pass
7. Agent uses Playwright MCP:
   - Opens `http://localhost:5173`
   - Navigates to the sidebar
   - Takes screenshot showing the indicator
   - Reads accessibility tree to confirm the dot is present
   - Checks console for errors
8. Agent writes a Playwright E2E spec for the indicator
9. Agent runs `scripts/agent/verify-e2e.mjs` -- passes
10. Agent commits with conventional message

### Success Criteria

- [ ] Agent followed all workflow phases without skipping
- [ ] Stop hook fired and `verify-tests.mjs` passed
- [ ] Playwright MCP was used for visual verification
- [ ] Screenshot shows the feature working
- [ ] No manual intervention was needed after "go"
- [ ] Commit follows conventional format

If the simulation fails at any step, that step's infrastructure needs fixing before the system is considered ready.

## Dependencies

- `@playwright/mcp` (npm, devDependency) -- Playwright MCP server
- Playwright browsers (already installed per `doctor.mjs` check)
- No new runtime dependencies

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Stop hook slows down every conversation turn | Script skips verification when no code changes detected; runs only `verify-tests.mjs` (fast), not full E2E |
| Playwright MCP not available for all agents | Graceful degradation: visual verify is "best-effort" per AGENTS.md |
| Agent ignores AGENTS.md workflow instructions | Claude Code has hard enforcement via hooks; other agents rely on docs |
| Dev server not running when agent tries visual verify | AGENTS.md instructs agent to check/start dev server first |
| E2E tests flaky | Existing Playwright config has 2 retries in CI, 0 locally |

## Sources

- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Playwright MCP Setup](https://playwright.dev/docs/getting-started-mcp)
- [Self-Verifying AI Agents (Pulumi)](https://www.pulumi.com/blog/self-verifying-ai-agents-vercels-agent-browser-in-the-ralph-wiggum-loop/)
- [AI QA Engineer with Claude + Playwright](https://alexop.dev/posts/building_ai_qa_engineer_claude_code_playwright/)
- [Playwright AI Ecosystem 2026](https://testdino.com/blog/playwright-ai-ecosystem)
- [Playwright MCP + Claude Code (Builder.io)](https://www.builder.io/blog/playwright-mcp-server-claude-code)
