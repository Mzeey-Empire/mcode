import "reflect-metadata";
import type { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AcceptedCanonicalAgentEventEnvelopeSchema,
  createAgentModelState,
  reduceAgentEventBatch,
  type AcceptedCanonicalAgentEventEnvelope,
  type AgentModelState,
  type CanonicalAgentEvent,
} from "@mcode/contracts/compat/agent-model";
import { openDatabase, openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { MessageStore as MessageRepo } from "../../conversation/persistence/message-store.js";
import { CanonicalAgentStore } from "../canonical-agent-store.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const EPOCH = "content-tail-epoch";
const NOW = "2026-10-29T12:00:00.000Z";
const ANSWER_ID = `assistant-response-text:${EXECUTION_ID}`;
const CACHE_MODES = [{ cache: true }, { cache: false }] as const;

function seedThread(db: Database): void {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("workspace-1", "Workspace", "C:/workspace", NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD_ID, "workspace-1", "Thread", "main", "codex", NOW, NOW);
}

function newStore(db: Database, cache: boolean): CanonicalAgentStore {
  return new CanonicalAgentStore(db, () => {}, { contentTail: { cache } });
}

function startParent(store: CanonicalAgentStore, db: Database): void {
  const messages = new MessageRepo(db);
  store.startParentTurn({
    thread: { id: THREAD_ID, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    providerIdentities: [],
    projectUserMessage: () => messages.create(THREAD_ID, "user", "write an answer", 1),
  });
}

function answer(content: string, isStreaming = true, itemId = ANSWER_ID): CanonicalAgentEvent {
  return { type: "item.recorded", item: { id: itemId, threadId: THREAD_ID, turnId: TURN_ID, kind: "message",
    providerIdentities: [], payload: { projection: "assistantText", content, isStreaming }, createdAt: NOW, updatedAt: NOW } };
}

function append(offset: number, text: string, updatedAt = NOW): CanonicalAgentEvent {
  return { type: "item.content-appended", offset, text, updatedAt };
}

function acceptedEvents(store: CanonicalAgentStore, payloads: readonly CanonicalAgentEvent[], itemId = ANSWER_ID): AcceptedCanonicalAgentEventEnvelope[] {
  const last = store.loadCheckpoint(EXECUTION_ID)?.lastAcceptedSequence ?? 0;
  return payloads.map((payload, index) => AcceptedCanonicalAgentEventEnvelopeSchema.parse({
    eventId: `content-tail-${last + index + 1}`,
    routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      ...(payload.type === "item.recorded" || payload.type === "item.content-appended" ? { itemId } : {}) },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence: last + index + 1,
    progressPosition: { epoch: EPOCH, sequence: last + index + 1 },
    serverTimestamps: { acceptedAt: NOW },
    payload,
  }));
}

function commit(store: CanonicalAgentStore, db: Database, events: readonly AcceptedCanonicalAgentEventEnvelope[]): void {
  db.transaction(() => store.appendAcceptedInsideTransaction({ threadId: THREAD_ID, turnId: TURN_ID,
    executionId: EXECUTION_ID, phase: "running", events }))();
}

function accept(store: CanonicalAgentStore, db: Database, payloads: readonly CanonicalAgentEvent[], itemId = ANSWER_ID): AcceptedCanonicalAgentEventEnvelope[] {
  const events = acceptedEvents(store, payloads, itemId);
  commit(store, db, events);
  return events;
}

function tailRows(db: Database, itemId = ANSWER_ID): Array<{ offset: number; text: string }> {
  return (db.prepare(`SELECT "offset" AS "offset", text_json AS textJson FROM canonical_agent_item_content_appends
    WHERE item_id = ? ORDER BY "offset"`).all(itemId) as Array<{ offset: number; textJson: string }>)
    .map((row) => ({ offset: row.offset, text: JSON.parse(row.textJson) as string }));
}

function storedRowContent(db: Database, itemId = ANSWER_ID): unknown {
  const row = db.prepare("SELECT payload_json AS payloadJson FROM canonical_agent_items WHERE id = ?").get(itemId) as { payloadJson: string };
  return (JSON.parse(row.payloadJson) as { content?: unknown }).content;
}

function recordItemWrites(db: Database): () => number {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS observed_item_writes (item_id TEXT NOT NULL);
    DELETE FROM observed_item_writes;
    CREATE TEMP TRIGGER IF NOT EXISTS observed_item_insert AFTER INSERT ON main.canonical_agent_items
      BEGIN INSERT INTO observed_item_writes VALUES (NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS observed_item_update AFTER UPDATE ON main.canonical_agent_items
      BEGIN INSERT INTO observed_item_writes VALUES (NEW.id); END;`);
  return () => (db.prepare("SELECT COUNT(*) AS count FROM observed_item_writes WHERE item_id = ?").get(ANSWER_ID) as { count: number }).count;
}

function finishInput(db: Database): Parameters<CanonicalAgentStore["finishParentTurnBatched"]>[0] {
  const messages = new MessageRepo(db);
  const message = messages.create(THREAD_ID, "assistant", "Partial", 2, undefined, undefined, undefined, undefined, true);
  return {
    threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex", providerIdentities: [], outcome: "completed",
    projectTurn: () => ({ message: { ...message, is_internal: false }, narrative: [] }),
    finalizeCompatibility: () => messages.publishAssistant(message.id),
  };
}

describe.each(CACHE_MODES)("canonical item content tail (writer cache $cache)", ({ cache }) => {
  let db: Database;
  let store: CanonicalAgentStore;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    store = newStore(db, cache);
    startParent(store, db);
    accept(store, db, [answer("Part")]);
  });

  afterEach(() => db.close(true));

  it("extends an answer with one tail row and leaves its item row alone", () => {
    const itemWrites = recordItemWrites(db);

    accept(store, db, [append(4, "ial")]);

    expect(itemWrites()).toBe(0);
    expect(tailRows(db)).toEqual([{ offset: 4, text: "ial" }]);
    expect(store.loadItem(ANSWER_ID)?.payload.content).toBe("Partial");
    expect(newStore(db, cache).loadItem(ANSWER_ID)?.payload.content).toBe("Partial");
  });

  it("writes an item once and clears its tail when one batch both replaces and appends to it", () => {
    accept(store, db, [append(4, "ial")]);
    const itemWrites = recordItemWrites(db);

    accept(store, db, [append(7, "ly"), answer("Partially", false), append(9, "!")]);

    expect(itemWrites()).toBe(1);
    expect(tailRows(db)).toEqual([]);
    expect(storedRowContent(db)).toBe("Partially!");
    expect(store.loadItem(ANSWER_ID)?.payload).toEqual({ projection: "assistantText", content: "Partially!", isStreaming: false });
  });

  it("folds the tail into the row when the response binds", () => {
    accept(store, db, [append(4, "ial")]);

    accept(store, db, [{ type: "turn.response-bound", messageId: "message-1", outcome: "completed", endedAt: NOW }]);

    expect(tailRows(db)).toEqual([]);
    expect(storedRowContent(db)).toBe("Partial");
    expect(newStore(db, cache).loadItem(ANSWER_ID)?.payload.content).toBe("Partial");
  });

  it.each([
    { path: "finishParentTurn", finish: (target: CanonicalAgentStore, input: ReturnType<typeof finishInput>) => target.finishParentTurn(input) },
    { path: "finishParentTurnBatched", finish: (target: CanonicalAgentStore, input: ReturnType<typeof finishInput>) => target.finishParentTurnBatched(input) },
  ])("folds the tail into the row when $path closes the turn", async ({ finish }) => {
    accept(store, db, [append(4, "ial")]);

    await finish(store, finishInput(db));

    expect(store.loadCheckpoint(EXECUTION_ID)?.terminalOutcome).toBe("completed");
    expect(tailRows(db)).toEqual([]);
    expect(storedRowContent(db)).toBe("Partial");
  });

  it.each([
    { failure: "after the tail insert", inject: (target: Database, run: () => void) => {
      target.exec(`CREATE TEMP TRIGGER injected_event_failure BEFORE INSERT ON main.canonical_agent_events
        BEGIN SELECT RAISE(ABORT, 'injected failure after the tail insert'); END;`);
      try {
        run();
      } finally {
        target.exec("DROP TRIGGER temp.injected_event_failure");
      }
    } },
    { failure: "after the event insert", inject: (target: Database, run: () => void) => {
      target.transaction(() => {
        run();
        throw new Error("injected failure before the receipt commits");
      })();
    } },
  ])("keeps one logical append after a rollback $failure and one retry", ({ inject }) => {
    const events = acceptedEvents(store, [append(4, "ial")]);

    expect(() => inject(db, () => commit(store, db, events))).toThrow(/injected failure/);
    const reloaded = newStore(db, cache);
    expect(reloaded.loadItem(ANSWER_ID)?.payload.content).toBe("Part");
    expect(tailRows(db)).toEqual([]);

    commit(reloaded, db, events);

    expect(newStore(db, cache).loadItem(ANSWER_ID)?.payload.content).toBe("Partial");
    expect(tailRows(db)).toEqual([{ offset: 4, text: "ial" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE event_id = ?").get(events[0]!.eventId)).toEqual({ count: 1 });
    accept(store, db, [append(7, "ly")]);
    expect(newStore(db, cache).loadItem(ANSWER_ID)?.payload.content).toBe("Partially");
  });

  it("rejects a tail that does not extend its row instead of returning truncated text", () => {
    accept(store, db, [append(4, "ial")]);
    db.prepare(`UPDATE canonical_agent_item_content_appends SET "offset" = 5 WHERE item_id = ?`).run(ANSWER_ID);

    expect(() => newStore(db, cache).loadItem(ANSWER_ID)).toThrow("content tail does not match its row");
  });
});

describe("canonical item content tail bytes", () => {
  function appendedBytes(prefix: string): { tail: number; event: number } {
    const db = openMemoryDatabase();
    try {
      seedThread(db);
      const store = newStore(db, true);
      startParent(store, db);
      accept(store, db, [answer(prefix)]);
      const [event] = accept(store, db, [append(prefix.length, "next words")]);
      return {
        tail: (db.prepare("SELECT SUM(length(CAST(text_json AS BLOB))) AS bytes FROM canonical_agent_item_content_appends").get() as { bytes: number }).bytes,
        event: (db.prepare("SELECT length(CAST(envelope_json AS BLOB)) AS bytes FROM canonical_agent_events WHERE event_id = ?").get(event!.eventId) as { bytes: number }).bytes,
      };
    } finally {
      db.close(true);
    }
  }

  it("stores an equal delta in the same bytes on a short and a long answer", () => {
    const short = "Part";
    const long = "x".repeat(100_000);

    const shortBytes = appendedBytes(short);
    const longBytes = appendedBytes(long);

    expect(longBytes.tail).toBe(shortBytes.tail);
    expect(longBytes.event - shortBytes.event).toBe(String(long.length).length - String(short.length).length);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CODE_POINTS = ["a", "b", " ", "\n", "é", "\u{1F600}", "\u{1F680}", "z"];

function randomText(random: () => number, codePoints: number): string {
  return Array.from({ length: codePoints }, () => CODE_POINTS[Math.floor(random() * CODE_POINTS.length)]).join("");
}

class RandomAnswerStream {
  content = "";
  private source: string;
  private cursor = 0;

  constructor(private readonly random: () => number, private readonly itemId: string) {
    this.source = randomText(random, 400);
  }

  next(batch: number): CanonicalAgentEvent | null {
    const roll = this.random();
    if (roll < 0.8) return this.append(batch);
    if (roll < 0.87) return this.replace("");
    if (roll < 0.94) return answer(this.content, false, this.itemId);
    this.source = randomText(this.random, 400);
    this.cursor = 0;
    return this.replace(`Corrected ${randomText(this.random, 3)}`);
  }

  private replace(content: string): CanonicalAgentEvent {
    this.content = content;
    return answer(content, true, this.itemId);
  }

  private append(batch: number): CanonicalAgentEvent | null {
    const text = this.source.slice(this.cursor, this.cursor + 1 + Math.floor(this.random() * 5));
    if (text.length === 0) return null;
    const event = append(this.content.length, text, `2026-10-29T12:${String(batch).padStart(2, "0")}:00.000Z`);
    this.content += text;
    this.cursor += text.length;
    return event;
  }
}

describe.each(CACHE_MODES)("canonical item content tail property (writer cache $cache)", ({ cache }) => {
  let directory: string;
  let db: Database;
  let reader: Database;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-content-tail-"));
    const path = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath: path });
    seedThread(db);
    reader = openReadOnlyDatabase(path);
  });

  afterEach(() => {
    reader.close(true);
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("agrees with the reducer, its own fold, and a fresh reader after every batch of random chunkings", () => {
    const store = newStore(db, cache);
    startParent(store, db);
    for (let seed = 1; seed <= 8; seed += 1) {
      const random = mulberry32(seed);
      const itemId = `answer-${seed}`;
      let reduced: AgentModelState = createAgentModelState();
      const stream = new RandomAnswerStream(random, itemId);
      const step = (payloads: CanonicalAgentEvent[]) => {
        const events = accept(store, db, payloads, itemId);
        const reduction = reduceAgentEventBatch(reduced, events);
        if (reduction.outcome !== "applied") throw new Error(`seed ${seed}: reducer rejected ${reduction.eventId}`);
        reduced = reduction.state;
        const expected = reduced.items[itemId];
        expect(store.loadItem(itemId), `seed ${seed} store`).toEqual(expected);
        expect(new CanonicalAgentStore(reader, () => {}).loadItem(itemId), `seed ${seed} fresh reader`).toEqual(expected);
        expect(expected?.payload.content).toBe(stream.content);
      };
      step([answer("", true, itemId)]);
      for (let batch = 0; batch < 25; batch += 1) {
        const operations = 1 + Math.floor(random() * 4);
        const payloads = Array.from({ length: operations }, () => stream.next(batch))
          .filter((payload): payload is CanonicalAgentEvent => payload !== null);
        if (payloads.length > 0) step(payloads);
      }
    }
  });
});
