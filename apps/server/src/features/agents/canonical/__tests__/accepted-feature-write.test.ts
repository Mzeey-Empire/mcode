import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { type PlanVersion } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadStore as ThreadRepo } from "../../../thread-control/persistence/thread-store.js";
import { PlanStore as PlanRepo } from "../../planning/persistence/plan-store.js";
import { AcceptedFeatureWriteMetadataSchema, persistAcceptedFeatureWrite } from "../accepted-feature-write.js";

const THREAD = "feature-thread";
const FOREIGN = "foreign-thread";
const STARTED_AT = "2026-09-30T10:00:00.000Z";
const ACCEPTED_AT = "2026-09-30T11:02:03.125+01:00";

function plan(overrides: Partial<PlanVersion> = {}): PlanVersion {
  return { id: "00000000-0000-4000-8000-000000000001", threadId: THREAD, messageId: "assistant-1", version: 7,
    title: "Assigned plan", contentMd: "# Assigned plan\n## Build\nUse passkeys.",
    author: "agent", providerId: "codex", captureSource: "fence", baseVersionId: null,
    revision: 0, acceptedAt: null, acceptedMessageId: null,
    status: "ready", createdAt: ACCEPTED_AT, updatedAt: ACCEPTED_AT, ...overrides };
}

function seedMessage(db: Database, id: string, role = "assistant", threadId = THREAD, systemNotice = false): void {
  db.prepare(`INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, is_internal, system_notice)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, threadId, role, `Body for ${id}`, STARTED_AT, 1, role === "assistant" ? 1 : 0,
    systemNotice ? JSON.stringify({ kind: "warning", presentation: "timeline", scope: "session", sessionId: "old-session", noticeKey: id }) : null);
}

describe("persistAcceptedFeatureWrite", () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDatabase();
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("feature-workspace", "Workspace", "C:/fixture", STARTED_AT, STARTED_AT);
    for (const id of [THREAD, FOREIGN]) {
      db.prepare(`INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at,
        last_context_tokens, context_window, sdk_session_id, current_notice_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, "feature-workspace", id, "main", "codex", STARTED_AT, STARTED_AT,
        10, 1000, "unchanged-sdk-cursor", "old-session");
    }
    seedMessage(db, "assistant-1");
    seedMessage(db, "assistant-2");
    seedMessage(db, "foreign-assistant", "assistant", FOREIGN);
    seedMessage(db, "user-1", "user");
    seedMessage(db, "notice-1", "system", THREAD, true);
    seedMessage(db, "notice-2", "system", THREAD, true);
    seedMessage(db, "foreign-notice", "system", FOREIGN, true);
    seedMessage(db, "plain-system", "system");
  });

  afterEach(() => db.close(true));

  it("persists the supplied plan identity/version/time and internal assistant linkage, including exact replay", () => {
    const assigned = plan();
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [assigned] });
    expect(new PlanRepo(db).getById(assigned.id)).toEqual(assigned);
    expect(new PlanRepo(db).getByMessageId("assistant-1")).toEqual(assigned);
    expect(db.prepare("SELECT is_internal FROM messages WHERE id = ?").get("assistant-1")).toEqual({ is_internal: 1 });
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [assigned] });
    expect(new PlanRepo(db).listByThread(THREAD)).toEqual([assigned]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM plans").get()).toEqual({ count: 1 });
  });

  it("updates only supplied plan status rows and preserves assigned content/version/time", () => {
    const previous = plan();
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [previous] });
    const next = plan({ id: "00000000-0000-4000-8000-000000000002", messageId: "assistant-2", version: 8,
      createdAt: "2026-09-30T11:02:04.125+01:00" });
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [{ ...previous, status: "superseded" }, next] });
    expect(new PlanRepo(db).getById(previous.id)).toEqual({ ...previous, status: "superseded" });
    expect(new PlanRepo(db).getById(next.id)).toEqual(next);
    expect(new PlanRepo(db).listByThread(FOREIGN)).toEqual([]);
  });

  it("rejects conflicting immutable plan fields and rolls back other feature writes", () => {
    const assigned = plan();
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [assigned] });
    for (const change of [{ title: "Conflicting" }, { contentMd: "Conflicting" }, { version: 9 },
      { messageId: "assistant-2" }, { createdAt: STARTED_AT }]) {
      expect(() => persistAcceptedFeatureWrite(db, THREAD, { threadPatch: { contextTokensUsed: 900 },
        noticeSession: { sessionId: "must-rollback" }, planRecords: [{ ...assigned, ...change }] })).toThrow("conflicting content");
    }
    expect(new PlanRepo(db).getById(assigned.id)).toEqual(assigned);
    expect(db.prepare("SELECT last_context_tokens, current_notice_session_id FROM threads WHERE id = ?").get(THREAD))
      .toEqual({ last_context_tokens: 10, current_notice_session_id: "old-session" });
  });

  it("requires a materialized same-thread assistant and rejects foreign plan routing, version collisions, and duplicate message bindings", () => {
    for (const messageId of ["not-yet-materialized", "foreign-assistant", "user-1"]) {
      expect(() => persistAcceptedFeatureWrite(db, THREAD, { planRecords: [plan({ messageId })] })).toThrow("materialized assistant");
    }
    expect(() => persistAcceptedFeatureWrite(db, THREAD, { planRecords: [plan({ threadId: FOREIGN, messageId: "foreign-assistant" })] })).toThrow("another thread");
    const assigned = plan();
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [assigned] });
    expect(() => persistAcceptedFeatureWrite(db, THREAD, { planRecords: [plan({ id: "00000000-0000-4000-8000-000000000002", messageId: "assistant-2" })] })).toThrow("version has conflicting identity");
    expect(() => persistAcceptedFeatureWrite(db, THREAD, { planRecords: [plan({ id: "00000000-0000-4000-8000-000000000002", version: 8 })] })).toThrow("assistant already has another plan");
    expect(new PlanRepo(db).listByThread(THREAD)).toEqual([assigned]);
  });

  it("preserves existing context-window semantics and persists the exact compaction summary", () => {
    persistAcceptedFeatureWrite(db, THREAD, { threadPatch: { contextTokensUsed: 800, compactSummary: "Accepted compacted context" } });
    expect(new ThreadRepo(db).findById(THREAD)).toMatchObject({ last_context_tokens: 800, context_window: 1000,
      last_compact_summary: "Accepted compacted context", sdk_session_id: "unchanged-sdk-cursor" });
    persistAcceptedFeatureWrite(db, THREAD, { threadPatch: { contextTokensUsed: 900, contextWindow: 2000, compactSummary: "" } });
    expect(new ThreadRepo(db).findById(THREAD)).toMatchObject({ last_context_tokens: 900, context_window: 2000, last_compact_summary: "" });
    expect(new ThreadRepo(db).findById(FOREIGN)).toMatchObject({ last_context_tokens: 10, context_window: 1000 });
  });

  it("persists session selection and serialized clearing without deleting unlisted notices or changing SDK cursors", () => {
    persistAcceptedFeatureWrite(db, THREAD, { noticeSession: { sessionId: "selected-session" } });
    expect(db.prepare("SELECT current_notice_session_id FROM threads WHERE id = ?").get(THREAD)).toEqual({ current_notice_session_id: "selected-session" });
    const clear = AcceptedFeatureWriteMetadataSchema().parse(JSON.parse(JSON.stringify({ noticeSession: { sessionId: null } })));
    persistAcceptedFeatureWrite(db, THREAD, clear);
    expect(db.prepare("SELECT current_notice_session_id, sdk_session_id FROM threads WHERE id = ?").get(THREAD))
      .toEqual({ current_notice_session_id: null, sdk_session_id: "unchanged-sdk-cursor" });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("notice-1")).toEqual({ id: "notice-1" });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("foreign-notice")).toEqual({ id: "foreign-notice" });
  });

  it("expires only exact system notice IDs and treats an already deleted notice as an idempotent replay", () => {
    persistAcceptedFeatureWrite(db, THREAD, { expiredNoticeMessageIds: ["notice-1"] });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("notice-1")).toBeNull();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("notice-2")).toEqual({ id: "notice-2" });
    persistAcceptedFeatureWrite(db, THREAD, { expiredNoticeMessageIds: ["notice-1"] });
    for (const id of ["assistant-1", "user-1", "plain-system"]) {
      expect(() => persistAcceptedFeatureWrite(db, THREAD, { expiredNoticeMessageIds: [id] })).toThrow("not a system notice");
      expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(id)).toEqual({ id });
    }
    expect(() => persistAcceptedFeatureWrite(db, THREAD, { expiredNoticeMessageIds: ["foreign-notice"] })).toThrow("another thread");
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("foreign-notice")).toEqual({ id: "foreign-notice" });
  });

  it("rolls back notice expiry, context and selection when SQLite fails the assigned plan write, then retries with the same identity", () => {
    db.run("CREATE TRIGGER fail_feature_plan BEFORE INSERT ON plans BEGIN SELECT RAISE(ABORT, 'feature plan unavailable'); END");
    const metadata = { threadPatch: { contextTokensUsed: 900 }, noticeSession: { sessionId: "new-session" },
      expiredNoticeMessageIds: ["notice-1"], planRecords: [plan()] };
    expect(() => persistAcceptedFeatureWrite(db, THREAD, metadata)).toThrow("feature plan unavailable");
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("notice-1")).toEqual({ id: "notice-1" });
    expect(db.prepare("SELECT last_context_tokens, current_notice_session_id FROM threads WHERE id = ?").get(THREAD))
      .toEqual({ last_context_tokens: 10, current_notice_session_id: "old-session" });
    expect(new PlanRepo(db).listByThread(THREAD)).toEqual([]);
    db.run("DROP TRIGGER fail_feature_plan");
    persistAcceptedFeatureWrite(db, THREAD, metadata);
    expect(new PlanRepo(db).getById(plan().id)).toEqual(plan());
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("notice-1")).toBeNull();
  });

  it("validates metadata schema, counts, bytes and routing at the worker boundary", () => {
    for (const metadata of [
      { threadPatch: { contextWindow: 2000 } }, { threadPatch: { contextTokensUsed: -1 } },
      { threadPatch: { contextTokensUsed: 1.5 } }, { noticeSession: { sessionId: "x".repeat(65) } },
      { noticeSessionId: undefined }, { providerEffect: "must not run" },
      { planRecords: [plan({ threadId: ` ${THREAD} ` })] },
      { expiredNoticeMessageIds: ["notice-1", "notice-1"] }, { planRecords: [plan(), plan()] },
      { expiredNoticeMessageIds: Array.from({ length: 8_193 }, (_, index) => String(index)) },
      { planRecords: Array.from({ length: 257 }, (_, index) => plan({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: index + 1 })) },
      { planRecords: Array.from({ length: 33 }, (_, index) => plan({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: index + 1, contentMd: "x".repeat(64 * 1024) })) },
      { threadPatch: { compactSummary: "x".repeat(2 * 1024 * 1024) } },
    ]) {
      expect(AcceptedFeatureWriteMetadataSchema().safeParse(metadata).success).toBe(false);
      expect(() => persistAcceptedFeatureWrite(db, THREAD, metadata)).toThrow();
    }
    expect(() => persistAcceptedFeatureWrite(db, "missing-thread", {})).toThrow("thread is missing");
    expect(() => persistAcceptedFeatureWrite(db, ` ${THREAD} `, {})).toThrow("altered thread identity");
    expect(new PlanRepo(db).listByThread(THREAD)).toEqual([]);
  });

  it("retains maximum-length plan content and larger compaction summaries within the aggregate budget", () => {
    const legacy = plan({ contentMd: "x".repeat(64 * 1024) });
    persistAcceptedFeatureWrite(db, THREAD, { planRecords: [legacy], threadPatch: { compactSummary: "s".repeat(300 * 1024) } });
    expect(new PlanRepo(db).getById(legacy.id)).toEqual(legacy);
    expect(new ThreadRepo(db).findById(THREAD)?.last_compact_summary).toBe("s".repeat(300 * 1024));
  });
});
