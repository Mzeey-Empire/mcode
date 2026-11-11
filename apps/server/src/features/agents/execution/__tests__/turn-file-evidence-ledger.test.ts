import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import type { Database } from "bun:sqlite";
import type { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { turnFileEvidenceWriteHandlers, listTurnFileEvidence, recordTurnFileEvidence } from "../../turns/persistence/turn-file-evidence-store.js";
import { TurnFileEvidenceLedger } from "../turn-file-evidence-ledger.js";
import { SNAPSHOT_CAPTURE_BUDGET_MS } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { FrozenExecutionFileEvidence } from "../execution-file-evidence-coordinator.js";
import type { PreparedExecutionFileEvidence } from "../../turns/turn-execution-file-evidence.js";
import * as push from "../../../../application/transport/push.js";
import { bindTurnFileEvidenceLedger, publishTurnPersisted } from "../turn-persisted-publication.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { PlanQuestionAnswersStore } from "../../planning/persistence/plan-question-answers-store.js";
import { TurnSnapshotStore } from "../../turns/persistence/turn-snapshot-store.js";
import { loadConversationPage } from "../../conversation/read-model/conversation-page.js";

const execution = { threadId: "thread", turnId: "turn", executionId: "00000000-0000-4000-8000-000000000001" };
const summary = { revision: 1, fileCount: 0, additions: 0, deletions: 0, effects: [] };
const frozen: FrozenExecutionFileEvidence = { turnId: execution.turnId, deliveryAttempt: 1, outcome: "completed", nativeDiff: null,
  handoff: { threadId: execution.threadId, executionId: execution.executionId, cwd: "/fixture", canonicalRoot: "/fixture", baselineRef: "before", generation: 1, generationToken: execution.executionId } };
const facts: PreparedExecutionFileEvidence = { ...execution, deliveryAttempt: 1, fileEffects: summary, filesChanged: [], snapshot: null, selectedTurnDiff: null };

let db: Database;
let ledger: TurnFileEvidenceLedger;
let writer: Pick<ApplicationDatabaseWriter, "execute">;
let failures: number;
const snapshots = { captureRef: vi.fn<() => Promise<string>>(), compareTrees: vi.fn<() => Promise<string[]>>() };

function terminal(outcome = "completed") { db.run("UPDATE canonical_agent_ingest_checkpoints SET terminal_outcome = ?", [outcome]); }
function evidence() { return listTurnFileEvidence(db)[0]?.evidence; }
async function flush() { await vi.advanceTimersByTimeAsync(0); }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(push, "broadcast").mockImplementation(() => {});
  db = openMemoryDatabase();
  db.run("INSERT INTO workspaces (id,name,path,created_at,updated_at) VALUES ('workspace','Fixture','/fixture','now','now')");
  db.run("INSERT INTO threads (id,workspace_id,title,branch,created_at,updated_at) VALUES ('thread','workspace','Fixture','main','now','now')");
  db.run("INSERT INTO canonical_agent_threads (id,workspace_id,root_thread_id,provider_id,activity_state,created_at,updated_at) VALUES ('thread','workspace','thread','codex','Running','now','now')");
  db.run("INSERT INTO canonical_agent_turns (id,thread_id,execution_id,status,trigger_json,permission_mode,created_at,updated_at) VALUES ('turn','thread',?,'Running','{}','full','now','now')", [execution.executionId]);
  db.run("INSERT INTO canonical_agent_ingest_checkpoints (execution_id,thread_id,turn_id,last_accepted_sequence,last_durable_sequence,phase,updated_at) VALUES (?,'thread','turn',0,0,'running','now')", [execution.executionId]);
  const handlers = turnFileEvidenceWriteHandlers(db);
  failures = 0;
  writer = { execute: async (operation, input) => {
    if (operation.name === recordTurnFileEvidence.name && failures-- > 0) throw new Error("disk unavailable");
    const handler = handlers.get(operation.name);
    if (!handler) throw new Error("Unknown operation");
    return db.transaction(() => operation.output.parse(handler(input))).immediate();
  } };
  snapshots.captureRef.mockResolvedValue("after"); snapshots.compareTrees.mockResolvedValue(["shell.txt"]);
  ledger = new TurnFileEvidenceLedger(db, writer, snapshots);
  await ledger.begin(execution);
});

afterEach(() => { ledger?.close(); db?.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("TurnFileEvidenceLedger", () => {
  it("bounds a wedged capture, keeps the agent's own diff, and discards the late result", async () => {
    let complete!: (ref: string) => void;
    snapshots.captureRef.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    db.run("INSERT INTO messages (id,thread_id,role,content,timestamp,sequence,outcome_execution_id) VALUES ('assistant','thread','assistant','Done','now',1,?)", [execution.executionId]);
    const selectedTurnDiff = { thread_id: execution.threadId, source: "native" as const, patch: "diff --git a/a.txt b/a.txt\n", revision: 1 };
    ledger.expect(execution, frozen); ledger.tracked(execution, { ...facts, selectedTurnDiff }); terminal(); ledger.terminalSaved(execution);
    let released = false;
    void ledger.collected(execution).then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_BUDGET_MS - 1);
    expect(released).toBe(false); expect(evidence()).toEqual({ state: "tracking" });
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(evidence()).toEqual({ state: "unavailable", reason: "timed-out", knownPaths: [] });
    const kept = [{ message_id: "assistant", source: "native", patch: selectedTurnDiff.patch }];
    expect(db.query("SELECT message_id, source, patch FROM turn_diff_snapshots").all()).toEqual(kept);
    complete("late"); await flush();
    expect(evidence()).toEqual({ state: "unavailable", reason: "timed-out", knownPaths: [] });
    expect(db.query("SELECT message_id, source, patch FROM turn_diff_snapshots").all()).toEqual(kept);
  });

  it("starts the collection budget when the ending is saved, so a slow save cannot time out a finished capture", async () => {
    ledger.expect(execution, frozen);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(evidence()).toEqual({ state: "tracking" });
    ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toMatchObject({ state: "recorded", filesChanged: ["shell.txt"] });
  });

  it("gives a wedged capture its full budget after a slow save", async () => {
    snapshots.captureRef.mockImplementationOnce(() => new Promise(() => {}));
    ledger.expect(execution, frozen);
    await vi.advanceTimersByTimeAsync(50_000);
    ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_BUDGET_MS - 1);
    expect(evidence()).toEqual({ state: "tracking" });
    await vi.advanceTimersByTimeAsync(1);
    expect(evidence()).toMatchObject({ state: "unavailable", reason: "timed-out" });
  });

  it("gives a full budget after a save that lands later than one budget", async () => {
    snapshots.captureRef.mockImplementationOnce(() => new Promise(() => {}));
    ledger.expect(execution, frozen);
    await vi.advanceTimersByTimeAsync(90_000);
    ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_BUDGET_MS - 1);
    expect(evidence()).toEqual({ state: "tracking" });
    await vi.advanceTimersByTimeAsync(1);
    expect(evidence()).toMatchObject({ state: "unavailable", reason: "timed-out" });
  });

  it("reports a comparison that Git ran out of time for as timed out", async () => {
    snapshots.compareTrees.mockRejectedValueOnce(Object.assign(new Error("Git command timed out after 10000 ms"), { killed: true }));
    ledger.expect(execution, frozen); ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toMatchObject({ state: "unavailable", reason: "timed-out", knownPaths: [] });
  });

  it("still releases the next turn when the ending is never saved and capture is wedged", async () => {
    snapshots.captureRef.mockImplementationOnce(() => new Promise(() => {}));
    ledger.expect(execution, frozen);
    let released = false;
    void ledger.collected(execution).then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(2 * SNAPSHOT_CAPTURE_BUDGET_MS);
    expect(released).toBe(true);
    expect(evidence()).toEqual({ state: "tracking" });
  });

  it("does not report a timeout for a collection that finished before the ending was saved", async () => {
    const warn = vi.spyOn(logger, "warn");
    ledger.expect(execution, frozen); ledger.tracked(execution, facts);
    await ledger.collected(execution);
    terminal(); ledger.terminalSaved(execution);
    await vi.advanceTimersByTimeAsync(2 * SNAPSHOT_CAPTURE_BUDGET_MS);
    expect(warn.mock.calls.map(([message]) => message)).not.toContain("Turn file evidence collection timed out");
    expect(evidence()).toMatchObject({ state: "recorded" });
  });

  it("reports a capture that Git ran out of time for as timed out", async () => {
    snapshots.captureRef.mockRejectedValueOnce(Object.assign(new Error("Git command timed out after 60000 ms"), { killed: true }));
    ledger.expect(execution, frozen); ledger.tracked(execution, { ...facts, filesChanged: ["edited.txt"] });
    terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toEqual({ state: "unavailable", reason: "timed-out", knownPaths: ["edited.txt"], fileEffects: summary });
  });

  it("retains provider paths and the agent's own diff when capture fails", async () => {
    snapshots.captureRef.mockRejectedValueOnce(new Error("git failed"));
    db.run("INSERT INTO messages (id,thread_id,role,content,timestamp,sequence,outcome_execution_id) VALUES ('assistant','thread','assistant','Done','now',1,?)", [execution.executionId]);
    const selectedTurnDiff = { thread_id: execution.threadId, source: "native" as const, patch: "diff --git a/edited.txt b/edited.txt\n", revision: 1 };
    ledger.expect(execution, frozen); ledger.tracked(execution, { ...facts, filesChanged: ["edited.txt"], selectedTurnDiff });
    terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toEqual({ state: "unavailable", reason: "capture-failed", knownPaths: ["edited.txt"], fileEffects: summary });
    expect(db.query("SELECT message_id, source, patch FROM turn_diff_snapshots").all())
      .toEqual([{ message_id: "assistant", source: "native", patch: selectedTurnDiff.patch }]);
  });

  it("reports comparison failure rather than no changes", async () => {
    snapshots.compareTrees.mockRejectedValueOnce(new Error("bad tree"));
    ledger.expect(execution, frozen); ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toMatchObject({ state: "unavailable", reason: "capture-failed", knownPaths: [] });
  });

  it("resolves restart tracking using only durable facts", async () => {
    terminal("interrupted"); await ledger.resolveAbandoned(undefined, "restarted");
    expect(evidence()).toEqual({ state: "unavailable", reason: "restarted", knownPaths: [] });
    expect(snapshots.captureRef).not.toHaveBeenCalled();
    expect(vi.mocked(push.broadcast).mock.calls.filter(([channel]) => channel === "turn.fileEvidence").map(([, value]) => value)).toEqual([
      { ...execution, messageId: null, evidence: { state: "unavailable", reason: "restarted", knownPaths: [] } },
    ]);
  });

  it("does not replace lost tracked facts with a Git-only list", async () => {
    ledger.expect(execution, frozen); terminal("interrupted"); ledger.terminalSaved(execution); ledger.tracked(execution, "lost"); await flush();
    expect(evidence()).toEqual({ state: "unavailable", reason: "observation-lost", knownPaths: [] });
    expect(snapshots.compareTrees).not.toHaveBeenCalled();
  });

  it("waits for terminal publication and retries failed writes without abandoning live entries", async () => {
    ledger.expect(execution, frozen); ledger.tracked(execution, facts); terminal(); failures = 2;
    await flush(); expect(evidence()).toEqual({ state: "tracking" });
    bindTurnFileEvidenceLedger(ledger);
    publishTurnPersisted(execution, { providerId: "codex", sessionId: null, messageSequence: null, messageId: null,
      settledMessage: null, outcome: "completed", toolCallCount: 0, filesChanged: [] });
    await flush();
    await ledger.resolveAbandoned(execution.threadId);
    await vi.advanceTimersByTimeAsync(1000); expect(evidence()).toEqual({ state: "tracking" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(evidence()).toEqual({ state: "recorded", filesChanged: ["shell.txt"], fileEffects: summary });
    expect(vi.mocked(push.broadcast).mock.calls.filter(([channel]) => channel === "turn.persisted" || channel === "turn.fileEvidence").map(([channel]) => channel))
      .toEqual(["turn.persisted", "turn.fileEvidence", "turn.fileEvidence"]);
  });

  it("resolves a lost worker's tracking once its interruption is saved, with no live entry", async () => {
    ledger.terminalSaved(execution); await flush();
    expect(evidence()).toEqual({ state: "tracking" });
    terminal("interrupted"); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toEqual({ state: "unavailable", reason: "observation-lost", knownPaths: [] });
  });

  it("stops retrying once the thread's execution is deleted", async () => {
    const execute = vi.spyOn(writer, "execute");
    ledger.expect(execution, frozen); ledger.tracked(execution, facts); terminal(); failures = 1;
    ledger.terminalSaved(execution); await flush();
    db.run("DELETE FROM canonical_agent_ingest_checkpoints");
    await vi.advanceTimersByTimeAsync(1000);
    const attempts = execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(execute.mock.calls.length).toBe(attempts);
  });

  it("refreshes the diff only once the evidence resolves", async () => {
    ledger.expect(execution, frozen); ledger.tracked(execution, facts); terminal();
    const channels = () => vi.mocked(push.broadcast).mock.calls.map(([channel]) => channel).filter((channel) => channel.startsWith("turn."));
    ledger.terminalSaved(execution);
    expect(channels()).toEqual(["turn.fileEvidence"]);
    await flush();
    expect(channels()).toEqual(["turn.fileEvidence", "turn.fileEvidence", "turn.diffChanged"]);
  });

  it("records tracked paths with no baseline", async () => {
    ledger.expect(execution, { ...frozen, handoff: { ...frozen.handoff, baselineRef: null } });
    ledger.tracked(execution, { ...facts, filesChanged: ["edited.txt"] }); terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toEqual({ state: "recorded", filesChanged: ["edited.txt"], fileEffects: summary });
    expect(snapshots.captureRef).not.toHaveBeenCalled();
  });

  it("leaves an empty turn with no baseline untracked", async () => {
    ledger.expect(execution, { ...frozen, handoff: { ...frozen.handoff, baselineRef: null } });
    ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution); await flush();
    expect(evidence()).toEqual({ state: "untracked" });
  });

  it("republishes the stored resolution when the first publication fails after commit", async () => {
    let failed = false;
    vi.mocked(push.broadcast).mockImplementation((channel, payload) => {
      if (channel === "turn.fileEvidence" && "evidence" in payload && payload.evidence.state === "recorded" && !failed) {
        failed = true;
        throw new Error("publication failed");
      }
    });
    ledger.expect(execution, frozen); ledger.tracked(execution, facts); terminal(); ledger.terminalSaved(execution);
    await flush();
    expect(evidence()).toEqual({ state: "recorded", filesChanged: ["shell.txt"], fileEffects: summary });
    await vi.advanceTimersByTimeAsync(1000);
    const recorded = vi.mocked(push.broadcast).mock.calls.filter(([channel, payload]) =>
      channel === "turn.fileEvidence" && "evidence" in payload && payload.evidence.state === "recorded");
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toEqual(recorded[0]);
  });

  it("rolls back the snapshot and thread flag when evidence resolution fails", async () => {
    terminal();
    db.run("INSERT INTO messages (id,thread_id,role,content,timestamp,sequence,outcome_execution_id) VALUES ('assistant','thread','assistant','Done','now',1,?)", [execution.executionId]);
    db.run("CREATE TRIGGER reject_evidence BEFORE UPDATE ON turn_file_evidence BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    await expect(writer.execute(recordTurnFileEvidence, { ...execution,
      evidence: { state: "recorded", filesChanged: ["shell.txt"], fileEffects: summary },
      snapshot: { threadId: execution.threadId, refBefore: "before", refAfter: "after", filesChanged: ["shell.txt"], fileEffects: summary, worktreePath: null }, diff: null,
    })).rejects.toThrow();
    expect(db.query("SELECT count(*) AS count FROM turn_snapshots").get()).toEqual({ count: 0 });
    expect(db.query("SELECT has_file_changes FROM threads").get()).toEqual({ has_file_changes: 0 });
    expect(evidence()).toEqual({ state: "tracking" });
  });

  it("keeps recorded paths across snapshot retention and drops a completed diff on interrupted recovery", async () => {
    terminal("interrupted");
    db.run("INSERT INTO messages (id,thread_id,role,content,timestamp,sequence,outcome_execution_id) VALUES ('assistant','thread','assistant','Done','now',1,?)", [execution.executionId]);
    await writer.execute(recordTurnFileEvidence, { ...execution,
      evidence: { state: "recorded", filesChanged: ["shell.txt"], fileEffects: summary },
      snapshot: { threadId: execution.threadId, refBefore: "before", refAfter: "after", filesChanged: ["shell.txt"], fileEffects: summary, worktreePath: null },
      diff: { thread_id: execution.threadId, source: "git", patch: null, revision: 1 },
    });
    expect(db.query("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM turn_snapshots").get()).toEqual({ count: 1 });
    db.run("DELETE FROM turn_snapshots");
    expect(evidence()).toEqual({ state: "recorded", filesChanged: ["shell.txt"], fileEffects: summary });
  });

  it("rejects foreign ownership and preserves the first resolution on replay", async () => {
    terminal();
    const resolution = { ...execution, evidence: { state: "recorded", filesChanged: [] } as const, snapshot: null, diff: null };
    await expect(writer.execute(recordTurnFileEvidence, { ...resolution, threadId: "other" })).rejects.toThrow();
    await writer.execute(recordTurnFileEvidence, resolution);
    await writer.execute(recordTurnFileEvidence, { ...resolution, evidence: { state: "unavailable", reason: "restarted", knownPaths: [] } });
    expect(evidence()).toEqual({ state: "recorded", filesChanged: [] });
  });

  it("pages evidence with its assistant message, and unattached evidence with the latest page only", () => {
    const messages = new MessageStore(db);
    const answer = messages.create(execution.threadId, "assistant", "Answer", 1);
    for (const sequence of [2, 3]) messages.create(execution.threadId, "user", `Later ${sequence}`, sequence);
    const paged = (before?: number) => loadConversationPage({ messageRepo: messages, planQuestionAnswersRepo: new PlanQuestionAnswersStore(db) },
      { threadId: execution.threadId, limit: 2, ...(before === undefined ? {} : { before }) }).turnFileEvidence?.map((row) => row.executionId);
    expect(paged()).toEqual([execution.executionId]);
    expect(paged(2)).toEqual([]);
    db.run("UPDATE messages SET outcome_execution_id = ? WHERE id = ?", [execution.executionId, answer.id]);
    expect(paged()).toEqual([]);
    expect(paged(2)).toEqual([execution.executionId]);
  });

  it("leaves row-less legacy paths available through their snapshot fallback", async () => {
    db.run("DELETE FROM turn_file_evidence");
    const message = new MessageStore(db).create(execution.threadId, "assistant", "Legacy answer", 1);
    const snapshots = new TurnSnapshotStore(db);
    snapshots.create({ messageId: message.id, threadId: execution.threadId, refBefore: "before", refAfter: "after", filesChanged: ["legacy.txt"], worktreePath: null });
    const page = loadConversationPage({ messageRepo: new MessageStore(db), planQuestionAnswersRepo: new PlanQuestionAnswersStore(db) },
      { threadId: execution.threadId, limit: 20 });
    expect(page.turnFileEvidence).toEqual([]);
    expect(snapshots.getByMessage(message.id)?.files_changed).toEqual(["legacy.txt"]);
  });
});
