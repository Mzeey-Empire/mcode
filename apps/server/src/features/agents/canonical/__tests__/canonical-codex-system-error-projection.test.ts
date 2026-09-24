import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentEvent } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { CodexLiveEventReducer } from "../../execution/codex-live-event-reducer.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalCodexSystemErrorProjection } from "../canonical-codex-system-error-projection.js";
import { CanonicalParentTurnWrite } from "../canonical-parent-turn-write.js";

const THREAD_ID = "thread-system-projection";
const TURN_ID = "turn-system-projection";
const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-24T10:00:00.000Z";
const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID };

function seedThread(db: Database): void {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("workspace-system-projection", "Workspace", "C:/fixture", NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD_ID, "workspace-system-projection", "Thread", "main", "codex", NOW, NOW);
  const turns = new CanonicalParentTurnWrite(db, () => {});
  expect(turns.start({
    thread: { id: THREAD_ID, workspaceId: "workspace-system-projection", providerId: "codex", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    providerIdentities: [],
    userMessage: { kind: "create", messageId: "user-system-projection", content: "Question", sequence: 1 },
  }).outcome).toBe("committed");
}

function boundSystem(subtype: string, extra: Partial<Extract<AgentEvent, { type: "system" }>> = {}): Extract<AgentEvent, { type: "system" }> {
  return { type: "system", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, subtype, ...extra };
}

describe("CanonicalCodexSystemErrorProjection", () => {
  let directory: string;
  let path: string;
  let db: Database;
  let projection: CanonicalCodexSystemErrorProjection;
  let reducer: CodexLiveEventReducer;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-codex-system-"));
    path = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath: path });
    seedThread(db);
    projection = new CanonicalCodexSystemErrorProjection(db);
    reducer = new CodexLiveEventReducer(execution);
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("persists turn-scoped notices with publication identity and rejects an unbound session event", () => {
    const session = boundSystem("provider.session.started", {
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session", sessionId: "session-1" },
    });
    const unbound = reducer.reduce({ ...session, turnExecutionId: undefined });
    expect(unbound).toMatchObject({ kind: "unsupported", eventType: "system" });
    expect(() => projection.project(unbound)).toThrow("Unsupported Codex event");
    expect(db.prepare("SELECT current_notice_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ current_notice_session_id: null });

    const sessionResult = projection.project(reducer.reduce(session));
    expect(sessionResult).toMatchObject({ kind: "system", event: { subtype: "provider.session.started" } });
    expect(db.prepare("SELECT current_notice_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ current_notice_session_id: "session-1" });
    expect(reducer.reduce({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID }).kind).toBe("reduced");

    const notice = boundSystem("provider.notice.unknown-event", {
      message: "Codex reported an update.",
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session",
        sessionId: "session-1", noticeKey: "notice-1" },
    });
    const reduction = reducer.reduce(notice);
    const first = projection.project(reduction);
    expect(first.kind).toBe("system");
    if (first.kind !== "system") return;
    expect(first.event.messageId).toBeDefined();
    if (!first.event.messageId) return;
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, first.event.messageId))
      .toMatchObject({ role: "system", content: "Codex reported an update." });
    expect(projection.project(reduction)).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND content = ?")
      .get(THREAD_ID, notice.message)).toEqual({ count: 1 });
    expect(structuredClone(first)).toEqual(first);

    db.close(true);
    db = openDatabase({ dbPath: path });
    expect(db.prepare("SELECT current_notice_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ current_notice_session_id: "session-1" });
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, first.event.messageId)).not.toBeNull();
  });

  it("persists a Codex cursor with canonical provenance and clears an invalidated cursor", () => {
    const unbound = reducer.reduce({ ...boundSystem("sdk_session_id:session-owned"), turnExecutionId: undefined });
    expect(unbound).toMatchObject({ kind: "unsupported", eventType: "system" });
    expect(() => projection.project(unbound)).toThrow("Unsupported Codex event");
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: null });

    expect(reducer.reduce({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID }).kind).toBe("reduced");
    const saved = projection.project(reducer.reduce(boundSystem("sdk_session_id:native-thread")));
    expect(saved).toMatchObject({ kind: "system", event: { subtype: "sdk_session_id:native-thread" } });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: "native-thread" });
    expect(new CanonicalAgentBoundary(db, () => {}).loadCheckpoint(EXECUTION_ID))
      .toMatchObject({ nativeCursor: { providerId: "codex", scope: "thread", value: "native-thread", provenance: "native" } });
    expect(projection.project(reducer.reduce(boundSystem("sdk_session_invalidated")))).toMatchObject({ kind: "system" });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: null });

    db.prepare("UPDATE canonical_agent_ingest_checkpoints SET terminal_outcome = 'completed' WHERE execution_id = ?")
      .run(EXECUTION_ID);
    expect(() => projection.project(reducer.reduce(boundSystem("sdk_session_id:late-thread"))))
      .toThrow("could not be persisted");
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: null });
  });

  it("returns cloneable error terminal input without publishing or terminalizing early", () => {
    expect(reducer.reduce({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID }).kind).toBe("reduced");
    expect(reducer.reduce({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      delta: "Partial answer", isFinalResponse: true }).kind).toBe("reduced");
    const reduction = reducer.reduce({ type: "error", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, error: "Provider failed" });
    expect(() => projection.project(reduction)).toThrow("end time");
    const result = projection.project(reduction, NOW);
    expect(result).toMatchObject({ kind: "error-terminal", event: { error: "Provider failed" }, after: "terminal",
      input: { threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "errored", assistant: { content: "Partial answer" } } });
    expect(structuredClone(result)).toEqual(result);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    if (result.kind !== "error-terminal") return;
    const staged = new CanonicalParentTurnWrite(db, () => {}).stageTerminalProjection(result.input);
    expect(staged.messageId).toBeDefined();
    if (!staged.messageId) return;
    expect(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, staged.messageId))
      .toMatchObject({ content: "Partial answer", is_internal: true });
  });
});
