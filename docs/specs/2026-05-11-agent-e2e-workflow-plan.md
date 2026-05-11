# Agent End-to-End Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up infrastructure so any AI agent can implement, test, visually verify, and debug features autonomously after the developer approves a plan.

**Architecture:** Shared shell scripts for verification, Playwright MCP for browser-based visual checks, Claude Code Stop hook for enforcement, and AGENTS.md documentation for the workflow. After infrastructure is built, run a smoke test simulation on a real feature.

**Tech Stack:** Bash scripts, Playwright MCP (`@playwright/mcp`), Claude Code hooks (`.claude/settings.json`), Vitest, Playwright E2E

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/agent/verify-tests.mjs` | Create | Run typecheck + lint + unit tests; skip if no code changes |
| `scripts/agent/verify-e2e.mjs` | Create | Run Playwright E2E test suite |
| `scripts/agent/verify-all.mjs` | Create | Orchestrate full verification pipeline (tests + e2e) |
| `.mcp.json` | Create | Shared Playwright MCP config for all agents |
| `.cursor/mcp.json` | Create | Cursor-specific MCP bridge (same config) |
| `.claude/settings.json` | Modify | Add Stop hook that runs verify-tests.mjs |
| `AGENTS.md` | Modify | Add Agent Development Workflow section |
| `package.json` | Modify | Add `verify`, `verify:e2e`, `verify:all` script aliases |

---

### Task 1: Create verification scripts

**Files:**
- Create: `scripts/agent/verify-tests.mjs`
- Create: `scripts/agent/verify-e2e.mjs`
- Create: `scripts/agent/verify-all.mjs`

- [ ] **Step 1: Create the scripts/agent/ directory**

Run: `mkdir -p scripts/agent`

- [ ] **Step 2: Create verify-tests.mjs**

Create `scripts/agent/verify-tests.mjs`:

```bash
#!/bin/bash
set -euo pipefail

# Skip verification if no code changes exist (e.g., brainstorming-only sessions).
# Checks staged, unstaged, and untracked .ts/.tsx/.js/.jsx files.
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

echo ""
echo "=== All checks passed ==="
```

- [ ] **Step 3: Create verify-e2e.mjs**

Create `scripts/agent/verify-e2e.mjs`:

```bash
#!/bin/bash
set -euo pipefail

echo "=== E2E Tests ==="
cd apps/web && bun run e2e
```

- [ ] **Step 4: Create verify-all.mjs**

Create `scripts/agent/verify-all.mjs`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/verify-tests.mjs"
"$SCRIPT_DIR/verify-e2e.mjs"

echo ""
echo "=== All verification passed ==="
```

- [ ] **Step 5: Make all scripts executable**

Run: `chmod +x scripts/agent/verify-tests.mjs scripts/agent/verify-e2e.mjs scripts/agent/verify-all.mjs`

- [ ] **Step 6: Test verify-tests.mjs with no changes**

Run: `node scripts/agent/verify-tests.mjs`
Expected: "No code changes detected, skipping verification" (exit 0, since we have no uncommitted code changes)

- [ ] **Step 7: Test verify-tests.mjs with a dummy change**

Create a temporary change, run the script, then revert:

```bash
echo "// temp" >> apps/web/src/app/App.tsx
node scripts/agent/verify-tests.mjs
git checkout apps/web/src/app/App.tsx
```

Expected: Script runs typecheck, lint, and unit tests. All pass.

- [ ] **Step 8: Add npm script aliases to root package.json**

Add these scripts to the `"scripts"` section of `package.json`:

```json
"verify": "node scripts/agent/verify-tests.mjs",
"verify:e2e": "node scripts/agent/verify-e2e.mjs",
"verify:all": "node scripts/agent/verify-all.mjs"
```

- [ ] **Step 9: Commit**

```bash
git add scripts/agent/ package.json
git commit -m "feat: add agent verification scripts

Shared shell scripts that any AI agent can call to verify code changes:
- verify-tests.mjs: typecheck + lint + unit tests (skips if no changes)
- verify-e2e.mjs: Playwright E2E test suite
- verify-all.mjs: full pipeline combining both"
```

---

### Task 2: Configure Playwright MCP

**Files:**
- Create: `.mcp.json`
- Create: `.cursor/mcp.json`

- [ ] **Step 1: Create .mcp.json at project root**

Create `.mcp.json`:

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

- [ ] **Step 2: Create .cursor/mcp.json**

Run: `mkdir -p .cursor`

Create `.cursor/mcp.json` with the same content:

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

- [ ] **Step 3: Verify Playwright MCP server starts**

Run: `npx @playwright/mcp@latest --help`
Expected: Help output from the Playwright MCP server (confirms the package is accessible via npx).

- [ ] **Step 4: Commit**

```bash
git add .mcp.json .cursor/mcp.json
git commit -m "feat: add Playwright MCP configuration for all agents

Shared .mcp.json at project root (Claude Code) and .cursor/mcp.json
(Cursor) so any MCP-capable agent can use browser automation for
visual verification during development."
```

---

### Task 3: Add Claude Code Stop hook

**Files:**
- Modify: `.claude/settings.json`

- [ ] **Step 1: Read current settings**

Read `.claude/settings.json` to confirm current state. It currently has a `PreToolUse` hook that blocks `.env` edits:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'if echo \"$TOOL_INPUT\" | grep -qE \"\\.env(\\.|$)\"; then echo \"BLOCK: Do not edit .env files directly. Update .env.example instead.\"; exit 2; fi'"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Add Stop hook**

Update `.claude/settings.json` to add the `Stop` hook alongside the existing `PreToolUse` hook:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'if echo \"$TOOL_INPUT\" | grep -qE \"\\.env(\\.|$)\"; then echo \"BLOCK: Do not edit .env files directly. Update .env.example instead.\"; exit 2; fi'"
          }
        ]
      }
    ],
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

- [ ] **Step 3: Verify hook is registered**

After editing, the hook can be verified by running `/hooks` in a Claude Code session and checking that `Stop` appears with 1 hook configured. For now, confirm the JSON is valid:

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('Valid JSON')"`
Expected: "Valid JSON"

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.json
git commit -m "feat: add Stop hook to enforce verification before completion

Claude Code cannot finish a conversation turn without verify-tests.mjs
passing. The script skips verification when no code changes are
detected, so brainstorming-only sessions are unaffected."
```

---

### Task 4: Update AGENTS.md with workflow documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Read current AGENTS.md ending**

Read the end of `AGENTS.md` to find the right insertion point. The new section should be added before the `## Worktrees` section (line 207), as it's a workflow concern that agents need to see prominently.

- [ ] **Step 2: Add Agent Development Workflow section**

Insert the following before the `## Worktrees` section in `AGENTS.md`:

```markdown
## Agent Development Workflow

When implementing features, follow this workflow. Steps 1-2 are interactive
with the developer. Steps 3-7 are autonomous.

### 1. Understand
Read AGENTS.md, ARCHITECTURE.md, and any relevant code before proposing
changes. Ask clarifying questions if the scope is unclear.

### 2. Plan
Write an implementation plan listing files to create/modify. Include test
files in the plan. Get developer approval before proceeding.

### 3. Implement
Write code and tests per the plan.

### 4. Verify (mandatory)
Run `scripts/agent/verify-tests.mjs` (or `bun run verify`) and fix all failures:
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
2. Run `scripts/agent/verify-e2e.mjs` (or `bun run verify:e2e`)
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

### Playwright MCP Setup

The project uses Playwright MCP for visual verification during development.

- **Claude Code:** reads `.mcp.json` automatically
- **Cursor:** reads `.cursor/mcp.json` automatically
- **Other agents:** run `npx @playwright/mcp@latest` and connect via MCP
```

- [ ] **Step 3: Verify AGENTS.md is well-formed**

Read the modified file and confirm the new section sits between the existing content and `## Worktrees`, with no formatting issues.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add agent development workflow to AGENTS.md

Documents the implement/test/verify/deliver workflow that all AI agents
should follow. Includes verification checklist and Playwright MCP
setup instructions for Claude Code, Cursor, and other agents."
```

---

### Task 5: Smoke test -- verify the infrastructure works

This task proves the system works by running the full workflow on a real change.

**Files:**
- No new files; uses existing infrastructure from Tasks 1-4

- [ ] **Step 1: Verify all scripts exist and are executable**

Run:
```bash
ls -la scripts/agent/verify-tests.mjs scripts/agent/verify-e2e.mjs scripts/agent/verify-all.mjs
```
Expected: All three files listed with execute permissions.

- [ ] **Step 2: Verify .mcp.json exists**

Run: `cat .mcp.json`
Expected: JSON with `mcpServers.playwright` configured.

- [ ] **Step 3: Verify Stop hook is configured**

Run: `cat .claude/settings.json`
Expected: JSON with both `PreToolUse` and `Stop` hooks.

- [ ] **Step 4: Verify AGENTS.md has the workflow section**

Run: `grep -c "Agent Development Workflow" AGENTS.md`
Expected: `1`

- [ ] **Step 5: Run verify-tests.mjs on clean state**

Run: `node scripts/agent/verify-tests.mjs`
Expected: "No code changes detected, skipping verification" (clean working tree).

- [ ] **Step 6: Run verify-tests.mjs with a real change**

Make a trivial code change (add a blank line to a file), run the script, confirm all checks pass, then revert:

```bash
echo "" >> apps/web/src/app/App.tsx
node scripts/agent/verify-tests.mjs
git checkout apps/web/src/app/App.tsx
```

Expected: Typecheck, lint, and unit tests all pass.

- [ ] **Step 7: Run verify-e2e.mjs**

Start the dev server if not already running, then run:

```bash
node scripts/agent/verify-e2e.mjs
```

Expected: All Playwright E2E tests pass.

- [ ] **Step 8: Test Playwright MCP browser verification (if MCP is connected)**

If Playwright MCP is available in the current session:
1. Use `browser_navigate` to open `http://localhost:5173`
2. Use `browser_snapshot` to read the accessibility tree
3. Use `browser_take_screenshot` to capture the current state
4. Confirm: page loads, sidebar visible, no console errors

If MCP is not connected, note this as expected -- the MCP tools are available when agents start a new session with the `.mcp.json` config in place.

- [ ] **Step 9: Run the full pipeline**

Run: `node scripts/agent/verify-all.mjs`
Expected: All checks pass (or "no changes detected" followed by E2E pass).

- [ ] **Step 10: Document results**

Report the verification results:
- verify-tests.mjs: PASS/FAIL
- verify-e2e.mjs: PASS/FAIL (with test count)
- Playwright MCP: CONNECTED/NOT AVAILABLE
- Stop hook: CONFIGURED (verified via settings.json)
- AGENTS.md workflow section: PRESENT
