---
name: build-ticket
description: Build one Ready for build ticket from issue to cross-reviewed PR, routing the writing and review between Claude and Codex. Run as /build-ticket <ticket id or issue number> from a Claude thread.
disable-model-invocation: true
---

# Build a ticket

You own one ticket from `docs/plans/ready-for-build/` until it is an open, cross-reviewed PR. The user merges.

The ticket is the contract. Its acceptance criteria, its Verify line, and its ledger rows define done. Treat everything under `docs/plans/ready-for-build/` as read-only, including `tools/`.

## Poteto Mode

Invoke Poteto Mode before step 1 and work in it for the whole run. This skill's steps replace the Feature playbook's sequence. Where the two overlap, this table decides.

| Feature playbook step | In this skill |
|---|---|
| `how` and `architect` | Run only when the route says `design: open` (step 5). The section brief is the grounding and the design for every other ticket. |
| `architect` design agents | Two seats, Opus xhigh and the Codex design agent. They replace the `architect runners` line in pstack-models. The judge stays as configured. |
| Code writer | The writer named in the route (step 4), never the pstack `feature` model. |
| `interrogate` | Replaced by the Codex review panel (step 9). |
| Principles, reply rules, verification, commits, PR | Poteto Mode, unchanged. |

## Models

| Role | Started with | Model | Options |
|---|---|---|---|
| Codex writer | `delegate_task`, provider `codex` | `gpt-6-astra` | `reasoningEffort: high` |
| Codex reviewer, and each panel seat | `delegate_task`, provider `codex` | `gpt-6-astra` | `reasoningEffort: high` |
| Codex design agent | `delegate_task`, provider `codex` | `gpt-6-astra` | `reasoningEffort: high` |
| Second Claude reviewer | Agent tool | `pstack-opus-xhigh` | none |

Confirm the IDs with `orchestrator_capabilities` before the first delegation.

## Steps

1. **Resolve.** Map the argument to a ticket id and issue number with `docs/plans/ready-for-build/tools/issue-map.json`. Read the issue, its parent epic, and every blocker with `gh issue view`. Done when every blocker is closed. If one is open, report it and stop.

2. **Workspace.** Confirm the thread runs in its own worktree on a new branch from `main`. If it runs in the project root, move it with `t3_worktree_handoff` first. Done when `git status` shows a clean tree on a ticket branch.

3. **Brief.** Follow steps 1 and 2 of "How to build a ticket" in `docs/plans/ready-for-build/README.md`. Open every board the ticket names with the Paper MCP. Done when you have posted a scope note in the thread that lists the files you expect to change, the locked decisions, the ledger rows to delete, and any `decisions.md` default the ticket builds to.

4. **Route.** Run `node docs/plans/ready-for-build/tools/graph.mjs route <id>`. It prints the ticket's lane, risk, and design flag. Post the matching row in the thread and follow it.

   | Lane | Who writes | Who reviews |
   |---|---|---|
   | `frontend` | You | Codex reviewer. The Codex review panel when risk is `high`. |
   | `backend` | Codex writer | You |
   | `backend`, risk `high` | Codex writer | You, then the second Claude reviewer |
   | `cleanup` | Codex writer | The gate's ledger proofs, then you |
   | `mixed` | Codex writer for the contract, server and adapter part, then you for the UI part | You review the Codex part. The Codex review panel reviews the UI part. |

5. **Design.** Skip this step unless the route says `design: open`. Run `architect` with two design agents. Spawn the Opus xhigh seat as `architect` describes. Start the Codex design agent with `delegate_task`, role `design`: "Design ticket <id> on this branch, read-only. Follow `architect`'s runner prompt in `references/runner-prompt.md` of your installed `architect` skill. The grounding is below." Paste the Phase A grounding after it. Done when `architect` has chosen a sketch and you have posted it in the thread.

6. **Build.** Build the vertical slice and delete what its ledger rows name, in this branch.
   - When you write, trace every change to a line in the ticket.
   - When Codex writes, delegate with `delegate_task`, role `implementation`: "Build <whole ticket | the contract, server and adapter part> of ticket <id> on this branch. Follow steps 3, 6 and 7 of `.agents/skills/build-ticket/SKILL.md`. Commit, leave pushing to me, and report the gate output, Decisions I made, and Questions." Add the chosen sketch if step 5 ran, and any prior findings and your responses. The child works in this worktree, so make no edits while it runs. Read `git diff main...HEAD` when it returns.
   - When the brief is silent on a product choice, write the question under "Questions" in the PR, build the smallest version that keeps both answers open, and keep going.
   - Record every choice the brief did not make under "Decisions I made".

   Done when the slice is committed with Conventional Commits.

7. **Gate.** Run `node docs/plans/ready-for-build/tools/graph.mjs gate <id>`. Done when it exits 0. When it fails, fix the product code and rerun. The gate, the ticket's tests, and the ledger stay as they are. A Codex-written failure goes back to a fresh Codex writer with the gate output.

8. **Live check.** If the ticket's Verify line names a live check, run it with `.agents/skills/verify-mcode/SKILL.md` and capture before and after screenshots or video. Report a provider that is unavailable on this machine as pending.

9. **Review.** Run the review your route names.
   - Codex reviewer. Delegate with `delegate_task`, role `review`: "Review ticket <id> on this branch, read-only. Check `git diff main...HEAD` against the issue's acceptance criteria, its ledger rows, and its Paper boards. Report each finding as file:line and the scenario that breaks." Add any prior findings and your responses.
   - Codex review panel. Three Codex reviewers started together with `mode: async`, each with the reviewer prompt narrowed to one lens. Lens one is the acceptance criteria and tests. Lens two is the ledger rows and the per-provider decisions. Lens three is fidelity to the Paper boards. Wait for all three before acting. Merge duplicate findings.
   - You. Review the diff against every acceptance criterion and the named boards, as you would review a colleague's PR.
   - Second Claude reviewer. Spawn it with the reviewer prompt and none of your conclusions.

   Fix each finding, or record why it does not apply. Fixes to Codex-written code go to a fresh Codex writer carrying the brief, the findings, and your responses. Each review round is a fresh delegation. Done when a round returns no findings and the gate still exits 0. After two rounds with findings still open, write the code yourself or, if the finding is a product question, open the PR as a draft with it under "Needs you" and stop.

10. **PR.** Push and open the PR with `.github/pull_request_template.md`. Include `Closes #<issue>`, the lane, who wrote and who reviewed, the gate output, the live evidence, "Decisions I made", "Questions", and one line per review round. Register it with `link_pull_request`. Done when the PR is open and linked.

## Final reply

State the PR link, the lane, the gate result, each review round and what it changed, and every open question. Label each claim as run, inferred, or pending.
