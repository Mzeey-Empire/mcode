# Astra review, round 2

The plan is not ready to publish as executable GitHub issues, even after approval of the breakdown. Most round-1 corrections are present, and the graph passes with 156 tickets, 7 merged/deferred entries and 13 waves. The ledger validator passes 282 rows, but its runner can report success without executing a required proof. Fix N1 through N11 below before publication. These findings concern the proposed implementation, not reproduced product failures. Reviewed HEAD: `bdf74d203b98fafbab4bc2333dfe7a817bd8ba87`. Only this review file was written.

Evidence shorthand: `S00`, `S01`, `S03`, `S04`, `S05`, `S06`, `S07`, `S08`, `S10`, `S11`, `S12a`, and `S12b` mean the corresponding files in `sections/`. `graph` means `tools/graph.json`; other paths are relative to this plan directory unless prefixed with `apps/`, `packages/`, or named as repository documents. Line numbers refer to the reviewed commit.

## Round-1 findings

| Finding | Status | Current evidence and remaining work |
|---|---|---|
| C1 Revert identity | RESOLVED | S08:150,184-186,234-240 separates request identity from the raw-state precondition. S08:481-483 tests apply/undo/apply, replay, parameter conflicts and mode/type changes. |
| C2 Revert recovery | PARTIAL | S08:152,249,274-287 prepares and pins raw recovery before writes; S08-05 is absorbed. However startup recovery identifies the operation's writes through filtered blob equality, which can overwrite later raw-byte edits. N1. |
| C3 Snapshot ownership | RESOLVED | S10:342-356 specifies a store namespace, a new identity for a copied database, capture-time baseline pins, owner-only sweeping and backfill. S08:346-348 shares it and retains unfinished recovery refs. |
| C4 Implement admission | PARTIAL | S07:348-398 makes Accepted atomic with canonical admission and adds reservations, durable requests and conditional cleanup. The request still lacks the client's revision precondition when no save is pending, and new-thread admission assumes attached worktrees skip Setup. N3, N4. |
| C5 Browser project binding | RESOLVED | S11:126,151-158 binds prepare, attach and adopt to the exact workspace partition; deletion follows the server and reconnect reconciliation requires a complete successful list. |
| C6 Approval choices and fail-closed | PARTIAL | S06:200-202 preserves both ACP deny choices and full scope; S06:263-279 distinguishes acknowledged denial from stop. But publish/list validate the body schema without the choice refinement attached to the final schema. N5. |
| C7 Deny notes and queue retention | PARTIAL | S06:319-335 persists notes; S04:628-631,1022-1024 preserves and pauses queued input on unsuccessful endings. S06:332 explicitly permits duplicate note delivery, contradicting S06:536,543-547. N6. |
| C8 Absent Git index | RESOLVED | S10:182-189 initializes an empty temporary index only for a missing source index, preserves existing staged/conflicted entries, propagates other errors and cleans up. |
| C9 Commit recovery | PARTIAL | S10:299-336 persists requests and captures the push destination, but its recovery heuristic can claim and push another actor's commit. N2. |
| C10 Plan protocol order | RESOLVED | S07:567-596 adds a bounded six-provider investigation and evidence-dependent fallback. S07:624-631 activates Codex mode with questions and cancellation. Graph dependencies include S07-00 before S07-01 and S07-09 before S07-02/12/13/14. |
| C11 Native plan-file ownership | RESOLVED | S07:454-455,469-475 requires a session-named exact path, containment, regular-file and hash checks; unproved paths are left alone. Native tickets depend on the investigation. |
| C12 Plan autosave | PARTIAL | S07:284-294 replaces client counters with server revisions and keys the first fork. However the losing window's "Keep my text" action cannot follow the specified fork rules without changing its draft identity. S07:666 also contradicts the replay exception. N10. |
| C13 Port readiness | PARTIAL | S12a:260-277 handles IPv6, current-run identities and display history; S11:186-202 consumes that contract. S12a:275 admits the listener may belong to another process, yet S12a:326 releases Setup on that signal. N7. |
| C14 Subagent evidence | RESOLVED | S12b:243-252 preserves entry identity, distinguishes readable children from aliases, gives honest empty-step copy and owns status normalization. S05:377-381 consumes entry provider/status through S12P-08. |
| B1 Startup executor | RESOLVED | S04:353-374 delegates execution to S12T-11 and uses action IDs, hashes and run IDs. S12a:301,320-354 owns bounds, retry, tail and atomic consumer conversion. S04-08 is dropped; both required graph edges exist. Readiness remains separately open under C13/E1. |
| B2 Seen protocol | RESOLVED | S01:126-164 owns `thread.acknowledgeSeen`, observed settled sequence, atomic previous/current marks and no-op repeats. S08:332-338 consumes its first advancing response and owns cumulative filtering. |
| B3 Qualified refs | RESOLVED | S03:186-218 owns `git.refs.list`, purpose/side, cursor, result, worktree context and sorting. S10:248-254 delegates to it and preserves local/origin twins. |
| B4 One draft store | PARTIAL | S10:359-392 and S11:308-316 agree on ComposerDraft, serializer/parser, exclusions and durable staging. In-flight page edits and staged-image disposal still lack a consistent ownership rule. N9. |
| B5 Terminal cap and ADR | RESOLVED | S12a:167-170 and S12b:373-386 consistently use eight pending/running/exited records. S12P-01 depends on S12T-01 and owns the single ADR. |
| B6 Approval location | RESOLVED | S06:261, S01:185 and S12b:319 agree on the source/owner thread, with target ownership only for an external integration lacking a source. |
| B7 Image route | RESOLVED | S12b:182-187 owns `/workspace-images`, both scopes, authentication, containment, SVG policy, 2 MB/20 MB caps and caller-specific caching. S12a:384,389 reuses it; S12T-14 depends on S12P-03. |
| A1 Missing edges | RESOLVED | All six requested edges are present at graph:163-201,356-360,439-444,597-601. An independent in-memory assertion also checked the additional round-1 prerequisite edges; none was missing. |
| A2 Ticket scope | RESOLVED | S07:182-191,644-671 narrows S07-03 and assigns comments, Implement and classification separately. Graph:297-300 adds S06-00 before the coordinated approval-v2 conversion. The remaining large conversions have coherent atomicity requirements. |
| A3 Unbuildable S02-04 | RESOLVED | Graph:87 removes it from active blockers and F-99; decisions.md:11 makes it design backlog. The separate default/hold inconsistency is N11. |
| D1 Retirement ownership | RESOLVED | S00:287-291 assigns pickers, glyphs and toasts; S12a:444-465 assigns modern backend, action menu and Setup retirement to active tickets. S05:258 and S12b:340 defer glyph retirement to F-06. The validator finds one active owner per row. |
| D2 Runnable retirement proofs | PARTIAL | Rows now name commands and owners, and previously overbroad palette/visual-editor searches are narrowed at S12b:325 and S11:394. However behavioral proofs are silently skipped, only the first command is considered, and the runner is unusable through this machine's Bash. N8. |
| D3 Historical plans | RESOLVED | S07:186,604-607 retains bounded legacy fence reading; S07:655,663 retains canonical-record loading. README:49 explicitly preserves historical plan and Browser-v1 readers. |
| E1 Startup and draft defaults | PARTIAL | decisions.md:146 discloses both command/shell differences; PRODUCT.md:123-126 distinguishes memory-only settings drafts. T3 still alternates between an executable default and a required user decision. N11; readiness safety is N7. |
| F1 Verification boundaries | RESOLVED | README:68-71 uses targeted checks and isolated homes/prefixes. S01:557-561,575-579 removes global credential/install mutation. S11:626 explicitly describes the second disposable fixture exception for approval with this plan. No such mutations were performed here. Remaining foundation-wide gates are part of N8. |
| F2 Immutable issue links | RESOLVED at plan stage | `tools/graph.mjs:18-19,214,224,278,301` uses `RFB_REF` for ticket and epic links. This suffices when publication sets it to the full published commit SHA and checks accessibility/anchors. The fallback is still a mutable branch, so publishing without that environment value does not satisfy F2. Remote publication was not verified and issue generation was not run because it writes other files. |

## New and residual findings, ranked

### N1 | blocker | Revert recovery can overwrite edits made after a crash

**Claim:** The new raw backup does not make the recovery decision byte-exact. Recovery treats filtered equivalence as proof that the interrupted operation wrote a path.

**Evidence:** S08:247 says `currentBlobIds` applies clean filters. S08:284 restores whenever that result equals the planned before-blob, whereas S08:485 promises that a path edited after the crash is left alone. For example, crash after restoring a CRLF file, then change its line endings externally. With EOL normalization, the filtered blob still matches, and startup overwrites the newer raw bytes. A clean filter that removes comments gives the same problem for substantive edits.

**Concrete fix:** In S08-03, persist the exact intended post-state before changing each path and compare raw content, type and mode during recovery. If that state cannot be proved, retain recovery material and report `recovery_failed` without overwriting. Add crash cases with subsequent EOL-only and clean-filter-equivalent edits. Do not infer writer identity from filtered equality.

### N2 | major | Commit recovery can claim and push an unrelated commit

**Claim:** Parent SHA, subject and committer time do not identify a request's commit.

**Evidence:** S10:333 calls those three matches proof; S10:330 then pushes the recovered SHA to the captured destination. After the prepared row is written but before Mcode commits, a crash followed by an external commit with the same subject and parent satisfies that test. Conversely, a valid hook rewrite becomes `unknown` at S10:334. Nothing durably binds the request to the Git result.

**Concrete fix:** S10-08 must either establish a durable request-specific Git identity and explain recovery of it, or return `unknown` whenever ownership is unproved. The latter is the smaller safe default. Never push a heuristically attributed commit. Add the external-same-subject case, lost response, hook rewrite and restart-before-push to acceptance tests.

### N3 | major | Implement can admit text the user did not approve

**Claim:** The durable request snapshots the server's current draft, rather than necessarily the revision visible when the user clicked Implement.

**Evidence:** S07:306 accepts a revision only inside optional `pending`. With no pending edit, the request contains `versionId` alone. S07:380 records whatever revision exists when Prepare runs; S07:388 checks against that server-captured revision. Another window can save first, so the clicked version number stays the same while its text changes. Also S07:764 requires implementing an older version, but S07:268 supersedes predecessors and S07:388 accepts only draft/ready rows.

**Concrete fix:** Require an expected revision for every Implement request, bind it in the fingerprint, and compare it before taking the text snapshot and again at admission. Define whether an explicitly selected superseded version is implementable; align the predicate, UI and older-version acceptance criterion. Test a second-window save between display and click admission.

### N4 | major | New-thread Implement assumes a Setup exemption another ticket removes

**Claim:** The new-thread failure/cleanup model is written for immediate admission, but its target can now wait on automatic Setup.

**Evidence:** S07:384 says an attached existing worktree avoids the Setup gate. S04:343-350 explicitly changes eligibility to include attached worktrees. S07:395-398 treats a returned-but-unadmitted request as failed and can remove its empty destination, while S07:773-784 promises one durable target. Graph:366-368 gives S07-08 only S07-07 as a blocker.

**Concrete fix:** Choose one rule in S07-08 and S04-07. Either explicitly exempt this same-checkout Implement startup, with a narrowly scoped admission reason, or preserve a pending Implement request through Setup approval, retry, skip, cancel and queued admission. Add S04-07 as a prerequisite and test the final eligibility rule, including cancellation and reconnect. Remove the stale claim that attachment alone bypasses Setup.

### N5 | major | The approval validation path bypasses its safety refinement

**Claim:** The proposed service can publish a request without a usable deny choice or with a note mapped to an allow choice.

**Evidence:** S06:185 attaches `denyChoicesAndNoteChoice` to `ApprovalRequestSchema`. S06:194,258,260 tells the service to validate only `ApprovalRequestBodySchema`, then compose and broadcast the envelope. The body lacks that refinement. S06:200 makes clear these are required invariants, not display preferences.

**Concrete fix:** Validate the fully composed request before publish/list, or move the choice refinement onto the body and reuse it in the final schema. Invalid choices must take the same fail-closed path. Require service-boundary tests for no deny choice, a missing note choice, and a note choice pointing to allow, alongside the valid two-deny ACP case.

### N6 | major | Deny-note recovery silently changes exactly-once delivery to possible duplication

**Claim:** The plan promises a guarantee that its own recovery procedure explicitly cannot provide.

**Evidence:** S06:536 promises a reload cannot duplicate a note; S06:543-547 requires exactly-once delivery. S06:332 converts every unresolved pending note to queued on restart, even if native delivery or steering succeeded before the status write. It expressly says the note can arrive twice. This can automatically launch another turn containing an instruction already delivered.

**Concrete fix:** Add an explicit `delivery_unknown` state for this gap. Show the retained note and let the user choose Send again or Remove; do not auto-queue an uncertain delivery. Use exactly-once wording only for delivery paths with an admission/native idempotency guarantee. Add crash-after-native-delivery-before-status-write and crash-after-steer cases. Record the user-visible unknown-delivery policy in decisions.md.

### N7 | major | TCP reachability still releases Setup for the wrong process

**Claim:** Correct host probing and a current-run URL do not prove that this startup action is ready.

**Evidence:** S12a:275 explicitly admits that another listener can answer while the new action is about to fail with address-in-use. S12a:326 nevertheless marks the action ready and releases the next action/turn. S12a:213 also feeds the synthesized command echo into command output, so a URL in a command argument can become a candidate before the child prints anything. S12a:277 calls a running-but-unreachable run a stopped tile, while S11:195 calls it Starting.

**Concrete fix:** Keep TCP reachability as a Browser display fact. For Setup, require exit 0 or an explicitly defined readiness policy with evidence sufficient for that policy; do not use an arbitrary responding listener as automatic success. Exclude synthetic echo from detector input. Align the two tile-state tables. Test an occupied port, an echoed URL, IPv6, and a server that prints its URL then fails, asserting the first turn remains gated.

### N8 | major | The retirement gate skips required proofs and suppresses actionable errors

**Claim:** A green `ledger-run` is not the proof README requires.

**Evidence:** `tools/graph.mjs:370-377` selects only the first command, skips every non-`rg` command and launches Bash without reporting stderr/status details. `ledger-run S11-15` returned exit 0 and no output, although its only proof is the draft round-trip test at S11:393. F-04c, S07-03 and S12T-01 returned exit 1 with blank diagnostics; a direct read-only child-process probe found Bash exit 127, `rg: command not found`. Native Windows `rg` is available. Mixed rows such as S00:283 and S07:542 lose their behavioral half. S12b:330 also searches canonical input words such as `Errored` across tests that legitimately retain them, for example `apps/web/src/features/subagents/roster/__tests__/SubagentsPanel.test.tsx:319-320`. S00:277,301 still demand repository-wide typecheck/lint despite README:68.

**Concrete fix:** Execute every declared proof with its expected outcome, distinguish `rg` no-match from test success, and report counts, skips, exit codes and stderr. Reject an unknown ticket and never silently mark skipped rows clean. Use the installed native executables rather than an undeclared Bash environment; do not install tooling. For pipelines, propagate upstream errors. Narrow retained-data searches or use behavioral tests, and replace the foundation-wide checks with targeted gates. Demonstrate that S11-15 actually executes its declared proof and that missing tools cannot produce a success-shaped result.

### N9 | major | Draft send ownership is insufficient for page edits and staged images

**Claim:** An item-level message mark does not preserve later edits to the same item, and moving draft images before durable admission can destroy a failed send's draft.

**Evidence:** S10:384-389 releases images on redraw/discard, moves them at admission and deletes marked items on success. S11:312,315 marks an entire page `inFlight`, but says a note saved during that send is unmarked and survives. Those are different ownership units. There is no stated copy-on-write rule for a new note on that same page or protection against another window releasing its submitted snapshot. S07:417 also promises an unsaved plan-comment editor in ComposerDraft, but S10:364-390 does not name that field or its implementing owner.

**Concrete fix:** Freeze submitted page/item revisions and their image references; keep subsequent edits in a separate current revision. Lease submitted images until admission settles, promote them without deleting the draft source before a durable successful admission, and release only unreferenced images. Assign the plan-comment editor field and its parser/serializer to S07-06. Add same-page-edit-during-send, cross-window discard, admission failure after image staging, and lost-success-response tests.

### N10 | major | Autosave conflict recovery has no legal request for the losing fork

**Claim:** "Keep my text" is not executable under the written first-edit protocol.

**Evidence:** S07:285 mints one draft ID per editor session. S07:286 allows a new ID to fork only the latest ready version. When another window creates the latest draft first, S07:294 correctly rejects the losing ID. S07:291 then says to save against the current latest version "under the same rules", but that base is now draft, not ready. S07:666 additionally rejects every lower revision while S07:287 explicitly permits one lower-revision identical replay.

**Concrete fix:** Specify that an explicit Keep my text confirmation adopts the returned draft ID and revision, then submits the retained local text, or define a deliberate new-fork operation from that draft. Keep revision equality for subsequent concurrent updates. Add the complete two-window conflict-and-resolution test and make the lower-revision acceptance criterion exempt the defined idempotent replay.

### N11 | major | T3 remains both a hold and an executable default

**Claim:** Approval of the breakdown alone will not tell a fresh agent whether it can build S12T-11 or what the toggle requires.

**Evidence:** decisions.md:3 and README:14 say build defaults. decisions.md:148 says the Keeps running toggle needs the user's yes before S12T-11; graph:700 and S12a:630 include the toggle in the default. S12a:643 says build exit-0-or-port and add the toggle only if approved. No field, persistence/upgrade rule or acceptance test specifies the toggle if approval arrives.

**Concrete fix:** Before publishing, record T3's actual decision and rewrite the decision row, graph flag/note and S12T-11 consistently. If the toggle remains deferred, make the base ticket executable and explicitly exclude it. If approved, define its environment field, readiness semantics, editor control, upgrade/approval implications and tests. Apply N7 to whichever readiness rule is selected.

## Checked and agreed

- `node docs/plans/ready-for-build/tools/graph.mjs check` passed: 156 tickets, 7 merged/deferred entries, 13 waves. `ledger` passed: 282 rows. Required round-1 edges were independently checked in memory. No graph renderer, sync, issue generator, code test or runtime startup was run.
- Spot-ran `ledger-run` for F-04c, S07-03, S12T-01 and S11-15. Results and the Bash diagnostic are recorded in N8. Existing code should still match retirement searches at this planning stage; matches are not implementation failures.
- T1 now states history and environment/cwd reset. T11 explicitly chooses legacy and retires modern. D11 visibly defers the extra model-picker interactions, consistently with S00:460. B1 visibly removes undesigned project-source flows from the build program. These are disclosed defaults for the user's approval, not evidence that the user already approved them.
- The unified seen protocol, qualified refs, image route, terminal cap, owner-thread approval placement, startup record shape and subagent status ownership are materially improved and internally aligned except where findings above identify a remaining edge case.
- Preserve the bounded provider investigation, historical readers, atomic admission direction, raw recovery backups and isolated live-proof boundaries. S07-03 is reasonably narrowed; the larger S06-01, S08-03 and S12T-11 conversions should keep their named integration gates rather than be split into incompatible intermediate contracts.
- `RFB_REF=<published full SHA>` is adequate for F2. Publishing must still verify that revision and its anchors are accessible. The reviewed commit is local evidence only.
