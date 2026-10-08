# Response to Astra review, round 1

Claude's resolution of each finding in `astra-review-round-1.md`. Graph edits are applied in `tools/graph.json` by `tools/apply-astra-round-1.cjs`. Section rewrites are assigned to fix agents by file group (G1 to G6) so no two agents edit one file.

| Finding | Verdict | Resolution | Fix group |
|---|---|---|---|
| C1 revert identity | Accept | `requestId` for apply and undo; `previewToken` is a precondition only, covering type and mode. | G1 |
| C2 revert recovery | Accept | S08-05 merged into S08-03; prepared operation and pinned recovery material before the first write; startup recovery; raw bytes where a tree cannot restore exactly. S08-03 now blocked by S10-12. | G1 |
| C3 snapshot ref ownership | Accept | `refs/mcode/<storeId>/snapshots/<id>` and `reverts/<id>`; sweep only own namespace; pin dirty baseline at capture. | G1 |
| C4 Implement admission | Accept | Durable Implement request; reserve admission before Accepted; conditional compensation; replay. | G2 |
| C5 browser partition binding | Accept | Exact binding of guest, adoption token and workspace to `browserPartitionFor(workspaceId)`; deletion driven by workspace removal. | G5 |
| B1 startup executor | Accept | S04-08 merged into S12T-11; S12 runner is the only executor; retry from first failed action; bounded read-only tail; scripts out of the startup record. | G4 |
| B2 seen protocol | Accept | `thread.acknowledgeSeen({ threadId, throughSequence })` in S01-03 replaces `markViewed`; S08 reads it. | G3 (S01), G1 (S08) |
| B3 qualified refs | Accept | S03-04 owns one qualified-ref listing with a purpose filter; Review keeps twins. | G5 (S03), G1 (S10) |
| B4 drafts | Accept | Persisted composer draft is the only send-draft store; S11 table and RPCs removed; exclusions and durable snapshot references specified in S10-11. S07-06 now blocked by S10-11. | G1, G2, G5 |
| B5 terminal cap | Accept | Eight records per scope everywhere; S12P-01 blocked by S12T-01 and owns the one ADR. | G4, G5 |
| B6 thread-operation approvals | Accept | Owner-thread rule from S06 everywhere; S12P-02's check and S01's waiting mapping updated. | G3, G5 |
| C6 deny choices | Accept | Keep every genuine deny option; routing identity outside display payload; Auto-denied only after upstream acknowledgement; never truncate scope. | G3 |
| C7 deny notes and queue | Accept | Note-delivery intent persisted with the outcome (S06-07, now blocked by S08F-05); S08F-05 owns queue retention. | G3, G4 |
| C8 absent index | Accept | Empty temp index via `read-tree --empty` only when no index exists. | G1 |
| C9 commit recovery | Accept | Persist request identity, inputs, original HEAD, result SHA and push outcome; reconcile before reporting failure; push the captured commit to the captured destination. | G1 |
| C10 plan protocol order | Accept | New S07-00 protocol investigation first; S07-10 merged into S07-02; S07-02 and S07-12 to S07-14 blocked by S07-09; `planTurn` and `prepareImplement` signatures in S07-01. | G2 |
| C11 native plan files | Accept | Mutate only a file whose owning session is proved; no glob deletes. | G2 |
| C12 plan autosave | Accept | `baseRevision` equality, server-incremented revision, conflict keeps local text, keyed first-edit fork. | G2 |
| C13 port detection | Accept | Probe the parsed host (IPv6 included); old ports are history only; S11 consumes `run.port`. | G4, G5 |
| C14 subagent tiers | Accept | Tier from persisted evidence and capability; S12P-08 owns status normalization; S05-08 consumes it (now blocked by S12P-08). | G5 |
| A1 missing edges | Accept | All six edges added. | graph |
| A2 oversized tickets | Accept | S07-03 narrowed; new S06-00 bug-fix ticket first. | G2, G3 |
| A3 S02-04 | Accept | Deferred to the design backlog; out of the graph and F-99. | graph, G5 |
| D1 retirement owners | Accept | New F-04c picker migration; one terminal backend chosen and the other deleted in S12T-01; owners remapped (toast F-07b, seen S01-03, glyph F-06, action menu S12T-10, setup S12T-11). | G6, G3, G4 |
| D2 executable proofs | Accept, encoded | `node tools/graph.mjs ledger` now fails any row without exactly one active owner or a runnable proof command; `ledger-run <ticket>` runs a ticket's `rg` proofs. Every fix agent makes its files pass. | all |
| D3 historic plan JSON | Accept | Keep a bounded legacy read transform for old `plan-output` fences inside the new renderer; retire writers and components only. | G2 |
| E1 startup readiness | Accept, user decision | Default: ready on exit 0 or a port from the current run. A watcher with no port would block, so T3 goes to the user. T1 now discloses that `cd` and environment changes do not carry into the shell. PRODUCT.md principle 12 no longer claims project settings drafts survive a restart (locked memory-only decision). | G4, Claude |
| F1 live check boundaries | Accept | Isolated provider homes and scratch CLI prefixes; a second fixture workspace explicitly authorized for S11-03; README uses targeted gates. | G3, G5, Claude |
| F2 immutable links | Accept | Docs are committed and pushed before publishing; issue links pin to the published commit SHA and are spot-checked. | Claude |
| B7 image route | Accept | S12P-03 owns one scoped image route; S12T-14 reuses it (now blocked by S12P-03). | G4, G5 |
