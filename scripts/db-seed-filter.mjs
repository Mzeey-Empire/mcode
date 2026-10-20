/**
 * Prunes a copy of a real Mcode database down to history that is safe to open in a development runtime.
 *
 * Boot recovery acts on many rows: it resumes turns, kills recorded process trees, removes worktrees, and
 * drains queues. A development server must therefore never inherit that machinery, so everything not
 * explicitly listed as history is emptied.
 */

/** Bump when the filter changes what a seeded database may contain; older seeds are rebuilt on launch. */
export const SEED_FILTER_VERSION = 1;

/** Default number of most recently active workspaces kept. */
export const DEFAULT_MAX_WORKSPACES = 8;

/** Default number of newest stopped thread families kept per workspace. */
export const DEFAULT_MAX_FAMILIES_PER_WORKSPACE = 20;

/** Migration bookkeeping the startup guard inspects. Copied verbatim and verified, never pruned. */
export const LEDGER_TABLES = ["__drizzle_migrations", "mcode_schema_compatibility"];

/**
 * The only application tables whose rows survive. Every other table is emptied, so a table added later is
 * denied until someone decides its rows are safe history. Rows are scoped by their thread_id and
 * workspace_id columns; a test checks each name against the migrated schema.
 */
export const HISTORY_TABLES = [
  "workspaces",
  "threads",
  "messages",
  "thought_segments",
  "tool_call_records",
  "approval_receipts",
  "hook_executions",
  "turn_diff_snapshots",
  "plans",
  "plan_comments",
  "plan_question_answers",
  "thread_control_audit",
  "provider_model_cache",
  "provider_model_sightings",
  "provider_catalog_snapshots",
  "workspace_terminal_preferences",
  "workspace_environment_storage_settings",
  "canonical_agent_threads",
  "canonical_agent_turns",
  "canonical_agent_items",
  "canonical_agent_events",
  "canonical_conversation_display_mappings",
  "conversation_display_materialization_state",
  "canonical_legacy_message_provenance",
  "canonical_legacy_migration_checkpoints",
  "canonical_writer_live_publication_heads",
  "canonical_writer_operation_receipts",
  "canonical_writer_thread_operation_receipts",
];

// Liveness mirrors the owning store, apps/server/src/features/agents/canonical/canonical-agent-store.ts
// (turns in 'Pending'/'Running', threads 'Starting'/'Active'). It is stated as "not known to be quiet" so a
// state added later counts as live. Source of truth for the values: packages/agent-model/src/records.ts.
const TERMINAL_TURN_STATUSES = ["Completed", "Cancelled", "Interrupted", "Errored"];
const QUIESCENT_ACTIVITY_STATES = ["Idle", "Closed", "Unavailable"];

const quoteList = (values) => values.map((value) => `'${value}'`).join(", ");
const quoteIdentifier = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Filters an open, writable copy of a donor database in one transaction.
 *
 * @param {import("bun:sqlite").Database} db Copy of the donor; never the donor itself.
 * @param {{ maxWorkspaces?: number, maxFamiliesPerWorkspace?: number }} [limits]
 * @returns {{ workspaces: number, threads: number }} Rows kept.
 * @throws When the pruned copy fails a foreign key or ledger check; the caller discards the copy.
 */
export function filterSeedDatabase(db, limits = {}) {
  const maxWorkspaces = requirePositiveInteger(limits.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES, "maxWorkspaces");
  const maxFamilies = requirePositiveInteger(
    limits.maxFamiliesPerWorkspace ?? DEFAULT_MAX_FAMILIES_PER_WORKSPACE,
    "maxFamiliesPerWorkspace",
  );
  const ledgerBefore = readLedgers(db);
  db.run("PRAGMA foreign_keys = ON");
  db.run("BEGIN IMMEDIATE");
  try {
    const tables = listTables(db);
    const history = HISTORY_TABLES.filter((table) => tables.includes(table));
    assertHistoryReferencesOnlyHistory(db, history);
    selectKeptRows(db, maxWorkspaces, maxFamilies);
    for (const table of tables) {
      if (!history.includes(table) && !LEDGER_TABLES.includes(table)) db.run(`DELETE FROM ${quoteIdentifier(table)}`);
    }
    pruneHistory(db, history);
    sanitizeKeptRows(db);
    assertForeignKeysIntact(db);
    if (JSON.stringify(readLedgers(db)) !== JSON.stringify(ledgerBefore)) {
      throw new Error("Seed filter changed the migration ledger.");
    }
    const kept = {
      workspaces: db.query("SELECT COUNT(*) AS n FROM workspaces").get().n,
      threads: db.query("SELECT COUNT(*) AS n FROM threads").get().n,
    };
    db.run("COMMIT");
    return kept;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function listTables(db) {
  return db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
}

function columnsOf(db, table) {
  return db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
}

function readLedgers(db) {
  const tables = listTables(db);
  return LEDGER_TABLES.map((table) =>
    tables.includes(table) ? db.query(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY 1`).all() : null,
  );
}

/** Emptying a denied parent would cascade into history, so history may reference only history. */
function assertHistoryReferencesOnlyHistory(db, history) {
  for (const table of history) {
    for (const foreignKey of db.query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()) {
      if (foreignKey.seq > 0) throw new Error(`Composite foreign keys are not supported: ${table}.`);
      if (!history.includes(foreignKey.table)) {
        throw new Error(`History table ${table} references denied table ${foreignKey.table}.`);
      }
    }
  }
}

/** Fills seed_keep_workspace and seed_keep_thread with the rows that survive. */
function selectKeptRows(db, maxWorkspaces, maxFamilies) {
  db.run("CREATE TEMP TABLE seed_keep_workspace (id TEXT PRIMARY KEY)");
  db.run("CREATE TEMP TABLE seed_keep_thread (id TEXT PRIMARY KEY)");

  // last_opened_at is epoch milliseconds while the other timestamps are ISO text.
  const workspaces = db
    .query(
      `SELECT w.id FROM workspaces w
       WHERE w.deleted_at IS NULL
       ORDER BY MAX(
         w.updated_at,
         COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', w.last_opened_at / 1000.0, 'unixepoch'), ''),
         COALESCE((SELECT MAX(t.updated_at) FROM threads t WHERE t.workspace_id = w.id AND t.deleted_at IS NULL), '')
       ) DESC, w.id
       LIMIT ?`,
    )
    .all(maxWorkspaces)
    .map((row) => row.id);
  const insertWorkspace = db.prepare("INSERT INTO seed_keep_workspace (id) VALUES (?)");
  const insertThread = db.prepare("INSERT INTO seed_keep_thread (id) VALUES (?)");
  const families = buildStoppedFamilies(db);
  for (const workspaceId of workspaces) {
    insertWorkspace.run(workspaceId);
    families
      .filter((family) => family.workspaceId === workspaceId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.rootId < b.rootId ? -1 : 1))
      .slice(0, maxFamilies)
      .forEach((family) => family.threadIds.forEach((id) => insertThread.run(id)));
  }
}

/**
 * Groups threads into families (forks, subagents, delegation) within one workspace and returns the
 * families with no live member. Legacy threads.status is not liveness: only canonical state is.
 */
function buildStoppedFamilies(db) {
  const rows = db
    .query(
      `SELECT t.id, t.workspace_id, t.updated_at, t.parent_thread_id, t.delegation_coordinator_thread_id,
              c.parent_thread_id AS canonical_parent, c.root_thread_id AS canonical_root,
              c.owning_parent_thread_id AS canonical_owner, c.activity_state,
              EXISTS (SELECT 1 FROM canonical_agent_turns turn
                      WHERE turn.thread_id = t.id AND turn.status NOT IN (${quoteList(TERMINAL_TURN_STATUSES)})) AS live_turn
       FROM threads t LEFT JOIN canonical_agent_threads c ON c.id = t.id
       WHERE t.deleted_at IS NULL`,
    )
    .all();
  const rootOf = familyRoots(rows);
  const families = new Map();
  for (const row of rows) {
    const rootId = rootOf(row.id);
    const family = families.get(rootId) ?? { rootId, workspaceId: row.workspace_id, updatedAt: "", threadIds: [], live: false };
    family.threadIds.push(row.id);
    if (row.updated_at > family.updatedAt) family.updatedAt = row.updated_at;
    family.live ||= isLive(row);
    families.set(rootId, family);
  }
  return [...families.values()].filter((family) => !family.live);
}

/** A thread is live unless its canonical state is known to be quiet; a thread with no canonical row is quiet. */
function isLive(row) {
  const quiet = row.activity_state === null || QUIESCENT_ACTIVITY_STATES.includes(row.activity_state);
  return Boolean(row.live_turn) || !quiet;
}

/** Union-find over every parent/root/coordinator link, ignoring links that leave the workspace. */
function familyRoots(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const leaderOf = new Map(rows.map((row) => [row.id, row.id]));
  const find = (id) => {
    while (leaderOf.get(id) !== id) {
      leaderOf.set(id, leaderOf.get(leaderOf.get(id)));
      id = leaderOf.get(id);
    }
    return id;
  };
  for (const row of rows) {
    const links = [row.parent_thread_id, row.delegation_coordinator_thread_id, row.canonical_parent, row.canonical_root, row.canonical_owner];
    for (const relative of links) {
      if (relative && byId.get(relative)?.workspace_id === row.workspace_id) leaderOf.set(find(row.id), find(relative));
    }
  }
  return find;
}

/** Drops history rows outside the kept set, then rows whose parents are gone. */
function pruneHistory(db, history) {
  db.run("DELETE FROM threads WHERE id NOT IN (SELECT id FROM seed_keep_thread)");
  db.run("DELETE FROM workspaces WHERE id NOT IN (SELECT id FROM seed_keep_workspace)");
  for (const table of history) {
    const columns = columnsOf(db, table).map((column) => column.name);
    const name = quoteIdentifier(table);
    if (columns.includes("thread_id")) {
      db.run(`DELETE FROM ${name} WHERE thread_id IS NOT NULL AND thread_id NOT IN (SELECT id FROM seed_keep_thread)`);
    }
    if (columns.includes("workspace_id")) {
      db.run(`DELETE FROM ${name} WHERE workspace_id IS NOT NULL AND workspace_id NOT IN (SELECT id FROM seed_keep_workspace)`);
    }
  }
  removeOrphans(db, history);
}

/**
 * Applies each foreign key's own delete action to rows whose parent is already missing in the donor, so
 * the copy is consistent even where the donor was not. Repeats because deleting a row can orphan its children.
 */
function removeOrphans(db, history) {
  let changes;
  do {
    changes = 0;
    for (const table of history) {
      const nullable = new Map(columnsOf(db, table).map((column) => [column.name, !column.notnull]));
      for (const foreignKey of db.query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()) {
        const child = quoteIdentifier(table);
        const from = quoteIdentifier(foreignKey.from);
        const dangling = `${from} IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM ${quoteIdentifier(foreignKey.table)} parent WHERE parent.${quoteIdentifier(foreignKey.to)} = ${child}.${from})`;
        const detach = foreignKey.on_delete !== "CASCADE" && nullable.get(foreignKey.from);
        changes += db.run(detach ? `UPDATE ${child} SET ${from} = NULL WHERE ${dangling}` : `DELETE FROM ${child} WHERE ${dangling}`).changes;
      }
    }
  } while (changes > 0);
}

/** Removes every binding that would let the development runtime resume, clean up, or act on a real checkout. */
function sanitizeKeptRows(db) {
  const threadColumns = columnsOf(db, "threads").map((column) => column.name);
  const cleared = [
    "sdk_session_id",
    "worktree_path",
    "pr_number",
    "pr_status",
    "scheduled_deletion_at",
    "cleanup_state",
    "cleanup_reason",
    "current_notice_session_id",
  ].filter((column) => threadColumns.includes(column));
  const assignments = [...cleared.map((column) => `${column} = NULL`), "worktree_managed = 0"];
  db.run(`UPDATE threads SET ${assignments.join(", ")}`);
  db.run("UPDATE canonical_agent_threads SET provider_identities_json = '[]'");
  db.run("UPDATE canonical_agent_turns SET provider_identities_json = '[]'");
  db.run("UPDATE plan_question_answers SET status = 'expired' WHERE status = 'pending'");
  db.run("UPDATE tool_call_records SET status = 'cancelled' WHERE status = 'running'");
}

function assertForeignKeysIntact(db) {
  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    const first = violations[0];
    throw new Error(`Seed filter left ${violations.length} foreign key violations, first in ${first.table} (rowid ${first.rowid}).`);
  }
}
