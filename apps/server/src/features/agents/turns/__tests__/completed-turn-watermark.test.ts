import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventSchema } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openMigratedTestDatabase } from "../../../../runtime/persistence/sqlite/testing/migrated-test-database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { leaseWriterWorker } from "../../../../runtime/persistence/sqlite/testing/reusable-writer-worker.js";
import { ThreadProviderSessionRepo } from "../../../thread-control/persistence/thread-provider-session-repo.js";
import { CanonicalAcceptedProgress } from "../../canonical/canonical-accepted-progress.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../../canonical/canonical-execution-writer-port.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand } from "../../execution/execution-worker-handler.js";
import { CompletedTurnWatermark } from "../completed-turn-watermark.js";

const pushes = vi.hoisted(() => ({ turns: [] as { channel: string; data: unknown }[] }));
vi.mock("../../../../application/transport/push.js", () => ({
  broadcast: (channel: string, frame: unknown) => {
    if (channel === "turn.persisted") pushes.turns.push({ channel, data: frame });
  },
  subscribedThreadIds: () => new Set<string>(),
}));

describe("CompletedTurnWatermark", () => {
  const sessions = { resolve: vi.fn(), markSeen: vi.fn() };
  const watermark = new CompletedTurnWatermark(sessions);
  const completed = { threadId: "thread", providerId: "claude", outcome: "completed" as const, sequence: 4 };

  beforeEach(() => {
    sessions.resolve.mockReset().mockReturnValue({ sessionId: "native-1", lastSeenSequence: 1 });
    sessions.markSeen.mockReset().mockResolvedValue(undefined);
  });

  it("credits a completed turn to the session the provider resolves to", async () => {
    await watermark.record(completed);
    expect(sessions.resolve).toHaveBeenCalledWith("thread", "claude");
    expect(sessions.markSeen).toHaveBeenCalledWith("thread", "claude", "native-1", 4);
  });

  it.each([
    ["an errored turn", { ...completed, outcome: "errored" as const }],
    ["an interrupted turn", { ...completed, outcome: "interrupted" as const }],
    ["a turn that persisted no message", { ...completed, sequence: null }],
  ])("does not advance for %s", async (_name, turn) => {
    await watermark.record(turn);
    expect(sessions.markSeen).not.toHaveBeenCalled();
  });

  it("does nothing when the provider holds no session", async () => {
    sessions.resolve.mockReturnValue(null);
    await watermark.record(completed);
    expect(sessions.markSeen).not.toHaveBeenCalled();
  });

  it("logs and resolves when the write fails, so the finished turn is not failed over bookkeeping", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    sessions.markSeen.mockRejectedValue(new Error("database is locked"));
    await expect(watermark.record(completed)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Failed to advance provider session watermark",
      { threadId: "thread", providerId: "claude", error: "database is locked" });
    warn.mockRestore();
  });
});

const NOW = "2026-10-20T10:00:00.000Z";
const execution = { threadId: "watermark-thread", turnId: "watermark-turn", executionId: "00000000-0000-4000-8000-000000000321" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "watermark-lease" };

function startClaudeTurn(): Extract<ExecutionWorkCommand, { kind: "start" }> {
  return { kind: "start", providerId: "claude", publishParentStart: true,
    parentLive: { planFeature: "none", precedingMessageId: `${execution.turnId}:user` },
    input: { thread: { id: execution.threadId, workspaceId: "workspace", providerId: "claude", createdAt: NOW },
      turnId: execution.turnId, executionId: execution.executionId, permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: `${execution.turnId}:user`, content: "Task", sequence: 1 } } };
}

function providerEvent(sequence: number, type: "textDelta" | "ended", fields: Record<string, unknown>) {
  const event = AgentEventSchema().parse({ type, threadId: execution.threadId, turnExecutionId: execution.executionId, ...fields });
  const itemId = `${execution.executionId}:raw:${sequence}`;
  return { eventId: itemId, routing: { ...execution, itemId }, sourceProviderId: "claude", sourceIdentities: [],
    sourceSequence: sequence, payload: { type: "item.recorded" as const,
      item: { id: itemId, threadId: execution.threadId, turnId: execution.turnId, kind: "system" as const, providerIdentities: [],
        payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } }, createdAt: NOW, updatedAt: NOW } } };
}

// Drives a real completed turn through the worker handler and the accepted-save path production uses.
describe("provider session watermark through the accepted worker path", { timeout: 30_000 }, () => {
  beforeAll(() => { vi.setConfig({ expect: { poll: { timeout: 10_000 } } }); });
  afterAll(() => { vi.resetConfig(); });

  let directory: string;
  let db: Database;
  let reader: Database;
  let writer: CanonicalAgentWriterClient;
  let databaseWriter: ApplicationDatabaseWriter;
  let progress: CanonicalAcceptedProgress;
  let handler: ExecutionWorkerHandler;
  let sessions: ThreadProviderSessionRepo;

  beforeEach(() => {
    pushes.turns.length = 0;
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-watermark-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    db = openMigratedTestDatabase(dbPath);
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace", "Workspace", directory, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, sdk_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(execution.threadId, "workspace", "Thread", "main", "claude", "claude-native", NOW, NOW);
    databaseWriter = new ApplicationDatabaseWriter(dbPath, leaseWriterWorker);
    writer = new CanonicalAgentWriterClient(databaseWriter);
    reader = openReadOnlyDatabase(dbPath);
    sessions = new ThreadProviderSessionRepo(reader, databaseWriter);
    progress = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer,
      undefined, new CompletedTurnWatermark(sessions));
    handler = new ExecutionWorkerHandler(new CanonicalExecutionWriterPort(writer, () => {}, undefined, undefined, progress));
  });

  afterEach(async () => {
    await progress.close();
    await writer.close();
    await databaseWriter.close();
    reader.close(true);
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const send = (ordinal: number, command: ExecutionWorkCommand) =>
    handler.handle({ requestId: ordinal, execution, lease, ordinal, command });
  const seed = (providerId: string, sessionId: string, lastSeenSequence: number) => db.prepare(
    "INSERT INTO thread_provider_sessions (thread_id, provider_id, session_id, last_seen_sequence, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(execution.threadId, providerId, sessionId, lastSeenSequence, NOW);
  const watermarkOf = (providerId: string) => sessions.find(execution.threadId, providerId)?.lastSeenSequence;

  async function completeTurn() {
    await send(1, startClaudeTurn());
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [providerEvent(1, "textDelta", { delta: "The answer", isFinalResponse: true })] });
    const terminal = await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [providerEvent(2, "ended", { outcome: "completed" })],
      terminalInput: { ...execution, providerId: "claude", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    expect(terminal.result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
  }

  it("advances the session the turn ran on to the turn's own reply", async () => {
    seed("claude", "claude-native", 0);
    await completeTurn();
    const reply = db.prepare("SELECT sequence FROM messages WHERE thread_id = ? AND role = 'assistant'").get(execution.threadId) as { sequence: number };
    expect(reply.sequence).toBe(2);
    await expect.poll(() => watermarkOf("claude")).toBe(2);
  });

  it("leaves another provider's session alone", async () => {
    seed("claude", "claude-native", 0);
    seed("codex", "codex-native", 1);
    await completeTurn();
    await expect.poll(() => watermarkOf("claude")).toBe(2);
    expect(watermarkOf("codex")).toBe(1);
  });

  it("does not credit a row whose session is not the one the thread resumes", async () => {
    seed("claude", "an-older-native-session", 1);
    await completeTurn();
    expect(watermarkOf("claude")).toBe(1);
  });

  it("still persists and publishes the turn when the watermark write fails", async () => {
    seed("claude", "claude-native", 0);
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(sessions, "markSeen").mockRejectedValue(new Error("database is locked"));
    await completeTurn();
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant'").get(execution.threadId)).toEqual({ content: "The answer" });
    expect(pushes.turns.some((push) => push.channel === "turn.persisted")).toBe(true);
    expect(watermarkOf("claude")).toBe(0);
  });
});
