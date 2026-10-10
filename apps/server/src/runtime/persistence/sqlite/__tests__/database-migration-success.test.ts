import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../database.js";

const MIGRATIONS_THROUGH_0041 = "0041_index_completed_thread_cleanup";
const SUBAGENT_IDENTITY_MIGRATION = "0042_supreme_terrax";
const MESSAGE_OUTCOME_MIGRATION = "0043_massive_dazzler";
const AUTOMATIC_SETUP_MIGRATION = "0044_small_prodigy";
const ASSISTANT_TEXT_CHECKPOINT_MIGRATION = "0045_tiny_stardust";
const QUEUED_TURNS_FIFO_MIGRATION = "0046_queued_turns_fifo";
const PROJECT_ACTION_RUNS_MIGRATION = "0047_conscious_tusk";
const PREVIOUS_MIGRATION = "0054_wise_supernaut";
const CODEX_CHILD_ORPHAN_REPAIR_MIGRATION = "0055_codex_child_orphan_repair";
const TURN_DIFF_MIGRATION = "0057_stiff_zaladane";
const SYSTEM_NOTICE_SESSION_MIGRATION = "0058_fine_rafael_vega";

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type MigrationJournal = {
  entries: JournalEntry[];
};

function readJournal(directory: string): MigrationJournal {
  return JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationHash(directory: string, tag: string): string {
  return NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(directory, `${tag}.sql`), "utf8"))
    .digest("hex");
}

function migrationEntry(directory: string, tag: string): JournalEntry {
  const entry = readJournal(directory).entries.find(
    (candidate) => candidate.tag === tag,
  );
  if (!entry) throw new Error(`Missing migration journal entry: ${tag}`);
  return entry;
}

function copyMigrationsThrough(
  sourceDirectory: string,
  destinationDirectory: string,
  lastTag: string,
): void {
  const journal = readJournal(sourceDirectory);
  const cutoff = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (cutoff === -1) throw new Error(`Missing migration journal entry: ${lastTag}`);

  const entries = journal.entries.slice(0, cutoff + 1);
  NodeFS.mkdirSync(NodePath.join(destinationDirectory, "meta"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(destinationDirectory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    NodeFS.copyFileSync(
      NodePath.join(sourceDirectory, `${entry.tag}.sql`),
      NodePath.join(destinationDirectory, `${entry.tag}.sql`),
    );
  }
}

function columnNames(db: Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function migrationsFolderForDrizzle(directory: string): string {
  return NodePath.resolve(directory).replace(/\\/g, "/");
}

describe("successful database migration recovery", () => {
  let directory: string;
  let databasePath: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-migration-success-"));
    databasePath = NodePath.join(directory, "mcode.db");
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = NodePath.join(process.cwd(), "drizzle");
  });

  it("removes the obsolete Copilot selection without rebuilding or cascading thread history", () => {
    const current = NodePath.join(process.cwd(), "drizzle");
    const previous = NodePath.join(directory, "drizzle-through-0067");
    copyMigrationsThrough(current, previous, "0067_cooing_tomorrow_man");
    const db = new Database(databasePath, { strict: true });
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrate(drizzle(db), { migrationsFolder: migrationsFolderForDrizzle(previous) });
      db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("copilot-workspace", "Copilot", "/fixture");
      const insert = db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, copilot_agent, parent_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
      insert.run("copilot-parent", "copilot-workspace", "Parent", "main", "copilot", "old-native-agent", null);
      insert.run("copilot-child", "copilot-workspace", "Child", "main", "copilot", "old-native-agent", "copilot-parent");
      db.prepare("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES (?, ?, ?, ?, ?)").run("copilot-message", "copilot-parent", "assistant", "Preserved history", 1);
      db.prepare("INSERT INTO tool_call_records (id, message_id, tool_name) VALUES (?, ?, ?)").run("copilot-tool", "copilot-message", "Read");
      migrate(drizzle(db), { migrationsFolder: migrationsFolderForDrizzle(current) });
      expect(columnNames(db, "threads")).not.toContain("copilot_agent");
      expect(db.prepare("SELECT id, parent_thread_id FROM threads WHERE workspace_id = ? ORDER BY id").all("copilot-workspace")).toEqual([{ id: "copilot-child", parent_thread_id: "copilot-parent" }, { id: "copilot-parent", parent_thread_id: null }]);
      expect(db.prepare("SELECT content FROM messages WHERE id = ?").get("copilot-message")).toEqual({ content: "Preserved history" });
      expect(db.prepare("SELECT message_id FROM tool_call_records WHERE id = ?").get("copilot-tool")).toEqual({ message_id: "copilot-message" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(current, "0068_tricky_morg.sql"), "utf8").trim()).toBe("ALTER TABLE `threads` DROP COLUMN `copilot_agent`;");
    } finally { db.close(true); }
  });

  afterEach(() => {
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("backfills legacy plans as ready agent versions and enforces per-thread version uniqueness", () => {
    const current = NodePath.join(process.cwd(), "drizzle");
    const previous = NodePath.join(directory, "drizzle-through-0070");
    copyMigrationsThrough(current, previous, "0070_lyrical_stellaris");
    const db = new Database(databasePath, { strict: true });
    const id = "00000000-0000-4000-8000-000000000071";
    const createdAt = "2026-10-01T00:00:00.000Z";
    const contentMd = "x".repeat(100_000);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrate(drizzle(db), { migrationsFolder: migrationsFolderForDrizzle(previous) });
      db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("plan-ws", "Plans", "/fixture");
      db.prepare("INSERT INTO threads (id, workspace_id, title, branch) VALUES (?, ?, ?, ?)").run("plan-thread", "plan-ws", "Plan", "main");
      db.prepare("INSERT INTO messages (id, thread_id, role, content, sequence) VALUES (?, ?, ?, ?, ?)").run("plan-message", "plan-thread", "assistant", "Summary", 1);
      db.prepare("INSERT INTO plans (id, thread_id, message_id, version, title, content_md, sections_json, change_summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, "plan-thread", "plan-message", 1, "Plan", contentMd, "[]", "old", "draft", createdAt);
      db.exec("PRAGMA foreign_keys = OFF");
      const insertLegacy = db.prepare("INSERT INTO plans (id, thread_id, message_id, version, title, content_md, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      insertLegacy.run("accepted", "plan-thread", "plan-message", 1, "Accepted", "# Accepted", "accepted", createdAt);
      insertLegacy.run("superseded", "plan-thread", "plan-message", 1, "Superseded", "# Superseded", "superseded", createdAt);
      insertLegacy.run("orphan-message", "plan-thread", "deleted-message", 2, "Retained", "# Retained", "draft", createdAt);
      insertLegacy.run("orphan-thread", "deleted-thread", "deleted-message", 1, "Deleted", "# Deleted", "draft", createdAt);
      db.exec("PRAGMA foreign_keys = ON");
      migrate(drizzle(db), { migrationsFolder: migrationsFolderForDrizzle(current) });
      expect(db.prepare("SELECT * FROM plans WHERE id = ?").get(id)).toEqual({
        id, thread_id: "plan-thread", message_id: "plan-message", version: 1, title: "Plan", content_md: contentMd,
        author: "agent", provider_id: null, capture_source: "fence", base_version_id: null,
        revision: 0, native_plan_file_json: null, status: "ready", created_at: createdAt, updated_at: createdAt, accepted_at: null,
      });
      expect(() => db.prepare("INSERT INTO plans (id, thread_id, version, title, content_md, author, capture_source) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("duplicate", "plan-thread", 1, "Duplicate", "", "user", "edit")).toThrow(/UNIQUE constraint failed: plans.thread_id, plans.version/);
      expect(db.prepare("SELECT id, version, status, message_id, author, revision FROM plans ORDER BY version").all()).toEqual([
        { id, version: 1, status: "ready", message_id: "plan-message", author: "agent", revision: 0 },
        { id: "accepted", version: 2, status: "accepted", message_id: "plan-message", author: "agent", revision: 0 },
        { id: "superseded", version: 3, status: "superseded", message_id: "plan-message", author: "agent", revision: 0 },
        { id: "orphan-message", version: 4, status: "ready", message_id: null, author: "agent", revision: 0 },
      ]);
      db.prepare("INSERT INTO plans (id, thread_id, message_id, version, title, content_md, author, capture_source) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)")
        .run("draft", "plan-thread", 5, "Edited", "# Edited", "user", "edit");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(true); }
  });

  it("keeps five generations and preserves public text identifiers", () => {
    const originalDatabase = new Database(databasePath, { strict: true });
    originalDatabase.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    originalDatabase
      .prepare("INSERT INTO records (id) VALUES (?)")
      .run("thread-public-id");
    originalDatabase.close(true);

    for (let generation = 0; generation < 7; generation++) {
      const upgradedDatabase = openDatabase({ dbPath: databasePath });
      expect(upgradedDatabase.prepare("SELECT id FROM records").get()).toEqual({
        id: "thread-public-id",
      });
      upgradedDatabase.close(true);
    }

    const generations = NodeFS.readdirSync(directory).filter(
      (name) => name.startsWith("mcode.db.bak-") && !name.endsWith("-wal"),
    );
    expect(generations).toHaveLength(5);
  });

  it("creates the complete automatic Setup lifecycle in one migration", () => {
    const database = openDatabase({ dbPath: databasePath });
    try {
      expect(readJournal(NodePath.join(process.cwd(), "drizzle")).entries.filter(
        (entry) => entry.tag.startsWith("0044_"),
      )).toEqual([migrationEntry(NodePath.join(process.cwd(), "drizzle"), AUTOMATIC_SETUP_MIGRATION)]);
      expect(columnNames(database, "workspace_environment_automatic_setup_attempts")).toEqual(expect.arrayContaining([
        "launch_snapshot_json",
        "outcome",
        "exit_code",
        "output",
        "output_truncated",
      ]));
      expect(columnNames(database, "workspace_environment_queued_turns")).toContain("dispatched_at");
      expect(database.prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?").all(
        migrationHash(NodePath.join(process.cwd(), "drizzle"), AUTOMATIC_SETUP_MIGRATION),
      )).toEqual([{
        created_at: migrationEntry(NodePath.join(process.cwd(), "drizzle"), AUTOMATIC_SETUP_MIGRATION).when,
      }]);
    } finally {
      database.close(true);
    }
  });

  it("creates the retained Project Action slot table after automatic Setup migrations", () => {
    const database = openDatabase({ dbPath: databasePath });
    try {
      expect(readJournal(NodePath.join(process.cwd(), "drizzle")).entries.filter(
        (entry) => entry.tag.startsWith("0047_"),
      )).toEqual([migrationEntry(NodePath.join(process.cwd(), "drizzle"), PROJECT_ACTION_RUNS_MIGRATION)]);
      expect(columnNames(database, "project_action_runs")).toEqual([
        "thread_id",
        "action_id",
        "workspace_id",
        "run_id",
        "revision",
        "terminal_session_id",
        "action_name",
        "status",
        "snapshot_json",
        "created_at",
        "started_at",
        "finished_at",
        "exit_code",
        "transcript",
        "transcript_truncated",
        "trigger",
      ]);
      expect(database.prepare("PRAGMA index_list(project_action_runs)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_project_action_runs_slot", unique: 1 }),
        expect.objectContaining({ name: "idx_project_action_runs_thread", unique: 0 }),
      ]));
      expect(database.prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?").all(
        migrationHash(NodePath.join(process.cwd(), "drizzle"), PROJECT_ACTION_RUNS_MIGRATION),
      )).toEqual([{
        created_at: migrationEntry(NodePath.join(process.cwd(), "drizzle"), PROJECT_ACTION_RUNS_MIGRATION).when,
      }]);
    } finally {
      database.close(true);
    }
  });

  it("upgrades a production-shaped 0044 database without changing existing data", () => {
    const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0044");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      AUTOMATIC_SETUP_MIGRATION,
    );

    const previousDatabase = new Database(databasePath, { strict: true });
    try {
      migrate(drizzle(previousDatabase), {
        migrationsFolder: migrationsFolderForDrizzle(previousMigrationsDirectory),
      });
      const timestamp = "2026-08-24T12:00:00.000Z";
      previousDatabase.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("workspace-production", "Production", "C:/production", timestamp, timestamp);
      previousDatabase.prepare(
        "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "thread-production",
        "workspace-production",
        "Existing thread",
        "main",
        "codex",
        "active",
        timestamp,
        timestamp,
      );
      previousDatabase.prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "message-production",
        "thread-production",
        "assistant",
        "Existing production text",
        timestamp,
        1,
      );
    } finally {
      previousDatabase.close(true);
    }

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      expect(upgradedDatabase.prepare(`
        SELECT id, thread_id, role, content, sequence
        FROM messages
        WHERE id = ?
      `).get("message-production")).toEqual({
        id: "message-production",
        thread_id: "thread-production",
        role: "assistant",
        content: "Existing production text",
        sequence: 1,
      });
      expect(columnNames(upgradedDatabase, "parent_assistant_text_checkpoints")).toEqual([
        "execution_id",
        "thread_id",
        "turn_id",
        "last_sequence",
        "retained_bytes",
        "retained_chunks",
        "updated_at",
      ]);
      expect(columnNames(upgradedDatabase, "parent_assistant_text_checkpoint_chunks")).toEqual([
        "execution_id",
        "first_sequence",
        "last_sequence",
        "text",
        "byte_length",
      ]);
      expect(upgradedDatabase.prepare(
        "PRAGMA foreign_key_list(parent_assistant_text_checkpoint_chunks)",
      ).all()).toEqual([
        expect.objectContaining({
          table: "parent_assistant_text_checkpoints",
          from: "execution_id",
          to: "execution_id",
          on_delete: "CASCADE",
        }),
      ]);
      const migration = migrationEntry(
        currentMigrationsDirectory,
        ASSISTANT_TEXT_CHECKPOINT_MIGRATION,
      );
      expect(upgradedDatabase.prepare(
        "SELECT created_at FROM __drizzle_migrations WHERE hash = ?",
      ).all(migrationHash(currentMigrationsDirectory, ASSISTANT_TEXT_CHECKPOINT_MIGRATION))).toEqual([
        { created_at: migration.when },
      ]);
    } finally {
      upgradedDatabase.close(true);
    }

    const reopenedDatabase = openDatabase({ dbPath: databasePath });
    try {
      expect(reopenedDatabase.prepare(
        "SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE hash = ?",
      ).get(migrationHash(currentMigrationsDirectory, ASSISTANT_TEXT_CHECKPOINT_MIGRATION))).toEqual({
        count: 1,
      });
      expect(reopenedDatabase.prepare(
        "SELECT content FROM messages WHERE id = ?",
      ).get("message-production")).toEqual({ content: "Existing production text" });
    } finally {
      reopenedDatabase.close(true);
    }
  });

  it("upgrades the queued Turn table with durable FIFO positions and a non-unique per-Thread index", () => {
    const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0045");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      ASSISTANT_TEXT_CHECKPOINT_MIGRATION,
    );

    const previousDatabase = new Database(databasePath, { strict: true });
    try {
      migrate(drizzle(previousDatabase), {
        migrationsFolder: migrationsFolderForDrizzle(previousMigrationsDirectory),
      });
      const timestamp = "2026-08-24T12:00:00.000Z";
      previousDatabase.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("workspace-queued", "Queued", "C:/queued", timestamp, timestamp);
      previousDatabase.prepare(
        "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("thread-queued", "workspace-queued", "Queued", "main", "codex", "active", timestamp, timestamp);
      previousDatabase.prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("message-queued-1", "thread-queued", "user", "First blocked Turn", timestamp, 1);
      previousDatabase.prepare(
        "INSERT INTO workspace_environment_queued_turns (id, thread_id, message_id, state, submission_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("queued-1", "thread-queued", "message-queued-1", "queued", "{}", timestamp);
    } finally {
      previousDatabase.close(true);
    }

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      upgradedDatabase.prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("message-queued-2", "thread-queued", "user", "Second blocked Turn", "2026-08-24T12:00:01.000Z", 2);
      expect(() => upgradedDatabase.prepare(
        "INSERT INTO workspace_environment_queued_turns (id, thread_id, message_id, queue_position, state, submission_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("queued-2", "thread-queued", "message-queued-2", 2, "queued", "{}", "2026-08-24T12:00:00.000Z")).not.toThrow();
      expect(upgradedDatabase.prepare(
        "SELECT id, message_id, queue_position FROM workspace_environment_queued_turns WHERE thread_id = ? ORDER BY queue_position",
      ).all("thread-queued")).toEqual([
        { id: "queued-1", message_id: "message-queued-1", queue_position: 1 },
        { id: "queued-2", message_id: "message-queued-2", queue_position: 2 },
      ]);
      expect(columnNames(upgradedDatabase, "workspace_environment_queued_turns")).toContain("queue_position");
      expect(upgradedDatabase.prepare("PRAGMA index_list(workspace_environment_queued_turns)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_workspace_environment_queued_turns_thread_state_position", unique: 0 }),
      ]));
      expect(upgradedDatabase.prepare(
        "SELECT created_at FROM __drizzle_migrations WHERE hash = ?",
      ).all(migrationHash(currentMigrationsDirectory, QUEUED_TURNS_FIFO_MIGRATION))).toEqual([{
        created_at: migrationEntry(currentMigrationsDirectory, QUEUED_TURNS_FIFO_MIGRATION).when,
      }]);
    } finally {
      upgradedDatabase.close(true);
    }
  });

  it("upgrades a 0041 database that the legacy fallback already patched", () => {
    const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0041");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      MIGRATIONS_THROUGH_0041,
    );

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = previousMigrationsDirectory;
    const previousDatabase = openDatabase({ dbPath: databasePath });
    try {
      expect(columnNames(previousDatabase, "tool_call_records")).toContain(
        "subagent_identity_key",
      );
      expect(previousDatabase.prepare(
        "SELECT MAX(created_at) AS created_at FROM __drizzle_migrations",
      ).get()).toEqual({
        created_at: migrationEntry(previousMigrationsDirectory, MIGRATIONS_THROUGH_0041).when,
      });
    } finally {
      previousDatabase.close(true);
    }

    const stagedDatabase = openDatabase({ dbPath: databasePath });
    stagedDatabase.close(true);

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      const identityMigration = migrationEntry(
        currentMigrationsDirectory,
        SUBAGENT_IDENTITY_MIGRATION,
      );
      const identityMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, SUBAGENT_IDENTITY_MIGRATION));
      expect(identityMigrationRows).toEqual([{ created_at: identityMigration.when }]);
      expect(columnNames(upgradedDatabase, "messages")).toEqual(
        expect.arrayContaining(["outcome", "outcome_execution_id"]),
      );
      const outcomeMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION));
      expect(outcomeMigrationRows).toEqual([{
        created_at: migrationEntry(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION).when,
      }]);
    } finally {
      upgradedDatabase.close(true);
    }
  });

  it("upgrades an unpatched 0041 database", () => {
    const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0041");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      MIGRATIONS_THROUGH_0041,
    );

    const previousDatabase = new Database(databasePath, { strict: true });
    try {
      migrate(drizzle(previousDatabase), {
        migrationsFolder: migrationsFolderForDrizzle(previousMigrationsDirectory),
      });
      expect(columnNames(previousDatabase, "tool_call_records")).not.toContain(
        "subagent_identity_key",
      );
      expect(previousDatabase.prepare(
        "SELECT MAX(created_at) AS created_at FROM __drizzle_migrations",
      ).get()).toEqual({
        created_at: migrationEntry(previousMigrationsDirectory, MIGRATIONS_THROUGH_0041).when,
      });
    } finally {
      previousDatabase.close(true);
    }

    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      const identityMigration = migrationEntry(
        currentMigrationsDirectory,
        SUBAGENT_IDENTITY_MIGRATION,
      );
      const identityMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, SUBAGENT_IDENTITY_MIGRATION));
      expect(identityMigrationRows).toEqual([{ created_at: identityMigration.when }]);
      expect(columnNames(upgradedDatabase, "tool_call_records")).toContain(
        "subagent_identity_key",
      );
      expect(columnNames(upgradedDatabase, "messages")).toEqual(
        expect.arrayContaining(["outcome", "outcome_execution_id"]),
      );
      const outcomeMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION));
      expect(outcomeMigrationRows).toEqual([{
        created_at: migrationEntry(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION).when,
      }]);
    } finally {
      upgradedDatabase.close(true);
    }
  });

  it("removes generated orphaned Codex children without deleting genuine roots", () => {
    const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0054");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      PREVIOUS_MIGRATION,
    );
    const orphanedRootId = "thread:codex-child:orphaned-root";
    const nestedChildId = "thread:codex-child:orphaned-nested";
    const genuineRootId = "thread:genuine-root";

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = previousMigrationsDirectory;
    const previousDatabase = openDatabase({ dbPath: databasePath });
    try {
      const timestamp = "2026-09-03T10:00:00.000Z";
      previousDatabase.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("workspace-codex-repair", "Codex repair", "C:/codex-repair", timestamp, timestamp);
      const insertThread = previousDatabase.prepare(
        "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, 'main', 'codex', 'active', ?, ?)",
      );
      insertThread.run(orphanedRootId, "workspace-codex-repair", "Sub-agent", timestamp, timestamp);
      insertThread.run(nestedChildId, "workspace-codex-repair", "Sub-agent", timestamp, timestamp);
      insertThread.run(genuineRootId, "workspace-codex-repair", "Sub-agent", timestamp, timestamp);
      previousDatabase.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?")
        .run(orphanedRootId, nestedChildId);
      const insertCanonicalThread = previousDatabase.prepare(`
        INSERT INTO canonical_agent_threads (
          id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
          provider_id, provider_identities_json, activity_state, conversation_revision,
          roster_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'codex', '[]', 'Idle', 1, 0, ?, ?)
      `);
      insertCanonicalThread.run(
        orphanedRootId,
        "workspace-codex-repair",
        null,
        orphanedRootId,
        null,
        timestamp,
        timestamp,
      );
      insertCanonicalThread.run(
        nestedChildId,
        "workspace-codex-repair",
        orphanedRootId,
        orphanedRootId,
        orphanedRootId,
        timestamp,
        timestamp,
      );
      insertCanonicalThread.run(
        genuineRootId,
        "workspace-codex-repair",
        null,
        genuineRootId,
        null,
        timestamp,
        timestamp,
      );
      previousDatabase.prepare(`
        INSERT INTO canonical_agent_turns (
          id, thread_id, execution_id, status, trigger_json, permission_mode,
          provider_identities_json, started_at, ended_at, created_at, updated_at
        ) VALUES ('orphaned-child-turn', ?, 'orphaned-child-execution', 'Completed', '{"kind":"child"}', 'full', '[]', ?, ?, ?, ?)
      `).run(nestedChildId, timestamp, timestamp, timestamp, timestamp);
      previousDatabase.prepare(`
        INSERT INTO canonical_agent_items (
          id, thread_id, turn_id, kind, provider_identities_json, payload_json, created_at, updated_at
        ) VALUES ('orphaned-child-item', ?, 'orphaned-child-turn', 'message', '[]', '{"projection":"message"}', ?, ?)
      `).run(nestedChildId, timestamp, timestamp);
    } finally {
      previousDatabase.close(true);
    }

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      expect(upgradedDatabase.prepare(
        "SELECT id FROM threads WHERE id IN (?, ?, ?) ORDER BY id",
      ).all(orphanedRootId, nestedChildId, genuineRootId)).toEqual([{ id: genuineRootId }]);
      expect(upgradedDatabase.prepare(
        "SELECT id FROM canonical_agent_threads WHERE id IN (?, ?, ?) ORDER BY id",
      ).all(orphanedRootId, nestedChildId, genuineRootId)).toEqual([{ id: genuineRootId }]);
      expect(upgradedDatabase.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE id = 'orphaned-child-turn'").get())
        .toEqual({ count: 0 });
      expect(upgradedDatabase.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = 'orphaned-child-item'").get())
        .toEqual({ count: 0 });
      expect(upgradedDatabase.prepare(
        "SELECT created_at FROM __drizzle_migrations WHERE hash = ?",
      ).all(migrationHash(currentMigrationsDirectory, CODEX_CHILD_ORPHAN_REPAIR_MIGRATION))).toEqual([{
        created_at: migrationEntry(
          currentMigrationsDirectory,
          CODEX_CHILD_ORPHAN_REPAIR_MIGRATION,
        ).when,
      }]);
    } finally {
      upgradedDatabase.close(true);
    }
  });

  it("adds notice metadata and the session lookup index", () => {
    const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0057");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      TURN_DIFF_MIGRATION,
    );

    const previousDatabase = new Database(databasePath, { strict: true });
    try {
      migrate(drizzle(previousDatabase), {
        migrationsFolder: migrationsFolderForDrizzle(previousMigrationsDirectory),
      });
    } finally {
      previousDatabase.close(true);
    }

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      expect(columnNames(upgradedDatabase, "messages")).toContain("system_notice");
      expect(columnNames(upgradedDatabase, "threads")).toContain("current_notice_session_id");
      expect(upgradedDatabase.prepare("PRAGMA index_list(messages)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_messages_notice_session_sequence", unique: 0 }),
      ]));
      expect(upgradedDatabase.prepare(
        "SELECT created_at FROM __drizzle_migrations WHERE hash = ?",
      ).all(migrationHash(currentMigrationsDirectory, SYSTEM_NOTICE_SESSION_MIGRATION))).toEqual([{
        created_at: migrationEntry(currentMigrationsDirectory, SYSTEM_NOTICE_SESSION_MIGRATION).when,
      }]);
    } finally {
      upgradedDatabase.close(true);
    }
  });
});
