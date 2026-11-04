import type { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { recordingFileId, type DiagRecord } from "@mcode/shared/diagnostics";
import { openMigratedTestDatabase } from "../../../persistence/sqlite/testing/migrated-test-database.js";
import { loadEvidence } from "../sources.js";
import { findAnomalies } from "../anomalies.js";
import { renderText } from "../render.js";
import type { DiagQuery } from "../model.js";

const WINDOW_START = 1000;
const WINDOW_END = 200_000;

describe("diagnostics reader", () => {
  let dir: string;
  let q: DiagQuery;

  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-reader-"));
    NodeFS.mkdirSync(NodePath.join(dir, "diagnostics/t"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(dir, "diagnostics/p"), { recursive: true });
    q = { dataDir: dir, noDb: true, since: WINDOW_START, until: WINDOW_END, limit: 400 };
  });

  afterEach(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function recordingPath(folder: "t" | "p", name: string): string {
    return NodePath.join(dir, "diagnostics", folder, name);
  }

  function writeLines(file: string, rows: DiagRecord[]): void {
    NodeFS.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  }

  function write(threadId: string, rows: DiagRecord[]): void {
    writeLines(recordingPath("t", recordingFileId(threadId) + ".jsonl"), rows);
  }

  function begin(threadId: string, channel = "approval", budgetMs: number | null = null): DiagRecord {
    return { t: 2000, n: 1, th: threadId, k: "beg", ch: channel, sp: "request", exp: budgetMs };
  }

  function render(): string {
    const evidence = loadEvidence(q);
    return renderText(evidence, findAnomalies(evidence, q), q);
  }

  function recordedThreadIds(): string[] {
    const evidence = loadEvidence(q);
    const ids = evidence.records.flatMap((record) => (record.th ? [record.th] : []));
    return [...new Set(ids)].sort();
  }

  it("distinguishes a human wait from an overdue action and sorts the summary", () => {
    write("waiting", [begin("waiting")]);
    write("stuck", [begin("stuck", "agent.send", 30_000)]);

    const evidence = loadEvidence(q);
    const findings = findAnomalies(evidence, q);

    expect(findings.map((f) => [f.thread, f.rule, f.certainty]).sort()).toEqual([
      ["stuck", "open-span", "observed"],
      ["waiting", "waiting", "waiting"],
    ]);
    const text = renderText(evidence, findings, q);
    expect(text.indexOf("stuck  unknown")).toBeLessThan(text.indexOf("waiting  unknown"));
    expect(text).not.toContain("TIMELINE");
  });

  it("keeps the newest rows when the timeline exceeds the limit, timed from the first shown row", () => {
    const pushes: DiagRecord[] = Array.from({ length: 5 }, (_, i) => ({
      t: 5000 + i * 100, n: i + 1, th: "a", k: "ev", ch: "push.canonical", d: { events: i },
    }));
    write("a", [
      ...pushes,
      { t: 6000, n: 6, th: "a", k: "beg", ch: "agent.stop", sp: "stop", exp: 10_000 },
      { t: 6250, n: 7, th: "a", k: "end", ch: "agent.stop", sp: "stop", ok: "ok", ms: 250 },
    ]);
    q.thread = "a";
    q.limit = 3;

    const text = render();

    expect(text).toContain("(7 rows; 4 earlier rows elided)");
    expect(text).toContain("L5 +0ms A ev push.canonical");
    expect(text).toContain("L7 +850ms A end agent.stop#stop ok 250ms");
    expect(text).not.toContain('{"events":0}');
  });

  it("names the recording state of each run marker in the timeline", () => {
    write("a", [
      { t: 2000, n: 1, k: "run", ch: "diag", run: "r1", pid: 1, state: "off", th: "a" },
      { t: 3000, n: 2, k: "run", ch: "diag", run: "r1", pid: 1, state: "on", th: "a" },
    ]);
    q.thread = "a";

    const text = render();

    expect(text).toContain("L1 +0ms A recording off run=r1");
    expect(text).toContain("L2 +1000ms A recording on run=r1");
  });

  it("marks a quiet gap as unrecorded when the process switched recording off during it", () => {
    write("a", [
      { t: 2000, n: 1, th: "a", k: "ev", ch: "agent.created" },
      { t: 60_000, n: 9, th: "a", k: "ev", ch: "agent.created" },
    ]);
    writeLines(recordingPath("p", "run.jsonl"), [
      { t: 30_000, n: 5, k: "run", ch: "diag", run: "r2", pid: 1, state: "off" },
    ]);
    q.thread = "a";

    const text = render();

    expect(text).toContain("---- 58s quiet on A (recording off at 1970-01-01T00:00:30.000Z) ----");
  });

  it("pairs begins outside the window and recognizes completed slow spans", () => {
    write("a", [
      begin("a", "agent.send", 30_000),
      { t: 50_000, n: 2, th: "a", k: "end", ch: "agent.send", sp: "request", ok: "ok", ms: 48_000 },
    ]);
    q.since = 10_000;

    const findings = findAnomalies(loadEvidence(q), q);

    expect(findings.map((f) => f.rule)).toEqual(["slow-span"]);
  });

  it.each(["off", "dropped", "on"] as const)("reports incomplete coverage after %s", (state) => {
    const laterRun = state === "on" ? "new" : "old";
    write("a", [
      { t: 1000, n: 0, k: "run", ch: "diag", run: "old", pid: 1, state: "on", th: "a" },
      begin("a", "agent.send", 30_000),
      { t: 3000, n: 2, k: "run", ch: "diag", run: laterRun, pid: 1, state, th: "a" },
    ]);

    const findings = findAnomalies(loadEvidence(q), q);

    expect(findings.map((f) => [f.rule, f.certainty])).toEqual([["incomplete", "incomplete"]]);
  });

  it("reports a stale nonterminal checkpoint unless recording was switched off", () => {
    write("a", [begin("a")]);
    const evidence = loadEvidence(q);
    evidence.threads[0].checkpoint = { phase: "streaming", terminal: null, updated: 2000 };

    const stalls = findAnomalies(evidence, q).filter((f) => f.rule === "stall");
    expect(stalls.map((f) => f.certainty)).toEqual(["observed"]);

    evidence.records.push({ t: 3000, n: 2, k: "run", ch: "diag", run: "one", pid: 1, state: "off" });
    expect(findAnomalies(evidence, q).filter((f) => f.rule === "stall")).toEqual([]);
  });

  it("continues reading when the canonical DB is missing", () => {
    write("a", [begin("a")]);
    q = { ...q, noDb: false, dbPath: NodePath.join(dir, "missing.db"), thread: "a" };

    const text = render();

    expect(text).toContain("canonical DB: missing");
    expect(text).toContain("A beg approval");
  });

  describe("scoped reads", () => {
    it("opens only the named thread's current and rotated files for --thread", () => {
      write("a", [begin("a")]);
      write("b", [begin("b")]);
      writeLines(recordingPath("t", "a.1.jsonl"), [{ ...begin("a"), t: 1500, n: 0, sp: "older" }]);
      q = { ...q, thread: "a" };

      expect(recordedThreadIds()).toEqual(["a"]);
      const text = render();
      expect(text).toContain("older");
      expect(text).not.toContain("B=");
    });

    it("never builds a file path from raw query text", () => {
      NodeFS.writeFileSync(
        NodePath.join(dir, "diagnostics", "outside.jsonl"),
        JSON.stringify({ ...begin("outside") }),
      );
      q = { ...q, thread: "../outside" };

      expect(recordedThreadIds()).toEqual([]);
    });

    it("keeps process records for a thread query", () => {
      write("a", [begin("a")]);
      writeLines(recordingPath("p", "run.jsonl"), [
        { t: 1500, n: 0, k: "run", ch: "diag", run: "one", pid: 1, state: "on" },
      ]);
      q = { ...q, thread: "a" };

      const evidence = loadEvidence(q);

      expect(evidence.records.filter((record) => record.k === "run")).toHaveLength(1);
    });

    it("reads only files modified since the window opened when no scope is given", () => {
      write("recent", [begin("recent")]);
      write("stale", [begin("stale")]);
      NodeFS.utimesSync(recordingPath("t", "stale.jsonl"), 0, 0);

      expect(recordedThreadIds()).toEqual(["recent"]);
    });
  });

  describe("with a canonical database", () => {
    let db: Database;
    let dbPath: string;

    beforeEach(() => {
      dbPath = NodePath.join(dir, "app.sqlite");
      db = openMigratedTestDatabase(dbPath);
      q = { ...q, noDb: false, dbPath };
    });

    afterEach(() => {
      db.close(true);
    });

    function seedWorkspace(id: string): void {
      const workspace = createMockWorkspace({ id, path: dir });
      db.run("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)", [id, workspace.name, id + dir]);
    }

    function seedThread(id: string, workspaceId: string): void {
      const thread = createMockThread({ id, workspaceId });
      db.run("INSERT INTO threads (id, workspace_id, title, branch) VALUES (?, ?, ?, ?)", [
        id,
        workspaceId,
        thread.title,
        thread.branch,
      ]);
    }

    function seedCanonicalThread(id: string, workspaceId: string): void {
      const stamp = new Date(WINDOW_START).toISOString();
      db.run(
        `INSERT INTO canonical_agent_threads
           (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
         VALUES (?, ?, ?, 'codex', 'idle', ?, ?)`,
        [id, workspaceId, id, stamp, stamp],
      );
      db.run(
        `INSERT INTO canonical_agent_turns
           (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, 'running', '{}', 'default', ?, ?)`,
        ["turn-" + id, id, "exec-" + id, stamp, stamp],
      );
    }

    function seedCheckpoint(threadId: string, updatedAt: number): void {
      db.run(
        `INSERT INTO canonical_agent_ingest_checkpoints
           (execution_id, thread_id, turn_id, last_accepted_sequence, last_durable_sequence, phase, updated_at)
         VALUES (?, ?, ?, 0, 0, 'streaming', ?)`,
        ["exec-" + threadId, threadId, "turn-" + threadId, new Date(updatedAt).toISOString()],
      );
    }

    function seedEvent(threadId: string, sequence: number, acceptedAt: number): void {
      const stamp = new Date(acceptedAt).toISOString();
      db.run(
        `INSERT INTO canonical_agent_events
           (event_id, thread_id, execution_id, accepted_sequence, durable_revision, envelope_json, accepted_at, persisted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`event-${threadId}-${sequence}`, threadId, "exec-" + threadId, sequence, sequence, '{"payload":{"type":"textDelta"}}', stamp, stamp],
      );
    }

    function seedActiveThread(id: string, workspaceId: string): void {
      seedThread(id, workspaceId);
      seedCanonicalThread(id, workspaceId);
    }

    it("joins workspace membership and interleaves lanes", () => {
      seedWorkspace("ws");
      for (const id of ["a", "b"]) {
        seedThread(id, "ws");
        write(id, [begin(id)]);
      }
      q = { ...q, workspace: "ws" };

      const text = render();

      expect(text).toContain("canonical DB: available");
      expect(text).toContain("A=a");
      expect(text).toContain("B=b");
      expect(text).toContain("A beg approval");
      expect(text).toContain("B beg approval");
    });

    it("opens only the files of the workspace's threads for --workspace", () => {
      seedWorkspace("ws-1");
      seedWorkspace("ws-2");
      seedThread("a", "ws-1");
      seedThread("b", "ws-1");
      seedThread("c", "ws-2");
      for (const id of ["a", "b", "c"]) write(id, [begin(id)]);
      q = { ...q, workspace: "ws-1" };

      expect(recordedThreadIds()).toEqual(["a", "b"]);
    });

    it("lists only threads active in the window when no scope is given", () => {
      seedWorkspace("ws");
      seedActiveThread("recorded", "ws");
      seedActiveThread("checkpointed", "ws");
      seedActiveThread("idle", "ws");
      write("recorded", [begin("recorded")]);
      seedCheckpoint("checkpointed", 5000);
      seedCheckpoint("idle", WINDOW_END + 60_000);

      const evidence = loadEvidence(q);

      expect(evidence.threads.map((view) => view.id).sort()).toEqual(["checkpointed", "recorded"]);
    });

    it("bounds canonical events by the window", () => {
      seedWorkspace("ws");
      seedActiveThread("a", "ws");
      seedEvent("a", 1, WINDOW_START - 500);
      seedEvent("a", 2, 5000);
      seedEvent("a", 3, WINDOW_END + 500);
      q = { ...q, thread: "a" };

      const evidence = loadEvidence(q);

      const canonical = evidence.threads[0].rows.filter((row) => row.ch === "db.canonical");
      expect(canonical.map((row) => row.d)).toEqual([{ type: "textDelta", sequence: 2 }]);
    });

    it("reads each thread's newest checkpoint, with its title and workspace, in a workspace query", () => {
      seedWorkspace("ws");
      seedActiveThread("a", "ws");
      seedCheckpoint("a", 5000);
      q = { ...q, workspace: "ws" };

      const view = loadEvidence(q).threads[0];

      expect(view).toMatchObject({ id: "a", workspace: "ws", checkpoint: { phase: "streaming", updated: 5000 } });
    });
  });
});
