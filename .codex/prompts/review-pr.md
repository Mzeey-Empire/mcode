---
description: Review changes across four dimensions — security, performance, quality, correctness
---

Review the changes in the current branch / PR / argument-supplied ref across four dimensions. In Codex, run them as four sequential focused passes (or parallel chats if you have multiple agents):

1. **Security** — Electron contextBridge surface, child-process spawning, SQLite parameterization, XSS, secrets, log content. Reference `.claude/agents/security-reviewer.md` for the full checklist.
2. **Performance** — bundle size, render hot paths, DB query patterns, the memory/startup targets in `AGENTS.md`.
3. **Quality** — code style per `AGENTS.md`, JSDoc on exports, no needless abstractions, naming.
4. **Correctness** — does the diff do what the PR description claims, edge cases, error handling at boundaries.

Then cross-reference findings, eliminate false positives, and present a single consolidated report grouped by severity (blocker / major / minor / nit).
