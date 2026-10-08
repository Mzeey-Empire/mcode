# Astra review, round 3

Verdict: **No, not publishable on approval of the ticket breakdown alone.** Nine round-2 findings are resolved in the proposed design. N8 and N9 remain partial. E9 and L9 also need explicit user confirmation before their changed behavior is published as agreed scope.

Reviewed HEAD: `f8c1325c15e9fa14712dbdf6c08d4913f69377b5`, `docs(plans): resolve Astra round 2 findings in the Ready for build plan`. This is a narrow confirmation of N1 through N11, the four new decisions, and the changed sections. It is not implementation verification. Only this review file was written; no commits, dependency setup or runtime startup were performed.

Evidence below is relative to `docs/plans/ready-for-build/`. S00, S04, S06, S07, S08, S10, S11, S12a and S12b identify the corresponding files in `sections/`. Line numbers refer to the reviewed HEAD.

## N1 through N11

| Finding | Status | Evidence and judgment |
|---|---|---|
| N1 Revert recovery by filtered equality | RESOLVED | S08:152,248-253,276-290 records and pins raw `pre` and `planned` states before writing, writes the recorded bytes, and compares raw state during rollback and recovery. Unproved paths remain untouched with `recovery_failed`. S08:487-493 requires prepared-state, EOL-only, clean-filter-equivalent and missing-ref cases. |
| N2 Commit recovery heuristic | RESOLVED | S10:328-339 separates a live process's observed outcome from recovery of a `prepared` row. Recovery never promotes that row to `committed` or pushes it based on parent, subject or time. S10:677-682 covers restart before push, an external same-subject commit, crash before settlement and hook rewrites. |
| N3 Implement revision and older versions | RESOLVED | S07:313,357-362,369-372 requires `expectedRevision`, binds it in the fingerprint, and defines implementable statuses. S07:394,406 checks the revision before snapshot and at admission. S07:803-810 covers the second-window save and superseded-version rejection. L9 makes the technical rule consistent, but its product restriction still needs confirmation below. |
| N4 New-thread Implement and Setup | RESOLVED | S04:345-356 and S07:398-402 now share the explicit continuation exception, rather than assuming attachment bypasses Setup. S07:815,820-844 adds S04-07 as a blocker, a server-only skip option checked against the source checkout, cancellation, compensation and reconnect cases. The graph's S07-08 blockers are S07-07 and S04-07. E9 remains a user decision below. |
| N5 Approval refinement bypass | RESOLVED | S06:179-188 applies the same refinement to both exported schemas; S06:203 includes unique choice ids and deny/note invariants. Publish and list use the shared validation step at S06:266-269, with the fail-closed path at 276. Service-boundary negative cases and the valid two-deny ACP case are required at 463-464. |
| N6 Deny-note delivery uncertainty | RESOLVED | S06:322,332-350 distinguishes rejected steering from an unknown outcome, persists `delivery_unknown`, excludes it from automatic dispatch, and gives Send again and Remove. Exactly-once claims are limited to guarded paths. S06:559-564 requires lost-response, crash-after-native-delivery, crash-after-steer and explicit resend cases. Decision P8 is recorded at decisions.md:94. |
| N7 TCP reachability releases Setup | RESOLVED | S12a:185,213,272 excludes synthetic echo from command output. S12a:258,334-335 and S04:391 require exit 0 for Setup. S11:194-200 and S12a:277-285 agree on Running, Starting and Stopped and treat reachability as display information. S12a:602-605,662-667 requires the occupied-port, echoed-URL, IPv6 and print-then-fail cases. |
| N8 Retirement runner and gates | PARTIAL | The required runs now produce useful failures, execute the declared non-search command, and reject an unknown ticket. However `ledger-run S11-15 --rg-only` still exits 0 with no executed proof. `tools/graph.mjs:428-431,458-460` counts skips but omits them from failure. S00:301,371 and README.md:68 also retain the broad lint gate from the accepted scope finding. Blocking edit B1 below. |
| N9 Draft send and image ownership | PARTIAL | S10:380-409 and S11:310-318 now freeze element revisions, copy images at admission and preserve later notes. S07:433-449,758-773 explicitly owns the unsaved comment editor and its persistence. However S10:397 deletes a deferred image when its admission lease ends, including failure, despite S10:406-407,765 and S11:615 promising the draft retains its images. Clean captures are excluded from admission leases at S11:314. Blocking edit B2 below. |
| N10 Autosave conflict recovery | RESOLVED | S07:288,292-301 specifies adoption of the winning draft id and revision for Keep my text, a new fork for a returned ready version, and no such action for an accepted version. S07:698 preserves the identical lost-response replay exception. S07:742-744 requires the complete two-window conflict, resolution and subsequent-save sequence. |
| N11 T3 hold versus default | RESOLVED | decisions.md:151, S12a:334-335,640-654,752 and S04:1162 consistently make exit-0 readiness the executable base and defer Keeps running to a separately defined follow-up. tools/graph.json:701,718 and tickets.md:254,273 say the same. The follow-up question does not hold S12T-11. |

## Ledger execution

Commands below use the prefix `node docs/plans/ready-for-build/tools/graph.mjs` and ran from the worktree root.

| Arguments | Exit | Observed result |
|---|---|---|
| `ledger` | 0 | 282 rows, each with one active owner and a recognized proof command. This validates ledger structure, not retirement. |
| `ledger-run S11-15` | 1 | Invoked `bun run --cwd apps/web test -- src/lib/composer-draft-storage.test.ts`; reported 0 passed, 1 failed, 0 errors, 0 skipped. Bun reported `command not found: vitest`. The test itself did not execute. |
| `ledger-run F-04c --rg-only` | 1 | Both native searches executed and found the model-picker and file-editor-picker code awaiting retirement. Reported 0 passed, 2 failed, 0 errors, 0 skipped. This is the expected pre-implementation result. |
| `ledger-run S99-99` | 1 | Reported `unknown or merged ticket S99-99`. |
| `ledger-run S11-15 --rg-only` | 0 | Additional read-only check of the remaining skip branch: 0 passed, 0 failed, 0 errors, 1 skipped. No proof executed. |

The default runner no longer silently skips the behavioral proof, and the missing test executable produces a failure with a useful diagnostic. The explicit search-only mode still produces a successful process exit without running any proof. Its SKIP text is honest, but its exit status cannot be used as a completed retirement gate. S00:623 already says that any skip is unfinished work.

## New decisions and cross-section check

| Decision | Consistency and confirmation |
|---|---|
| E9 | Sections 04 and 07 agree technically. However source/screen-pass-todo.md:19 says Existing worktree runs Setup on every start, with the live-sibling exception. S04:355 now narrows that locked rule to composer-created starts and adds the continuation exception. decisions.md:69 and S04:1163 still ask the user to confirm it. **Explicit confirmation required**, rather than treating approval of the breakdown as this answer. |
| L9 | S07 consistently hides and rejects Implement on superseded versions, while retaining the ready parent of a user draft. The locked design at source/screen-pass-todo.md:46 and S07:55 describes Implement for the version on screen without that restriction. This is a new restriction, not evidence of an already approved prohibition. S07:982 itself says to confirm it. **Explicit confirmation required.** |
| P8 | decisions.md:94 and S06:339-350 agree. The queue/steer delivery note in source/screen-pass-todo.md:44 does not settle crash uncertainty. Retaining an uncertain note for an explicit Send again is compatible with that decision. It can be approved as a disclosed default with the breakdown; no separate conflict requires an answer first. |
| T3 | decisions.md:151 and sections 04, 11 and 12a agree on exit-0 readiness and the deferred toggle. The locked actions/setup decisions at source/screen-pass-todo.md:59 and S12a:37-40 do not promise port-based readiness or fire-and-forget startup. No separate answer is needed to publish the base ticket. An explicit yes and a defined ticket are needed before adding Keeps running. |

The `git diff HEAD~1 -- docs/plans/ready-for-build/sections` scan found the remaining cross-section contradiction in B2: section 10's deletion mechanism cannot meet section 11's failure-retention promise. The changed approval method names and unknown-delivery states, Implement revision precondition and skip reason, startup action bound, exit-0 readiness, and Browser tile states otherwise agree across their defining and consuming sections. No additional blocking name, constant or state mismatch was found in this pass.

## Blocking edits before publication

### B1. Finish N8: skipped proofs must not return a completed gate

At tools/graph.mjs:458-460, make any skipped proof produce a non-success or explicit incomplete exit status. An all-skipped selection must never exit 0. Keep the counts and SKIP diagnostics. The acceptance check is `ledger-run S11-15 --rg-only`: it must report the skip and return nonzero without needing Vitest installed. Reserve exit 0 for a selection whose required proofs all executed and passed.

Finish the accepted gate-scoping correction as well. S00:301,371 and README.md:68 still prescribe root `bun run lint`; S00:371 also invokes the whole web test workspace. Specify the relevant lint paths and focused tests instead, retaining the root lint configuration and plugin build where needed. The supplied AGENTS.md requires targeted checks and leaves repository-wide checks to CI. This is remaining N8 work, not a new style finding.

### B2. Finish N9: preserve draft images when another window discards during a failed send

Concrete sequence from the current contract:

1. Window A sends a Browser page. Admission leases its marked snapshot and copies it.
2. Window B has an older draft copy and removes that page. S10:397 defers deletion of the leased snapshot until the lease ends. The clean capture has no admission lease and can be deleted immediately under S11:314.
3. Admission fails after staging. Its lease ends, so the deferred snapshot is deleted. A retains its notes, but cannot resend the snapshot or redraw from the deleted clean capture.

That contradicts S10:748,765 and S11:615, which require a failed send to retain readable images and retry without Retake. The separate success-only cross-window test at S10:764 does not cover this combination.

Rewrite S10:397-407 and S11:314-318 so a stale window cannot authorize deletion of another window's retained draft images. Both marked snapshots and clean captures need retention. A small conservative option is to make ambiguous cross-window releases leave staged files for the existing retention sweep, instead of deleting them when an admission lease ends; update the immediate-deletion acceptance criteria accordingly. If immediate reclamation is retained, specify an authoritative reference check across windows and preserve references on admission failure. Add the combined two-window-discard plus failed-admission case, then prove retry and redraw succeed without Retake. Also preserve images referenced by later current notes after a successful admission.

### B3. Record the user's E9 exception

Obtain and record an explicit answer and date in decisions.md:69. If approved, amend the locked Setup account to include the same-checkout plan-implementation exception and link that answer from S04:355 and S07:983. If declined, remove the skip and specify durable Implement waiting through Setup before publication. Approval of ticket sequencing alone does not establish this product exception.

### B4. Record the user's L9 restriction

Obtain and record an explicit answer and date in decisions.md:108. If approved, qualify the locked version-on-screen Implement behavior in S07:55 and the source decision so superseded versions are explicitly read-only and not implementable. If declined, revise the server predicate, picker, commands and acceptance criteria together. S07:982 must no longer present an unanswered product restriction as an engineering decision.

## Non-blocking verification note

S11-15's required run failed because Vitest is unavailable, not because a retirement assertion ran and found old behavior. No tools were installed. Repeat the behavioral proof in a provisioned implementation checkout when that ticket is built; the native search failures already provide the expected pre-implementation evidence here.
