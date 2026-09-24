import "reflect-metadata";
import type { Database } from "bun:sqlite";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import type { CanonicalAgentEventDraft } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";

const THREAD_ID = "writer-thread";
const TURN_ID = "writer-turn";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000176";
const NOW = "2026-09-24T12:00:00.000Z";

function events(): CanonicalAgentEventDraft[] {
  const sourceIdentities = [{ providerId: "codex" as const, scope: "thread" as const, value: "native-writer-thread", provenance: "native" as const }];
  return [
    {
      eventId: `${EXECUTION_ID}:thread`,
      routing: { threadId: THREAD_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: {
        type: "thread.recorded",
        thread: {
          id: THREAD_ID,
          workspaceId: "writer-workspace",
          rootThreadId: THREAD_ID,
          providerId: "codex",
          providerIdentities: sourceIdentities,
          activityState: "Active",
          conversationRevision: 0,
          rosterRevision: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    },
    {
      eventId: `${EXECUTION_ID}:turn`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: {
        type: "turn.created",
        turn: {
          id: TURN_ID,
          threadId: THREAD_ID,
          status: "Pending",
          trigger: { kind: "user" },
          permissionMode: "supervised",
          approvalReviewMode: "manual",
          approvalReviewReason: "manual-requested",
          providerIdentities: sourceIdentities,
          startedAt: null,
          endedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    },
    {
      eventId: `${EXECUTION_ID}:started`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: { type: "turn.started", startedAt: NOW },
    },
  ];
}

describe("canonical SQLite writer", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let writer: CanonicalAgentWriterClient | undefined;

  beforeEach(async () => {
    tempDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-canonical-writer-"));
    dbPath = NodePath.join(tempDir, "app.sqlite");
    db = openDatabase({ dbPath });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("writer-workspace", "Writer test", tempDir, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(THREAD_ID, "writer-workspace", "Writer thread", "main", "codex", NOW, NOW);
  });

  afterEach(async () => {
    await writer?.close();
    db.close(true);
    await NodeFSPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("acknowledges only committed events and deduplicates a replay", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    const first = await writer.commit("writer-operation-1", batch);
    expect(first).toMatchObject({ outcome: "committed", acceptedThrough: 3, durableThrough: 3 });
    expect(first.events.map((event) => event.eventId)).toEqual(batch.events.map((event) => event.eventId));
    expect(first).not.toHaveProperty("canonicalDelivery");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });

    const replay = await writer.commit("writer-operation-1", batch);
    expect(replay).toMatchObject({ outcome: "duplicate", acceptedThrough: 3, durableThrough: 3, events: [] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });
  });

  it("rejects a database failure without reporting a durable receipt", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.whenReady();
    db.run("DROP TABLE canonical_agent_events");
    await expect(writer.commit("writer-operation-2", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: events(),
    })).rejects.toThrow("Canonical writer write-failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
  });

  it("rejects an unmigrated path without creating a second database", async () => {
    const missingPath = NodePath.join(tempDir, "missing.sqlite");
    writer = new CanonicalAgentWriterClient(missingPath);
    await expect(writer.whenReady()).rejects.toThrow("Canonical writer open-failed");
    await expect(NodeFSPromises.stat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds write admission while SQLite is busy", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const activeWriter = writer;
    await activeWriter.whenReady();
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    db.run("BEGIN IMMEDIATE");
    let locked = true;
    try {
      const accepted = Array.from({ length: 64 }, (_, index) => activeWriter.commit(`queued-${index}`, batch));
      await expect(activeWriter.commit("overflow", batch)).rejects.toThrow("Canonical writer admission is full");
      db.run("ROLLBACK");
      locked = false;
      const results = await Promise.all(accepted);
      expect(results[0]?.outcome).toBe("committed");
      expect(results.slice(1).every((result) => result.outcome === "duplicate")).toBe(true);
    } finally {
      if (locked) db.run("ROLLBACK");
    }
  });

  it("rejects future writes if the worker exits", async () => {
    let worker: Worker | undefined;
    writer = new CanonicalAgentWriterClient(dbPath, () => {
      worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
      return worker;
    });
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await writer.commit("writer-operation-3", batch);
    const closed = new Promise((resolve) => worker?.addEventListener("close", resolve, { once: true }));
    worker?.terminate();
    await closed;
    await expect(writer.commit("writer-operation-4", batch)).rejects.toThrow("Canonical writer worker closed");
  });
});
