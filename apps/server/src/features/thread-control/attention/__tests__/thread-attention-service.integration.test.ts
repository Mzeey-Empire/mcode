import { createMockApproval, createMockThreadAttention } from "@mcode/contracts/testing";
import "reflect-metadata";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@mcode/contracts/models/approval";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { ThreadStore } from "../../persistence/thread-store.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { ApprovalService } from "../../../agents/approvals/approval-service.js";
import { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import { CanonicalParentTurnWrite } from "../../../agents/canonical/canonical-parent-turn-write.js";
import { CanonicalExecutionSemanticWriter } from "../../../agents/canonical/canonical-execution-semantic-writer.js";
import { ExecutionWorkerHandler } from "../../../agents/execution/execution-worker-handler.js";
import { deriveTurnAssistantMessageId } from "../../../agents/turns/turn-assistant-message-id.js";
import { MessageStore } from "../../../agents/conversation/persistence/message-store.js";
import { invalidateAttentionOnSettledTurns, ThreadAttentionService } from "../thread-attention-service.js";
import { threadDescendantsSource } from "../thread-descendants.js";
import { CanonicalAgentBoundary } from "../../../agents/canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../../agents/canonical/canonical-agent-writer-client.js";
import { SubagentRosterService } from "../../../agents/collaboration/subagent-roster-service.js";
import { NarrativeStore } from "../../../agents/conversation/narrative/narrative-store.js";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../../agents/tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../../agents/conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../../agents/events/persistence/hook-execution-repo.js";
import { ThreadControlApprovalRepo } from "../../authority/persistence/thread-control-approval-repo.js";
import { ProviderRegistry } from "../../../providers/composition/provider-registry.js";
import { notifyCommittedCanonicalEvents, subscribeCommittedCanonicalEvents } from "../../../agents/canonical/committed-canonical-events.js";
import { approvalWaitingSource } from "../approval-waiting-source.js";
import { plannedRestartNoticeText } from "@mcode/shared/planned-restart";

const BEFORE = "2026-10-10T10:00:00.000Z";
const ENDED = "2026-10-10T10:01:00.000Z";

function backgroundSubagents() {
  const running = new Set<string>();
  const listeners = new Set<(threadId: string) => void>();
  const announce = (threadId: string) => { for (const listener of listeners) listener(threadId); };
  return {
    backgroundSubagentThreadIds: () => running,
    onSubagentChange: (listener: (threadId: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    launch: (threadId: string) => { running.add(threadId); announce(threadId); },
    settle: (threadId: string) => { running.delete(threadId); announce(threadId); },
  };
}

async function fixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Attention", "attention-fixture");
  const a = await threads.create(workspace.id, "A", "direct", "main", true, "codex");
  const b = await threads.create(workspace.id, "B", "direct", "main", true, "codex");
  const requests: ApprovalRequest[] = [];
  const approvals = new ApprovalService({ resolveAll: () => [] });
  const pushes: ThreadAttention[] = [];
  const coordinators = new Set<string>();
  const subagents = backgroundSubagents();
  const { reader, writer } = runtime;
  const narrative = new NarrativeStore(new MessageRepo(reader, writer), new ToolCallRecordRepo(reader, writer),
    new ThoughtSegmentRepo(reader, writer), new HookExecutionRepo(reader, writer), reader);
  const canonical = new CanonicalAgentBoundary(reader, writer, new CanonicalAgentWriterClient(writer), () => {});
  const roster = new SubagentRosterService(canonical, new ProviderRegistry([]), narrative, reader);
  roster.bindPendingInput(approvals, new ThreadControlApprovalRepo(reader, writer));
  const rosterSource = threadDescendantsSource(roster, subagents);
  const descendants = {
    descendants: (id: string) => coordinators.has(id) ? "running" as const : rosterSource.descendants(id),
    candidates: () => new Set([...coordinators, ...rosterSource.candidates()]),
  };
  const service = new ThreadAttentionService(reader, writer, [approvalWaitingSource(approvals)], descendants, (attention) => pushes.push(attention));
  const inputChanged = (id: string) => { service.invalidate(id); roster.inputChanged(id); };
  approvals.start({
    publishApprovalRequest: (request) => inputChanged(request.threadId),
    publishApprovalResolved: (resolved) => inputChanged(resolved.threadId),
    stopSession: async () => {},
  }, { listPendingApprovals: () => requests, respondToApproval: async () => ({ status: "not_pending" }) });
  threads.attention = service;
  const snapshots = new TurnSnapshotRepo(runtime.reader, runtime.writer);
  snapshots.attention = service;
  const settle = (sequence: number, outcome: TurnOutcome = "completed") => {
    runtime.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, outcome) VALUES (?, ?, 'assistant', 'Answer', ?, ?)")
      .run(`message-${sequence}`, a.id, sequence, outcome);
  };
  const markBefore = () => runtime.database.query("UPDATE threads SET seen_through_sequence = 2, seen_at = ? WHERE id = ?").run(BEFORE, a.id);
  return { ...runtime, a, b, workspace, threads, service, approvals, snapshots, requests, pushes, settle, markBefore, coordinators, descendants, subagents, roster };
}

describe("thread attention through real SQLite and the serialized writer", () => {
  it("publishes a canonical parent's attention when its child's approval opens and resolves", async () => {
    const t = await fixture();
    const canonicalThread = t.database.query(`INSERT INTO canonical_agent_threads
      (id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'codex', ?, ?, ?)`);
    canonicalThread.run(t.a.id, t.workspace.id, null, t.a.id, null, "Idle", BEFORE, BEFORE);
    canonicalThread.run(t.b.id, t.workspace.id, t.a.id, t.a.id, t.a.id, "Active", BEFORE, BEFORE);
    const request = createMockApproval({ requestId: "child-approval", threadId: t.b.id, providerId: "codex", requestedAt: BEFORE });
    const states = () => t.pushes.filter(({ threadId }) => threadId === t.a.id).map(({ descendants }) => descendants);
    const unsubscribe = t.roster.onChanged((parentId) => t.service.invalidate(parentId));
    vi.useFakeTimers();
    try {
      t.service.invalidate(t.a.id);
      t.requests.push(request);
      t.approvals.publish({ requestId: request.requestId, threadId: request.threadId, body: {
        requestedAt: request.requestedAt, subject: request.subject, choices: request.choices, origin: request.origin,
      } }, { id: "codex" });
      expect(states()).toEqual(["running"]);
      vi.advanceTimersByTime(250);
      expect(states()).toEqual(["running", "needs-you"]);
      t.requests.pop();
      t.approvals.resolved({ requestId: request.requestId, threadId: request.threadId,
        outcome: { status: "allowed", intent: "allow_once", choiceLabel: "Allow" } });
      vi.advanceTimersByTime(250);
      expect(states()).toEqual(["running", "needs-you", "running"]);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("hydrates a seen Coordinator without a wait only while delegated tasks are unfinished", async () => {
    const t = await fixture();
    t.settle(2);
    t.markBefore();
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    t.coordinators.add(t.a.id);
    expect(t.service.listInteresting().map(({ threadId, waiting, descendants }) => ({ threadId, waiting, descendants })))
      .toEqual([{ threadId: t.a.id, waiting: null, descendants: "running" }]);
    t.coordinators.clear();
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("hydrates a seen thread only while a background subagent runs", async () => {
    const t = await fixture();
    t.settle(2);
    t.markBefore();
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    t.subagents.launch(t.a.id);
    expect(t.service.listInteresting().map(({ threadId, descendants }) => ({ threadId, descendants })))
      .toEqual([{ threadId: t.a.id, descendants: "running" }]);
    t.subagents.settle(t.a.id);
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("republishes attention when a background subagent launches and when it settles", async () => {
    const t = await fixture();
    t.settle(2);
    t.markBefore();
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    t.pushes.length = 0;
    const stopWorkload = t.roster.observeWorkload(t.subagents);
    const unsubscribe = t.roster.onChanged((parentId) => t.service.invalidate(parentId));
    vi.useFakeTimers();
    try {
      t.subagents.launch(t.a.id);
      vi.advanceTimersByTime(250);
      t.subagents.settle(t.a.id);
      vi.advanceTimersByTime(250);
      expect(t.pushes.map(({ threadId, descendants }) => ({ threadId, descendants })))
        .toEqual([{ threadId: t.a.id, descendants: "running" }, { threadId: t.a.id, descendants: "none" }]);
      unsubscribe();
      t.subagents.launch(t.a.id);
      vi.advanceTimersByTime(250);
      expect(t.pushes).toHaveLength(2);
    } finally {
      unsubscribe();
      stopWorkload();
      vi.useRealTimers();
    }
  });

  it("publishes delegation changes once and emits one clearing frame", async () => {
    const t = await fixture();
    t.coordinators.add(t.a.id);
    t.service.invalidate(t.a.id);
    t.service.invalidate(t.a.id);
    expect(t.pushes.map(({ descendants }) => descendants)).toEqual(["running"]);
    t.coordinators.clear();
    t.service.invalidate(t.a.id);
    t.service.invalidate(t.a.id);
    expect(t.pushes.map(({ descendants }) => descendants)).toEqual(["running", "none"]);
  });

  it.each([true, false])("uses only transcript-visible sequence anchors, with answer: %s", async (withAnswer) => {
    const t = await fixture();
    t.database.query("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES ('prompt', ?, 'user', 'Question', 1)").run(t.a.id);
    if (withAnswer) t.settle(2);
    t.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, is_internal, outcome) VALUES ('internal', ?, 'assistant', 'Internal', 3, 1, 'completed')").run(t.a.id);
    for (const [index, notice] of [
      { scope: "session", kind: "mode" },
      { scope: "turn", kind: "warning" },
      { scope: "turn", kind: "configuration" },
      { scope: "turn", kind: "deprecation" },
      { scope: "turn", kind: "authentication-recovered" },
    ].entries()) {
      t.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, system_notice) VALUES (?, ?, 'system', 'Notice', ?, ?)")
        .run(`notice-${index}`, t.a.id, index + 4, JSON.stringify(notice));
    }

    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    const messages = new MessageStore(t.database);
    const sequence = withAnswer ? 2 : 1;
    expect(messages.latestSequenceMessage(t.a.id)).toEqual({ id: withAnswer ? "message-2" : "prompt", sequence });
    expect(messages.listByThread(t.a.id, 20).messages.map((message) => message.sequence)).toEqual(withAnswer ? [1, 2] : [1]);
    expect(t.service.get(t.a.id)?.lastTurn?.sequence).toBe(sequence);
    await expect(t.service.acknowledgeSeen(t.a.id, sequence + 1)).rejects.toMatchObject({ code: "sequence_ahead" });
    expect((await t.service.acknowledgeSeen(t.a.id, sequence)).current.sequence).toBe(sequence);
    expect(t.service.listInteresting()).toEqual([]);
  });

  async function beginEmptyTurn(t: Awaited<ReturnType<typeof fixture>>) {
    const execution = { threadId: t.a.id, turnId: "empty-turn", executionId: "00000000-0000-4000-8000-000000000002" };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "empty-lease" };
    const handler = new ExecutionWorkerHandler(new CanonicalExecutionSemanticWriter(t.database, () => {}));
    const started = await handler.handle({ requestId: 1, execution, lease, ordinal: 1, command: { kind: "start", providerId: "codex", input: {
      thread: { id: t.a.id, workspaceId: t.workspace.id, providerId: "codex", createdAt: BEFORE }, ...execution,
      permissionMode: "supervised", providerIdentities: [], userMessage: { kind: "create", messageId: "empty-prompt", content: "Next question", sequence: 3 },
    } } });
    expect(started.result.kind).toBe("committed");
    return () => handler.handle({ requestId: 2, execution, lease, ordinal: 2, command: {
      kind: "finish-live-event", outcome: "errored",
      projection: { threadId: t.a.id, executionId: execution.executionId, outcome: "errored", endedAt: ENDED,
        assistant: { content: "", model: null, attachments: [] }, narrative: [] },
      input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "errored", error: "Dispatch failed", projection: { kind: "writer-staged" } },
      livePublication: [{ after: "terminal", event: { type: "ended", threadId: t.a.id, turnExecutionId: execution.executionId, outcome: "errored" } }],
    } });
  }

  it("surfaces an empty failed turn at its own prompt sequence and clears only that rendered sequence", async () => {
    const t = await fixture();
    t.settle(2); t.markBefore();
    const finish = await beginEmptyTurn(t);
    await expect(t.service.acknowledgeSeen(t.a.id, 3)).rejects.toMatchObject({ code: "sequence_ahead" });
    const result = await finish();
    expect(result.result).toMatchObject({ kind: "committed", terminalPersistence: {
      messageId: null, settledMessage: { id: "empty-prompt", sequence: 3 }, outcome: "errored", toolCallCount: 0,
    } });
    expect(t.service.listInteresting().map(({ lastTurn }) => lastTurn)).toEqual([
      { sequence: 3, outcome: "errored", endedAt: ENDED, changedFileCount: null },
    ]);
    expect(t.database.query("SELECT id, sequence FROM messages WHERE thread_id = ? ORDER BY sequence").all(t.a.id))
      .toEqual([{ id: "message-2", sequence: 2 }, { id: "empty-prompt", sequence: 3 }]);
    await expect(t.service.acknowledgeSeen(t.a.id, 4)).rejects.toMatchObject({ code: "sequence_ahead" });
    const seen = await t.service.acknowledgeSeen(t.a.id, 3);
    expect(seen.previous).toEqual({ sequence: 2, at: BEFORE });
    expect(seen.current.sequence).toBe(3);
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("rejects the semantic finish when its compatibility thread is missing", async () => {
    const t = await fixture();
    const finish = await beginEmptyTurn(t);
    t.database.run("PRAGMA foreign_keys = OFF");
    t.database.query("DELETE FROM threads WHERE id = ?").run(t.a.id);
    t.database.run("PRAGMA foreign_keys = ON");
    const result = await finish();
    expect(result.result).toEqual({ kind: "rejected", reason: "writer-conflict" });
    expect(t.database.query("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get("00000000-0000-4000-8000-000000000002")).toEqual({ terminal_outcome: null });
  });

  it("orders mixed-precision endings by instant and ignores an older replay", async () => {
    const t = await fixture();
    t.settle(2);
    expect(await t.threads.recordTurnOutcome(t.a.id, "completed", "2026-10-10T10:00:01Z")).toBe(true);
    expect(await t.threads.recordTurnOutcome(t.a.id, "errored", "2026-10-10T10:00:01.500Z")).toBe(true);
    expect(await t.threads.recordTurnOutcome(t.a.id, "completed", "2026-10-10T10:00:01Z")).toBe(false);
    expect(t.service.get(t.a.id)?.lastTurn).toEqual({
      sequence: 2, outcome: "errored", endedAt: "2026-10-10T10:00:01.500Z", changedFileCount: null,
    });
  });

  it("allows a stale semantic finish without overwriting a newer ending", async () => {
    const t = await fixture();
    const finish = await beginEmptyTurn(t);
    await t.threads.recordTurnOutcome(t.a.id, "completed", "2026-10-10T10:02:00.000Z");
    const result = await finish();
    expect(result.result.kind).toBe("committed");
    expect(t.service.get(t.a.id)?.lastTurn).toEqual({
      sequence: 3, outcome: "completed", endedAt: "2026-10-10T10:02:00.000Z", changedFileCount: null,
    });
  });

  it("pushes attention once when a saved canonical batch settles a turn", async () => {
    const t = await fixture();
    const unsubscribe = invalidateAttentionOnSettledTurns(t.service, subscribeCommittedCanonicalEvents);
    try {
      t.settle(3);
      new ThreadStore(t.database).recordTurnOutcome(t.a.id, "completed", ENDED);
      expect(t.pushes).toEqual([]);
      const event = (type: string) => ({ routing: { threadId: t.a.id }, payload: { type } }) as unknown as Parameters<typeof notifyCommittedCanonicalEvents>[0][number];
      notifyCommittedCanonicalEvents([event("turn.started")]);
      expect(t.pushes).toEqual([]);
      notifyCommittedCanonicalEvents([event("message.recorded"), event("turn.completed")]);
      notifyCommittedCanonicalEvents([event("turn.completed")]);
      expect(t.pushes).toEqual([createMockThreadAttention({ threadId: t.a.id,
        lastTurn: { outcome: "completed", endedAt: ENDED, sequence: 3, changedFileCount: null }, seen: { sequence: null, at: null } })]);
    } finally {
      unsubscribe();
    }
  });

  it("advances once, returns both marks, and pauses completed status atomically", async () => {
    const t = await fixture();
    t.settle(2); t.settle(4); t.markBefore();
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    t.pushes.length = 0;
    const result = await t.service.acknowledgeSeen(t.a.id, 4);
    expect(result.previous).toEqual({ sequence: 2, at: BEFORE });
    expect(result.current.sequence).toBe(4);
    expect(result.current.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(t.service.get(t.a.id)?.seen).toEqual(result.current);
    expect(t.threads.findById(t.a.id)?.status).toBe("paused");
    expect(t.pushes).toEqual([createMockThreadAttention({ threadId: t.a.id,
      lastTurn: { outcome: "completed", endedAt: ENDED, sequence: 4, changedFileCount: null }, seen: result.current })]);
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("does not write or push for repeated/lower marks, and rejects sequences ahead of settled history", async () => {
    const t = await fixture();
    t.settle(2); t.markBefore();
    t.database.run("CREATE TRIGGER reject_attention_update BEFORE UPDATE ON threads BEGIN SELECT RAISE(ABORT, 'unexpected update'); END");
    for (const sequence of [2, 1]) expect(await t.service.acknowledgeSeen(t.a.id, sequence)).toEqual({
      previous: { sequence: 2, at: BEFORE }, current: { sequence: 2, at: BEFORE },
    });
    await expect(t.service.acknowledgeSeen(t.a.id, 3)).rejects.toMatchObject({ code: "sequence_ahead" });
    expect(t.service.get(t.a.id)?.seen).toEqual({ sequence: 2, at: BEFORE });
    expect(t.pushes).toEqual([]);
  });

  it.each([[4, 8], [8, 4]])("serializes concurrent acknowledgements %i then %i", async (first, second) => {
    const t = await fixture();
    t.settle(2); t.settle(4); t.settle(8); t.markBefore();
    const [one, two] = await Promise.all([t.service.acknowledgeSeen(t.a.id, first), t.service.acknowledgeSeen(t.a.id, second)]);
    expect(one.previous).toEqual({ sequence: 2, at: BEFORE });
    expect(one.current.sequence).toBe(first);
    expect(two.previous).toEqual(one.current);
    expect(two.current.sequence).toBe(8);
    expect(t.service.get(t.a.id)?.seen).toEqual(two.current);
    if (first === 8) expect(two.previous).toEqual(two.current);
  });

  it("returns the marker before three unseen turns and does not replay an older outcome", async () => {
    const t = await fixture();
    t.settle(2); t.markBefore();
    t.settle(4); t.settle(6); t.settle(8, "errored");
    await t.threads.recordTurnOutcome(t.a.id, "errored", ENDED);
    expect(await t.threads.recordTurnOutcome(t.a.id, "completed", BEFORE)).toBe(false);
    expect(t.service.listInteresting().map(({ lastTurn }) => lastTurn)).toEqual([
      { outcome: "errored", endedAt: ENDED, sequence: 8, changedFileCount: null },
    ]);
    const result = await t.service.acknowledgeSeen(t.a.id, 8);
    expect(result.previous).toEqual({ sequence: 2, at: BEFORE });
    expect(result.current.sequence).toBe(8);
    expect(t.threads.findById(t.a.id)?.status).toBe("errored");
  });

  it("lists owner A's supervised send approval after reload, keeps it after ack, and drops deleted threads", async () => {
    const t = await fixture();
    t.settle(2); await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    const request: ApprovalRequest = createMockApproval({
      requestId: "approval-send",
      threadId: t.a.id,
      providerId: "codex",
      requestedAt: BEFORE,
      subject: { kind: "thread_operation", operation: "thread_send", targetThreadId: t.b.id, message: "Continue" },
      choices: [{ id: "allow", intent: "allow_once", label: "Allow" }, { id: "deny", intent: "deny", label: "Deny" }],
      origin: { kind: "agent" },
    });
    t.requests.push({ ...request, requestId: "later", requestedAt: ENDED }, request);
    t.approvals.publish({ requestId: request.requestId, threadId: request.threadId, body: {
      requestedAt: request.requestedAt, subject: request.subject, choices: request.choices, origin: request.origin,
    } }, { id: "codex" });
    const reloaded = new ThreadAttentionService(t.reader, t.writer, [approvalWaitingSource(t.approvals)], t.descendants, () => {});
    expect(reloaded.listInteresting().map(({ threadId, waiting }) => ({ threadId, waiting }))).toEqual([
      { threadId: t.a.id, waiting: { kind: "approval", since: BEFORE } },
    ]);
    expect(reloaded.get(t.b.id)?.waiting).toBeNull();
    await t.service.acknowledgeSeen(t.a.id, 2);
    expect(t.service.listInteresting().map(({ waiting }) => waiting)).toEqual([{ kind: "approval", since: BEFORE }]);
    t.requests.length = 0;
    t.approvals.resolved({ requestId: request.requestId, threadId: t.a.id, outcome: { status: "allowed", intent: "allow_once", choiceLabel: "Allow" } });
    expect(t.pushes.at(-1)?.waiting).toBeNull();
    t.requests.push(request);
    await t.threads.softDelete(t.a.id);
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("fills changed file count when the snapshot lands and suppresses unchanged invalidation", async () => {
    const t = await fixture();
    t.settle(2); await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    t.pushes.length = 0;
    await t.snapshots.create({ messageId: "message-2", threadId: t.a.id, refBefore: "before", refAfter: "after", filesChanged: [],
      fileEffects: { revision: 1, fileCount: 3, additions: 5, deletions: 1, effects: [] }, worktreePath: null });
    expect(t.pushes.map(({ lastTurn }) => lastTurn?.changedFileCount)).toEqual([3]);
    t.service.invalidate(t.a.id);
    expect(t.pushes).toHaveLength(1);
  });

  it("backfills existing threads from the actual migration SQL without manufacturing last turns", async () => {
    const t = await fixture();
    t.settle(2); t.settle(4);
    await t.threads.updateStatus(t.a.id, "completed");
    await t.threads.complete(t.a.id, BEFORE, null);
    t.database.query("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES ('unsettled', ?, 'assistant', '', 6)").run(t.a.id);
    for (const column of ["seen_through_sequence", "seen_at", "last_turn_outcome", "last_turn_ended_at", "last_turn_sequence"]) {
      t.database.run(`ALTER TABLE threads DROP COLUMN ${column}`);
    }
    t.database.run(NodeFS.readFileSync(new URL("../../../../../drizzle/0075_legal_snowbird.sql", import.meta.url), "utf8"));
    expect(t.service.get(t.a.id)?.seen.sequence).toBe(4);
    expect(t.service.get(t.b.id)?.seen.sequence).toBeNull();
    expect(t.service.get(t.a.id)?.lastTurn).toBeNull();
    expect(t.threads.findById(t.a.id)?.status).toBe("paused");
    expect(t.threads.findById(t.a.id)?.user_completed_at).toBe(BEFORE);
    expect(t.service.get(t.a.id)?.seen.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(t.service.listInteresting()).toEqual([]);
  });

  it.each(["cancelled", "interrupted"] as const)("records %s with the settled message sequence through the actual terminal writer", async (outcome) => {
    const t = await fixture();
    const execution = { threadId: t.a.id, turnId: "turn-1", executionId: "00000000-0000-4000-8000-000000000001" };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "lease-1" };
    const semantic = new CanonicalExecutionSemanticWriter(t.database, () => {});
    const handler = new ExecutionWorkerHandler(semantic);
    await handler.handle({ requestId: 1, execution, lease, ordinal: 1, command: { kind: "start", providerId: "codex", input: {
      thread: { id: t.a.id, workspaceId: t.workspace.id, providerId: "codex", createdAt: BEFORE }, ...execution,
      permissionMode: "supervised", providerIdentities: [], userMessage: { kind: "create", messageId: "user-1", content: "Question", sequence: 1 },
    } } });
    if (outcome === "cancelled") {
      await handler.handle({ requestId: 2, execution, lease, ordinal: 2, stopWatermark: 1, command: { kind: "stop", requestId: "stop-1" } });
      const result = await handler.handle({ requestId: 3, execution, lease, ordinal: 3, command: {
        kind: "finish-live-event", outcome,
        projection: { threadId: t.a.id, executionId: execution.executionId, outcome, endedAt: ENDED,
          assistant: { content: "Stopped answer", model: null, attachments: [] }, narrative: [] },
        input: { ...execution, providerId: "codex", providerIdentities: [], outcome, projection: { kind: "writer-staged" } },
        livePublication: [{ after: "terminal", event: { type: "ended", threadId: t.a.id, turnExecutionId: execution.executionId, outcome: "interrupted" } }],
      } });
      expect(result.result.kind).toBe("committed");
    } else {
      const recovered = new CanonicalParentTurnWrite(t.database, () => {});
      const messageId = deriveTurnAssistantMessageId(t.a.id, "user-1");
      expect(recovered.upsertStagedAssistant(execution, { precedingMessageId: "user-1", messageId, content: "Partial answer", model: null, attachments: [] })).toBe(true);
      t.database.transaction(() => recovered.interruptLostExecution({ ...execution, assignedMessageId: messageId, reason: "Server restarted", cause: "app_closed", recoveryIncidentId: "restart-1", endedAt: ENDED }))();
    }
    expect(t.database.query("SELECT status, last_turn_outcome, last_turn_sequence FROM threads WHERE id = ?").get(t.a.id))
      .toEqual({ status: "interrupted", last_turn_outcome: outcome, last_turn_sequence: 2 });
    expect(t.database.query("SELECT sequence, outcome FROM messages WHERE thread_id = ? AND outcome IS NOT NULL").all(t.a.id))
      .toEqual([{ sequence: 2, outcome }]);
  });
});

describe("planned restart failure attention", () => {
  function notice(t: Awaited<ReturnType<typeof fixture>>, sequence: number, content: string, noticeKey = "planned-restart:turn-1") {
    t.database.query("INSERT INTO messages (id, thread_id, role, content, sequence, timestamp, system_notice) VALUES (?, ?, 'system', ?, ?, ?, ?)")
      .run(`notice-${sequence}`, t.a.id, content, sequence, ENDED, JSON.stringify({ kind: "diagnostic", presentation: "timeline", noticeKey }));
  }

  it("alerts for a failure that left no turn and clears once the thread is seen", async () => {
    const t = await fixture();
    t.settle(2);
    t.markBefore();
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    notice(t, 3, plannedRestartNoticeText("wake", "failed"));

    expect(t.service.get(t.a.id)?.restartFailure).toEqual({ sequence: 3, at: ENDED });
    expect(t.service.listInteresting().map(({ threadId }) => threadId)).toEqual([t.a.id]);
    await t.service.acknowledgeSeen(t.a.id, 3);
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("does not alert for a success, another feature's notice, or a failure older than the last turn", async () => {
    const t = await fixture();
    notice(t, 1, plannedRestartNoticeText("wake", "failed"));
    t.settle(2);
    t.markBefore();
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    notice(t, 3, plannedRestartNoticeText("wake", "started"));
    notice(t, 4, plannedRestartNoticeText("wake", "failed"), "other-feature:turn-1");
    expect(t.service.get(t.a.id)?.restartFailure).toBeNull();
    expect(t.service.listInteresting()).toEqual([]);
  });

  it("ignores a failure older than the last turn for both alerting and acknowledgement", async () => {
    const t = await fixture();
    notice(t, 1, plannedRestartNoticeText("wake", "failed"));
    t.settle(2);
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    notice(t, 3, plannedRestartNoticeText("wake", "started"));
    expect(t.service.get(t.a.id)?.restartFailure).toBeNull();
    await expect(t.service.acknowledgeSeen(t.a.id, 3)).rejects.toMatchObject({ code: "sequence_ahead" });
  });

  it("moves a late failure that replaces the success after the attempt's turn, so it still alerts", async () => {
    const t = await fixture();
    const messages = new MessageStore(t.database);
    const noticeKey = "planned-restart:turn-1";
    t.settle(2);
    messages.replaceKeyedSystemNotice(t.a.id, plannedRestartNoticeText("wake", "started"), { kind: "diagnostic", presentation: "timeline", noticeKey });
    t.settle(5);
    await t.threads.recordTurnOutcome(t.a.id, "completed", ENDED);
    await t.service.acknowledgeSeen(t.a.id, 5);
    messages.replaceKeyedSystemNotice(t.a.id, plannedRestartNoticeText("wake", "failed"), { kind: "diagnostic", presentation: "timeline", noticeKey });

    expect(t.service.get(t.a.id)?.restartFailure?.sequence).toBeGreaterThan(5);
    expect(t.database.query("SELECT count(*) AS count FROM messages WHERE json_extract(system_notice, '$.noticeKey') = ?").get(noticeKey))
      .toEqual({ count: 1 });
  });

  it("does not raise a failure again once the errored attempt turn has been seen", async () => {
    const t = await fixture();
    t.settle(2, "errored");
    await t.threads.recordTurnOutcome(t.a.id, "errored", ENDED);
    notice(t, 3, plannedRestartNoticeText("resume", "failed"));
    await t.service.acknowledgeSeen(t.a.id, 2);
    expect(t.service.get(t.a.id)?.restartFailure).toBeNull();
  });

  it("leaves a failure that ended as an unseen errored turn to that turn's alert", async () => {
    const t = await fixture();
    t.settle(2, "errored");
    await t.threads.recordTurnOutcome(t.a.id, "errored", ENDED);
    notice(t, 3, plannedRestartNoticeText("resume", "failed"));
    const attention = t.service.get(t.a.id);
    expect(attention?.restartFailure).toBeNull();
    expect(attention?.lastTurn?.outcome).toBe("errored");
  });
});
