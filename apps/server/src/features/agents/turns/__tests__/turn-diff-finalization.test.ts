import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { RealGitExecutor } from "../../../projects/git/execution/real-git-executor.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { TurnDiffRepo } from "../persistence/turn-diff-repo.js";
import { TurnSnapshotRepo } from "../persistence/turn-snapshot-repo.js";
import { TurnDiffService } from "../turn-diff-service.js";
import { TurnFinalizer } from "../turn-finalizer.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const identity = { threadId: "thread-1", turnId: "turn-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", deliveryAttempt: 1 };
const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

describe("native diff terminal persistence", () => {
  let db: Database;
  let setup: Database;
  beforeEach(() => {
    setup = openAgentStorageTestDatabase();
    const now = new Date().toISOString();
    setup.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws-1", "Test", "/test", now, now);
    setup.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(identity.threadId, "ws-1", "Test", "main", now, now);
    db = openReadOnlyDatabase(setup.filename);
  });
  afterEach(async () => { db.close(true); await closeAgentStorageTestDatabases(); });

  async function harness(canonical: boolean) {
    const writer = agentStorageTestWriter(setup);
    const messages = new MessageRepo(db, writer);
    const narrative = new NarrativeStore(messages, new ToolCallRecordRepo(db, writer), new ThoughtSegmentRepo(db, writer), new HookExecutionRepo(db, writer));
    const sink = canonical ? new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), () => {}) : undefined;
    if (sink) await sink.startParentTurn({
      thread: { id: identity.threadId, workspaceId: "ws-1", providerId: "codex", createdAt: new Date().toISOString() },
      turnId: identity.turnId, executionId: identity.turnExecutionId, permissionMode: "supervised", providerIdentities: [],
      userMessage: { kind: "create", content: "Edit the agent marker", sequence: 1 },
    });
    else await messages.create(identity.threadId, "user", "Edit the agent marker", 1);
    const repo = new TurnDiffRepo(db, writer);
    const diffs = new TurnDiffService(repo);
    const finalizer = new TurnFinalizer(messages, new ThreadRepo(db, writer), narrative, new SnapshotService(new RealGitExecutor()),
      new TurnSnapshotRepo(db, writer), writer, undefined, sink, undefined, diffs);
    diffs.begin(identity);
    diffs.push({ ...identity, revision: 1, state: "snapshot", nativeFidelity: "agent", patch });
    return { finalizer, diffs, repo, messages };
  }

  it.each([false, true])("retains native evidence after a failed write and idempotent terminal replay, canonical=%s", async (canonical) => {
    const { finalizer, diffs, repo, messages } = await harness(canonical);
    finalizer.bufferAssistantBody(identity.threadId, "Agent marker changed", "test-model");
    setup.exec("CREATE TRIGGER reject_turn_diff BEFORE INSERT ON turn_diff_snapshots BEGIN SELECT RAISE(ABORT, 'forced write failure'); END");
    await expect(finalizer.finalize(identity.threadId, "completed", Promise.resolve(), identity.turnExecutionId)).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER" });
    expect(diffs.liveComparison(identity.threadId)).toBeNull();
    expect(repo.latest(identity.threadId)).toBeUndefined();
    setup.exec("DROP TRIGGER reject_turn_diff");
    await finalizer.finalize(identity.threadId, "completed", Promise.resolve(), identity.turnExecutionId);
    await finalizer.finalize(identity.threadId, "completed", Promise.resolve(), identity.turnExecutionId);
    const assistant = messages.listByThread(identity.threadId, 10).messages.find((message) => message.role === "assistant");
    expect(repo.latest(identity.threadId)).toMatchObject({ message_id: assistant?.id, source: "native", patch });
    expect(db.prepare("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 1 });
  });

  it("clears an unmaterialized turn without creating a hollow assistant or diff record", async () => {
    const { finalizer, diffs, repo, messages } = await harness(false);
    await finalizer.finalize(identity.threadId, "completed", Promise.resolve(), identity.turnExecutionId);
    expect(diffs.liveComparison(identity.threadId)).toBeNull();
    expect(repo.latest(identity.threadId)).toBeUndefined();
    expect(messages.listByThread(identity.threadId, 10).messages.map((message) => message.role)).toEqual(["user"]);
  });
});
