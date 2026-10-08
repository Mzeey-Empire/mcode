# Astra review, round 1

The plan is a sound direction, but is not ready to publish as executable issues. Keep the locked product decisions and the shared-service design. Fix the destructive-operation and project-isolation defects first, then resolve the contradictory contracts, retirement ownership and incomplete tickets below. `node docs/plans/ready-for-build/tools/graph.mjs check` passes with 157 tickets, 3 merged tickets and 13 waves. That proves graph structure, not safe implementation order. The proposed graph edits were also checked together in memory: 156 build tickets, 13 waves, no missing blockers or cycles. This was a read-only document and code review, not a runtime verification. Only this review file was written.

Paths beginning `sections/`, `source/`, `tools/`, or a plan-level filename below are relative to `docs/plans/ready-for-build/`. Findings describe proposed behavior unless explicitly identified as current code.

## Findings

### C1 | blocker | Revert conflates a state precondition with an operation identity

**Evidence:** `sections/08-finished-turn.md:179,249,275` hashes snapshot, scope and current blob IDs into `previewToken`, makes it unique, and returns the old operation before checking current state. Revert, Undo, then Revert again recreates the first token. The third operation returns the already-undone record without reverting. Blob-only tokens also omit executable mode and file type, although `blobIdsAt` returns mode at line 227.

**Fix:** Add a client-generated `requestId` to apply and undo. Persist the request identity, bound parameters and result; replay only the same request. Keep `previewToken` solely as a precondition over repository/worktree identity, snapshot, scope and every path's presence, type, mode and content. Give a new click a new request ID. Add real-git cases for apply/undo/apply, lost-response replay, and mode-only changes. Owner: S08-03.

### C2 | blocker | Revert can lose its recovery record after changing files

**Evidence:** `sections/08-finished-turn.md:251-258` captures a safety tree, changes files, then inserts the record and receipt. A process death or database failure between those steps leaves altered files without a recoverable operation. Undo has the same gap. Safety pinning is deferred to S08-05, while S08-04 can already expose Revert. Current `snapshot-service.ts:398-416` creates unreferenced trees and uses Git clean filters through `add -A`; a tree is not a byte-exact backup of arbitrary working-tree bytes. The plan nevertheless promises exact Undo and byte-exact CRLF round trips at lines 148 and 460.

**Fix:** Persist a prepared operation and pin its recovery material before the first destructive write. Track affected paths and completion, recover unfinished operations after restart, and distinguish failed recovery from no change. Preserve raw pre-operation bytes and file metadata for touched paths where a Git tree cannot guarantee exact restoration. Test process death and database failure between stages, filters, mixed line endings, symlinks and file/directory transitions. Do not expose Revert before its safety mechanism exists.

**Graph edit:** merge S08-05 into S08-03. Delete `blockers.S08-05`; add `dropped.S08-05: "Merged into S08-03: safety pinning must precede destructive writes."`; add S10-12 to `blockers.S08-03`; move its safety-pin notes and acceptance criteria into S08-03. Keep snapshot pinning owned by S10-12.

### C3 | blocker | Snapshot sweeping can delete another runtime's live refs

**Evidence:** `sections/10-review-panel.md:305-306` deletes every snapshot ref whose ID is absent from the current database. `sections/08-finished-turn.md:321-323` applies the same rule to reverts and acknowledges that refs are shared across linked worktrees. Runtime databases are separate snapshots, explicitly documented at `docs/agents/runtime.md:48,59`. One runtime cannot infer that another runtime's ref is orphaned. Pinning only at finalization also leaves the dirty pre-turn tree unprotected during the turn: current capture occurs at `apps/server/src/features/agents/orchestration/turn-runtime-controller.ts:598-608`, with finalization much later.

**Fix:** Namespace refs by a durable database/runtime owner, with a distinct owner for a cloned development database. Sweep only refs owned by that store. Pin a dirty baseline when captured, retain it across restart, then transfer or release it at finalization. Test two independent databases using linked worktrees, either starting its sweep, and GC while a turn is running. Update `notes.S10-12` with ownership and active-baseline retention. No new generic GC service is needed.

### C4 | blocker | Plan Implement can become Accepted without an admitted turn

**Evidence:** `sections/07-plan-mode.md:303-317` commits Accepted and Build mode before writing the plan file, calling `prepareImplement`, creating a destination thread or dispatching. Only a dispatch exception is compensated. A file/hook failure or crash strands Accepted; request replay at line 303 assumes a stored receipt that the proposed plans migration at lines 234-238 does not define. A check for no running turn is also not a reservation against another send. The existing canonical start atomically projects its user message and retry consumption in `apps/server/src/features/agents/canonical/canonical-parent-turn-lifecycle.ts:78-96`; the new path should coordinate with that admission boundary.

**Fix:** Specify a durable Implement request with immutable version/revision/text, target thread, admission identity and recoverable status. Reserve admission before changing plan status; accept with successful admission, or make the intermediate state recoverable before publishing Accepted. Replay the same target/message, including new-thread creation. Use conditional compensation so an older failure cannot restore over newer state. Add races with ordinary Send and crash tests before/after file preparation, thread creation and admission. Owner: S07-07, extended by S07-08.

### C5 | blocker | Browser profile validation does not bind a guest to its project

**Evidence:** `sections/11-browser-panel.md:128-145` accepts any matching partition string and replaces exact session equality with `isBrowserSession`. Current `apps/desktop/src/features/preview/surfaces/registry.ts:197-208` treats enforced session identity as part of guest adoption's trust proof. After the change, a valid project-B partition could be adopted under project-A surface identity unless an exact binding is added. Checking that both belong to Mcode is insufficient.

**Fix:** At prepare/attach/adopt, bind the adoption token and validated workspace identity to exactly `browserPartitionFor(workspaceId)`. Reject a valid partition belonging to another workspace, not only malformed names. Keep permission/download/clipboard policy installed before attachment. Drive deletion from authoritative workspace removal and reconcile it on desktop reconnect; the renderer-only calls at line 146 miss removal through another client. Owner: S11-03.

### B1 | major | Startup actions have competing executors, retry rules and bounds

**Evidence:** S04 retries from the failed action and appends terminal output to the trail (`sections/04-08f-thread-start-and-turn-endings.md:359-365,831`). S12 reruns all non-running actions and stops startup transcript appends (`sections/12a-terminal-actions-and-project-settings.md:296-324`). Both claim the automatic-setup switch. S04 accepts 16 commands of 16,384 characters (`:252-258`), while S12 accepts 256 action IDs and documents 32 KB scripts (`12a:284,309`). Valid action configuration can therefore fail startup-record validation. S12T-11 deletes old fields in wave 10; S04-08 consumes the replacement in wave 11.

**Fix:** Make S12's runner the sole executor and the trail a projection of its frozen action/run IDs. Decide one retry rule and whether the trail contains a bounded read-only output excerpt. Share command bounds or keep scripts out of the startup record. Convert the runner and all old-contract consumers in one ticket.

**Graph edit:** fold S04-08 into S12T-11; add S04-04 and S04-07 to `blockers.S12T-11`; delete `blockers.S04-08`; add `dropped.S04-08: "Merged into S12T-11: atomic startup-actions switch and trail consumer."`. Move its acceptance criteria, then resolve their conflicting retry wording.

### B2 | major | One seen marker still has two incompatible write protocols

**Evidence:** S01 specifies `thread.markSeen({threadId})`, server-now timestamps and an attention schema without sequence (`sections/01-09-shell-sidebar-and-notifications.md:130-155,239-242`). S08 specifies a changed `thread.markViewed` returning previous/current settled sequences, with a visit baseline (`sections/08-finished-turn.md:296-306,534-542`). The graph note says one marker but does not choose a protocol. Marking the server's latest state can acknowledge a turn the client has not received. A timestamp update on every call is not an idempotent acknowledgement.

**Fix:** S01-03 owns one operation carrying the client's observed settled sequence. Atomically return previous/new sequence and its corresponding timestamp. Make repeats true no-ops and reject sequences beyond the thread's settled history. Capture the Review visit baseline from that response before clearing the badge. Remove or migrate every `markViewed` caller in the same ticket, including the current unfocused call in `apps/web/src/stores/threadStore.ts:2473-2476`. Rewrite both backend sections and `notes.S01-03`, not just the ticket's reconciliation line.

### B3 | major | Branch-list reconciliation does not preserve Review's refs

**Evidence:** S03 drops a remote ref when its local twin exists and pages with a cursor (`sections/02-03-add-project-and-new-thread.md:177-195`). S10 requires independently selectable local/origin refs and sketches `git.listRefs` with offset paging and different result fields (`sections/10-review-panel.md:233-253`). Reusing S03 unchanged makes comparing local `main` against `origin/main` impossible. The existing graph blocker is correct, but the contract is not reconciled.

**Fix:** S03-04 owns one qualified-ref listing with an explicit purpose/filter. Review retains remote twins; the creation picker may group them for display. Specify one paging/result contract, current-worktree context and sorting. Remove the competing `git.listRefs` sketch and update `notes.S10-05` with the agreed parameters. Test diverged local/origin branches with the same short name.

### B4 | major | Draft persistence is still specified as both local and server-owned

**Evidence:** S10 chooses persisted `ComposerDraft` (`sections/10-review-panel.md:308-312,621`), but S11 still defines `thread_annotation_drafts`, two RPCs and server-row deletion on Send (`sections/11-browser-panel.md:304-321,600-605`). S07's chip derives selection from all open unsent comments, with no persisted exclusion field (`sections/07-plan-mode.md:336,551`). Current `apps/web/src/lib/composer-draft-storage.ts:126-179` validates restored fields and silently tolerates storage write failure; new arrays do not become durable just by adding TypeScript properties. Screenshot metadata can persist while its source file disappears.

**Fix:** Keep the chosen single composer draft for next-send selection and open editors, including excluded/included plan comment IDs. Keep authoritative plan comments in `plan_comments`; they are records, not a second send draft. Specify durable snapshot staging and reference release on discard, thread deletion and successful admission. Update serializer, parser and persistence-failure behavior. Remove S11's competing table/RPC instructions and rewrite its tests around the chosen storage. Clear only the submitted draft revision after admission, preserving edits made while Send is in flight.

**Graph edit:** add S10-11 to `blockers.S07-06`.

### B5 | major | The sole panel ADR still specifies the retired four-terminal cap

**Evidence:** S12T-01 introduces `TERMINAL_MAX_PER_SCOPE = 8` and retires `MAX_TERMINALS_PER_SCOPE` (`sections/12a-terminal-actions-and-project-settings.md:152-158,450-456`). S12P-01 later instructs its agent to use the retired constant, preserve four in the ADR and disable + at four (`sections/12b-panel-shell-files-and-subagents.md:360,366`). It has no dependency on S12T-01.

**Fix:** Use the shared cap of eight for pending, running and exited records, including actions. S12P-01 owns the one ADR and takes the value from that contract. Remove the competing ADR instructions remaining in 12a.

**Graph edit:** add S12T-01 to `blockers.S12P-01`; amend `notes.S12P-01` to state the eight-record rule.

### B6 | major | Thread-operation approval location conflicts across sections

**Evidence:** Approval v2 places thread operations on the owner/source thread (`sections/06-approvals.md:162-164,361`). Coordination removal says they continue on the target thread and tests that behavior (`sections/12b-panel-shell-files-and-subagents.md:373,378`). This affects which background thread shows Needs you. It is not resolved by removing the old panel.

**Fix:** Use S06's owner-thread rule everywhere, with the target described in the subject. Change S12P-02's acceptance check and S01's waiting-source mapping accordingly. Include a supervised cross-thread send fixture that asserts both the owning dock and sidebar marker. No extra service is needed.

### C6 | major | Approval v2 can reject valid choices and claim a denial that failed

**Evidence:** `sections/06-approvals.md:169-176` demands exactly one deny choice while the provider table promises verbatim ACP options. ACP can expose both `reject_once` and `reject_always`, explicitly handled by current `packages/providers/src/private/cursor/acp/cursor-acp-permission-mapper.ts:65-77`. The proposed fail-closed sequence at lines 229-239 does not specify what happens when the upstream rejection fails or when raw data has no usable ID. It also says adapters truncate valid data to fit bounds without separating harmless patch clipping from truncating the actual command/file scope being approved.

**Fix:** Permit all genuine deny choices, preserving option identity, or explicitly select and label one without changing its meaning. Keep routing identity outside the untrusted display payload. Emit Auto-denied only after upstream acknowledgement; on transport failure keep a recoverable failure or stop the owning turn, never leave an invisible wait. Never truncate approval scope into a misleading authorization; fail closed if it cannot be represented honestly. Add tests for two reject options, malformed display data, missing routing data, oversized scope and rejection transport failure. Owner: S06-01.

### C7 | major | Queued deny notes can disappear after a successful denial

**Evidence:** `sections/06-approvals.md:270-274` makes the web enqueue a note only after receiving the response. A lost response loses the note, and retry returns `not_pending`. Existing `apps/web/src/stores/threadStore.ts:2687-2688` clears queued messages on an error. Section 05 explicitly delegates that unresolved behavior to S08 (`sections/05-running-turn.md:468`), but S08F contains no preservation acceptance criterion. This directly undermines decisions.md P2's queued-note default.

**Fix:** Persist note-delivery intent with the approval outcome and deduplicate by request ID. Reconnect restores pending delivery; the user can edit or remove it. Keep queued user input on failure rather than silently clearing it, with a visible paused queue and an explicit send action. Test lost RPC response, immediate provider error, reconnect and duplicate response. S06-07 owns note delivery; S08F-05 owns the ending/queue behavior.

**Graph edit:** add S08F-05 to `blockers.S06-07`; add a note to S08F-05 explicitly assigning queue retention.

### C8 | major | The temporary review index assumes an index file exists

**Evidence:** `sections/10-review-panel.md:182-190` starts with copying the real index. A fresh `git init` repository can have untracked files and no index. The same section promises HEAD-or-empty-tree comparisons at line 178. Current `snapshot-service.ts:398-408` already demonstrates creating an isolated index, rather than assuming one exists.

**Fix:** Copy an existing index to retain staged state; on an absent index only, initialize an empty temporary index with `read-tree --empty`. Do not turn other I/O failures into an empty index. Cover unborn repositories, intent-to-add, staged plus unstaged changes, conflicts, ignored files and cleanup after failure. The real index must remain byte-identical. Owner: S10-02. This is a proposed-path defect, not a reproduced runtime failure.

### C9 | major | Commit deduplication has no durable result or push recovery

**Evidence:** `sections/10-review-panel.md:290-299` caches promises for ten minutes and uses changed HEAD after restart as duplicate protection. That prevents an ordinary duplicate commit, but a successful commit followed by a lost response/restart returns `head-moved`, losing the committed SHA and pending/failed push result. Push is outside the lock and must not rediscover a different current branch after checkout changes. A timeout can also be an unknown commit outcome, not proof that HEAD is unchanged.

**Fix:** Persist request identity, bound inputs, original HEAD, resulting SHA and push outcome. After restart or timeout, reconcile before reporting failure or retrying. Push the captured source commit to the captured destination and report it separately. Keep hooks and pathspec commits. Test lost response after commit, restart before push, hook failure and branch changes during the push gap. Owner: S10-08. Do not claim that the current HEAD check is full operation idempotency.

### C10 | major | Native plan activation precedes the protocol support it requires

**Evidence:** S07-02 enables Codex native plan mode in wave 2; S07-10 handles its questions much later. S07-09 owns `TurnRequest.planTurn` even though S07-12 through S07-14 consume it without depending on S07-09 (`sections/07-plan-mode.md:601,643,652,664`). The provider table at lines 368-373 leaves Cursor response semantics, Copilot events, native plan-file identity and minimum Codex version inferred. These are feasibility questions, not finishing work after Implement UI.

**Fix:** Add an early bounded protocol investigation covering all six providers, with captured request/response evidence and supported-version decisions. Put `planTurn` and `prepareImplement` signatures in S07-01. Enable native Codex mode only with its question handler and cancellation behavior. Distinguish renderer reconnect from provider-process restart; the latter cannot preserve an in-memory request promise merely by persisting the question (`S07-10:614`).

**Graph edit:** add `blockers.S07-00: []` and a matching section ticket for this investigation; add S07-00 to `blockers.S07-01`. Merge S07-10 into S07-02: delete `blockers.S07-10`, add `dropped.S07-10: "Merged into S07-02: native plan mode and its question protocol activate together."`, and add S07-09 to `blockers.S07-02`. Also add S07-09 to `blockers.S07-12`, `blockers.S07-13` and `blockers.S07-14`, since it classifies and forwards their plan turns. This preserves early discovery while preventing premature native-mode activation.

### C11 | major | Native plan-file cleanup lacks ownership proof

**Evidence:** `sections/07-plan-mode.md:368-373,667-670` proposes watching shared provider plan directories and overwriting/deleting files found during a turn. The native path and session identity remain inferred. Another provider session can create a file during the same window; a returned path is external input. The acceptance criterion that no `.opencode/plans` file remains is broader than the current turn's ownership.

**Fix:** Identify one exact file from the owning native session, validate containment and symlink behavior, record its identity/hash and compare before mutation. Never glob-delete files or overwrite another session's plan. When ownership cannot be proved, use the inline authoritative plan and fail/report the unsupported native-file synchronization step honestly. The early S07-00 investigation must settle supported adapters before their implementation issues promise cleanup.

### C12 | major | Plan autosave uses a client counter instead of a revision precondition

**Evidence:** `sections/07-plan-mode.md:205,256,526-528` rejects only `revision <= stored`. A second window with a larger local counter can overwrite newer server content based on an older draft. Reloading on `plan_stale` can discard the user's unacknowledged text. The first-edit fork also needs idempotency when its response is lost.

**Fix:** Send `baseRevision`, require equality and increment the revision on the server. Preserve rejected local text for an explicit conflict resolution. Key the first editable-version creation so retry does not create another version. Serialize save, capture and admission for the thread. Test two windows, reordered saves and a lost first-save response. Owner: S07-03/S07-05.

### C13 | major | Port detection can report readiness for the wrong listener

**Evidence:** `sections/12a-terminal-actions-and-project-settings.md:251-253` takes the first printed URL, probes only `127.0.0.1`, and seeds a new run with the previous port. An IPv6-only server never becomes reachable. A help URL or a stale port occupied by another process can mark the new action ready. That result releases the startup gate at line 297. S11 still sketches numeric `port`, `listening` and a separate `servers.list` at `sections/11-browser-panel.md:179-192`, despite S12 owning an object-valued `run.port`.

**Fix:** Parse and probe the actual normalized host, including IPv6. Treat printed URLs as candidates and old ports as display history, not current-run readiness evidence. Require evidence from the current run before release; document that TCP reachability is not HTTP/application health. Test chunked ANSI output, IPv6, a stale occupied port and misleading output. Remove S11's alternate fields/RPC and consume the agreed run projection. Owner: S12T-08, consumed by S11-09.

### C14 | major | Subagent detail tier must follow available evidence, not just provider identity

**Evidence:** `sections/12b-panel-shell-files-and-subagents.md:195,234-249` derives tier from provider metadata and changes Copilot from tool-call ID/steps to child-thread ID/transcript later. Historical Copilot rows still have no child transcript. OpenCode is assigned `steps` even when the required child event stream is unverified, while the UI asserts that it shares steps. S05 independently introduces `subagentStatusWord` using the parent's provider (`sections/05-running-turn.md:379-380`), while S12 introduces another status mapping and per-entry provider.

**Fix:** Keep stable roster identity across enrichment. Derive each entry's tier from persisted evidence and capability together; never advertise a transcript without a readable child. State empty/unsupported step evidence accurately. Let S12P-08 own status normalization and roster identity, and make chips/overview consume it rather than build another status model.

**Graph edit:** add S12P-08 to `blockers.S05-08`; update S05-08's notes to consume entry provider/status. Verify old Copilot rows after upgrade, mixed-provider children and reconnect.

### A1 | major | Several concrete consumers lack prerequisite edges

**Evidence and exact graph edits:**

- `blockers.S01-03: add S06-01`. Its waiting source currently specifies `agentPermissionService` and old pending APIs (`01-09:170`), which S06-01 deletes. Rewrite it to use ApprovalService from the start.
- `blockers.S03-02: add F-04a`. It ports branch/local side menus (`02-03:455`) but depends only on overlay surfaces, not the menu primitive.
- `blockers.S03-03: add F-02`. Its acceptance criterion explicitly requires F-02 fading (`02-03:476`).
- `blockers.S07-06: add F-07b`. decisions.md L6 chooses an Undo toast for Resolve; no ancestor provides the toast lane.
- `blockers.S08F-07: add F-04b`. Its build notes explicitly use the F-04 model picker (`04-08f:986`).
- `blockers.S12P-07: add S07-06`. The locked Files decision reuses the plan comment editor (`12b:48`); otherwise explicitly choose the existing Review editor and remove that promised reuse.

These are additional to the specific edits in other findings. Recompute waves after all edits together. Wave membership alone is not a safe parallel-write plan for shared contracts, stores and migrations.

### A2 | major | S07-03 owns too many unfinished operations

**Evidence:** `sections/07-plan-mode.md:483-500` assigns migration, versions, comment CRUD, re-anchoring, all wire methods, phase classification, file materialization, writer reload and an ADR to one backend prefactor. Implement and comment behavior are then assigned again to S07-06/S07-07. Acceptance tests cover only a subset. The shared S06-01 conversion is also unusually broad across six adapters, orchestration, thread control, transport and the web store (`06:354`).

**Fix:** Narrow S07-03 to durable versions, save/snapshot, writer coordination and a working read consumer. Move comment operations and re-anchoring into S07-06, and the Implement operation entirely into S07-07. Move phase classification into S07-09. For S06, separate the existing Cursor deny and unreadable-request hang fixes into a small first ticket, then perform the unavoidable all-consumer v2 conversion with its full conformance gate. Do not split v2 into independently shippable incompatible adapter contracts.

**Graph edit:** add `blockers.S06-00: []`, a matching fail-closed bug-fix ticket, and S06-00 to `blockers.S06-01`. Other S07 dependencies already support the narrowed ownership. The primitive/backend tickets with real integration tests need not all become screen-sized vertical slices.

### A3 | major | A deliberately unbuildable ticket blocks final cleanup forever

**Evidence:** S02-04 has neither acceptance criteria nor verification (`sections/02-03-add-project-and-new-thread.md:591-600`), is out of scope by `spec.md:248` and decisions.md B1, but remains in the build graph. F-99 depends on every graph ticket. The plan also says build defaults, while generated issues say Needs decision before build (`tools/graph.mjs:225`).

**Fix:** Publish S02-04 separately as design backlog, not as a buildable blocker. Define whether each remaining decision has an executable default or a true hold. A missing board is not equivalent to permission to invent a flow.

**Graph edit:** delete `blockers.S02-04` and `needsDecision.S02-04`; add `dropped.S02-04: "Deferred to design backlog; excluded from this build program and F-99."`. Update counts after graph changes, rather than preserving 157 as a target.

### D1 | major | Retirement ownership is incomplete and sometimes names the wrong ticket

**Evidence:** The foundation ledger assigns ModelSelector and FileEditorPicker to whole sections without concrete migration tickets (`sections/00-foundation.md:283`). F-04b migrates only the two settings pickers (`:422-423`). decisions.md T11 says one terminal backend, but 12a explicitly retains modern and has no retirement row for its selector or implementation (`12a:158,215,681`; current selector at `apps/server/src/features/terminal/backends/terminal-backend-selector.ts:15-17`). Identity glyph deletion belongs simultaneously to F-06, S05-08 and S12P-13. The 12a ledger still assigns action-menu deletion to S12T-09 and startup migration to S12T-10, whose current titles are Action icons and Actions menu. Other ledgers still assign deletions to dropped S09-01 and S08-07.

**Fix:** Give every artifact exactly one active owner. Follow T11 by choosing the retained backend in S12T-01 and assigning deletion of the other backend, selector/env option, tests and obsolete docs there. Assign glyph retirement to F-06. Remap toast retirement to F-07b, seen retirement to S01-03, action-menu retirement to S12T-10 and setup retirement to S12T-11. Add an explicit model/editor picker migration ticket rather than leave it to F-99.

**Graph edit:** add `blockers.F-04c: ["F-04b", "F-06"]` with the matching picker-migration ticket; add F-04c to `blockers.S08F-07` when it consumes the migrated model picker. Add the backend and retirement-owner assignments to the relevant graph notes.

### D2 | major | The retirement proofs cannot all be run as promised

**Evidence:** README promises every proof returns nothing, but rows use descriptions such as Unit test, File absent, Live check, or allowed matches (`08:382,386,390-391`; `00:274,283,289`). Some searches are overbroad: 12b's proof deletes every `commandPalette.toggle` occurrence while preserving the palette on Ctrl K (`12b:309`); S11-16 searches generic `changeSummary` across all packages (`11:400`). `graph.mjs check` validates ticket headings/edges/cycles, not ledger ownership or proofs. F-99's all-clean claim is therefore not currently checkable.

**Fix:** For each row, specify an active owner, exact command, expected exit/result and any allowed matches. Use behavioral tests where names are intentionally retained. Validate owner IDs before publishing. Restrict grep scope to the retired behavior. F-99 should run these declared checks and investigate hits, not delete everything a fresh dead-code baseline reports across unrelated features.

### D3 | major | Retiring the old plan renderer can expose historic plan JSON

**Evidence:** S07-01 deletes `plan-output` stripping and requires zero occurrences in the web (`sections/07-plan-mode.md:418-423`). Existing messages contain those fences; current `apps/web/src/features/conversation/messages/MessageBubble.tsx:38-42` and `apps/web/src/components/chat/MarkdownContent.tsx:498` hide them. The proposed migration rebuilds plan rows, not historical message text. Removing the reader without migration makes old transcripts display the hidden payload.

**Fix:** Either migrate persisted messages safely or keep a bounded legacy read transformation inside the new renderer. Retire the old component and all old writers, not the ability to read existing records. Add a historical-message fixture and canonical plan replay/rehydration coverage. Apply the same distinction to Browser v1 payload readers, which the plan correctly retains.

### E1 | major | Startup default T3 is not an implementable readiness rule

**Evidence:** decisions.md T3 says long-running startup commands are not awaited past start. The backend explicitly blocks on no-port commands until exit (`12a:302,670`). A process spawn does not tell the runner whether `bun install` will finish or `bun test --watch` will run indefinitely. Treating both as ready immediately can start the agent before dependencies exist.

**Fix and decision:** Prefer exit-zero or a current-run readiness signal by default. If the user wants no-port background startup commands, ask for an explicit background/readiness choice; do not infer it from elapsed time or command-name heuristics. Also disclose both command-then-shell differences under T1: history is absent and `cd`/environment changes do not carry into the shell (`12a:175`). The latter is missing from decisions.md. I agree with the phase model once that behavior is understood.

The locked memory-only project-settings draft at `12a:44,369` also contradicts PRODUCT.md principle 12's restart promise. Preserve the locked decision and record that exception in the product/spec wording; do not silently add persistence or claim restart survival.

### F1 | major | Some live checks exceed the authorized fixture boundaries

**Evidence:** S09-04 removes/restores Devin credentials (`01-09:541`); S09-05 updates an older CLI install (`:557`); S11-03 registers a second throwaway project (`11:441`). AGENTS.md limits product/runtime mutation to `.dev/fixture-repo` and forbids global configuration writes. README also tells every ticket to run repository-wide lint/typecheck, conflicting with AGENTS.md's targeted-check rule. These are predictable fresh-agent blockers, not reasons to waive the tests.

**Fix:** Specify isolated provider homes/configuration and scratch CLI prefixes, with no global sign-out or installation change. Explicitly authorize and document a second fixture workspace for the project-isolation test, or supply an existing approved pair. Use the repo's targeted gates. Mark captured-trace evidence separately from real-provider proof and declare unavailable-provider evidence pending rather than passed. No such live mutations were performed in this review.

### F2 | major | Published issues will rely on brief links not yet established by this checkout

**Evidence:** `tools/graph.mjs:18,223` hard-codes a mutable `docs/app-page-map` branch URL; generated issue bodies require its backend and ledger sections. `git ls-files docs/plans/ready-for-build` currently returns no files. This does not prove remote absence, but there is no tracked local publication artifact here to establish those links. A heading-only dependency checker cannot verify them.

**Fix:** Commit and publish the agreed plan through the author's workflow before issue publication, then pin full-brief links to the published revision and verify accessibility and anchors. Include the final dependency/decision/retirement ownership in each issue's usable context. Do not publish 157 tickets pointing at an unverified mutable draft. This review makes no commits.

### B7 | minor | Files and project icons each introduce an image-serving contract

**Evidence:** `sections/12b-panel-shell-files-and-subagents.md:180` defines `/workspace-files/...` and says icons use it. `sections/12a-terminal-actions-and-project-settings.md:357-364` defines `/workspace-images/...` and says Files can use that instead. They differ in scope, size cap, caching and CSP. Neither ticket owns the shared decision or blocks on the other.

**Fix:** Let S12P-03 own a single authenticated scoped image-read implementation, supporting workspace-root icons and thread-worktree files. Keep the caller-specific 2 MB icon and 20 MB Files limits, and their appropriate caching behavior, explicit. S12T-14 reuses it. Do not copy path/auth/SVG validation.

**Graph edit:** add S12P-03 to `blockers.S12T-14`; record image-route ownership in both notes.

## Checked and agreed

- Shared primitives, semantic tokens, provider-neutral orchestration and adapter-owned native differences are the right boundaries. Backend-first work is justified where the existing consumer remains functional and the public seam has an integration test.
- All twelve section briefs, the central decisions/spec, graph structure and wave policy were reviewed. Code evidence was spot-checked, not exhaustively re-audited. No Paper access was needed.
- Current invalid approval publication really returns without resolving the provider (`permission-publication.ts:24-31`); current Cursor deny really can select the first allow option (`cursor-acp-permission-mapper.ts:73`). Fixing these early is warranted.
- Approval receipts should be durable, and session scope should be adapter-stated. Claude destination rewriting and replacing Copilot's global approval flag deserve the planned conformance tests.
- Classified failures and explicit native-versus-seeded Resume are sound. Existing recovery currently forces a fresh session (`apps/server/src/features/agents/recovery/turn-recovery-service.ts:143`), while canonical retry consumption is atomic (`canonical-parent-turn-lifecycle.ts:398-407`). Preserve that one-shot admission guarantee.
- Revert's explicit overwrite confirmation, working-tree-only scope, attribution checks, shared file/turn operation and refusal to undo over later edits are sensible. An in-process Git lock is useful for Mcode operations; it does not lock editors, external Git or another server process.
- Temporary indexes are the correct way to expose untracked files without touching the user's index. Preserve staged state and test absent-index repositories.
- Real commit operations, hooks, selected-path semantics and a separate push result are preferable to asking an agent to commit. The planned real-git/bare-remote/hook tests are appropriate.
- Snapshot refs are justified by retention requirements. Their namespace ownership and capture-time lifetime need the corrections above.
- Environment 0.1.0 cannot be made readable by already-shipped strict 0.0.1 readers. The lowest-representable-version writer, no rewrite on read, unknown-key preservation and deliberate one-time reapproval are honest choices. Test against the old schema as well as the new one.
- Script then interactive shell is a smaller, more portable action-run model than shell integration across every shell family. Keep phase-local exit codes, stable terminal IDs, bounded replay and server-side output observation independent of renderer attachment.
- One server port detector, one shared draft selection store and one subagent roster are appropriate. None needs a second parallel service in its consumer section.
- Native plan capture plus a bounded fenced fallback is appropriate. Mcode should retain the exact approved version and avoid claiming native read-only enforcement before measured provider support.
- Per-project Electron partitions, sticky human control and shared browser-control rules are appropriate once session/workspace identity is bound exactly.
- One attention record and one observed-sequence acknowledgement can serve both the sidebar and Since you looked. Live pending approvals must not clear merely because the user opens the thread.
- Keeping Browser v1 message readers, avoiding fabricated provider detail, and retaining real error states rather than empty-success fallbacks are correct compatibility choices.

## 40-line summary

1. Verdict: sound direction, but do not publish the build issues yet.
2. Keep the locked product decisions and shared-service architecture.
3. Graph validation passes: 157 tickets, 3 merged, 13 waves.
4. Proposed graph changes also validate: 156 build tickets, 13 waves.
5. C1: separate revert request identity from the preview state hash.
6. C2: persist and pin recovery material before changing files.
7. C2: verify exact Undo across crashes, filters and file-type changes.
8. C3: scope snapshot refs and sweeping to the owning database/runtime.
9. C3: pin dirty baselines during turns, not only at finalization.
10. C4: coordinate Plan Implement with durable, replayable turn admission.
11. C5: bind each Electron guest to its exact project partition.
12. B1: give startup execution, retry and trail projection one owner.
13. B1: align action counts and script bounds across startup contracts.
14. B2: replace the competing seen APIs with one observed-sequence acknowledgement.
15. B3: preserve qualified local/origin refs in the shared branch listing.
16. B4: remove the competing annotation-draft table and RPC specification.
17. B4: persist draft selection, exclusions and durable screenshot references.
18. B5: use eight terminal records consistently in the panel contract and ADR.
19. B6: place thread-operation approvals on the agreed owner thread.
20. C6: support valid deny choices and handle upstream rejection failure.
21. C7: preserve queued deny notes and user input across errors and reconnects.
22. C8: initialize a temporary index when a fresh repository has none.
23. C9: recover committed SHA and push outcome after lost responses or restart.
24. C10: investigate provider plan protocols early and activate questions atomically.
25. C11: mutate only native plan files whose session ownership is proved.
26. C12: use server-checked base revisions for plan autosave.
27. C13: probe the actual host and never treat stale ports as new-run readiness.
28. C14: derive subagent detail tiers from persisted evidence and capability.
29. A1: add the concrete missing blocker edges listed in the review.
30. A2: narrow plan-record ownership and extract the urgent approval bug fixes.
31. A3: move undesigned S02-04 out of the build graph and F-99 blockers.
32. D1: assign every retirement to one active ticket, including backend and pickers.
33. D2: turn ledger descriptions into executable, scoped proof commands.
34. D3: preserve historical plan readability when retiring old writers and components.
35. B7: share scoped image serving between Files and project icons.
36. E1: resolve no-port startup readiness and disclose shell context reset.
37. E1: reconcile the locked memory-only settings draft with product wording.
38. F1: make live verification fit isolated fixture and configuration boundaries.
39. F2: publish and verify immutable brief links before publishing issues.
40. Full findings: [astra-review-round-1.md](C:/Users/chukwudi.nwobodo/.t3/worktrees/mcode/t3-a03e2ec1/docs/plans/ready-for-build/source/astra-review-round-1.md). Only this file was written.
