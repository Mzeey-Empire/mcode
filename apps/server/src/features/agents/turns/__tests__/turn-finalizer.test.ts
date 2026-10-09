import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CANONICAL_AGENT_EVENT_BATCH_MAX, CanonicalAgentProgressFrameSchema } from "@mcode/contracts";
import type { Database } from "bun:sqlite";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { TurnFinalizer, type TurnBaselinePins } from "../turn-finalizer.js";
import { deriveTurnAssistantMessageId } from "../turn-assistant-message-id.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { TurnSnapshotRepo } from "../persistence/turn-snapshot-repo.js";
import type { TurnOutcome } from "../turn-outcome.js";
import type { TurnFileTracker } from "../turn-file-tracker.js";
import { broadcast } from "../../../../application/transport/push.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { createCanonicalAgentBoundaryStub } from "../../canonical/__tests__/canonical-agent-boundary-stub.js";
import { ParentAssistantTextCheckpointService } from "../parent-assistant-text-checkpoint-service.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const THREAD = "thread-1";
const databases = new Map<Database, Database>();

function openFinalizerDatabase(): Database {
  const setup = openAgentStorageTestDatabase();
  seedThread(setup);
  const reader = openReadOnlyDatabase(setup.filename);
  databases.set(reader, setup);
  return reader;
}

function fixtureDatabase(reader: Database): Database {
  const setup = databases.get(reader);
  if (!setup) throw new Error("Finalizer fixture has no setup database");
  return setup;
}

function writerFor(reader: Database) { return agentStorageTestWriter(fixtureDatabase(reader)); }

afterEach(async () => {
  for (const reader of databases.keys()) reader.close(true);
  databases.clear();
  await closeAgentStorageTestDatabases();
});

/** Seed a workspace + thread so message/record foreign keys are satisfied. */
function seedThread(db: Database): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(THREAD, "ws-1", "Test thread", "main", now, now);
}

async function insertMessage(db: Database, id: string, role: Parameters<MessageRepo["create"]>[1], content: string, sequence: number): Promise<void> {
  await new MessageRepo(db, writerFor(db)).create(THREAD, role, content, sequence, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { type: "composer" }, id);
}

/**
 * Real-DB harness: the finalize seam exercised end to end over an file-backed
 * SQLite database with a physically read-only reader so the persisted tool-call statuses can be read back. No git
 * ref is recorded, so the snapshot step is skipped (covered separately below).
 */
describe("TurnFinalizer.finalize — turn outcome → tool-call status", () => {
  let db: Database;
  let toolRepo: ToolCallRecordRepo;
  let narrativeStore: NarrativeStore;
  let finalizer: TurnFinalizer;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openFinalizerDatabase();
    const messageRepo = new MessageRepo(db, writerFor(db));
    toolRepo = new ToolCallRecordRepo(db, writerFor(db));
    narrativeStore = new NarrativeStore(
      messageRepo,
      toolRepo,
      new ThoughtSegmentRepo(db, writerFor(db)),
      new HookExecutionRepo(db, writerFor(db)),
    );
    const threadRepo = {
      findById: vi.fn(() => ({ id: THREAD, model: "claude-sonnet-4-6" })),
    } as unknown as ThreadRepo;
    const snapshotService = {
      captureRef: vi.fn(),
      getFilesChanged: vi.fn(),
    } as unknown as SnapshotService;
    const turnSnapshotRepo = { create: vi.fn() } as unknown as TurnSnapshotRepo;
    finalizer = new TurnFinalizer(
      messageRepo,
      threadRepo,
      narrativeStore,
      snapshotService,
      turnSnapshotRepo,
      writerFor(db),
      undefined,
      createCanonicalAgentBoundaryStub(db, writerFor(db)),
    );
  });

  /** Seed an assistant message + one running tool call buffered for the turn. */
  async function seedRunningToolCall(): Promise<void> {
    await insertMessage(db, "m1", "assistant", "final body", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });
  }

  const cases: Array<{ outcome: TurnOutcome; expected: string }> = [
    { outcome: "completed", expected: "completed" },
    { outcome: "errored", expected: "failed" },
    { outcome: "cancelled", expected: "cancelled" },
    { outcome: "interrupted", expected: "failed" },
  ];

  for (const { outcome, expected } of cases) {
    it(`maps a still-running tool call to "${expected}" on a ${outcome} turn`, async () => {
      await seedRunningToolCall();

      await finalizer.finalize(THREAD, outcome);

      const tools = toolRepo.listByMessage("m1");
      expect(tools).toHaveLength(1);
      expect(tools[0].status).toBe(expected);
    });
  }

  it("broadcasts turn.persisted against the assistant message with the tool-call count", async () => {
    await seedRunningToolCall();

    await finalizer.finalize(THREAD, "completed");

    expect(broadcast).toHaveBeenCalledWith("turn.persisted", {
      threadId: THREAD,
      turnId: null,
      messageId: "m1",
      toolCallCount: 1,
      filesChanged: [],
      outcome: "completed",
      executionId: null,
    });
  });

  it("distinguishes a crash from a user stop on the same buffered tool call", async () => {
    // The whole point of the outcome enum: errored and cancelled no longer collapse.
    await insertMessage(db, "m1", "assistant", "", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "a", toolName: "Bash", toolInput: {} });
    await finalizer.finalize(THREAD, "errored");
    expect(toolRepo.listByMessage("m1")[0].status).toBe("failed");

    // A second, independent turn that the user cancels.
    await insertMessage(db, "m2", "assistant", "", 2);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "b", toolName: "Bash", toolInput: {} });
    await finalizer.finalize(THREAD, "cancelled");
    expect(toolRepo.listByMessage("m2")[0].status).toBe("cancelled");
  });

  it.each(["completed", "cancelled", "interrupted", "errored"] as const)(
    "persists the %s outcome on the assistant compatibility row",
    async (outcome) => {
      await insertMessage(db, "m1", "assistant", "body", 1);
      narrativeStore.beginTurn(THREAD);
      narrativeStore.resetTurnCounters(THREAD);
      finalizer.bufferAssistantBody(THREAD, "body", null);
      await finalizer.finalize(THREAD, outcome);

      expect(new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10).messages[0]).toMatchObject({ outcome });
    },
  );

  it("materializes an assistant row for a buffered tool call when no Message event fired", async () => {
    // A turn that buffered a tool call but never emitted a provider Message
    // (interrupted before the final body). hasRecordableActivity holds on the
    // tool call, so finalize synthesizes the assistant row the tool attaches to
    // rather than discarding the turn.
    await insertMessage(db, "u1", "user", "do the thing", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });

    await finalizer.finalize(THREAD, "errored");

    const { messages } = new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const tools = toolRepo.listByMessage(assistant!.id);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("failed");
  });

  it("leaves no assistant row and broadcasts nothing for a fully empty turn", async () => {
    // The genuine pre-turn / no-output case: no tool, body, narration, or hook.
    // hasRecordableActivity is false, so finalize writes nothing.
    await insertMessage(db, "u1", "user", "do the thing", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);

    await finalizer.finalize(THREAD, "errored");

    const { messages } = new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10);
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.anything());
  });

  it("clears the last-persisted message id on an empty turn so a late hook can't attach to the prior turn", async () => {
    // Turn 1 produces a body and records a persisted id late hooks attach to.
    await insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    finalizer.bufferAssistantBody(THREAD, "the answer", "claude-sonnet-4-6");
    await finalizer.finalize(THREAD, "completed");
    expect(finalizer.getLastPersistedMessageId(THREAD)).toBeDefined();

    // Turn 2 is fully empty. Its finalize must drop turn 1's id so a late hook
    // for turn 2 is discarded rather than mis-attached to turn 1's message.
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    await finalizer.finalize(THREAD, "completed");

    expect(finalizer.getLastPersistedMessageId(THREAD)).toBeUndefined();
  });

  it("materializes the buffered provider body into exactly one assistant row", async () => {
    // The normal completed path: the provider body is buffered (not written on
    // the Message event), then materialized once at finalize.
    await insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    const expectedId = finalizer.bufferAssistantBody(THREAD, "the final answer", "claude-sonnet-4-6");

    await finalizer.finalize(THREAD, "completed");

    const { messages } = new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10);
    const assistantRows = messages.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].id).toBe(expectedId);
    expect(assistantRows[0].content).toBe("the final answer");
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: THREAD,
      messageId: expectedId,
    }));
  });

  it("materializes an image-only assistant row for generated attachments", async () => {
    await insertMessage(db, "u1", "user", "draw this", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    const attachment = {
      id: "img-1",
      name: "generated.png",
      mimeType: "image/png",
      sizeBytes: 128,
    };

    finalizer.bufferAssistantAttachments(THREAD, [attachment]);
    await finalizer.finalize(THREAD, "completed");

    const { messages } = new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("");
    expect(assistant?.attachments).toEqual([attachment]);
    const publications = vi.mocked(broadcast).mock.calls.flatMap(([channel, payload]) => {
      if (channel !== "agent.canonical") return [];
      const frame = CanonicalAgentProgressFrameSchema().parse(payload);
      if (frame.phase !== "accepted") return [];
      return frame.events.flatMap((event) => event.payload.type === "publication.recorded" ? [event.payload.event] : []);
    });
    expect(publications).toContainEqual(expect.objectContaining({
      type: "message",
      threadId: THREAD,
      content: "",
      attachments: [attachment],
      messageId: assistant?.id,
    }));
  });

  it("flushes interrupted streaming text into a new assistant row that tool calls attach to", async () => {
    // A user stop arrives mid-stream: streamed text accumulated but the
    // provider never emitted a Message row. The flush must create the
    // assistant row so the buffered tool call has somewhere to land.
    await insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });
    finalizer.appendStreamingText(THREAD, "partial answer before stop");

    await finalizer.finalize(THREAD, "cancelled");

    const messageRepo = new MessageRepo(db, writerFor(db));
    const { messages } = messageRepo.listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("partial answer before stop");
    const tools = toolRepo.listByMessage(assistant!.id);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("cancelled");
  });

  it("synthesizes the interrupted assistant row under a deterministic per-turn id", async () => {
    // The flushed row's identity must derive from the turn's anchor (the
    // preceding user message), not a fresh random id — so a replayed flush
    // collapses onto the same row.
    await insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    finalizer.appendStreamingText(THREAD, "partial answer before stop");

    await finalizer.finalize(THREAD, "cancelled");

    const { messages } = new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.id).toBe(deriveTurnAssistantMessageId(THREAD, "u1"));
  });

  it("produces exactly one assistant row when finalize runs twice for one turn", async () => {
    // Reconnect replay: the streamed deltas are re-accumulated and finalize is
    // called a second time. Here the second flush is short-circuited by the
    // existing "last row is already assistant" guard, so it never reaches the
    // insert — this asserts the end-to-end "twice → one row" outcome. The
    // deterministic-id + INSERT OR IGNORE collapse that backs this up at the DB
    // layer is covered directly in message-repo.test.ts.
    await insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    finalizer.appendStreamingText(THREAD, "partial answer before stop");

    await finalizer.finalize(THREAD, "cancelled");
    // A replay re-buffers the same streamed text before the second finalize.
    finalizer.appendStreamingText(THREAD, "partial answer before stop");
    await finalizer.finalize(THREAD, "cancelled");

    const { messages } = new MessageRepo(db, writerFor(db)).listByThread(THREAD, 10);
    const assistantRows = messages.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
  });

  it("is a no-op when a finalize is already in flight (re-entrancy guard)", async () => {
    await seedRunningToolCall();

    // Fire a second finalize before the first settles. The guard, held across
    // the snapshot await, must make the second call a no-op so the tool row is
    // written exactly once rather than duplicated.
    const first = finalizer.finalize(THREAD, "completed");
    const second = finalizer.finalize(THREAD, "completed");
    await Promise.all([first, second]);

    expect(toolRepo.listByMessage("m1")).toHaveLength(1);
  });
});

describe("TurnFinalizer canonical commit recovery", () => {
  const executionId = "00000000-0000-4000-8000-000000000010";
  const turnId = "canonical-turn-1";

  async function buildCanonicalHarness(toolCallCount = 1) {
    const db = openFinalizerDatabase();
    const messageRepo = new MessageRepo(db, writerFor(db));
    const threadRepo = new ThreadRepo(db, writerFor(db));
    const toolRepo = new ToolCallRecordRepo(db, writerFor(db));
    const thoughtRepo = new ThoughtSegmentRepo(db, writerFor(db));
    const hookRepo = new HookExecutionRepo(db, writerFor(db));
    const narrativeStore = new NarrativeStore(
      messageRepo,
      toolRepo,
      thoughtRepo,
      hookRepo,
    );
    const sink = new CanonicalAgentBoundary(db, writerFor(db), new CanonicalAgentWriterClient(writerFor(db)), vi.fn());
    await sink.startParentTurn({
      thread: {
        id: THREAD,
        workspaceId: "ws-1",
        providerId: "claude",
        createdAt: new Date().toISOString(),
      },
      turnId,
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "create", content: "question", sequence: 1 },
    });
    const checkpoints = new ParentAssistantTextCheckpointService(db, writerFor(db));
    const finalizer = new TurnFinalizer(
      messageRepo,
      threadRepo,
      narrativeStore,
      { captureRef: vi.fn(), getFilesChanged: vi.fn() } as unknown as SnapshotService,
      new TurnSnapshotRepo(db, writerFor(db)),
      writerFor(db),
      undefined,
      sink,
      checkpoints,
    );
    finalizer.bufferAssistantBody(THREAD, "answer", "claude-sonnet-4-6");
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    for (let index = 0; index < toolCallCount; index += 1) {
      narrativeStore.bufferToolCall(THREAD, {
        toolCallId: `tool-${index}`,
        toolName: "Read",
        toolInput: { path: `file-${index}.md` },
      });
    }
    return {
      db,
      finalizer,
      messageRepo,
      toolRepo,
      thoughtRepo,
      hookRepo,
      sink,
      checkpoints,
      narrativeStore,
    };
  }

  it("retires provisional text only after the canonical terminal commit", async () => {
    const { finalizer, sink, checkpoints } = await buildCanonicalHarness();
    await checkpoints.appendChunk([{
      executionId,
      threadId: THREAD,
      turnId,
      sequence: 1,
      text: "answer",
    }]);

    await finalizer.finalize(THREAD, "completed", Promise.resolve(), executionId);

    expect(sink.loadCheckpoint(executionId)?.terminalOutcome).toBe("completed");
    expect(checkpoints.restore(executionId)).toBe("");
  });

  it("reanchors active recovery narrative to the terminal assistant before retiring recovery", async () => {
    const {
      finalizer,
      messageRepo,
      toolRepo,
      thoughtRepo,
      hookRepo,
      sink,
      narrativeStore,
    } = await buildCanonicalHarness();
    narrativeStore.openOrExtendThought(THREAD, "I will inspect the result.");
    narrativeStore.openHook(THREAD, {
      hookName: "PostToolUse",
      toolName: "Read",
      phase: "post",
      payload: "{}",
      sortOrder: 2,
    });
    await sink.recordParentNarrativeRecovery({
      executionId,
      items: narrativeStore.recoverySnapshot(THREAD),
    });

    await finalizer.finalize(THREAD, "completed", Promise.resolve(), executionId);

    const assistant = messageRepo.listByThread(THREAD, 10).messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    expect(toolRepo.listByMessage(assistant!.id)).toMatchObject([{
      id: "tool-0",
      status: "completed",
    }]);
    expect(thoughtRepo.listByMessage(assistant!.id)).toMatchObject([{
      text: "I will inspect the result.",
    }]);
    expect(hookRepo.listByMessage(assistant!.id)).toMatchObject([{
      hook_name: "PostToolUse",
    }]);
    expect(sink.loadItem("toolCall:tool-0")?.payload).toMatchObject({
      projection: "toolCall",
    });
    expect(sink.loadParentNarrativeRecovery(turnId)).toEqual([]);
  });

  it("retains recovery data and withholds completion when canonical finalization rolls back", async () => {
    const { db, finalizer, messageRepo, sink, checkpoints, narrativeStore } = await buildCanonicalHarness();
    await checkpoints.appendChunk([{
      executionId,
      threadId: THREAD,
      turnId,
      sequence: 1,
      text: "answer",
    }]);
    narrativeStore.openOrExtendThought(THREAD, "answer");
    await sink.recordParentNarrativeRecovery({
      executionId,
      items: narrativeStore.recoverySnapshot(THREAD),
    });
    vi.mocked(broadcast).mockClear();
    fixtureDatabase(db).exec(`
      CREATE TRIGGER reject_canonical_tool
      BEFORE INSERT ON tool_call_records
      BEGIN
        SELECT RAISE(ABORT, 'forced narrative failure');
      END;
    `);

    await expect(finalizer.finalize(
      THREAD,
      "completed",
      Promise.resolve(),
      executionId,
    )).rejects.toThrow("forced narrative failure");
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.anything());
    expect(checkpoints.restore(executionId)).toBe("answer");
    expect(sink.loadParentNarrativeRecovery(turnId)).toHaveLength(2);
    // Recovery envelopes commit independently of the finalize projection, so a finalize
    // rollback must not remove the durable canonical copies.
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_events
      WHERE json_extract(envelope_json, '$.payload.item.payload.projection') = 'narrativeRecovery'
    `).get()).toEqual({ count: 2 });
    fixtureDatabase(db).exec("DROP TRIGGER reject_canonical_tool");

    await finalizer.finalize(THREAD, "completed", Promise.resolve(), executionId);

    expect(messageRepo.listByThread(THREAD, 10).messages.map((message) => message.content)).toEqual([
      "question",
      "answer",
    ]);
    expect(sink.loadTerminalProjection(turnId)).toMatchObject({
      message: expect.objectContaining({ content: "answer" }),
      toolCallCount: 1,
    });
    expect(sink.loadParentNarrativeRecovery(turnId)).toEqual([]);
    expect(sink.loadItem("toolCall:tool-0")?.payload).toMatchObject({
      projection: "toolCall",
    });
    // Canonical history is append-only: the recorded recovery envelopes stay committed
    // while the terminal commit removes the item rows they hydrated.
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_events
      WHERE json_extract(envelope_json, '$.payload.item.payload.projection') = 'narrativeRecovery'
    `).get()).toEqual({ count: 2 });
  });

  it("replays terminal post-commit effects from the canonical projection", async () => {
    const { finalizer, messageRepo } = await buildCanonicalHarness();
    await finalizer.finalize(THREAD, "completed", Promise.resolve(), executionId);
    const messageId = messageRepo.listByThread(THREAD, 10).messages[1].id;
    vi.mocked(broadcast).mockClear();

    await finalizer.finalize(THREAD, "completed", Promise.resolve(), executionId);

    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: THREAD,
      turnId,
      messageId,
      toolCallCount: 1,
    }));
    expect(messageRepo.listByThread(THREAD, 10).messages).toHaveLength(2);
  });

  it("publishes a terminal turn with more than 256 canonical events", async () => {
    const { finalizer, messageRepo, sink } = await buildCanonicalHarness(
      CANONICAL_AGENT_EVENT_BATCH_MAX,
    );
    vi.mocked(broadcast).mockClear();

    await finalizer.finalize(THREAD, "completed", Promise.resolve(), executionId);

    expect(sink.loadCheckpoint(executionId)).toMatchObject({
      phase: "completed",
      terminalOutcome: "completed",
    });
    expect(messageRepo.listByThread(THREAD, 10).messages.map((message) => message.content)).toEqual([
      "question",
      "answer",
    ]);
    const assistantMessage = messageRepo.listByThread(THREAD, 10).messages[1];
    expect(assistantMessage).toBeDefined();
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: THREAD,
      turnId,
      messageId: assistantMessage!.id,
      toolCallCount: CANONICAL_AGENT_EVENT_BATCH_MAX,
    }));
  });
});

/**
 * TurnSubstance predicate: hasRecordableActivity decides whether a turn is
 * worth a persisted assistant row. Each contributor is exercised in isolation
 * over the real-DB harness so the buffers are seeded the same way a live turn
 * seeds them.
 */
describe("TurnFinalizer.hasRecordableActivity — TurnSubstance predicate", () => {
  let db: Database;
  let narrativeStore: NarrativeStore;
  let finalizer: TurnFinalizer;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openFinalizerDatabase();
    const messageRepo = new MessageRepo(db, writerFor(db));
    narrativeStore = new NarrativeStore(
      messageRepo,
      new ToolCallRecordRepo(db, writerFor(db)),
      new ThoughtSegmentRepo(db, writerFor(db)),
      new HookExecutionRepo(db, writerFor(db)),
    );
    const threadRepo = {
      findById: vi.fn(() => ({ id: THREAD, model: "claude-sonnet-4-6" })),
    } as unknown as ThreadRepo;
    const snapshotService = {
      captureRef: vi.fn(),
      getFilesChanged: vi.fn(),
    } as unknown as SnapshotService;
    const turnSnapshotRepo = { create: vi.fn() } as unknown as TurnSnapshotRepo;
    finalizer = new TurnFinalizer(
      messageRepo,
      threadRepo,
      narrativeStore,
      snapshotService,
      turnSnapshotRepo,
      writerFor(db),
    );
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
  });

  it("is true when only a tool call is buffered", () => {
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is true when only a non-empty assistant body is buffered", () => {
    finalizer.bufferAssistantBody(THREAD, "here is the answer", "claude-sonnet-4-6");

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is true when only a narration segment is buffered", () => {
    narrativeStore.openOrExtendThought(THREAD, "let me think about this");

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is true when only a hook is buffered", () => {
    narrativeStore.openHook(THREAD, {
      hookName: "PreToolUse",
      toolName: "Bash",
      phase: "pre",
      payload: "{}",
      sortOrder: 0,
    });

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is false for a fully empty turn (no tool, body, narration, or hook)", () => {
    expect(finalizer.hasRecordableActivity(THREAD)).toBe(false);
  });

  it("treats a whitespace-only assistant body as no body", () => {
    finalizer.bufferAssistantBody(THREAD, "   \n  ", null);

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(false);
  });
});

/** Finalization commits snapshot metadata and file-change markers through the actual owner. */
describe("TurnFinalizer.finalize — git snapshot write", () => {
  async function build(filesChanged: string[], options?: {
    refAfter?: string;
    fileTracker?: TurnFileTracker;
    captureRef?: SnapshotService["captureRef"];
    getFilesChanged?: SnapshotService["getFilesChanged"];
    pins?: TurnBaselinePins;
  }) {
    const db = openFinalizerDatabase();
    const writer = writerFor(db);
    await insertMessage(db, "msg-1", "assistant", "snapshot response", 2);
    const messageRepo = new MessageRepo(db, writer);
    const threadRepo = new ThreadRepo(db, writer);
    const narrativeStore = new NarrativeStore(messageRepo, new ToolCallRecordRepo(db, writer),
      new ThoughtSegmentRepo(db, writer), new HookExecutionRepo(db, writer));
    const snapshotService = {
      captureRef: options?.captureRef ?? vi.fn(async () => options?.refAfter ?? "def222"),
      getFilesChanged: options?.getFilesChanged ?? vi.fn(async () => filesChanged),
    } as unknown as SnapshotService;
    const turnSnapshotRepo = new TurnSnapshotRepo(db, writer);
    const finalizer = new TurnFinalizer(messageRepo, threadRepo, narrativeStore, snapshotService,
      turnSnapshotRepo, writer, options?.fileTracker, undefined, undefined, undefined, options?.pins);
    const beginTurn = () => {
      narrativeStore.beginTurn(THREAD);
      narrativeStore.resetTurnCounters(THREAD);
      finalizer.bufferAssistantBody(THREAD, "snapshot response", null);
    };
    beginTurn();
    return { finalizer, db, snapshotService, turnSnapshotRepo, threadRepo, beginTurn };
  }

  beforeEach(() => vi.clearAllMocks());

  it("rolls back the snapshot when its file-change marker fails, then accepts a later save", async () => {
    const { finalizer, db, turnSnapshotRepo, threadRepo, beginTurn } = await build(["src/index.ts"]);
    fixtureDatabase(db).exec(`
      CREATE TRIGGER reject_file_marker BEFORE UPDATE OF has_file_changes ON threads
      BEGIN SELECT RAISE(ABORT, 'forced file marker failure'); END;
    `);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.listByThread(THREAD)).toEqual([]);
    expect(threadRepo.findById(THREAD)?.has_file_changes).toBe(false);

    fixtureDatabase(db).exec("DROP TRIGGER reject_file_marker");
    beginTurn();
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.listByThread(THREAD)).toHaveLength(1);
    expect(threadRepo.findById(THREAD)?.has_file_changes).toBe(true);
  });

  it("moves the baseline pin onto the written snapshot row", async () => {
    const pins = { transferToSnapshot: vi.fn(async () => true), release: vi.fn(async () => true) };
    const { finalizer, turnSnapshotRepo } = await build(["src/index.ts"], { pins });
    const pin = { kind: "baseline", threadId: THREAD, executionId: "exec-1" } as const;
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace", undefined, pin);
    await finalizer.finalize(THREAD, "completed");
    const row = turnSnapshotRepo.getByMessage("msg-1");
    expect(pins.transferToSnapshot).toHaveBeenCalledWith(
      "/workspace", { id: row?.id, refBefore: "abc111", refAfter: "def222" }, pin);
    expect(pins.release).not.toHaveBeenCalled();
  });

  it("releases the baseline pin of a turn that writes no snapshot", async () => {
    const pins = { transferToSnapshot: vi.fn(async () => true), release: vi.fn(async () => true) };
    const { finalizer, turnSnapshotRepo } = await build([], {
      pins, captureRef: vi.fn(async () => { throw new Error("capture failed"); }),
    });
    const pin = { kind: "baseline", threadId: THREAD, executionId: "exec-1" } as const;
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace", undefined, pin);
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.listByThread(THREAD)).toEqual([]);
    expect(pins.release).toHaveBeenCalledWith("/workspace", pin);
    expect(pins.transferToSnapshot).not.toHaveBeenCalled();
  });

  it("creates the turn snapshot row with the correct values", async () => {
    const { finalizer, turnSnapshotRepo } = await build(["src/index.ts"]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.getByMessage("msg-1")).toMatchObject({
      message_id: "msg-1", thread_id: THREAD, ref_before: "abc111", ref_after: "def222",
      files_changed: ["src/index.ts"], worktree_path: null,
    });
  });

  it("does not let an older finalize clear a newer turn ref while snapshot capture is still running", async () => {
    let resolveFirstCapture: ((ref: string) => void) | undefined;
    const captureRef = vi.fn<SnapshotService["captureRef"]>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirstCapture = resolve; }))
      .mockResolvedValueOnce("second-after");
    const getFilesChanged = vi.fn<SnapshotService["getFilesChanged"]>(async (_cwd, refBefore) =>
      refBefore === "first-before" ? ["first.ts"] : ["second.ts"]);
    const { finalizer, turnSnapshotRepo, beginTurn } = await build([], { captureRef, getFilesChanged });
    finalizer.recordTurnRef(THREAD, "first-before", "/workspace");
    const first = finalizer.finalize(THREAD, "completed");
    await vi.waitFor(() => expect(captureRef).toHaveBeenCalledTimes(1));
    finalizer.recordTurnRef(THREAD, "second-before", "/workspace");
    resolveFirstCapture?.("first-after");
    await first;
    beginTurn();
    await finalizer.finalize(THREAD, "completed");
    expect(captureRef).toHaveBeenCalledTimes(2);
    expect(turnSnapshotRepo.listByThread(THREAD)).toMatchObject([
      { message_id: "msg-1", ref_before: "first-before", ref_after: "first-after", files_changed: ["first.ts"] },
      { message_id: "msg-1", ref_before: "second-before", ref_after: "second-after", files_changed: ["second.ts"] },
    ]);
  });

  it("does not let a finalize without a ref clear a newer turn ref before cleanup", async () => {
    const { finalizer, turnSnapshotRepo, beginTurn } = await build(["second.ts"]);
    const first = finalizer.finalize(THREAD, "completed");
    queueMicrotask(() => finalizer.recordTurnRef(THREAD, "second-before", "/workspace"));
    await first;
    beginTurn();
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.getByMessage("msg-1")).toMatchObject({
      ref_before: "second-before", ref_after: "def222", files_changed: ["second.ts"],
    });
  });

  it("keeps the file-change marker set across later changed snapshots", async () => {
    const { finalizer, threadRepo, turnSnapshotRepo, beginTurn } = await build(["src/index.ts"]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");
    await finalizer.finalize(THREAD, "completed");
    expect(threadRepo.findById(THREAD)?.has_file_changes).toBe(true);
    beginTurn();
    finalizer.recordTurnRef(THREAD, "def222", "/workspace");
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.listByThread(THREAD)).toHaveLength(2);
    expect(threadRepo.findById(THREAD)?.has_file_changes).toBe(true);
  });

  it("leaves the file-change marker unset when nothing changed", async () => {
    const { finalizer, threadRepo } = await build([]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");
    await finalizer.finalize(THREAD, "completed");
    expect(threadRepo.findById(THREAD)?.has_file_changes).toBe(false);
  });

  it("persists an empty authored summary when the repository ref is unchanged", async () => {
    const emptySummary = { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] };
    const fileTracker = { finalizeTurn: vi.fn(async () => emptySummary), clearTurn: vi.fn(),
      reconstructionPatch: vi.fn(async () => undefined) } as unknown as TurnFileTracker;
    const { finalizer, turnSnapshotRepo } = await build([], { refAfter: "abc111", fileTracker });
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace", 1);
    await finalizer.finalize(THREAD, "completed");
    expect(turnSnapshotRepo.getByMessage("msg-1")).toMatchObject({
      ref_before: "abc111", ref_after: "abc111", files_changed: [], file_effects: emptySummary,
    });
  });

  it("persists external effects when Git refs are unavailable", async () => {
    const fileEffects = { revision: 1, fileCount: 1, additions: 0, deletions: 0, effects: [{
      path: "C:/outside.txt", kind: "edited" as const, scope: "external" as const,
      additions: null, deletions: null, binary: false, toolCallIds: ["edit"],
    }] };
    const fileTracker = { finalizeTurn: vi.fn(async () => fileEffects), clearTurn: vi.fn(),
      reconstructionPatch: vi.fn(async () => undefined) } as unknown as TurnFileTracker;
    const { finalizer, snapshotService, turnSnapshotRepo, threadRepo } = await build([], { fileTracker });
    finalizer.recordTurnRef(THREAD, null, "/workspace", 1);
    await finalizer.finalize(THREAD, "completed");
    expect(snapshotService.captureRef).not.toHaveBeenCalled();
    expect(turnSnapshotRepo.getByMessage("msg-1")).toMatchObject({
      ref_before: "", ref_after: "", files_changed: [], file_effects: fileEffects,
    });
    expect(threadRepo.findById(THREAD)?.has_file_changes).toBe(true);
  });

  it("uses a late ref update pinned before finalization waits", async () => {
    let releasePrerequisite: (() => void) | undefined;
    const prerequisite = new Promise<void>((resolve) => { releasePrerequisite = resolve; });
    const { finalizer, turnSnapshotRepo } = await build(["late.ts"]);
    finalizer.recordTurnRef(THREAD, null, "/workspace", 1);
    const finalized = finalizer.finalize(THREAD, "completed", prerequisite);
    finalizer.recordTurnRef(THREAD, "captured-before", "/workspace", 1);
    releasePrerequisite?.();
    await finalized;
    expect(turnSnapshotRepo.getByMessage("msg-1")).toMatchObject({
      ref_before: "captured-before", ref_after: "def222", files_changed: ["late.ts"],
    });
  });

  it("keeps out-of-order ref captures attached to their own generations", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const { finalizer, turnSnapshotRepo, beginTurn } = await build(["tracked.ts"]);
    finalizer.recordTurnRef(THREAD, null, "/workspace", 1);
    const first = finalizer.finalize(THREAD, "completed", firstGate);
    finalizer.recordTurnRef(THREAD, null, "/workspace", 2);
    const second = finalizer.finalize(THREAD, "completed", secondGate);
    finalizer.recordTurnRef(THREAD, "second-before", "/workspace", 2);
    finalizer.recordTurnRef(THREAD, "first-before", "/workspace", 1);
    releaseFirst?.();
    await first;
    beginTurn();
    releaseSecond?.();
    await second;
    expect(turnSnapshotRepo.listByThread(THREAD)).toMatchObject([
      { ref_before: "first-before" }, { ref_before: "second-before" },
    ]);
  });
});
