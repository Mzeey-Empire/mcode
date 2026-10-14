import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventSchema, CanonicalAgentProgressFrameSchema, WS_CHANNELS, WS_METHODS, type AgentEvent, type PlanVersion, type ProviderRuntimeEvent } from "@mcode/contracts";
import { logger, resolveThreadPlanFile } from "@mcode/shared";
import { CanonicalAgentStore } from "../../canonical/canonical-agent-store.js";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalAcceptedProgress } from "../../canonical/canonical-accepted-progress.js";
import { CanonicalExecutionWriterPort } from "../../canonical/canonical-execution-writer-port.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand } from "../../execution/execution-worker-handler.js";
import { HandoffStorage } from "../../../handoff/persistence/handoff-storage.js";
import { PlanStore } from "../persistence/plan-store.js";
import { PlanFileWriter } from "../plan-file-writer.js";
import { PlanService, PlanServiceError } from "../plan-service.js";
import { planImplementWriteOperations } from "../persistence/plan-implement-write-operations.js";
import { PlanCommentStore } from "../persistence/plan-comment-store.js";
import { openMigratedTestDatabase } from "../../../../runtime/persistence/sqlite/testing/migrated-test-database.js";
import { leaseWriterWorker } from "../../../../runtime/persistence/sqlite/testing/reusable-writer-worker.js";

const pushes = vi.hoisted(() => ({ versions: [] as unknown[], frames: [] as unknown[], comments: [] as unknown[] }));
vi.mock("../../../../application/transport/push.js", () => ({
  broadcast: (channel: string, data: unknown) => {
    if (channel === "plan.versionUpserted") pushes.versions.push(data);
    if (channel === "agent.canonical") pushes.frames.push(data);
    if (channel === "plan.commentsChanged") pushes.comments.push(data);
  },
  subscribedThreadIds: () => new Set<string>(),
}));
const threadId = "plan-thread";
const now = "2026-10-09T00:00:00.000Z";
const execution = { threadId, turnId: "plan-turn", executionId: "00000000-0000-4000-8000-000000000123" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "plan-lease" };

describe("PlanService on the application SQLite writer", { timeout: 30_000 }, () => {
  let directory: string;
  let db: Database;
  let owner: ApplicationDatabaseWriter;
  let canonicalWriter: CanonicalAgentWriterClient;
  let progress: CanonicalAcceptedProgress;
  let handler: ExecutionWorkerHandler;
  let plans: PlanStore;
  let files: PlanFileWriter;
  let service: PlanService;
  let ready: PlanVersion;

  beforeEach(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-plan-service-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    db = openMigratedTestDatabase(dbPath);
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("workspace", "Plans", directory);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider) VALUES (?, ?, ?, ?, ?)")
      .run(threadId, "workspace", "Plan", "main", "codex");
    db.prepare("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES (?, ?, ?, ?, ?)")
      .run("assistant", threadId, "assistant", "Summary", 1);
    plans = new PlanStore(db);
    ready = plans.create(threadId, "assistant", { title: "Original", contentMd: "# Original", captureSource: "fence" }, "codex");
    owner = new ApplicationDatabaseWriter(dbPath, leaseWriterWorker);
    await owner.whenReady();
    canonicalWriter = new CanonicalAgentWriterClient(owner);
    files = new PlanFileWriter((id) => plans.listByThread(id), () => directory);
    progress = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, owner, canonicalWriter, () => {}), canonicalWriter, files);
    handler = new ExecutionWorkerHandler(new CanonicalExecutionWriterPort(canonicalWriter, () => {}, undefined, undefined, progress));
    service = new PlanService(owner, progress, files);
    pushes.versions.length = 0;
    pushes.frames.length = 0;
    pushes.comments.length = 0;
  });

  afterEach(async () => {
    await progress.close();
    await canonicalWriter.close();
    await owner.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fork(contentMd = "# Edited") {
    return { threadId, versionId: NodeCrypto.randomUUID(), baseVersionId: ready.id, baseRevision: 0, contentMd };
  }

  function commentInput(versionId = ready.id) {
    return { commentId: NodeCrypto.randomUUID(), versionId, body: "Clarify the order",
      anchor: { kind: "text" as const, start: 2, end: 10, quote: "Original", prefix: "# ", suffix: "", section: "Original" } };
  }

  it("persists trimmed comments across reopening and replays create without overwriting", async () => {
    const input = commentInput();
    const created = await service.createComment({ ...input, body: "  Clarify the order  " });
    expect(created).toMatchObject({ id: input.commentId, body: "Clarify the order", status: "open", sentMessageId: null });
    expect(await service.createComment({ ...input, body: "Retry must not replace it" })).toEqual(created);
    const reopened = openDatabase({ dbPath: NodePath.join(directory, "app.sqlite") });
    try { expect(new PlanCommentStore(reopened).listByThread(threadId)).toEqual([created]); }
    finally { reopened.close(true); }
    expect((await service.snapshot({ threadId })).comments).toEqual([created]);
    expect(pushes.comments).toContainEqual({ threadId, upserted: [created], deletedIds: [] });
  });

  it("creates a comment on the displayed superseded version", async () => {
    await start();
    await captureAndFinish();
    expect(plans.getById(ready.id)?.status).toBe("superseded");
    const created = await service.createComment(commentInput());
    expect(created).toMatchObject({ versionId: ready.id, body: "Clarify the order",
      anchor: { quote: "Original" }, status: "open", sentMessageId: null, carriedFromCommentId: null });
    expect((await service.snapshot({ threadId })).comments).toEqual([created]);
    expect(pushes.comments.at(-1)).toEqual({ threadId, upserted: [created], deletedIds: [] });
  });

  it("updates notes, resolves and reopens them, and deletes idempotently", async () => {
    const input = commentInput();
    await service.createComment(input);
    expect(await service.updateComment({ commentId: input.commentId, body: "Use dependency order" }))
      .toMatchObject({ body: "Use dependency order", anchor: input.anchor });
    const resolved = await service.setCommentStatus({ commentId: input.commentId, status: "resolved" });
    expect(resolved.status).toBe("resolved");
    expect(Number.isFinite(Date.parse(resolved.resolvedAt ?? ""))).toBe(true);
    expect(await service.setCommentStatus({ commentId: input.commentId, status: "open" }))
      .toMatchObject({ status: "open", resolvedAt: null, body: "Use dependency order" });
    await service.deleteComment({ commentId: input.commentId });
    await service.deleteComment({ commentId: input.commentId });
    expect((await service.snapshot({ threadId })).comments).toEqual([]);
    expect(pushes.comments.at(-1)).toEqual({ threadId, upserted: [], deletedIds: [input.commentId] });
    await expect(service.updateComment({ commentId: input.commentId, body: "Deleted" })).rejects.toMatchObject({ code: "plan_comment_invalid" });
  });

  it("rejects incorrect anchors and protects accepted versions from every comment mutation", async () => {
    const input = commentInput();
    await expect(service.createComment({ ...input, anchor: { ...input.anchor, quote: "Outdated" } }))
      .rejects.toMatchObject({ code: "plan_comment_invalid" });
    expect((await service.snapshot({ threadId })).comments).toEqual([]);
    const created = await service.createComment(input);
    db.prepare("UPDATE plans SET status = 'accepted' WHERE id = ?").run(ready.id);
    for (const operation of [
      () => service.createComment(commentInput()),
      () => service.updateComment({ commentId: created.id, body: "No" }),
      () => service.setCommentStatus({ commentId: created.id, status: "resolved" }),
      () => service.deleteComment({ commentId: created.id }),
    ]) await expect(operation()).rejects.toMatchObject({ code: "plan_read_only" });
    expect((await service.snapshot({ threadId })).comments).toEqual([created]);
  });

  it.each(["running", "preparing"])("blocks comment writes while %s", async state => {
    const created = await service.createComment(commentInput());
    if (state === "running") await start();
    else await owner.execute(planImplementWriteOperations.prepare, { input: { requestId: NodeCrypto.randomUUID(), threadId,
      versionId: ready.id, expectedRevision: 0, target: "thread" }, fingerprint: "comments", planFilePath: files.path(threadId) });
    for (const operation of [
      () => service.createComment(commentInput()),
      () => service.updateComment({ commentId: created.id, body: "No" }),
      () => service.setCommentStatus({ commentId: created.id, status: "resolved" }),
      () => service.deleteComment({ commentId: created.id }),
    ]) await expect(operation()).rejects.toMatchObject({ code: "plan_busy" });
    expect((await service.snapshot({ threadId })).comments).toEqual([created]);
  });

  it("carries only open unsent comments to a fork and reanchors each subsequent draft save", async () => {
    const open = await service.createComment(commentInput());
    const resolved = await service.createComment(commentInput());
    await service.setCommentStatus({ commentId: resolved.id, status: "resolved" });
    const sent = await service.createComment(commentInput());
    new PlanCommentStore(db).stampSent(threadId, [sent.id], "previous-user-message");
    const input = fork("Intro\n# Original");
    const draft = await service.saveVersion(input);
    const copied = (await service.snapshot({ threadId })).comments.filter(comment => comment.versionId === draft.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ carriedFromCommentId: open.id, anchor: { kind: "text", start: 8, end: 16 }, sentMessageId: null });
    expect(copied[0]?.id).not.toBe(open.id);
    await service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Original\nThe words moved." });
    expect((await service.snapshot({ threadId })).comments.find(comment => comment.versionId === draft.id)?.anchor)
      .toEqual({ ...open.anchor, start: 2, end: 10 });
    await service.saveVersion({ ...input, baseRevision: 2, contentMd: "# Changed\nThe words moved." });
    expect((await service.snapshot({ threadId })).comments.find(comment => comment.versionId === draft.id)?.anchor)
      .toEqual({ kind: "section", section: null, quote: "Original" });
    expect(pushes.comments.at(-1)).toMatchObject({ threadId, deletedIds: [] });
  });

  it("carries predecessor comments through canonical agent capture and publishes after persistence", async () => {
    const open = await service.createComment(commentInput());
    await start();
    await captureAndFinish();
    const snapshot = await service.snapshot({ threadId });
    const latest = snapshot.versions.at(-1);
    const copied = snapshot.comments.filter(comment => comment.versionId === latest?.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ carriedFromCommentId: open.id, body: "Clarify the order",
      anchor: { kind: "section", section: null, quote: "Original" } });
    expect(pushes.comments).toContainEqual({ threadId, upserted: snapshot.comments, deletedIds: [] });
  });

  function send(ordinal: number, command: ExecutionWorkCommand) {
    return handler.handle({ requestId: ordinal, execution, lease, ordinal, command });
  }

  async function start(providerId = "codex") {
    await send(1, { kind: "start", providerId, publishParentStart: true,
      parentLive: { planFeature: "output", precedingMessageId: "user-plan" },
      input: { thread: { id: threadId, workspaceId: "workspace", providerId, createdAt: now },
        turnId: execution.turnId, executionId: execution.executionId, permissionMode: "full", providerIdentities: [],
        userMessage: { kind: "create", messageId: "user-plan", content: "Revise", sequence: 2 } } });
  }

  function event(sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}, planCapture?: ProviderRuntimeEvent["planCapture"]) {
    const value = AgentEventSchema().parse({ type, threadId, turnExecutionId: execution.executionId,
      ...(type === "turnComplete" ? { reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } : {}), ...fields });
    const itemId = `plan-event-${sequence}`;
    return { eventId: itemId, routing: { ...execution, itemId }, sourceProviderId: "codex", sourceIdentities: [],
      sourceSequence: sequence, payload: { type: "item.recorded" as const,
        item: { id: itemId, threadId, turnId: execution.turnId, kind: "system" as const, providerIdentities: [],
          payload: { projection: "providerRuntimeEvent", runtimeEvent: { event: value, ...(planCapture ? { planCapture } : {}) } }, createdAt: now, updatedAt: now } } };
  }

  async function captureAndFinish(waitForSaves = true) {
    const content = "````mcode-plan\n# Revised by agent\nDo the new work.\n````";
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [event(1, "textDelta", { delta: content, isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [event(2, "message", { content, tokens: null })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [event(3, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    if (waitForSaves) await expect.poll(() => progress.depth().pending, { timeout: 10_000 }).toBe(0);
  }

  function insertCanonicalItem(id: string, payload: string) {
    db.prepare("INSERT INTO canonical_agent_items (id, thread_id, turn_id, kind, payload_json, provider_identities_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, threadId, execution.turnId, "system", payload, "[]", now, now);
  }

  it("rejects a save during an unfinished execution with no write", async () => {
    await start();
    await expect(service.saveVersion(fork())).rejects.toMatchObject({ code: "plan_busy", latestVersion: ready });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    expect(pushes.versions).toEqual([]);
  });

  it("prepares a snapshot on the writer and excludes a second window's save", async () => {
    const requestId = NodeCrypto.randomUUID();
    const result = await owner.execute(planImplementWriteOperations.prepare, { input: { requestId, threadId,
      versionId: ready.id, expectedRevision: 0, target: "thread" }, fingerprint: "fixture", planFilePath: files.path(threadId) });
    expect(result).toMatchObject({ ok: true, contentMd: "# Original", request: { status: "preparing", revision: 0 } });
    await expect(service.saveVersion(fork())).rejects.toMatchObject({ code: "plan_busy", latestVersion: ready });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    await owner.execute(planImplementWriteOperations.fail, { requestId, code: "interrupted" });
    expect(await service.saveVersion(fork())).toMatchObject({ status: "draft", revision: 1 });
  });

  it.each([false, true])("commits a new-thread copy atomically on worker start, injected failure: %s", async (failCopy) => {
    const targetId = "implement-target";
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider) VALUES (?, ?, ?, ?, ?)")
      .run(targetId, "workspace", "Implement", "main", "codex");
    const requestId = NodeCrypto.randomUUID();
    const prepared = await owner.execute(planImplementWriteOperations.prepare, { input: { requestId, threadId,
      versionId: ready.id, expectedRevision: 0, target: "new-thread" }, fingerprint: "new", planFilePath: files.path(threadId) });
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.request).toMatchObject({ targetThreadId: null, startupId: requestId, status: "preparing" });
    if (failCopy) db.run("CREATE TRIGGER fail_copy AFTER INSERT ON plans WHEN NEW.capture_source = 'copy' BEGIN SELECT RAISE(ABORT, 'copy fault'); END");
    const targetExecution = { ...execution, threadId: targetId };
    const admission = handler.handle({ requestId: 1, execution: targetExecution, lease, ordinal: 1,
      command: { kind: "start", providerId: "codex", publishParentStart: true,
        parentLive: { planFeature: "none", precedingMessageId: prepared.request.messageId },
        input: { thread: { id: targetId, workspaceId: "workspace", providerId: "codex", createdAt: now },
          turnId: execution.turnId, executionId: execution.executionId,
          permissionMode: "full", providerIdentities: [], planImplement: { requestId },
          userMessage: { kind: "create", messageId: prepared.request.messageId, content: "Implement plan v1", sequence: 1 } } } });
    if (failCopy) {
      await expect(admission).rejects.toThrow();
      expect(plans.getById(ready.id)?.status).toBe("ready");
      expect(plans.listByThread(targetId)).toEqual([]);
      expect(db.prepare("SELECT id FROM messages WHERE thread_id = ?").all(targetId)).toEqual([]);
      expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE thread_id = ?").all(targetId)).toEqual([]);
      expect(await owner.execute(planImplementWriteOperations.read, requestId)).toMatchObject({ status: "preparing", targetThreadId: null });
    } else {
      await admission;
      expect(plans.getById(ready.id)?.status).toBe("accepted");
      expect(plans.listByThread(targetId)).toMatchObject([{ version: 1, contentMd: "# Original", status: "accepted",
        captureSource: "copy", baseVersionId: ready.id, acceptedMessageId: prepared.request.messageId }]);
      expect(db.prepare("SELECT content FROM messages WHERE thread_id = ?").all(targetId)).toEqual([{ content: "Implement plan v1" }]);
      expect(await owner.execute(planImplementWriteOperations.read, requestId)).toMatchObject({ status: "admitted", targetThreadId: targetId });
    }
  });

  it("refuses Implement preparation during an unfinished execution without creating a request", async () => {
    await start();
    const requestId = NodeCrypto.randomUUID();
    expect(await owner.execute(planImplementWriteOperations.prepare, { input: { requestId, threadId,
      versionId: ready.id, expectedRevision: 0, target: "thread" }, fingerprint: "fixture", planFilePath: files.path(threadId) }))
      .toMatchObject({ ok: false, code: "thread_busy" });
    expect(await owner.execute(planImplementWriteOperations.read, requestId)).toBeNull();
    expect(plans.listByThread(threadId)).toEqual([ready]);
  });

  it("rejects missing or invalid revision preconditions and mismatched pending identities at the wire boundary", () => {
    const input = { requestId: NodeCrypto.randomUUID(), threadId, versionId: ready.id, target: "thread" };
    const schema = WS_METHODS()["plan.implement"].params;
    for (const invalid of [input, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 0.5 },
      { ...input, expectedRevision: 1, pending: { versionId: NodeCrypto.randomUUID(), baseVersionId: ready.id, baseRevision: 0, contentMd: "# Edit" } },
      { ...input, expectedRevision: 0, target: "new-worktree" }]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
    expect(schema.parse({ ...input, expectedRevision: 0 })).toEqual({ ...input, expectedRevision: 0 });
  });

  it("keys a fork by client id and replays a lost response without allocating another version", async () => {
    const input = fork();
    const draft = await service.saveVersion(input);
    expect(draft).toMatchObject({ id: input.versionId, version: 2, revision: 1, author: "user", status: "draft",
      messageId: null, providerId: null, captureSource: "edit", baseVersionId: ready.id, contentMd: input.contentMd });
    expect(await service.saveVersion(input)).toEqual(draft);
    expect(plans.listByThread(threadId)).toEqual([ready, draft]);
    expect(NodeFS.readFileSync(resolveThreadPlanFile(directory, threadId), "utf8")).toBe(input.contentMd);
  });

  it("ignores a stale nonterminal checkpoint once its turn is terminal", async () => {
    await start();
    await captureAndFinish();
    db.prepare("UPDATE canonical_agent_ingest_checkpoints SET terminal_outcome = NULL WHERE execution_id = ?").run(execution.executionId);
    expect(new CanonicalAgentStore(db).listUnfinishedCheckpoints()).toEqual([]);
    const latest = plans.listByThread(threadId)[1];
    const saved = await service.saveVersion({ ...fork(), baseVersionId: latest.id });
    expect(saved).toMatchObject({ version: 3, baseVersionId: latest.id, revision: 1 });
  });

  it("returns and broadcasts committed saves despite a failed file rename", async () => {
    NodeFS.mkdirSync(resolveThreadPlanFile(directory, threadId), { recursive: true });
    const log = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const input = fork();
    const saved = await service.saveVersion(input);
    expect(saved).toMatchObject({ id: input.versionId, revision: 1, contentMd: input.contentMd });
    expect(plans.getById(saved.id)).toEqual(saved);
    expect(pushes.versions).toEqual([{ threadId, version: saved }]);
    expect(log).toHaveBeenCalledWith("Failed to project committed plan file", expect.objectContaining({ threadId }));
    const next = await service.saveVersion({ ...input, baseRevision: saved.revision, contentMd: "# Next edit" });
    expect(next).toMatchObject({ revision: 2, contentMd: "# Next edit" });
  });

  it("finishes canonical saves and retires receipts when the plan file cannot be written", async () => {
    NodeFS.mkdirSync(resolveThreadPlanFile(directory, threadId), { recursive: true });
    const log = vi.spyOn(logger, "error").mockImplementation(() => logger);
    await start();
    await captureAndFinish();
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(canonicalWriter.pendingAcknowledgementCount).toBe(0);
    expect(plans.listByThread(threadId).map((plan) => [plan.version, plan.status])).toEqual([[1, "superseded"], [2, "ready"]]);
    expect(pushes.versions).toContainEqual({ threadId, version: plans.listByThread(threadId)[1] });
    expect(log).toHaveBeenCalledWith("Failed to project committed plan file", expect.objectContaining({ threadId }));
  });

  it("increments equal revisions, rejects higher/lower revisions, and permits only the identical lost-response replay", async () => {
    const input = fork();
    const first = await service.saveVersion(input);
    const save = { ...input, baseRevision: 1, contentMd: "# Second\nExact text\n" };
    const second = await service.saveVersion(save);
    expect(second).toMatchObject({ id: first.id, revision: 2, contentMd: save.contentMd });
    expect(await service.saveVersion(save)).toEqual(second);
    for (const baseRevision of [0, 1, 3]) {
      await expect(service.saveVersion({ ...save, baseRevision, contentMd: "# Conflicting" }))
        .rejects.toMatchObject({ code: "plan_conflict", latestVersion: second });
      expect(plans.getById(first.id)).toEqual(second);
    }
    expect(NodeFS.readFileSync(resolveThreadPlanFile(directory, threadId), "utf8")).toBe(save.contentMd);
  });

  it("serializes competing forks and lets Keep my text save into the winning draft", async () => {
    const first = fork("# Window one");
    const second = fork("# Window two");
    const results = await Promise.allSettled([service.saveVersion(first), service.saveVersion(second)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const draft = plans.listByThread(threadId)[1];
    expect(draft).toMatchObject({ id: first.versionId, version: 2, revision: 1 });
    const rejected = results[1];
    if (rejected.status !== "rejected") throw new Error("Second fork must conflict");
    expect(rejected.reason).toMatchObject({ code: "plan_conflict", latestVersion: draft });
    const kept = await service.saveVersion({ ...second, versionId: draft.id, baseRevision: draft.revision });
    expect(kept).toMatchObject({ id: draft.id, version: 2, revision: 2, contentMd: second.contentMd });
    await expect(service.saveVersion({ ...first, baseRevision: 1, contentMd: "# Window one again" }))
      .rejects.toMatchObject({ code: "plan_conflict", latestVersion: kept });
    expect(plans.listByThread(threadId)).toEqual([ready, kept]);
  });

  it("replays the two-window conflict and resolution sequence without a second draft", async () => {
    const windowA = fork("# Window A");
    const windowB = fork("# Window B");

    const created = await service.saveVersion(windowA);
    expect(created).toMatchObject({ id: windowA.versionId, version: 2, revision: 1, status: "draft", contentMd: "# Window A" });
    await expect(service.saveVersion(windowB)).rejects.toMatchObject({ code: "plan_conflict", latestVersion: created });

    const keptB = await service.saveVersion({ ...windowB, versionId: created.id, baseRevision: created.revision });
    expect(keptB).toMatchObject({ id: created.id, version: 2, revision: 2, contentMd: "# Window B" });
    await expect(service.saveVersion({ ...windowA, baseRevision: 1, contentMd: "# Window A again" }))
      .rejects.toMatchObject({ code: "plan_conflict", latestVersion: keptB });

    const editedA = await service.saveVersion({ ...windowA, baseRevision: keptB.revision, contentMd: "# Window B\nA adds" });
    expect(editedA).toMatchObject({ id: created.id, version: 2, revision: 3, contentMd: "# Window B\nA adds" });
    await expect(service.saveVersion({ ...windowB, versionId: created.id, baseRevision: 2, contentMd: "# Window B again" }))
      .rejects.toMatchObject({ code: "plan_conflict", latestVersion: editedA });

    expect(plans.listByThread(threadId)).toEqual([ready, editedA]);
  });

  it("commits exactly one of two different saves with the same baseRevision", async () => {
    const input = fork();
    await service.saveVersion(input);
    const results = await Promise.allSettled([
      service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Winner" }),
      service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Conflict" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(plans.getById(input.versionId)).toMatchObject({ revision: 2, contentMd: "# Winner" });
  });

  it("saves Keep my text to another window's draft at its current revision", async () => {
    const firstWindow = await service.saveVersion(fork("# Window one"));
    const secondWindow = await service.saveVersion({ ...fork("# Window two"), versionId: firstWindow.id, baseRevision: 1 });
    expect(secondWindow).toMatchObject({ id: firstWindow.id, version: 2, revision: 2, contentMd: "# Window two" });
    expect(plans.listByThread(threadId)).toEqual([ready, secondWindow]);
  });

  it("keeps the ready base after a user fork and supersedes both on agent capture", async () => {
    const draft = await service.saveVersion(fork());
    expect((await service.snapshot({ threadId })).versions.map((version) => version.status)).toEqual(["ready", "draft"]);
    await start();
    await captureAndFinish();
    expect(plans.getById(ready.id)?.status).toBe("superseded");
    expect(plans.getById(draft.id)?.status).toBe("superseded");
  });

  it("projects exact text after every version upsert, including concurrent saves", async () => {
    const filename = resolveThreadPlanFile(directory, threadId);
    const input = fork("# First\n\nExact whitespace.\n");
    const draft = await service.saveVersion(input);
    expect(NodeFS.readFileSync(filename, "utf8")).toBe("# First\n\nExact whitespace.\n");
    const saved = await Promise.all([
      service.saveVersion({ ...input, baseRevision: 1, contentMd: "# Second" }),
      service.saveVersion({ ...input, baseRevision: 2, contentMd: "# Third" }),
    ]);
    expect(saved.map((version) => version.revision)).toEqual([2, 3]);
    expect(NodeFS.readFileSync(filename, "utf8")).toBe("# Third");
    expect(pushes.versions).toEqual([draft, ...saved].map((version) => ({ threadId, version })));
    await start();
    await captureAndFinish();
    expect(NodeFS.readFileSync(filename, "utf8")).toBe("# Revised by agent\nDo the new work.");
  });

  it("bounds save input before any database write and accepts the exact content limit", async () => {
    const input = fork("x".repeat(65_537));
    await expect(service.saveVersion(input)).rejects.toThrow();
    expect(plans.listByThread(threadId)).toEqual([ready]);
    const draft = await service.saveVersion({ ...input, contentMd: "x".repeat(65_536) });
    expect(draft.contentMd).toBe("x".repeat(65_536));
    expect(draft.revision).toBe(1);
  });

  it("numbers an agent capture past user versions, supersedes both bases, and permits an immediate post-turn fork", async () => {
    const draft = await service.saveVersion(fork());
    expect(plans.getById(ready.id)?.status).toBe("ready");
    await start();
    await captureAndFinish();
    const snapshot = await service.snapshot({ threadId });
    expect(snapshot.versions.map(({ version, status, author }) => ({ version, status, author }))).toEqual([
      { version: 1, status: "superseded", author: "agent" },
      { version: 2, status: "superseded", author: "user" },
      { version: 3, status: "ready", author: "agent" },
    ]);
    const latest = snapshot.versions[2];
    expect(latest).toMatchObject({ providerId: "codex", captureSource: "fence", revision: 0 });
    expect(NodeFS.readFileSync(resolveThreadPlanFile(directory, threadId), "utf8")).toBe(latest.contentMd);
    const next = await service.saveVersion({ ...fork("# After turn"), baseVersionId: latest.id });
    expect(next).toMatchObject({ version: 4, revision: 1, baseVersionId: latest.id });
    await expect(service.saveVersion({ ...fork(), versionId: draft.id, baseRevision: draft.revision }))
      .rejects.toMatchObject({ code: "plan_conflict", latestVersion: next });
  });

  it("never supersedes accepted versions and continues numbering after them", async () => {
    db.prepare("UPDATE plans SET status = 'accepted' WHERE id = ?").run(ready.id);
    await expect(service.saveVersion(fork())).rejects.toMatchObject({ code: "plan_read_only" });
    await start();
    await captureAndFinish();
    expect((await service.snapshot({ threadId })).versions.map((plan) => [plan.version, plan.status]))
      .toEqual([[1, "accepted"], [2, "ready"]]);
  });

  it("orders a fork behind the planning turn while its accepted saves are still queued", async () => {
    await start();
    db.exec("BEGIN IMMEDIATE");
    let saved: Promise<PlanVersion>;
    try {
      await captureAndFinish(false);
      expect(progress.depth().pending).toBeGreaterThan(0);
      const latest = progress.reloadPlans(threadId)[1];
      expect(latest).toMatchObject({ version: 2, status: "ready" });
      saved = service.saveVersion({ ...fork("# Queued fork"), baseVersionId: latest.id });
    } finally {
      db.exec("COMMIT");
    }
    expect(await saved).toMatchObject({ version: 3, revision: 1, contentMd: "# Queued fork" });
    expect(plans.listByThread(threadId).map((plan) => [plan.version, plan.status])).toEqual([[1, "superseded"], [2, "ready"], [3, "draft"]]);
  });

  it("retains native capture ownership only on the server", async () => {
    const nativePlanFile = { path: NodePath.join(directory, "native-plan.md"), sessionId: "native-session", sha256: "a".repeat(64) };
    await start("claude");
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [{ ...event(1, "message", { content: "Native summary", tokens: null },
        { markdown: "# Native plan", source: "native", nativePlanFile }), sourceProviderId: "claude" }] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [{ ...event(2, "turnComplete"), sourceProviderId: "claude" }],
      terminalInput: { ...execution, providerId: "claude", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending, { timeout: 10_000 }).toBe(0);
    const snapshot = await service.snapshot({ threadId });
    const captured = snapshot.versions[1];
    expect(captured).toMatchObject({ author: "agent", providerId: "claude", captureSource: "native", contentMd: "# Native plan" });
    expect(db.prepare("SELECT native_plan_file_json FROM plans WHERE id = ?").get(captured.id))
      .toEqual({ native_plan_file_json: JSON.stringify(nativePlanFile) });
    expect(JSON.stringify(snapshot)).not.toContain("nativePlanFile");
    expect(JSON.stringify(pushes.versions)).not.toContain(nativePlanFile.path);
    const frames = pushes.frames.map((frame) => CanonicalAgentProgressFrameSchema().parse(frame));
    expect(JSON.stringify(frames)).toContain("# Native plan");
    expect(JSON.stringify(frames)).not.toContain("nativePlanFile");
    expect(JSON.stringify(frames)).not.toContain(nativePlanFile.path);
    const storedItems = db.prepare("SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?").all(threadId);
    expect(JSON.stringify(storedItems)).toContain("# Native plan");
    expect(JSON.stringify(storedItems)).not.toContain("nativePlanFile");
    expect(NodeFS.existsSync(nativePlanFile.path)).toBe(false);
  });

  it("keeps later memory status after reload with a head present and never returns stale user content", async () => {
    const draft = await service.saveVersion(fork());
    await start();
    await captureAndFinish();
    db.prepare("UPDATE plans SET status = 'ready' WHERE id = ?").run(ready.id);
    db.prepare("UPDATE plans SET content_md = ?, revision = ? WHERE id = ?").run("# Saved user text", 7, draft.id);
    expect(progress.reloadPlans(threadId).find((plan) => plan.id === ready.id)?.status).toBe("superseded");
    const snapshot = await service.snapshot({ threadId });
    expect(snapshot.versions.find((plan) => plan.id === ready.id)?.status).toBe("superseded");
    expect(snapshot.versions.find((plan) => plan.id === draft.id)).toMatchObject({ contentMd: "# Saved user text", revision: 7 });
    db.prepare("UPDATE plans SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now, ready.id);
    expect(progress.reloadPlans(threadId).find((plan) => plan.id === ready.id)?.status).toBe("accepted");
    db.prepare("UPDATE plans SET status = 'ready', accepted_at = NULL WHERE id = ?").run(ready.id);
    expect((await service.snapshot({ threadId })).versions.find((plan) => plan.id === ready.id))
      .toMatchObject({ status: "accepted", acceptedAt: now });
  });

  it("loads legacy canonical payloads as ready without rewriting retained history", async () => {
    await start();
    const contentMd = "x".repeat(100_000);
    db.prepare("UPDATE plans SET content_md = ? WHERE id = ?").run(contentMd, ready.id);
    const legacy = { id: NodeCrypto.randomUUID(), threadId, messageId: ready.messageId, version: 2, title: ready.title,
      contentMd, sectionsJson: [], changeSummary: null, status: "draft", createdAt: ready.createdAt,
      providerId: "unknown-legacy-provider" };
    const payload = JSON.stringify({ projection: "plan", plan: legacy });
    insertCanonicalItem("legacy-plan", payload);
    const snapshot = await service.snapshot({ threadId });
    expect(snapshot.versions).toHaveLength(2);
    expect(snapshot.versions[0]).toEqual({ ...ready, contentMd });
    expect(snapshot.versions[1]).toMatchObject({ id: legacy.id, contentMd, status: "ready", author: "agent", revision: 0 });
    expect(WS_METHODS()["plan.snapshot"].result.parse(snapshot)).toEqual(snapshot);
    expect(new CanonicalAgentStore(db).loadAcceptedFeatureSeed(threadId).plans).toEqual(snapshot.versions);
    for (const version of snapshot.versions) {
      expect(WS_CHANNELS["plan.versionUpserted"].parse({ threadId, version })).toEqual({ threadId, version });
    }
    expect(db.prepare("SELECT payload_json FROM canonical_agent_items WHERE id = ?").get("legacy-plan")).toEqual({ payload_json: payload });
  });

  it("skips malformed and foreign legacy items without hiding valid versions", async () => {
    await start();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    insertCanonicalItem("invalid-json", "{");
    insertCanonicalItem("invalid-plan", JSON.stringify({ projection: "plan", plan: { id: "invalid" } }));
    insertCanonicalItem("foreign-plan", JSON.stringify({ projection: "plan", plan: { ...ready, threadId: "another-thread" } }));
    insertCanonicalItem("missing-plan", JSON.stringify({ projection: "plan" }));
    expect((await service.snapshot({ threadId })).versions).toEqual([ready]);
    expect(warn.mock.calls.filter(([message]) => message === "Skipping unreadable historic plan")
      .map(([, details]) => details?.itemId).sort()).toEqual(["foreign-plan", "invalid-plan", "missing-plan"]);
  });

  it("rejects missing threads and foreign version identities without exposing their rows", async () => {
    await expect(service.snapshot({ threadId: "missing" })).rejects.toMatchObject({ code: "thread_not_found", latestVersion: null });
    await expect(service.saveVersion({ ...fork(), threadId: "missing" })).rejects.toBeInstanceOf(PlanServiceError);
    await expect(service.saveVersion({ ...fork(), versionId: ready.id })).rejects.toMatchObject({ code: "plan_conflict", latestVersion: ready });
    expect(plans.listByThread(threadId)).toEqual([ready]);
  });

  it("removes the plan file with the existing handoff thread cleanup", async () => {
    await service.saveVersion(fork());
    const storage = HandoffStorage.forTesting({ mcodeDirFn: () => directory });
    await storage.deleteThreadFiles(threadId);
    expect(NodeFS.existsSync(NodePath.dirname(resolveThreadPlanFile(directory, threadId)))).toBe(false);
    expect(() => resolveThreadPlanFile(directory, "../escape")).toThrow();
  });
});
