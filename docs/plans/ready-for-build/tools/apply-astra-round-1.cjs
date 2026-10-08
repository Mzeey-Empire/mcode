// One-off: applies the graph edits agreed after Astra review round 1. Kept for the audit trail.
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "graph.json");
const g = JSON.parse(fs.readFileSync(file, "utf8"));
const add = (id, ...bs) => { for (const b of bs) if (!g.blockers[id].includes(b)) g.blockers[id].push(b); };
const drop = (id, why) => { delete g.blockers[id]; delete g.needsDecision[id]; g.dropped[id] = why; };

drop("S08-05", "Merged into S08-03: revert safety material must be persisted and pinned before the first destructive write.");
drop("S04-08", "Merged into S12T-11: one atomic switch makes the S12 action runner the only startup executor and converts the trail to read it.");
drop("S07-10", "Merged into S07-02: Codex native plan mode and its requestUserInput question protocol activate together.");
drop("S02-04", "Deferred to the design backlog: New project, Git URL and GitHub sources have no boards. Excluded from this program and from F-99.");

g.blockers["S06-00"] = [];
g.blockers["S07-00"] = [];
g.blockers["F-04c"] = ["F-04b", "F-06"];

g.blockers["S08-03"] = ["S10-12"];
add("S12T-11", "S04-04", "S04-07");
add("S06-01", "S06-00");
add("S07-01", "S07-00");
add("S07-02", "S07-09");
add("S07-12", "S07-09");
add("S07-13", "S07-09");
add("S07-14", "S07-09");
add("S07-06", "S10-11", "F-07b");
add("S12P-01", "S12T-01");
add("S06-07", "S08F-05");
add("S05-08", "S12P-08");
add("S01-03", "S06-01");
add("S03-02", "F-04a");
add("S03-03", "F-02");
add("S08F-07", "F-04b", "F-04c");
add("S12P-07", "S07-06");
add("S12T-14", "S12P-03");

const ordered = {};
for (const k of Object.keys(g.blockers).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) ordered[k] = g.blockers[k];
const star = ordered["F-99"];
delete ordered["F-99"];
ordered["F-99"] = star;
g.blockers = ordered;

Object.assign(g.notes, {
  "S01-03": "Owns the single seen marker and its one write: `thread.acknowledgeSeen({ threadId, throughSequence })`, where `throughSequence` is the settled message sequence the client has actually rendered. Returns `{ previous: { sequence, at }, current: { sequence, at } }` atomically; a repeat is a no-op; a sequence beyond the thread's settled history is rejected. Replaces `thread.markViewed` and every caller (including the unfocused call in the thread store) in this ticket. Waiting sources read ApprovalService (S06-01), never the old permission service. `recordTurnOutcome` is the one write path for turn endings; S08F-01 extends it. Opening a thread clears Finished and Failed, never a live pending approval.",
  "S08-03": "Absorbs S08-05. Apply and undo take a client `requestId` (operation identity, replayed only for the same request); `previewToken` is only a precondition over repo identity, snapshot, scope and each path's presence, type, mode and content. Persist a prepared operation and pin its recovery material (`refs/mcode/<storeId>/reverts/<id>`, plus raw bytes and metadata for touched paths where a tree cannot restore exactly) before the first write; recover unfinished operations on startup. Revert UI (S08-04) cannot ship before this.",
  "S10-12": "Owns snapshot pinning for every section, namespaced by the owning database: `refs/mcode/<storeId>/snapshots/<id>` (a cloned dev database gets its own storeId). Sweep only refs under this store's namespace. Pin the dirty pre-turn baseline when it is captured, not at finalization. S08-03 adds `reverts/` beside it.",
  "S10-11": "Owns the one draft store for everything that rides the next message: Review comments, Browser design notes (S11-15), file line comments (S12P-07) and plan-comment chip selection (S07-06). Decision: the persisted composer draft, no new table. It must persist included and excluded plan comment ids, stage screenshot snapshots durably with reference release on discard, thread deletion and successful admission, update the serializer, parser and the write-failure path (surface failure, never silently drop), and clear only the submitted draft revision after admission. Plan comments themselves stay records in `plan_comments`.",
  "S11-15": "Uses the S10-11 draft store. Delete the `thread_annotation_drafts` table and its two RPCs from this brief.",
  "S12P-01": "Writes the single ADR for right panel tabs (rail = tools, row-1 tabs inside a tool), superseding ADR-0020. Terminal cap is eight records per scope (pending, running and exited, shells and actions together) from S12T-01's contract constant; + disables at eight. S12T-02 writes no ADR.",
  "S12T-11": "Absorbs S04-08. The S12 action runner is the only startup executor; the startup trail is a projection of the frozen action and run ids. Retry reruns from the first failed action and skips actions that succeeded in this attempt. The trail shows a bounded read-only tail of the run's terminal output plus Open terminal. Scripts stay out of the startup record (ids plus a content hash), so the record has no separate command bounds. Converts the runner and every old-setup consumer in one ticket. Readiness: an action is ready on exit 0 or on a port detected from the current run, whichever comes first (decision T3).",
  "S12T-08": "Owns port detection for every consumer. Parse candidate URLs from the current run's output (ANSI and chunk safe), normalize the host (IPv4, IPv6, localhost) and probe that host. A previous run's port is display history only, never readiness. TCP reachability is not app health; say so in copy. The Browser (S11-09) reads `run.port`; delete S11's alternate `servers.list` sketch and the unimplemented `detectLocalPorts` declaration.",
  "S12P-03": "Owns the single authenticated, scoped image-read route used by Files and by project icons (S12T-14): workspace-root and thread-worktree scopes, per-segment path checks, SVG handling, caller-specific size caps (icon 2 MB, Files 20 MB) and caching.",
  "S12T-14": "Reuses the S12P-03 image route; no second route. The sidebar project row's icon slot is a lifecycle toggle today; S01-02 decides where that toggle goes before this ticket swaps the slot to the project icon.",
  "S05-08": "Consumes the S12P-08 roster entry's provider and normalized status; no second status model in the chips or overview.",
  "S08F-05": "Also owns queue retention: an error or ending never silently clears queued user input. The queue pauses visibly with an explicit send action.",
  "S06-07": "Persists note-delivery intent with the approval outcome, deduplicated by request id, so a lost response or reconnect cannot drop the note.",
  "S10-05": "Reuses S03-04's qualified-ref listing with an explicit purpose filter. Review keeps local and origin twins as separate selectable refs; the new-thread picker may group them for display. Remove the competing `git.listRefs` sketch.",
  "S03-04": "Owns one qualified-ref listing (full ref names, explicit purpose filter, one paging and result contract, current-worktree context, sorting) shared with Review's Branch picker (S10-05). Test diverged local and origin branches with the same short name.",
  "S06-00": "Small first fix, before the v2 contract: Cursor deny never selects an allow option, and a request that fails validation is denied upstream with a visible receipt instead of hanging the agent.",
  "S07-00": "Bounded protocol investigation for all six providers before plan capture: captured request and response evidence for native plan output, questions, plan-file identity and minimum supported versions. Its findings decide which native paths S07-02 and S07-12 to S07-14 promise.",
  "F-04c": "Migrates the model picker and the file editor picker to the F-04b picker; owns their retirement (they were assigned to whole sections before).",
  "S12T-01": "Chooses the one terminal backend to keep (decision T11) and deletes the other backend, its selector and env option, its tests and docs. Defines `TERMINAL_MAX_PER_SCOPE = 8`.",
  "S07-03": "Narrowed: durable versions, save and snapshot, writer coordination and one working read consumer. Comment operations and re-anchoring move to S07-06, the Implement operation to S07-07, plan-phase classification to S07-09. `planTurn` and `prepareImplement` signatures are set in S07-01.",
  "S07-07": "Implement is a durable request (immutable version, revision and text, target thread, admission identity, recoverable status). Reserve turn admission before changing plan status; mark Accepted only with successful admission, with conditional compensation. Replays return the same target and message, including the new-thread path (S07-08)."
});
fs.writeFileSync(file, JSON.stringify(g, null, 2) + "\n");
console.log(`graph.json updated: ${Object.keys(g.blockers).length} tickets, ${Object.keys(g.dropped).length} merged or deferred`);
