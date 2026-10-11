import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_AGENT_EVENT_BATCH_MAX } from "@mcode/contracts";
import { agentStorageTestWriter, closeAgentStorageTestDatabases, openAgentStorageTestDatabase } from "../../__tests__/agent-storage-fixture.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import {
  CanonicalAgentStore,
  type CanonicalAgentEventPublisher,
} from "../../canonical/canonical-agent-store.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { TurnRecoveryService } from "../turn-recovery-service.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SendMessageCommand } from "../../orchestration/agent-service.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { turnRecoveryErrorCode } from "../turn-recovery-error.js";
import type { PreviewAnnotationBundle, ThreadStartup } from "@mcode/contracts";

const NOW = "2026-08-10T09:00:00.000Z";
const THREAD_ID = "00000000-0000-4000-8000-000000000021";
const TURN_ID = "turn-recovery";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000015";

describe("TurnRecoveryService", () => {
  let db: Database;
  let sink: CanonicalAgentStore;
  let runtimeSink: CanonicalAgentBoundary;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageStore;
  let defaultCheckpoints: ParentAssistantTextCheckpointService;
  let narrativeStore: NarrativeStore;
  let startupRepo: ThreadStartupRepo;
  let published: ReturnType<typeof vi.fn<CanonicalAgentEventPublisher>>;

  beforeEach(() => {
    db = openAgentStorageTestDatabase();
    const writer = agentStorageTestWriter(db);
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("workspace-recovery", "Workspace", "C:/workspace", NOW, NOW);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "workspace-recovery", "Recovery", "main", "codex", "active", NOW, NOW);
    published = vi.fn();
    sink = new CanonicalAgentStore(db, published);
    runtimeSink = new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), published);
    threadRepo = new ThreadRepo(db, writer);
    startupRepo = new ThreadStartupRepo(db, writer);
    messageRepo = new MessageStore(db);
    defaultCheckpoints = new ParentAssistantTextCheckpointService(db, writer);
    narrativeStore = new NarrativeStore(
      new MessageRepo(db, writer),
      new ToolCallRecordRepo(db, writer),
      new ThoughtSegmentRepo(db, writer),
      new HookExecutionRepo(db, writer),
    );
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-recovery",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [{
        providerId: "codex",
        scope: "thread",
        value: "native-cursor-15",
        provenance: "native",
      }],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "repeat only when asked", 1),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeAgentStorageTestDatabases();
  });

  describe("retryTurn", () => {
    let service: TurnRecoveryService;
    let attachments: AttachmentService;

    beforeEach(() => {
      vi.stubEnv("MCODE_DATA_DIR", NodePath.dirname(db.filename));
      attachments = new AttachmentService();
      service = new TurnRecoveryService(runtimeSink, threadRepo, attachments, defaultCheckpoints, startupRepo);
    });

    function failTurn(turnId = TURN_ID): void {
      const turn = sink.loadTurn(turnId);
      if (!turn?.executionId) throw new Error("Test turn missing");
      sink.finishParentTurn({ threadId: THREAD_ID, turnId, executionId: turn.executionId,
        providerId: "codex", providerIdentities: [], outcome: "errored", error: "Invalid model",
        ending: { failure: { kind: "fatal", provider: "codex", message: "Invalid model" } },
        projectTurn: () => ({ message: null, narrative: [] }) });
    }

    async function admit(command: SendMessageCommand): Promise<void> {
      if (!command.sourceTurnId) throw new Error("Retry must assign its returned turn identity");
      const persisted = await attachments.persist(THREAD_ID, command.attachments ?? []);
      await runtimeSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "workspace-recovery", providerId: "codex", createdAt: NOW },
        turnId: command.sourceTurnId, executionId: NodeCrypto.randomUUID(),
        permissionMode: "supervised", providerIdentities: [], retryOfExecutionId: command.retryOfExecutionId,
        userMessage: { kind: "create", content: command.content, sequence: messageRepo.listByThread(THREAD_ID, 100).messages.length + 1,
          attachments: persisted.stored, replyToMessageId: command.replyToMessageId,
          quotedText: command.quotedText, mentions: command.mentions, previewAnnotations: command.previewAnnotations },
      });
    }

    const rejectDispatch = async (): Promise<void> => { throw new Error("Rejected retry dispatched a turn"); };

    it.each([
      { threadId: "other-thread", turnId: TURN_ID },
      { threadId: THREAD_ID, turnId: "missing-turn" },
    ])("rejects a missing or foreign turn %j", async (input) => {
      await expect(service.retryTurn(input, rejectDispatch)).rejects.toMatchObject({ code: "TURN_RETRY_NOT_FOUND" });
    });

    it.each(["completed", "cancelled", "interrupted"] as const)("rejects a %s turn", async (outcome) => {
      sink.finishParentTurn({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
        providerId: "codex", providerIdentities: [], outcome, projectTurn: () => ({ message: null, narrative: [] }) });
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_NOT_ERRORED" });
    });

    it("rejects a thread with a running turn", async () => {
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_RUNNING" });
    });

    it("rejects a missing accepted user message without consuming the attempt", async () => {
      failTurn();
      db.prepare("DELETE FROM canonical_agent_items WHERE turn_id = ? AND kind = 'message'").run(TURN_ID);
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_INPUT_MISSING" });
      expect(sink.loadCheckpoint(EXECUTION_ID)?.phase).toBe("errored");
    });

    it("does not return an attempt identity when dispatch was handled without admission", async () => {
      failTurn();
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, async () => {}))
        .rejects.toMatchObject({ code: "TURN_RETRY_NOT_ADMITTED" });
      expect(sink.loadCheckpoint(EXECUTION_ID)?.phase).toBe("errored");
    });

    async function addStartup(state: ThreadStartup["state"]): Promise<void> {
      await startupRepo.insert({ startupId: "00000000-0000-4000-8000-000000000020",
        workspaceId: "workspace-recovery", threadId: THREAD_ID, kind: "direct", state,
        phase: state === "completed" ? "agent" : "thread",
        steps: [
          { phase: "thread", state, ...(state !== "pending" ? { startedAt: NOW } : {}),
            ...(!["pending", "running"].includes(state) ? { endedAt: NOW } : {}) },
          { phase: "agent", state: state === "completed" ? "completed" : "pending",
            ...(state === "completed" ? { startedAt: NOW, endedAt: NOW } : {}) },
        ],
        ...(state === "blocked" ? { block: { code: "test-block", message: "Needs a decision", actions: ["retry"] } } : {}),
        ...(state === "failed" ? { error: { code: "test-failure", message: "Startup failed", retryable: true } } : {}),
        transcript: [], cancellation: state === "cancelled" ? "requested" : "none", revision: 1, createdAt: NOW, updatedAt: NOW });
    }

    it.each(["pending", "running", "blocked"] as const)("rejects a %s startup", async (state) => {
      failTurn();
      await addStartup(state);
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_STARTUP_ACTIVE" });
    });

    it.each(["completed", "failed", "cancelled", "interrupted"] as const)("allows a terminal %s startup", async (state) => {
      failTurn();
      await addStartup(state);
      const result = await service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, admit);
      expect(sink.loadTurn(result.turnId)).toMatchObject({ status: "Running", attemptOf: TURN_ID });
    });

    it("rejects an older attempt even after its timestamp is updated", async () => {
      failTurn();
      await admit({ threadId: THREAD_ID, sourceTurnId: "later-turn", content: "another request" });
      failTurn("later-turn");
      db.prepare("UPDATE canonical_agent_turns SET updated_at = ? WHERE id = ?")
        .run("2099-01-01T00:00:00.000Z", TURN_ID);
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_NOT_LATEST" });
    });

    it.each([undefined, "replacement-model"])("preserves accepted input and session while selecting model %s", async (model) => {
      const original = sink.loadUserMessage(TURN_ID);
      if (!original) throw new Error("Accepted test message missing");
      const storedDir = NodePath.join(NodePath.dirname(db.filename), "attachments", THREAD_ID);
      NodeFS.mkdirSync(storedDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(storedDir, "source-file.txt"), "original bytes");
      const annotation: PreviewAnnotationBundle = { schemaVersion: 1, annotations: [{
        kind: "diff", id: "00000000-0000-4000-8000-000000000022", displayNumber: 1,
        filePath: "file.ts", side: "right", line: 2, lineContent: "const value = 1;", note: "Fix this",
      }] };
      const mentions = [{ id: "mention-file", kind: "file", path: "file.ts", label: "file.ts", range: { start: 0, end: 7 } }];
      db.prepare("UPDATE messages SET attachments = ?, reply_to_message_id = ?, quoted_text = ?, mentions = ?, preview_annotations = ? WHERE id = ?")
        .run(JSON.stringify([{ id: "source-file", name: "input.txt", mimeType: "text/plain", sizeBytes: 14 }]),
          original.id, "quoted input", JSON.stringify(mentions), JSON.stringify(annotation), original.id);
      db.prepare("UPDATE canonical_agent_items SET payload_json = json_set(payload_json, '$.message', json(?)) WHERE turn_id = ? AND kind = 'message'")
        .run(JSON.stringify({ ...original,
          attachments: [{ id: "source-file", name: "input.txt", mimeType: "text/plain", sizeBytes: 14 }],
          reply_to_message_id: original.id, quoted_text: "quoted input", mentions, previewAnnotations: annotation,
        }), TURN_ID);
      db.prepare("UPDATE threads SET model = ?, sdk_session_id = ? WHERE id = ?").run("original-model", "existing-session", THREAD_ID);
      const partial = messageRepo.createAssistantIdempotent({ id: "partial-answer", threadId: THREAD_ID,
        content: "Work before failure", sequence: 2, isInternal: true });
      sink.finishParentTurn({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
        providerId: "codex", providerIdentities: [], outcome: "errored", error: "Invalid model",
        ending: { failure: { kind: "fatal", provider: "codex", message: "Invalid model" } },
        projectTurn: () => ({ message: partial, narrative: [] }) });
      const failed = sink.loadTurn(TURN_ID);
      const accepted = sink.loadUserMessage(TURN_ID);
      const result = await service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID, model }, async (command) => {
        expect(command.model).toBe(model ?? "original-model");
        expect(Object.hasOwn(command, "forceFreshSession")).toBe(false);
        expect(command.retryOfExecutionId).toBe(EXECUTION_ID);
        await admit(command);
      });
      const retryMessage = sink.loadUserMessage(result.turnId);
      expect(retryMessage).toMatchObject({ content: "repeat only when asked", reply_to_message_id: original.id,
        quoted_text: "quoted input", mentions, previewAnnotations: annotation });
      expect(retryMessage?.attachments?.map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes })))
        .toEqual([{ name: "input.txt", mimeType: "text/plain", sizeBytes: 14 }]);
      const retryFile = attachments.prepareRetryAttachments(THREAD_ID, retryMessage?.attachments ?? [])[0];
      if (!retryFile) throw new Error("Retry attachment missing");
      expect(NodeFS.readFileSync(retryFile.sourcePath, "utf8")).toBe("original bytes");
      expect(sink.loadTurn(result.turnId)).toMatchObject({ status: "Running", attemptOf: TURN_ID });
      const reloaded = new CanonicalAgentStore(db, published);
      expect(reloaded.loadTurn(TURN_ID)).toEqual(failed);
      expect(reloaded.loadUserMessage(TURN_ID)).toEqual(accepted);
      expect(reloaded.loadTerminalProjection(TURN_ID).message).toMatchObject({ id: "partial-answer", content: "Work before failure" });
      expect(reloaded.loadTurn(TURN_ID)?.ending).toEqual({ outcome: "errored",
        failure: { kind: "fatal", provider: "codex", message: "Invalid model" } });
      expect(threadRepo.findById(THREAD_ID)?.sdk_session_id).toBe("existing-session");
    });

    it("keeps retry chains flat and rejects a second retry of each consumed attempt", async () => {
      failTurn();
      const first = await service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, admit);
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_CONFLICT" });
      failTurn(first.turnId);
      const second = await service.retryTurn({ threadId: THREAD_ID, turnId: first.turnId }, admit);
      expect(sink.loadTurn(second.turnId)?.attemptOf).toBe("turn-recovery");
      expect(sink.loadTurn(first.turnId)).toMatchObject({ status: "Errored", attemptOf: "turn-recovery" });
      expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Errored", attemptOf: null });
      await expect(service.retryTurn({ threadId: THREAD_ID, turnId: first.turnId }, rejectDispatch))
        .rejects.toMatchObject({ code: "TURN_RETRY_CONFLICT" });
    });

    it("returns a conflict from the transactional consume when two retries pass the initial checks", async () => {
      failTurn();
      let arrivals = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const dispatch = async (command: SendMessageCommand): Promise<void> => {
        arrivals += 1;
        if (arrivals === 2) release();
        await ready;
        await admit(command);
      };
      const results = await Promise.allSettled([
        service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, dispatch),
        service.retryTurn({ threadId: THREAD_ID, turnId: TURN_ID }, dispatch),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status !== "rejected") throw new Error("Concurrent retry did not conflict");
      expect(turnRecoveryErrorCode(rejected.reason)).toBe("TURN_RETRY_CONFLICT");
      expect(messageRepo.listByThread(THREAD_ID, 100).messages).toHaveLength(2);
      expect(sink.loadTurn(TURN_ID)?.ending).toEqual({ outcome: "errored",
        failure: { kind: "fatal", provider: "codex", message: "Invalid model" } });
    });
  });

  function startUnfinishedTurn(input: {
    workspaceId: string;
    workspaceName: string;
    threadId: string;
    threadTitle: string;
    turnId: string;
    executionId: string;
  }): void {
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.workspaceId, input.workspaceName, `C:/${input.workspaceId}`, NOW, NOW);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.threadId, input.workspaceId, input.threadTitle, "main", "codex", "active", NOW, NOW);
    sink.startParentTurn({
      thread: {
        id: input.threadId,
        workspaceId: input.workspaceId,
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: input.turnId,
      executionId: input.executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(input.threadId, "user", "recover this turn", 1),
    });
  }

  it("interrupts every execution that lacks exact provider proof at startup as app_closed", async () => {
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );

    const result = await service.reconcileOnStartup();

    expect(result).toEqual({ interrupted: [EXECUTION_ID] });
    expect(sink.loadTurn(TURN_ID)?.status).toBe("Interrupted");
    expect(sink.loadTurn(TURN_ID)?.ending).toEqual({ outcome: "interrupted", cause: "app_closed" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
    });
    expect(threadRepo.findById(THREAD_ID)?.status).toBe("interrupted");
  });

  it("marks an existing assistant projection interrupted with its original execution identity", async () => {
    const assistant = messageRepo.createAssistantIdempotent({
      id: "assistant-recovery",
      threadId: THREAD_ID,
      content: "A full-looking response",
      sequence: 2,
      isInternal: true,
    });
    const thread = sink.loadThread(THREAD_ID);
    if (!thread) throw new Error("Recovery test thread was not persisted canonically");

    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: [{
        eventId: `${EXECUTION_ID}:partial-assistant`,
        routing: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          executionId: EXECUTION_ID,
          itemId: `message:${assistant.id}`,
        },
        sourceProviderId: thread.providerId,
        sourceIdentities: thread.providerIdentities,
        payload: {
          type: "item.recorded",
          item: {
            id: `message:${assistant.id}`,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            kind: "message",
            providerIdentities: thread.providerIdentities,
            payload: { projection: "message", message: assistant },
            createdAt: assistant.timestamp,
            updatedAt: assistant.timestamp,
          },
        },
      }],
    });
    await defaultCheckpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "stale checkpoint must not replace canonical text",
    }]);

    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );
    await service.reconcileOnStartup();

    expect(messageRepo.findById(assistant.id)).toMatchObject({
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
      is_internal: false,
    });
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      id: assistant.id,
      content: "A full-looking response",
      is_internal: false,
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
    expect(defaultCheckpoints.restore(EXECUTION_ID)).toBe("");
  });

  it("restores exact checkpoint text in order, interrupts it, and retires the checkpoint", async () => {
    const checkpoints = new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db));
    await checkpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "First durable ",
    }]);
    await checkpoints.appendChunk([
      {
        executionId: EXECUTION_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        sequence: 2,
        text: "second durable ",
      },
      {
        executionId: EXECUTION_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        sequence: 3,
        text: "third durable.",
      },
    ]);
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      checkpoints,
      startupRepo,
    );

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "repeat only when asked" }),
      expect.objectContaining({
        role: "assistant",
        content: "First durable second durable third durable.",
        is_internal: false,
        outcome: "interrupted",
        outcomeExecutionId: EXECUTION_ID,
      }),
    ]);
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      content: "First durable second durable third durable.",
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
    expect(checkpoints.restore(EXECUTION_ID)).toBe("");

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [] });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(2);
  });

  it("imports a fsynced recovery journal before it restores the interrupted assistant text", async () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-recovery-journal-"));
    const checkpoints = new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db), { directory: journalDirectory });
    checkpoints.recoveryJournal.append([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "Journal text survives the SQLite outage.",
    }]);
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      checkpoints,
      startupRepo,
    );

    try {
      expect(await service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
      expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
        content: "Journal text survives the SQLite outage.",
        outcome: "interrupted",
        outcomeExecutionId: EXECUTION_ID,
      });
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("restores ordered narration, interrupted tools, completed hooks, and explicit parallel parents", async () => {
    narrativeStore.beginTurn(THREAD_ID);
    narrativeStore.resetTurnCounters(THREAD_ID);
    narrativeStore.openOrExtendThought(THREAD_ID, "I will inspect both children.");
    narrativeStore.closeOpenThought(THREAD_ID);
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "agent-a",
      toolName: "Agent",
      toolInput: { description: "first" },
    });
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "agent-b",
      toolName: "Agent",
      toolInput: { description: "second" },
    });
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "read-a",
      toolName: "Read",
      toolInput: { path: "a.ts" },
      parentToolCallId: "agent-a",
    });
    narrativeStore.updateBufferedToolCallOutput(THREAD_ID, "read-a", "contents", false);
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "agent-a-child",
      toolName: "Agent",
      toolInput: { description: "nested" },
      parentToolCallId: "agent-a",
    });
    const hookId = narrativeStore.openHook(THREAD_ID, {
      hookName: "PreToolUse",
      toolName: "Read",
      phase: "preToolUse",
      payload: "{\"hookType\":\"preToolUse\"}",
      sortOrder: narrativeStore.nextSortOrder(THREAD_ID),
    });
    narrativeStore.pushClosedHook(THREAD_ID, {
      id: hookId,
      messageId: "",
      hookName: "PreToolUse",
      toolName: "Read",
      phase: "preToolUse",
      payload: "{\"hookType\":\"preToolUse\"}",
      durationMs: 12,
      didBlock: false,
      startedAt: NOW,
      endedAt: NOW,
      sortOrder: 5,
    });
    narrativeStore.removeOpenHook(THREAD_ID, "PreToolUse");
    narrativeStore.openHook(THREAD_ID, {
      hookName: "PostToolUse",
      toolName: "Read",
      phase: "postToolUse",
      payload: "{\"hookType\":\"postToolUse\"}",
      sortOrder: narrativeStore.nextSortOrder(THREAD_ID),
    });

    sink.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID,
      items: narrativeStore.recoverySnapshot(THREAD_ID),
    });
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    const assistant = messageRepo.listByThread(THREAD_ID, 10).messages.at(-1)!;
    expect(assistant).toMatchObject({ role: "assistant", content: "", outcome: "interrupted" });
    const recovered = narrativeStore.loadForMessages([assistant]);
    expect(recovered.map((entry) => entry.kind)).toEqual([
      "narrationSegment",
      "toolCall",
      "toolCall",
      "toolCall",
      "toolCall",
      "hook",
      "hook",
      "assistantMessage",
    ]);
    const recoveredRead = recovered.find((entry) => entry.kind === "toolCall" && entry.record.id === "read-a");
    expect(recoveredRead).toMatchObject({
      record: {
        parent_tool_call_id: "agent-a",
        status: "completed",
        output_summary: "contents",
      },
    });
    expect(recovered.find((entry) => entry.kind === "toolCall" && entry.record.id === "agent-a"))
      .toMatchObject({ record: { status: "failed", completed_at: expect.any(String) } });
    expect(recovered.find((entry) => entry.kind === "toolCall" && entry.record.id === "agent-a-child"))
      .toMatchObject({ record: { parent_tool_call_id: "agent-a", status: "failed" } });
    expect(recovered.find((entry) => entry.kind === "hook")).toMatchObject({
      record: { hook_name: "PreToolUse", duration_ms: 12, ended_at: NOW },
    });
    expect(recovered.find((entry) => entry.kind === "hook" && entry.record.hook_name === "PostToolUse"))
      .toMatchObject({ record: { phase: "postToolUse", ended_at: expect.any(String) } });
    const canonicalPayload = db.prepare(`
      SELECT payload_json FROM canonical_agent_items
      WHERE id = 'toolCall:read-a'
    `).get() as { payload_json: string };
    expect(canonicalPayload.payload_json).not.toContain("toolInput");
    expect(canonicalPayload.payload_json).toContain('"projection":"toolCall"');
    expect(sink.loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
  });

  it("repairs a terminal checkpoint whose assistant projection was not materialized before process loss", async () => {
    narrativeStore.beginTurn(THREAD_ID);
    narrativeStore.resetTurnCounters(THREAD_ID);
    narrativeStore.openOrExtendThought(THREAD_ID, "I will run the command.");
    narrativeStore.closeOpenThought(THREAD_ID);
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "shell-live-1523",
      toolName: "Bash",
      toolInput: { command: "git status --short" },
    });
    narrativeStore.updateBufferedToolCallOutput(THREAD_ID, "shell-live-1523", "clean", false);
    sink.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID,
      items: narrativeStore.recoverySnapshot(THREAD_ID),
    });
    await defaultCheckpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "LIVE-NARRATION-1523 final answer",
    }]);
    db.prepare(`
      UPDATE canonical_agent_turns
      SET status = 'Completed', ended_at = ?
      WHERE id = ?
    `).run(NOW, TURN_ID);
    db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET phase = 'completed', terminal_outcome = 'completed'
      WHERE execution_id = ?
    `).run(EXECUTION_ID);
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    const projection = sink.loadConversationProjection(THREAD_ID, 10);
    expect(projection.messages).toEqual([
      expect.objectContaining({ role: "user", content: "repeat only when asked" }),
      expect.objectContaining({
        role: "assistant",
        content: "LIVE-NARRATION-1523 final answer",
        outcome: "interrupted",
        outcomeExecutionId: EXECUTION_ID,
      }),
    ]);
    const assistant = projection.messages.at(-1)!;
    expect(projection.narrativeByMessage[assistant.id]).toMatchObject({
      thoughts: [expect.objectContaining({ text: "I will run the command." })],
      tools: [expect.objectContaining({ id: "shell-live-1523", status: "completed" })],
    });
    expect(defaultCheckpoints.restore(EXECUTION_ID)).toBe("");
  });

  it("removes a stale checkpoint when a completed canonical message already exists", async () => {
    const checkpoints = new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db));
    await checkpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "stale checkpoint text",
    }]);
    const completed = messageRepo.createAssistantIdempotent({
      id: "completed-canonical-message",
      threadId: THREAD_ID,
      content: "canonical completed text",
      sequence: 2,
    });
    sink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed",
      projectTurn: () => ({
        message: {
          ...completed,
          outcome: "completed",
          outcomeExecutionId: EXECUTION_ID,
        },
        narrative: [],
      }),
    });
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      checkpoints,
      startupRepo,
    );

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [] });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "repeat only when asked" }),
      expect.objectContaining({
        id: "completed-canonical-message",
        content: "canonical completed text",
      }),
    ]);
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      id: "completed-canonical-message",
      content: "canonical completed text",
      outcome: "completed",
    });
    expect(checkpoints.restore(EXECUTION_ID)).toBe("");
  });

  it("marks an unresolved child delivery unknown before interrupting its parent execution", async () => {
    // Regression: restart must not classify a dispatched child as rejected or make
    // its uncertain identity eligible for reuse.
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:recovery-child",
      receiverThreadIds: ["native-recovery-child"],
      providerIdentities: [],
    });
    published.mockClear();
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );

    await service.reconcileOnStartup();

    expect(sink.loadCollaborationAction(delegation.collaborationAction.id)).toMatchObject({
      status: "Dispatched",
      deliveryUnknown: true,
    });
    expect(sink.loadThread(delegation.childThread.id)?.activityState).toBe("Unavailable");
    expect(published).toHaveBeenCalledTimes(3);
    expect(published.mock.calls[1]![0].every((event: { routing: { threadId: string } }) => (
      event.routing.threadId === delegation.childThread.id
    ))).toBe(true);
    expect(sink.loadThread(delegation.childThread.id)?.conversationRevision).toBe(1);
    expect(sink.recoverThread(delegation.childThread.id, {
      conversationRevision: 0,
      rosterRevision: 0,
    }).mode).toBe("snapshot");
  });

  it("reports only the exact turns interrupted by the current restart", async () => {
    const other = {
      workspaceId: "workspace-other",
      workspaceName: "Other workspace",
      threadId: "thread-other",
      threadTitle: "Other recovery",
      turnId: "turn-other",
      executionId: "00000000-0000-4000-8000-000000000016",
    };
    const completed = {
      workspaceId: "workspace-completed",
      workspaceName: "Completed workspace",
      threadId: "thread-completed",
      threadTitle: "Completed recovery",
      turnId: "turn-completed",
      executionId: "00000000-0000-4000-8000-000000000017",
    };
    const historic = {
      workspaceId: "workspace-historic",
      workspaceName: "Historic workspace",
      threadId: "thread-historic",
      threadTitle: "Historic error",
      turnId: "turn-historic",
      executionId: "00000000-0000-4000-8000-000000000018",
    };
    startUnfinishedTurn(other);
    startUnfinishedTurn(completed);
    startUnfinishedTurn(historic);
    sink.finishParentTurn({
      threadId: historic.threadId,
      turnId: historic.turnId,
      executionId: historic.executionId,
      providerId: "codex",
      providerIdentities: [],
      outcome: "errored",
      error: "historic provider failure",
      projectTurn: () => ({ message: null, narrative: [] }),
    });
    db.prepare("UPDATE threads SET user_completed_at = ? WHERE id = ?").run(NOW, completed.threadId);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ? WHERE execution_id = ?")
      .run("2026-08-10T09:00:00.000Z", EXECUTION_ID);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ? WHERE execution_id = ?")
      .run("2026-08-10T09:02:00.000Z", other.executionId);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ? WHERE execution_id = ?")
      .run("2026-08-10T09:01:00.000Z", completed.executionId);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T09:03:00.000Z"));
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );
    try {
      expect(await service.reconcileOnStartup()).toEqual({
        interrupted: [EXECUTION_ID, other.executionId, completed.executionId],
      });
      const incident = service.currentRecoveryIncident();
      expect(incident).toMatchObject({
        createdAt: "2026-08-10T09:03:00.000Z",
        entries: [
          {
            workspaceId: "workspace-recovery",
            workspaceName: "Workspace",
            threadId: THREAD_ID,
            threadTitle: "Recovery",
            executionId: EXECUTION_ID,
            startedAt: "2026-08-10T09:00:00.000Z",
            interruptedAt: "2026-08-10T09:03:00.000Z",
            durationMs: 180_000,
          },
          {
            workspaceId: other.workspaceId,
            workspaceName: other.workspaceName,
            threadId: other.threadId,
            threadTitle: other.threadTitle,
            executionId: other.executionId,
            startedAt: "2026-08-10T09:02:00.000Z",
            interruptedAt: "2026-08-10T09:03:00.000Z",
            durationMs: 60_000,
          },
        ],
      });
      expect(incident?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      const cleanRestart = new TurnRecoveryService(
        runtimeSink,
        threadRepo,
        new AttachmentService(),
        defaultCheckpoints,
        startupRepo,
      );
      expect(await cleanRestart.reconcileOnStartup()).toEqual({ interrupted: [] });
      expect(cleanRestart.currentRecoveryIncident()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches an explicit Retry as a fresh execution with the accepted user input", async () => {
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );
    await service.reconcileOnStartup();
    const dispatched: SendMessageCommand[] = [];
    const dispatch = vi.fn(async (command: SendMessageCommand) => {
      dispatched.push(command);
    });

    await service.retry(EXECUTION_ID, dispatch);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID,
      content: "repeat only when asked",
      provider: "codex",
      forceFreshSession: true,
      retryOfExecutionId: EXECUTION_ID,
    }));

    const retryCommand = dispatched[0]!;
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-recovery",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: "turn-retry",
      executionId: "00000000-0000-4000-8000-000000000016",
      permissionMode: "supervised",
      providerIdentities: [],
      retryOfExecutionId: retryCommand.retryOfExecutionId,
      projectUserMessage: () => new MessageStore(db).create(
        THREAD_ID,
        "user",
        retryCommand.content,
        2,
      ),
    });

    expect(sink.listInterruptedCheckpoints()).toEqual([]);
    expect(sink.loadCheckpoint(EXECUTION_ID)?.phase).toBe("retried");
    expect(sink.loadTurn(TURN_ID)?.attemptOf).toBeNull();
    expect(sink.loadTurn("turn-retry")?.attemptOf).toBe(TURN_ID);
    expect(service.currentRecoveryIncident()).toBeNull();

    sink.finishParentTurn({ threadId: THREAD_ID, turnId: "turn-retry", executionId: "00000000-0000-4000-8000-000000000016",
      providerId: "codex", providerIdentities: [], outcome: "errored", error: "failed again", projectTurn: () => ({ message: null, narrative: [] }) });
    sink.startParentTurn({ thread: { id: THREAD_ID, workspaceId: "workspace-recovery", providerId: "codex", createdAt: NOW },
      turnId: "turn-retry-again", executionId: "00000000-0000-4000-8000-000000000017", permissionMode: "supervised", providerIdentities: [],
      retryOfExecutionId: "00000000-0000-4000-8000-000000000016", projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "Retry again", 3) });
    expect(sink.loadTurn("turn-retry-again")?.attemptOf).toBe(TURN_ID);
    expect(sink.loadCheckpoint("00000000-0000-4000-8000-000000000016")?.phase).toBe("retried");
  });

  it("rolls back the attempt link and retry consumption when starting fails", () => {
    sink.finishParentTurn({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex", providerIdentities: [],
      outcome: "errored", error: "failed", projectTurn: () => ({ message: null, narrative: [] }) });
    expect(() => sink.startParentTurn({ thread: { id: THREAD_ID, workspaceId: "workspace-recovery", providerId: "codex", createdAt: NOW },
      turnId: "failed-start", executionId: "00000000-0000-4000-8000-000000000018", permissionMode: "supervised", providerIdentities: [],
      retryOfExecutionId: EXECUTION_ID, projectUserMessage: () => { throw new Error("Projection failed"); },
    })).toThrow();
    expect(sink.loadCheckpoint(EXECUTION_ID)?.phase).toBe("errored");
    expect(sink.loadTurn("failed-start")).toBeNull();
    expect(sink.loadCheckpoint("00000000-0000-4000-8000-000000000018")).toBeNull();
  });

  it("rejects a provider failure outside the current restart incident", async () => {
    sink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "errored",
      error: "provider failed",
      projectTurn: () => ({ message: null, narrative: [] }),
    });
    await threadRepo.updateStatus(THREAD_ID, "errored");

    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );
    const dispatch = vi.fn(async () => undefined);
    await expect(service.retry(EXECUTION_ID, dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("interrupts an execution whose recovered narrative exceeds one semantic batch", async () => {
    // Regression: a single interruption commit must never overflow the canonical
    // event batch cap; recovered narrative materializes in bounded commits first.
    narrativeStore.beginTurn(THREAD_ID);
    narrativeStore.resetTurnCounters(THREAD_ID);
    for (let index = 0; index < CANONICAL_AGENT_EVENT_BATCH_MAX; index += 1) {
      narrativeStore.bufferToolCall(THREAD_ID, {
        toolCallId: `recovered-tool-${index}`,
        toolName: "Read",
        toolInput: { path: `file-${index}.ts` },
      });
    }
    sink.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID,
      items: narrativeStore.recoverySnapshot(THREAD_ID),
    });
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    expect(sink.loadTurn(TURN_ID)?.status).toBe("Interrupted");
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
    });
    expect(sink.loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
    const materialized = db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE turn_id = ?
        AND json_extract(payload_json, '$.projection') = 'toolCall'
    `).get(TURN_ID) as { count: number };
    expect(materialized.count).toBe(CANONICAL_AGENT_EVENT_BATCH_MAX);
    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [] });
  });

  it("recovers an execution whose earlier interruption overflowed the canonical batch", async () => {
    // Regression: the first post-crash boot left a durable ingest-overflow record,
    // a staged internal assistant row, and retired text chunks. The next boot must
    // reopen the checkpoint and finish the interruption without crashing.
    narrativeStore.beginTurn(THREAD_ID);
    narrativeStore.resetTurnCounters(THREAD_ID);
    for (let index = 0; index < 8; index += 1) {
      narrativeStore.bufferToolCall(THREAD_ID, {
        toolCallId: `overflow-tool-${index}`,
        toolName: "Read",
        toolInput: { path: `overflow-${index}.ts` },
      });
    }
    sink.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID,
      items: narrativeStore.recoverySnapshot(THREAD_ID),
    });
    messageRepo.createAssistantIdempotent({
      id: deriveTurnAssistantMessageId(THREAD_ID, `recovery:${EXECUTION_ID}`),
      threadId: THREAD_ID,
      content: "Text recovered before the first restart overflowed.",
      sequence: 2,
      isInternal: true,
    });
    const thread = sink.loadThread(THREAD_ID);
    if (!thread) throw new Error("Recovery test thread was not persisted canonically");
    const overflow = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: Array.from(
        { length: CANONICAL_AGENT_EVENT_BATCH_MAX + 1 },
        (_, index) => ({
          eventId: `${EXECUTION_ID}:saturated-${index}`,
          routing: { threadId: THREAD_ID, executionId: EXECUTION_ID },
          sourceProviderId: thread.providerId,
          sourceIdentities: thread.providerIdentities,
          payload: {
            type: "thread.recorded" as const,
            thread: { ...thread, updatedAt: NOW },
          },
        }),
      ),
    });
    expect(overflow.outcome).toBe("ingest-overflow");
    const service = new TurnRecoveryService(
      runtimeSink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      startupRepo,
    );

    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
    });
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      content: "Text recovered before the first restart overflowed.",
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
    expect(sink.loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
    expect(await service.reconcileOnStartup()).toEqual({ interrupted: [] });
  });

  it("treats a repeated structural overflow as a duplicate of the durable record", async () => {
    // Regression: re-recording an overflow for a reopened execution must dedupe
    // against the durable ingest-overflow event instead of throwing an identity conflict.
    const thread = sink.loadThread(THREAD_ID);
    if (!thread) throw new Error("Recovery test thread was not persisted canonically");
    const saturatedBatch = (prefix: string) => Array.from(
      { length: CANONICAL_AGENT_EVENT_BATCH_MAX + 1 },
      (_, index) => ({
        eventId: `${EXECUTION_ID}:${prefix}-${index}`,
        routing: { threadId: THREAD_ID, executionId: EXECUTION_ID },
        sourceProviderId: thread.providerId,
        sourceIdentities: thread.providerIdentities,
        payload: {
          type: "thread.recorded" as const,
          thread: { ...thread, updatedAt: NOW },
        },
      }),
    );
    const first = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: saturatedBatch("first"),
    });
    expect(first.outcome).toBe("ingest-overflow");

    expect(sink.reopenUnmaterializedTerminalCheckpoint(EXECUTION_ID)).toBe(true);
    const second = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: saturatedBatch("second"),
    });
    expect(second.outcome).toBe("ingest-overflow");
    const overflowEvents = db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_events
      WHERE event_id = ?
    `).get(`${EXECUTION_ID}:ingest-overflow`) as { count: number };
    expect(overflowEvents.count).toBe(1);
  });
});
