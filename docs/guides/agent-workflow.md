---
name: agent-workflow
description: Use when implementing code changes autonomously after a plan is approved. Covers the mandatory verify/visual-check/deliver cycle enforced by Stop hooks.
---

# Agent Workflow

Mandatory workflow for autonomous code implementation. Stop hooks enforce
verification; you cannot finish a turn with failing checks.

## Workflow

```dot
digraph workflow {
    rankdir=TB;
    "Implement per plan" [shape=box];
    "Run bun run verify" [shape=box];
    "Passes?" [shape=diamond];
    "Fix errors" [shape=box];
    "UI change?" [shape=diamond];
    "Visual verify with Playwright MCP" [shape=box];
    "Visual OK?" [shape=diamond];
    "E2E needed?" [shape=diamond];
    "Write spec + run bun run verify:e2e" [shape=box];
    "Commit + show results" [shape=box];

    "Implement per plan" -> "Run bun run verify";
    "Run bun run verify" -> "Passes?";
    "Passes?" -> "Fix errors" [label="no"];
    "Fix errors" -> "Run bun run verify";
    "Passes?" -> "UI change?" [label="yes"];
    "UI change?" -> "Visual verify with Playwright MCP" [label="yes"];
    "UI change?" -> "E2E needed?" [label="no"];
    "Visual verify with Playwright MCP" -> "Visual OK?";
    "Visual OK?" -> "Fix errors" [label="no"];
    "Visual OK?" -> "E2E needed?" [label="yes"];
    "E2E needed?" -> "Write spec + run bun run verify:e2e" [label="yes"];
    "E2E needed?" -> "Commit + show results" [label="no"];
    "Write spec + run bun run verify:e2e" -> "Commit + show results";
}
```

## Verify (mandatory, enforced)

Verification has two tiers. The stop hook runs the **fast gate** on every
turn so type errors and lint violations surface in seconds; the **full gate**
runs at commit time and adds the unit-test suite on top.

| Tier | When it runs | What it runs | How to invoke |
|------|--------------|--------------|---------------|
| Fast gate | Every agent stop hook | Typecheck + Lint (parallel) | `node scripts/agent/verify-fast.mjs` |
| Full gate | Before committing | Typecheck + Lint + Tests (parallel) | `bun run verify` |

Both tiers share the same `hasCodeChanges()` early-exit bypass, so
brainstorming-only sessions with no code edits skip verification entirely.

The Stop hook calls the fast gate automatically when you try to finish a
turn. If typecheck or lint fails, you get the error output and must fix
before you can stop. **Before committing**, run `bun run verify` yourself
to exercise the full gate, including the unit tests. The fast gate alone
does not certify a commit.

Do not run `tsc --noEmit` or test commands individually. Use the tier
appropriate for what you are doing.

**Test scope.** `bun run verify` runs the full unit-test gate whenever
verification runs (it still skips entirely when no code changes are detected).
The Stop hook calls `verify-tests.mjs` directly without `--full`, so it scopes
each workspace's vitest run to tests related to the changed files
(`vitest related <files> --run`) for fast feedback. Any change inside
`packages/contracts` or `packages/shared` falls back to the full suite because
those packages are imported across the repo and vitest's related-file import
graph is per-project.

## Visual Verify (when UI changes + Playwright MCP available)

If Playwright MCP is connected and the change affects UI:

| Step | Tool | Purpose |
|------|------|---------|
| 1 | Check `localhost:5173` is up (or run `bun run dev:web`) | Dev server |
| 2 | `browser_navigate` | Open affected page |
| 3 | `browser_snapshot` | Read accessibility tree |
| 4 | `browser_take_screenshot` | Capture visual state |
| 5 | `browser_console_messages` | Check for errors |

If visual issues found, fix and re-run `bun run verify` before retrying.

If Playwright MCP is not connected, skip and note it.

## E2E Tests

Write E2E tests when the change involves any of these triggers:
interactive components, keyboard navigation, focus trapping, responsive
layout, accessibility semantics, floating overlays, or persisted state.

"If applicable" is not a loophole. A dropdown with keyboard navigation
needs an E2E spec. A color change does not. When in doubt, write the spec.

1. Write a Playwright spec in `apps/web/e2e/`
2. Run `bun run verify:e2e`
3. Fix any failures

## Deliver

Commit with a conventional commit message. Show `bun run verify` output as
evidence that checks passed.

## Before You Declare Done

- [ ] `bun run verify` (the full gate, including unit tests) passes
- [ ] UI changes verified visually (if Playwright MCP available)
- [ ] E2E tests pass (if applicable)
- [ ] No browser console errors on affected pages

The fast gate that the stop hook ran during the turn is not sufficient on
its own — it skips the unit test phase. Run `bun run verify` explicitly
before committing.

## Enforcement

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

## One-time cleanup

After the first per-build nightly release lands, run:

```bash
GH_TOKEN=$(gh auth token) node scripts/agent/one-time-cleanup-rolling-nightly.mjs --confirm
```

This deletes the legacy rolling `nightly` release (49 stale assets) and its tag. Clients on the nightly channel auto-rediscover via `allowPrerelease`.
