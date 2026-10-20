/**
 * Behavior tests for the filtered development database seed (scripts/db-seed.mjs).
 *
 * Donors are real migrated databases built in a temp directory. The real ~/.mcode is never read.
 */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Database } from "bun:sqlite";

import { ensureRuntimeDatabase } from "../../db-seed.mjs";
import { HISTORY_TABLES, LEDGER_TABLES } from "../../db-seed-filter.mjs";
import { getRuntimePaths } from "../runtime-contract.mjs";
import { hasRuntimeDatabaseMarker } from "../runtime-database.mjs";

const assert = NodeAssertStrict.default;
const SERVER_DATABASE_MODULE = new URL(
  "../../../apps/server/src/runtime/persistence/sqlite/database.ts",
  import.meta.url,
).href;
const AGENT_MODEL_RECORDS_MODULE = new URL("../../../packages/agent-model/src/records.ts", import.meta.url).href;

/** Terminal outcome for a canonical turn: a family with only these is stopped. */
const TERMINAL_TURN_STATUSES = ["Completed", "Cancelled", "Interrupted", "Errored"];
/** Idle-like thread activity: a family with only these is stopped. */
const QUIESCENT_ACTIVITY_STATES = ["Idle", "Closed", "Unavailable"];

let templateDonor;

/** Builds one migrated, empty database with the real server migrations, then reuses it as a file copy. */
async function migratedTemplate() {
  if (templateDonor) return templateDonor;
  const { openDatabase } = await import(SERVER_DATABASE_MODULE);
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-seed-template-"));
  const path = NodePath.join(dir, "template.db");
  openDatabase({ dbPath: path }).close(true);
  templateDonor = path;
  return path;
}

/** Creates an isolated repo and a migrated donor database, and removes both after the callback. */
async function withSeedFixture(callback) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-seed-"));
  const repoRoot = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repoRoot);
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  NodeFS.writeFileSync(NodePath.join(repoRoot, ".gitignore"), ".dev/\n");
  const donorPath = NodePath.join(root, "donor.db");
  NodeFS.copyFileSync(await migratedTemplate(), donorPath);
  try {
    await callback({ repoRoot, donorPath, targetPath: getRuntimePaths(repoRoot).dbPath });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

/** Opens the donor for writing with foreign keys on, as the server does. */
function editDatabase(path, edit) {
  const db = new Database(path);
  try {
    db.run("PRAGMA foreign_keys = ON");
    edit(db);
  } finally {
    db.close(true);
  }
}

function readDatabase(path, read) {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close(true);
  }
}

function addWorkspace(db, id, updatedAt, lastOpenedAt = null) {
  db.run(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, id, `/real/repos/${id}`, updatedAt, updatedAt, lastOpenedAt],
  );
}

/**
 * Inserts one thread with its canonical thread, optional canonical turn, and one message.
 * `turn` null means the thread never ran a canonical turn.
 */
function addThread(db, {
  id,
  workspaceId,
  updatedAt,
  parent = null,
  activity = "Idle",
  turn = "Completed",
  deletedAt = null,
}) {
  db.run(
    `INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at, deleted_at, parent_thread_id,
       sdk_session_id, worktree_path, worktree_managed, pr_number, pr_status, cleanup_state, scheduled_deletion_at)
     VALUES (?, ?, ?, 'main', ?, ?, ?, ?, 'sdk-session', '/real/worktrees/x', 1, 42, 'open', 'scheduled', ?)`,
    [id, workspaceId, id, updatedAt, updatedAt, deletedAt, parent, updatedAt],
  );
  db.run(
    `INSERT INTO canonical_agent_threads (id, workspace_id, parent_thread_id, root_thread_id, provider_id,
       provider_identities_json, activity_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claude', '[{"kind":"session","id":"native-1"}]', ?, ?, ?)`,
    [id, workspaceId, parent, parent ?? id, activity, updatedAt, updatedAt],
  );
  if (turn) {
    db.run(
      `INSERT INTO canonical_agent_turns (id, thread_id, execution_id, status, trigger_json, permission_mode,
         provider_identities_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{"kind":"user"}', 'default', '[{"kind":"session","id":"native-1"}]', ?, ?)`,
      [`turn-${id}`, id, `exec-${id}`, turn, updatedAt, updatedAt],
    );
  }
  db.run("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES (?, ?, 'user', 'hello', 1)", [
    `msg-${id}`,
    id,
  ]);
}

function keptThreadIds(path) {
  return readDatabase(path, (db) => db.query("SELECT id FROM threads ORDER BY id").all().map((row) => row.id));
}

function seed(fixture, options = {}) {
  return ensureRuntimeDatabase({
    repoRoot: fixture.repoRoot,
    refresh: true,
    source: fixture.donorPath,
    ...options,
  });
}

NodeTest.test("a family with a live member is left out and stopped families are kept", async () => {
  await withSeedFixture((fixture) => {
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "w1", "2026-01-01T00:00:00.000Z");
      addThread(db, { id: "stopped-a", workspaceId: "w1", updatedAt: "2026-02-01T00:00:00.000Z" });
      addThread(db, { id: "live-parent", workspaceId: "w1", updatedAt: "2026-02-02T00:00:00.000Z", turn: "Running" });
      // The fork itself finished, but its family is live through the parent.
      addThread(db, {
        id: "fork-of-live",
        workspaceId: "w1",
        updatedAt: "2026-02-03T00:00:00.000Z",
        parent: "live-parent",
      });
      addThread(db, { id: "stopped-b", workspaceId: "w1", updatedAt: "2026-02-04T00:00:00.000Z" });
      addThread(db, {
        id: "soft-deleted",
        workspaceId: "w1",
        updatedAt: "2026-02-05T00:00:00.000Z",
        deletedAt: "2026-02-06T00:00:00.000Z",
      });
    });

    seed(fixture);

    assert.deepEqual(keptThreadIds(fixture.targetPath), ["stopped-a", "stopped-b"]);
    readDatabase(fixture.targetPath, (db) => {
      assert.equal(db.query("SELECT COUNT(*) AS n FROM messages").get().n, 2);
      assert.equal(db.query("SELECT COUNT(*) AS n FROM canonical_agent_turns").get().n, 2);
    });
  });
});

NodeTest.test("liveness covers every canonical turn status and activity state, and unknown values", async () => {
  const { AgentTurnStatusSchema, AgentThreadActivityStateSchema } = await import(AGENT_MODEL_RECORDS_MODULE);
  // A new enum value must be classified here on purpose, because the seed treats unclassified state as live.
  assert.deepEqual([...AgentTurnStatusSchema.options].sort(), ["Cancelled", "Completed", "Errored", "Interrupted", "Pending", "Running"]);
  assert.deepEqual([...AgentThreadActivityStateSchema.options].sort(), ["Active", "Closed", "Idle", "Starting", "Unavailable"]);

  await withSeedFixture((fixture) => {
    const expectedKept = [];
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "w1", "2026-01-01T00:00:00.000Z");
      let index = 0;
      const add = (label, input, kept) => {
        const id = `${label}-${index++}`;
        addThread(db, { id, workspaceId: "w1", updatedAt: "2026-02-01T00:00:00.000Z", ...input });
        if (kept) expectedKept.push(id);
      };
      for (const status of [...AgentTurnStatusSchema.options, "Mystery"]) {
        add(`turn-${status}`, { turn: status }, TERMINAL_TURN_STATUSES.includes(status));
      }
      for (const state of [...AgentThreadActivityStateSchema.options, "Mystery"]) {
        add(`activity-${state}`, { activity: state }, QUIESCENT_ACTIVITY_STATES.includes(state));
      }
    });

    seed(fixture, { maxFamiliesPerWorkspace: 100 });

    assert.deepEqual(keptThreadIds(fixture.targetPath), expectedKept.sort());
  });
});

NodeTest.test("caps keep the most recently active workspaces and the newest families in each", async () => {
  await withSeedFixture((fixture) => {
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "old-ws", "2026-01-01T00:00:00.000Z");
      addWorkspace(db, "mid-ws", "2026-01-02T00:00:00.000Z");
      // Recent by thread activity even though its own timestamp is oldest.
      addWorkspace(db, "busy-ws", "2025-12-01T00:00:00.000Z");
      addThread(db, { id: "busy-new", workspaceId: "busy-ws", updatedAt: "2026-03-01T00:00:00.000Z" });
      addThread(db, { id: "busy-older", workspaceId: "busy-ws", updatedAt: "2026-02-01T00:00:00.000Z" });
      addThread(db, { id: "mid-new", workspaceId: "mid-ws", updatedAt: "2026-01-20T00:00:00.000Z" });
      addThread(db, { id: "mid-fork", workspaceId: "mid-ws", updatedAt: "2026-01-21T00:00:00.000Z", parent: "mid-new" });
      addThread(db, { id: "mid-older", workspaceId: "mid-ws", updatedAt: "2026-01-10T00:00:00.000Z" });
      addThread(db, { id: "old-only", workspaceId: "old-ws", updatedAt: "2026-01-05T00:00:00.000Z" });
    });

    seed(fixture, { maxWorkspaces: 2, maxFamiliesPerWorkspace: 1 });

    readDatabase(fixture.targetPath, (db) => {
      assert.deepEqual(db.query("SELECT id FROM workspaces ORDER BY id").all().map((row) => row.id), ["busy-ws", "mid-ws"]);
    });
    // The mid-ws family {mid-new, mid-fork} counts once and wins over mid-older.
    assert.deepEqual(keptThreadIds(fixture.targetPath), ["busy-new", "mid-fork", "mid-new"]);
  });
});

NodeTest.test("tables outside the history allowlist are emptied while history is kept", async () => {
  await withSeedFixture((fixture) => {
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "w1", "2026-01-01T00:00:00.000Z");
      addThread(db, { id: "t1", workspaceId: "w1", updatedAt: "2026-02-01T00:00:00.000Z" });
      db.run("INSERT INTO terminal_cleanup_ledger VALUES ('s1', 1, 4242, 4242, 'job-object', 'now', 'now')");
      db.run("INSERT INTO store_identity (store_id, database_path, created_at) VALUES ('prod-store', '/prod/mcode.db', 'now')");
      db.run("INSERT INTO turn_resume_schedules VALUES ('t1', 'turn-t1', 'exec-t1', 'now', 'now')");
      db.run(
        `INSERT INTO workspace_environment_queued_turns (id, thread_id, message_id, state, submission_json)
         VALUES ('q1', 't1', 'msg-t1', 'queued', '{}')`,
      );
      db.run("INSERT INTO cleanup_jobs (id, thread_id, workspace_path, worktree_path, branch, kind, created_at) VALUES ('c1', 't1', '/real/repos/w1', '/real/worktrees/x', 'b', 'k', 'now')");
    });

    seed(fixture);

    readDatabase(fixture.targetPath, (db) => {
      for (const table of ["terminal_cleanup_ledger", "store_identity", "turn_resume_schedules", "workspace_environment_queued_turns", "cleanup_jobs"]) {
        assert.equal(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
      }
      assert.equal(db.query("SELECT COUNT(*) AS n FROM messages").get().n, 1);
    });
  });
});

NodeTest.test("kept rows carry no session, checkout, PR, or cleanup bindings and no pending work", async () => {
  await withSeedFixture((fixture) => {
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "w1", "2026-01-01T00:00:00.000Z");
      addThread(db, { id: "t1", workspaceId: "w1", updatedAt: "2026-02-01T00:00:00.000Z" });
      db.run("INSERT INTO plan_question_answers (id, thread_id, status) VALUES ('q-pending', 't1', 'pending'), ('q-done', 't1', 'answered')");
      db.run("INSERT INTO tool_call_records (id, message_id, tool_name, status) VALUES ('tc-running', 'msg-t1', 'Bash', 'running'), ('tc-done', 'msg-t1', 'Bash', 'completed')");
    });

    seed(fixture);

    readDatabase(fixture.targetPath, (db) => {
      const thread = db.query("SELECT * FROM threads WHERE id = 't1'").get();
      for (const column of ["sdk_session_id", "worktree_path", "pr_number", "pr_status", "cleanup_state", "scheduled_deletion_at"]) {
        assert.equal(thread[column], null, column);
      }
      assert.equal(thread.worktree_managed, 0);
      assert.equal(db.query("SELECT provider_identities_json AS v FROM canonical_agent_threads").get().v, "[]");
      assert.equal(db.query("SELECT provider_identities_json AS v FROM canonical_agent_turns").get().v, "[]");
      assert.deepEqual(
        db.query("SELECT id, status FROM plan_question_answers ORDER BY id").all(),
        [{ id: "q-done", status: "answered" }, { id: "q-pending", status: "expired" }],
      );
      assert.deepEqual(
        db.query("SELECT id, status FROM tool_call_records ORDER BY id").all(),
        [{ id: "tc-done", status: "completed" }, { id: "tc-running", status: "cancelled" }],
      );
    });
  });
});

NodeTest.test("the migration ledger and compatibility floor match the donor exactly and the donor is untouched", async () => {
  await withSeedFixture((fixture) => {
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "w1", "2026-01-01T00:00:00.000Z");
      addThread(db, { id: "t1", workspaceId: "w1", updatedAt: "2026-02-01T00:00:00.000Z" });
    });
    const donorBytesBefore = NodeFS.readFileSync(fixture.donorPath);

    seed(fixture);

    const ledger = (path) => readDatabase(path, (db) => LEDGER_TABLES.map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const targetLedger = ledger(fixture.targetPath);
    assert.deepEqual(targetLedger, ledger(fixture.donorPath));
    assert.ok(targetLedger[0].length > 0, "ledger rows were copied, not just equal empty sets");
    assert.ok(donorBytesBefore.equals(NodeFS.readFileSync(fixture.donorPath)));
  });
});

NodeTest.test("a failure while building leaves an existing target byte-identical and no temp files", async () => {
  await withSeedFixture((fixture) => {
    seed(fixture);
    const before = NodeFS.readFileSync(fixture.targetPath);
    const markerBefore = hasRuntimeDatabaseMarker(fixture.repoRoot);
    // A donor without the workspace tables fails after the snapshot copy exists, so this is a mid-build failure.
    NodeFS.rmSync(fixture.donorPath);
    editDatabase(fixture.donorPath, (db) => {
      db.run("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)");
    });

    assert.throws(() => seed(fixture));

    assert.ok(before.equals(NodeFS.readFileSync(fixture.targetPath)));
    assert.equal(markerBefore, true);
    assert.deepEqual(
      NodeFS.readdirSync(NodePath.dirname(fixture.targetPath)).filter((name) => name.includes(".seed-")),
      [],
    );
  });
});

NodeTest.test("without refresh a current seed is reused and a stale or missing marker is reseeded", async () => {
  await withSeedFixture((fixture) => {
    editDatabase(fixture.donorPath, (db) => {
      addWorkspace(db, "w1", "2026-01-01T00:00:00.000Z");
    });
    seed(fixture);
    const markWork = () => editDatabase(fixture.targetPath, (db) => addWorkspace(db, "local-work", "2026-03-01T00:00:00.000Z"));
    const workspaceIds = () => readDatabase(fixture.targetPath, (db) => db.query("SELECT id FROM workspaces ORDER BY id").all().map((row) => row.id));
    const marker = NodePath.join(getRuntimePaths(fixture.repoRoot).dbDir, ".agent-runtime-database");

    markWork();
    seed(fixture, { refresh: false });
    assert.deepEqual(workspaceIds(), ["local-work", "w1"], "current marker reuses the target");

    NodeFS.writeFileSync(marker, "agent-runtime-snapshot\n");
    seed(fixture, { refresh: false });
    assert.deepEqual(workspaceIds(), ["w1"], "marker from the unfiltered seed is reseeded");

    markWork();
    NodeFS.rmSync(marker);
    seed(fixture, { refresh: false });
    assert.deepEqual(workspaceIds(), ["w1"], "missing marker is reseeded");

    markWork();
    seed(fixture, { refresh: true });
    assert.deepEqual(workspaceIds(), ["w1"], "refresh always reseeds");
  });
});

NodeTest.test("a build abandoned by a killed process is cleaned up by the next one", async () => {
  await withSeedFixture((fixture) => {
    const dbDir = NodePath.dirname(fixture.targetPath);
    NodeFS.mkdirSync(dbDir, { recursive: true });
    const abandoned = NodePath.join(dbDir, ".app.sqlite.seed-abandoned");
    NodeFS.writeFileSync(abandoned, "partial copy of private history");

    seed(fixture);

    assert.equal(NodeFS.existsSync(abandoned), false);
  });
});

NodeTest.test("a missing donor skips the seed on launch but fails an explicit refresh", async () => {
  await withSeedFixture((fixture) => {
    NodeFS.rmSync(fixture.donorPath);

    const result = seed(fixture, { refresh: false });

    assert.equal(result.status, "no-donor");
    assert.equal(NodeFS.existsSync(fixture.targetPath), false);
    assert.throws(() => seed(fixture, { refresh: true }), /Source database not found/);
  });
});

NodeTest.test("every history table exists in the migrated schema and only references history tables", async () => {
  await withSeedFixture((fixture) => {
    readDatabase(fixture.donorPath, (db) => {
      const tables = new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      for (const table of [...HISTORY_TABLES, ...LEDGER_TABLES]) {
        assert.ok(tables.has(table), `${table} is not in the schema`);
      }
      for (const table of HISTORY_TABLES) {
        for (const foreignKey of db.query(`PRAGMA foreign_key_list(${table})`).all()) {
          // Emptying a denied parent would cascade into the history child.
          assert.ok(HISTORY_TABLES.includes(foreignKey.table), `${table} references denied table ${foreignKey.table}`);
        }
      }
    });
  });
});
