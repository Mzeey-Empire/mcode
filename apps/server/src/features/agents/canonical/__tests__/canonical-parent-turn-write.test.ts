import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import {
  CanonicalParentTurnWrite,
  type DataOnlyParentTurnFinishInput,
  type DataOnlyParentTurnStartInput,
} from "../canonical-parent-turn-write.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-24T10:00:00.000Z";

function seedThread(db: Database): void {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("workspace-1", "Workspace", "C:/fixture", NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD_ID, "workspace-1", "Thread", "main", "codex", NOW, NOW);
}

function startInput(): DataOnlyParentTurnStartInput {
  return {
    thread: { id: THREAD_ID, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    providerIdentities: [],
    userMessage: { kind: "create", messageId: "user-1", content: "Question", sequence: 1 },
  };
}

function finishInput(message: ReturnType<MessageRepo["create"]>): DataOnlyParentTurnFinishInput {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    providerId: "codex",
    providerIdentities: [],
    outcome: "completed",
    projection: { message, narrative: [] },
  };
}

describe("CanonicalParentTurnWrite", () => {
  let directory: string;
  let path: string;
  let db: Database;
  let published: string[][];
  let writer: CanonicalParentTurnWrite;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-write-"));
    path = NodePath.join(directory, "mcode.db");
    db = openDatabase({ dbPath: path });
    seedThread(db);
    published = [];
    writer = new CanonicalParentTurnWrite(db, (events) => {
      published.push(events.map((event) => event.eventId));
    });
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("commits cloneable start, event checkpoint and terminal projection across a reload", async () => {
    const start = startInput();
    expect(() => structuredClone(start)).not.toThrow();
    expect(writer.start(start).outcome).toBe("committed");
    expect(writer.start(start).outcome).toBe("duplicate");

    const event = {
      eventId: `${EXECUTION_ID}:item-1`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, itemId: "item-1" },
      sourceProviderId: "codex",
      sourceIdentities: [],
      payload: {
        type: "item.recorded" as const,
        item: {
          id: "item-1",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          kind: "message" as const,
          providerIdentities: [],
          payload: { projection: "message", content: "Event" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    };
    expect(writer.append({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: [event] }).outcome)
      .toBe("committed");
    expect(writer.append({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: [event] }).outcome)
      .toBe("duplicate");

    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const finish = finishInput(staged);
    expect(() => structuredClone(finish)).not.toThrow();
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect((await writer.finish(finish)).outcome).toBe("terminal-outcome-confirmed");
    expect(published.flat()).toContain(`${EXECUTION_ID}:turn.completed`);

    db.close(true);
    db = openDatabase({ dbPath: path });
    const checkpoint = db.prepare("SELECT phase, terminal_outcome, last_accepted_sequence, last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID) as { phase: string; terminal_outcome: string; last_accepted_sequence: number; last_durable_sequence: number };
    expect(checkpoint).toMatchObject({ phase: "completed", terminal_outcome: "completed" });
    expect(checkpoint.last_accepted_sequence).toBe(checkpoint.last_durable_sequence);
    expect(checkpoint.last_accepted_sequence).toBeGreaterThan(4);
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, staged.id)).toMatchObject({ is_internal: false, outcome: "completed" });
  });

  it("rolls back a failed user-message projection with canonical start", () => {
    db.prepare("UPDATE threads SET user_completed_at = ? WHERE id = ?").run(NOW, THREAD_ID);
    db.run("CREATE TRIGGER fail_user_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message unavailable'); END");
    expect(() => writer.start({ ...startInput(), reopenThread: true })).toThrow("message unavailable");
    expect(db.prepare("SELECT user_completed_at FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({ user_completed_at: NOW });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
    expect(published).toEqual([]);
  });

  it("does not confirm a terminal checkpoint when assistant publication fails", async () => {
    writer.start(startInput());
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    db.run("CREATE TRIGGER fail_assistant_outcome BEFORE UPDATE OF outcome ON messages BEGIN SELECT RAISE(ABORT, 'outcome unavailable'); END");
    const finish = finishInput(staged);
    await expect(writer.finish(finish)).rejects.toThrow("outcome unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID).find((message) => message.id === staged.id))
      .toMatchObject({ is_internal: true, outcome: null });
    expect(published.flat()).not.toContain(`${EXECUTION_ID}:turn.completed`);

    db.run("DROP TRIGGER fail_assistant_outcome");
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, staged.id)).toMatchObject({ is_internal: false, outcome: "completed" });
  });
});
