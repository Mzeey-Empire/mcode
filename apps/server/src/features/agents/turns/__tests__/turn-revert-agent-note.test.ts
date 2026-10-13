import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageSchema, type CanonicalAgentEventEnvelope, type IAgentProvider, type IProviderRegistry } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { absentState } from "../../../projects/diffs/snapshots/snapshot-raw-state.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { TurnRevertStore } from "../persistence/turn-revert-store.js";
import { prepareTurnRevert, settleTurnRevert } from "../persistence/turn-revert-write-operations.js";
import { TurnAdmissionDispatchCoordinator, type SendMessageCommand, type TurnParentStartOwner, type TurnRuntimeAdmissionAuthority } from "../turn-admission-dispatch-coordinator.js";

let directory: string;
let settings: SettingsService;

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-revert-note-"));
  vi.stubEnv("MCODE_DATA_DIR", directory);
  settings = new SettingsService();
});
afterEach(async () => {
  settings.dispose();
  await closeAgentStorageTestDatabases();
  vi.unstubAllEnvs();
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

async function fixture(workerOwned: boolean) {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const workspaces = new WorkspaceRepo(db, writer);
  const messages = new MessageRepo(db, writer);
  const reverts = new TurnRevertStore(db);
  const workspace = await workspaces.create("Revert fixture", directory, false);
  const thread = await threads.create(workspace.id, "Revert notes", "direct", "main", false, "codex");
  const target = await messages.create(thread.id, "assistant", "Earlier changes", 1);
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] }, supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Not used by admission"); } },
    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const worktrees = new GitWorktreeService(workspaces, new FakeGitExecutor(), hostRuntime);
  const publications: CanonicalAgentEventEnvelope[] = [];
  const publish = (events: readonly CanonicalAgentEventEnvelope[]) => { publications.push(...events); };
  const client = new CanonicalAgentWriterClient(writer);
  const canonical = new CanonicalAgentBoundary(db, writer, client, publish);
  const commands = new AgentRuntimeCommandPort();
  const plans = new PlanTurnService(threads, providers, new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db, writer)), new PlanRepo(db, writer), new AgentTurnCommandPort(commands));
  const beforeCommit = { run: async () => {} };
  const owner: TurnParentStartOwner = { start: async ({ execution, ownerEpoch, providerId, parentTurn }) => {
    await beforeCommit.run();
    const receipt = await client.transactSemantic({
      operationId: `${execution.executionId}:1`, execution, ordinal: 1,
      lease: { ownerEpoch, workerIndex: 0, workerGeneration: 1, leaseId: execution.executionId },
      mutation: { kind: "begin", providerId, input: parentTurn },
    }, publish);
    if (receipt.kind !== "committed") throw new Error(`Parent start ${receipt.kind}`);
  } };
  const admission = new TurnAdmissionDispatchCoordinator(
    threads, workspaces, messages, reverts, worktrees, new AttachmentService(), providers,
    new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
    new GoalLifecycleService(threads, providers, writer, commands, canonical), undefined, undefined,
    hostRuntime.platform, workerOwned ? owner : undefined,
  );
  const runtime: TurnRuntimeAdmissionAuthority = {
    reserve: () => ({ threadId: thread.id, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 }),
    activate: () => {}, abort: async () => {}, release: () => {}, owns: () => true,
  };
  const send = async (extra: Partial<SendMessageCommand> = {}) => {
    const result = await admission.admit({ threadId: thread.id, content: "What changed?", messageId: NodeCrypto.randomUUID(), ...extra }, runtime);
    if (result.kind !== "dispatch") throw new Error("Expected provider dispatch");
    return result;
  };
  const revert = async (paths: string[], options: { kind?: "turn" | "file" | "undo"; state?: "prepared" | "committed" | "rolled_back" | "recovery_failed"; undoesRevertId?: string; threadId?: string } = {}) => {
    const id = NodeCrypto.randomUUID();
    await writer.execute(prepareTurnRevert, {
      id, requestId: NodeCrypto.randomUUID(), threadId: options.threadId ?? thread.id, targetMessageId: target.id,
      fromMessageId: null, kind: options.kind ?? "turn", path: options.kind === "file" ? paths[0] : null,
      undoesRevertId: options.undoesRevertId ?? null,
      context: { request: id, cwd: directory, snapshotIds: [], label: "Earlier changes" }, recoveryRef: `refs/mcode/test/reverts/${id}`,
      files: paths.map((path) => ({ path, action: "restore", beforeBlob: null, pre: absentState(), planned: absentState() })),
    });
    if (options.state !== "prepared") await writer.execute(settleTurnRevert, { id, state: options.state ?? "committed", content: null, failure: null });
    return id;
  };
  const publishedMessages = () => publications.flatMap(({ payload }) => {
    if (payload.type !== "item.recorded" || payload.item.kind !== "message") return [];
    return [MessageSchema().parse(payload.item.payload.message)];
  });
  return { db, thread, threads, messages, reverts, revert, send, beforeCommit, publishedMessages };
}

describe.each([false, true])("revert note admission, worker owned = %s", (workerOwned) => {
  it("sends the literal note once while keeping persisted and published user content clean", async () => {
    const f = await fixture(workerOwned);
    expect((await f.send()).request.message).toBe("What changed?");
    const id = await f.revert(["a.ts", "b.ts"]);
    const messageId = NodeCrypto.randomUUID();
    const first = await f.send({ messageId, displayContent: "My visible question" });
    expect(first.request.message).toBe("Note from Mcode: the user reverted your earlier changes to: a.ts, b.ts (restored to their state before that turn).\nWhat changed?");
    expect(f.messages.findById(messageId)?.content).toBe("My visible question");
    expect(f.publishedMessages().map((message) => message.content)).toEqual(["What changed?", "My visible question"]);
    expect(f.reverts.get(id)?.agentNotifiedAt).toEqual(expect.any(String));
    expect((await f.send()).request.message).toBe("What changed?");
  });

  it("skips both an undone revert and the Undo row", async () => {
    const f = await fixture(workerOwned);
    const id = await f.revert(["a.ts"]);
    const undo = await f.revert(["a.ts"], { kind: "undo", undoesRevertId: id });
    expect((await f.send()).request.message).toBe("What changed?");
    expect([f.reverts.get(id)?.agentNotifiedAt, f.reverts.get(undo)?.agentNotifiedAt]).toEqual([null, null]);
  });

  it("deduplicates in stable journal order and ignores unfinished, failed, and other-thread rows", async () => {
    const f = await fixture(workerOwned);
    const first = await f.revert(["b.ts", "a.ts"]);
    const second = await f.revert(["a.ts", "c.ts"], { kind: "file" });
    f.db.run("UPDATE turn_reverts SET created_at = ? WHERE id = ?", ["2026-10-01T00:00:00.000Z", first]);
    f.db.run("UPDATE turn_reverts SET created_at = ? WHERE id = ?", ["2026-10-02T00:00:00.000Z", second]);
    const other = await f.threads.create(f.thread.workspace_id, "Other", "direct", "main", false, "codex");
    const skipped = await Promise.all([
      f.revert(["prepared.ts"], { state: "prepared" }), f.revert(["failed.ts"], { state: "recovery_failed" }),
      f.revert(["rolled-back.ts"], { state: "rolled_back" }), f.revert(["other.ts"], { threadId: other.id }),
    ]);
    expect((await f.send()).request.message).toBe("Note from Mcode: the user reverted your earlier changes to: b.ts, a.ts, c.ts (restored to their state before that turn).\nWhat changed?");
    expect(skipped.map((id) => f.reverts.get(id)?.agentNotifiedAt)).toEqual([null, null, null, null]);
  });

  it("rolls back the notification and user message when the write fails, then retries", async () => {
    const f = await fixture(workerOwned);
    const id = await f.revert(["a.ts"]);
    const messageId = NodeCrypto.randomUUID();
    f.db.run("CREATE TRIGGER fail_note AFTER UPDATE OF agent_notified_at ON turn_reverts BEGIN SELECT RAISE(ABORT, 'forced note failure'); END");
    await expect(f.send({ messageId })).rejects.toThrow();
    expect(f.messages.findByIdInThread(f.thread.id, messageId)).toBeNull();
    expect(f.reverts.get(id)?.agentNotifiedAt).toBeNull();
    expect(f.publishedMessages()).toEqual([]);
    f.db.run("DROP TRIGGER fail_note");
    expect((await f.send({ messageId })).request.message).toBe("Note from Mcode: the user reverted your earlier changes to: a.ts (restored to their state before that turn).\nWhat changed?");
  });

  it("includes the note on an existing message resend without changing that message", async () => {
    const f = await fixture(workerOwned);
    const existing = await f.messages.create(f.thread.id, "user", "Queued question", 2);
    await f.revert(["a.ts"]);
    const extra = { content: "Queued question", persistedUserMessage: { id: existing.id, sequence: existing.sequence, attachments: [], persistedAttachments: [] } };
    expect((await f.send(extra)).request.message).toBe("Note from Mcode: the user reverted your earlier changes to: a.ts (restored to their state before that turn).\nQueued question");
    expect((await f.send(extra)).request.message).toBe("Queued question");
    expect(f.messages.findById(existing.id)?.content).toBe("Queued question");
    expect(f.publishedMessages().map((message) => message.content)).toEqual(["Queued question", "Queued question"]);
  });

  it("leaves notices pending on provider-originated turns and includes them on internal wire overrides", async () => {
    const f = await fixture(workerOwned);
    const id = await f.revert(["a.ts"]);
    expect((await f.send({ providerOriginated: true })).request.message).toBe("What changed?");
    expect(f.reverts.get(id)?.agentNotifiedAt).toBeNull();
    const messageId = NodeCrypto.randomUUID();
    const next = await f.send({ messageId, internalUserMessage: true, providerWireOverride: "Continue the work" });
    expect(next.request.message).toBe("Note from Mcode: the user reverted your earlier changes to: a.ts (restored to their state before that turn).\nContinue the work");
    expect(f.messages.findByIdInThreadIncludingInternal(f.thread.id, messageId)?.content).toBe("What changed?");
    expect((await f.send()).request.message).toBe("What changed?");
  });
});

it("stamps only the selected IDs when another revert commits before the parent start", async () => {
  const f = await fixture(true);
  await f.revert(["a.ts"]);
  f.beforeCommit.run = async () => { await f.revert(["b.ts"]); f.beforeCommit.run = async () => {}; };
  expect((await f.send()).request.message).toBe("Note from Mcode: the user reverted your earlier changes to: a.ts (restored to their state before that turn).\nWhat changed?");
  expect((await f.send()).request.message).toBe("Note from Mcode: the user reverted your earlier changes to: b.ts (restored to their state before that turn).\nWhat changed?");
});

it("rejects an Undo racing the selected notice without saving its user message", async () => {
  const f = await fixture(true);
  const id = await f.revert(["a.ts"]);
  f.beforeCommit.run = async () => { await f.revert(["a.ts"], { kind: "undo", undoesRevertId: id }); f.beforeCommit.run = async () => {}; };
  const messageId = NodeCrypto.randomUUID();
  await expect(f.send({ messageId })).rejects.toThrow("Revert notice changed during turn admission");
  expect(f.messages.findByIdInThread(f.thread.id, messageId)).toBeNull();
  expect(f.reverts.get(id)?.agentNotifiedAt).toBeNull();
  expect((await f.send({ messageId })).request.message).toBe("What changed?");
});
