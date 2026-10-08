# Astra review, round 6

Verdict: not publishable.

Narrow confirmation of R5-1, R5-2 and R5-3 on `docs/app-page-map`, HEAD `8f254a54a393b1ac7b18f469e3d566cb3e9917b9`, against `430f1b3f1`. Paths below are relative to `docs/plans/ready-for-build/`. Only this review file was written. No existing files were edited and no commit was made.

| Finding | Status | Confirmation and file:line evidence |
|---|---|---|
| R5-1 | RESOLVED | `VERIFY_COMMAND` and extraction recognize the revised commands at `tools/graph.mjs:526-537`; `verify` checks every ticket at `:675-679`. The gate fails an absent runnable Verify command at `:609-614`, checks every named test path at `:550-556,622-629`, and propagates command failures at `:568-574,643-645`. S10-02 now invokes three test commands naming seven files. Failing tests, no runnable Verify command, and each of the seven files independently missing all produce gate exit 1. The plugin build precedes ledger proofs, Verify commands and final lint at `:598-603,615-629,638-640`; the F-01b probe confirms it precedes both its Verify oxlint command and final lint. |
| R5-2 | PARTIAL | The original deletion bug is fixed at `tools/graph.mjs:582-596,632-640`: all changed paths protect the plan and select workspaces; only existing files reach lint. The deleted plan README plus deleted server file plus web edit probe exits 1, checks both server and web, and lints only the web file. Git diff failure also exits 1. However, the new F-99 exception at `:593-596` allows every change anywhere in `sections/*.md`, not only ledger edits. A simulated F-99 edit replacing the resend guarantee outside the ledger at `sections/05-running-turn.md:295` exits 0 and reports `PASS plan folder unchanged`. F-99's authorized change is narrowing an over-broad ledger proof, `sections/00-foundation.md:620-622`. This is a major regression in the plan protection boundary. Restrict the exception to changes within retirement ledgers and reject other section hunks. |
| R5-3 | RESOLVED | Backend 6 step 8 restores both unknown and queued resends, and held rows never expire, `sections/05-running-turn.md:294`. Step 9 commits a stable replacement id before replying, replays that intent, restores the queued copy, and consumes it once in the user-message transaction at `:295-300`. Acceptance criteria cover dropped settle responses, renderer reload, server restart, two-window admission, Edit and Remove at `:535-538`. S06-07 applies the same admission-only rule to queued notes at `sections/06-approvals.md:345-347,552`. This resolves the planning gap; product behavior was not tested. |

The F-99 exception is the only new major problem found in these fixes.

| Required command, run from the plan folder | Result |
|---|---|
| `node tools/graph.mjs check` | Exit 0. 157 tickets, 7 merged, 13 waves. |
| `node tools/graph.mjs ledger` | Exit 0. 285 rows with one active owner and a runnable proof each. |
| `node tools/graph.mjs verify` | Exit 0. Every ticket names a recognized Verify command. |

Probe method: executed the current graph functions in memory against the real graph and briefs, replacing only process and filesystem boundaries with controlled responses. Named tests were presented as existing except for the selected missing-file case. The no-command and F-99 cases changed only in-memory section reads. No probe files, builds, tests or Git mutations were run. These results establish gate control flow, not successful product tests or retirement proofs. The F-99 tool-edit control still fails as expected. An initial supplemental oxlint probe selected F-01a, which has no Verify oxlint command; correcting the probe to F-01b passed.
