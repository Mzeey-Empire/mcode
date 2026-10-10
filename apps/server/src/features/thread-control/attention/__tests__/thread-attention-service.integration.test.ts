import "reflect-metadata";
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ThreadAttention, TurnOutcome } from "@mcode/contracts";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { ApprovalService } from "../../../agents/approvals/approval-service.js";
import { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import { CanonicalParentTurnWrite } from "../../../agents/canonical/canonical-parent-turn-write.js";
import { CanonicalExecutionSemanticWriter } from "../../../agents/canonical/canonical-execution-semantic-writer.js";
import { ExecutionWorkerHandler } from "../../../agents/execution/execution-worker-handler.js";
import { deriveTurnAssistantMessageId } from "../../../agents/turns/turn-assistant-message-id.js";
import { ThreadAttentionService } from "../thread-attention-service.js";
import { approvalWaitingSource } from "../approval-waiting-source.js";

const BEFORE = "2026-10-10T10:00:00.000Z";
const ENDED = "2026-10-10T10:01:00.000Z";

async function fixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Attention", "attention-fixture");
  const a = await threads.create(workspace.id, "A", "direct", "main", true, "codex");
  const b = await threads.create(workspace.id, "B", "direct", "main", true, "codex");
  const requests: ApprovalRequest[] = [];
  const approvals = new ApprovalService({ resolveAll: () => [] });
  const pushes: ThreadAttention[] = [];
  const service = new ThreadAttentionService(runtime.reader, runtime.writer, [approvalWaitingSource(approvals)], (attention) => pushes.push(attention));
  approvals.start({
    publishApprovalRequest: (request) => service.invalidate(request.threadId),
    publishApprovalResolved: (resolved) => service.invalidate(resolved.threadId),
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
  return { ...runtime, a, b, workspace, threads, service, approvals, snapshots, requests, pushes, settle, markBefore };
}

describe("thread attention through real SQLite and the serialized writer", () => {
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
    expect(t.pushes).toEqual([{ threadId: t.a.id, waiting: null,
      lastTurn: { outcome: "completed", endedAt: ENDED, sequence: 4, changedFileCount: null }, seen: result.current }]);
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
    const request: ApprovalRequest = { requestId: "approval-send", threadId: t.a.id, providerId: "codex", requestedAt: BEFORE,
      subject: { kind: "thread_operation", operation: "thread_send", targetThreadId: t.b.id, message: "Continue" },
      choices: [{ id: "allow", intent: "allow_once", label: "Allow" }, { id: "deny", intent: "deny", label: "Deny" }],
      noteDelivery: "none", origin: { kind: "agent" } };
    t.requests.push({ ...request, requestId: "later", requestedAt: ENDED }, request);
    t.approvals.publish({ requestId: request.requestId, threadId: request.threadId, body: {
      requestedAt: request.requestedAt, subject: request.subject, choices: request.choices, noteDelivery: request.noteDelivery, origin: request.origin,
    } }, { id: "codex" });
    const reloaded = new ThreadAttentionService(t.reader, t.writer, [approvalWaitingSource(t.approvals)], () => {});
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
    t.database.query("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES ('unsettled', ?, 'assistant', '', 6)").run(t.a.id);
    for (const column of ["seen_through_sequence", "seen_at", "last_turn_outcome", "last_turn_ended_at", "last_turn_sequence"]) {
      t.database.run(`ALTER TABLE threads DROP COLUMN ${column}`);
    }
    t.database.run(NodeFS.readFileSync(new URL("../../../../../drizzle/0075_legal_snowbird.sql", import.meta.url), "utf8"));
    expect(t.service.get(t.a.id)?.seen.sequence).toBe(4);
    expect(t.service.get(t.b.id)?.seen.sequence).toBeNull();
    expect(t.service.get(t.a.id)?.lastTurn).toBeNull();
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
      expect(recovered.stageLiveAssistant(execution, { precedingMessageId: "user-1", messageId, content: "Partial answer", model: null, attachments: [] })).toBe(true);
      t.database.transaction(() => recovered.interruptLostExecution({ ...execution, assignedMessageId: messageId, reason: "Server restarted", recoveryIncidentId: "restart-1", endedAt: ENDED }))();
    }
    expect(t.database.query("SELECT status, last_turn_outcome, last_turn_sequence FROM threads WHERE id = ?").get(t.a.id))
      .toEqual({ status: "interrupted", last_turn_outcome: outcome, last_turn_sequence: 2 });
    expect(t.database.query("SELECT sequence, outcome FROM messages WHERE thread_id = ? AND outcome IS NOT NULL").all(t.a.id))
      .toEqual([{ sequence: 2, outcome }]);
  });
});
