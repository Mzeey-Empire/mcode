# Fix round 1: brief for every fix agent

You are revising section build briefs after an independent review. Worktree: `C:\Users\chukwudi.nwobodo\.t3\worktrees\mcode\t3-a03e2ec1`. Paths below are relative to `docs/plans/ready-for-build/`.

## Read first

1. `source/astra-review-round-1.md`: the review. Read every finding assigned to your group, plus its evidence.
2. `source/astra-review-round-1-response.md`: the agreed resolution per finding and which group owns it.
3. `tools/graph.json`: the ticket graph. Its `notes` hold the agreed decision text for each affected ticket, and its `dropped` map lists merged tickets. Treat both as decided.
4. `source/section-doc-template.md`: the section template and rules.
5. Your section files, in full.

## What to do

- Rewrite the affected parts of your section files in place so a fresh implementing agent reads one consistent design. Fix Backend architecture, the ticket bodies (Delivers, Build notes, Deletes, Acceptance criteria, Verify), Tests and Risks. Do not append a "changes" log; the doc should read as if it was written right the first time.
- Merged tickets: move the merged ticket's acceptance criteria and build notes into the absorbing ticket and resolve any conflicting wording. Leave the merged ticket's heading in place with one line saying where it went; the tooling marks it.
- New tickets assigned to you: add a `### <ID> <Title>` heading in the Proposed tickets section using the template fields (Boards, Delivers, Build notes, Deletes, Acceptance criteria, Verify). Leave the Blocked by line as `- **Blocked by:** (set by graph.json)`.
- Do not edit `- **Blocked by:**` or `- **Reconciled:**` lines by hand; `tools/graph.mjs sync-docs` rewrites them from `graph.json`. If you believe the graph needs another edge or merge, say so in your final message instead of editing `graph.json`.
- Retirement ledgers in your files must pass `node tools/graph.mjs ledger` (run it from `docs/plans/ready-for-build`; it prints problems for every file, fix only yours). Each row needs exactly one active owning ticket in the "Deleted in ticket" column and a runnable proof in backticks (`rg -n "<pattern>" <scoped paths>` that must print nothing, or a named `bun run --cwd <ws> test -- <file>` behavioral test when names are intentionally kept). Scope each `rg` to the retired behavior, not a generic word. Escape a pipe inside a table cell as `\|`. Use `node tools/graph.mjs ledger-run <ticket>` to see current hits.
- Verify code claims you add with `path:line`, read-only. Mark anything unverified "(inferred)".
- Live checks must stay inside the authorized boundaries in `AGENTS.md`: product and runtime tests touch only `.dev/fixture-repo`; no global config writes, sign-outs or CLI installs. Use isolated provider homes and scratch prefixes where a check needs them.
- Write clear prose. No em dashes. No mid-sentence colons where a period works.

## Rules

- Edit only your assigned files. No code edits, no git commits, no Paper writes.
- Finish by running `node tools/graph.mjs ledger` and confirming no problems remain in your files.
- Final message, under 20 lines: what you changed per finding, any new ticket headings, any graph edge you recommend, and anything you could not resolve.
