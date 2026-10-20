/**
 * SQLite database setup with the approved connection policy and Drizzle migrations.
 */

import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir, logger } from "@mcode/shared";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { bootstrapDrizzle } from "./bootstrap-drizzle.js";
import {
  applyRepair,
  assertLedgerMigratable,
  assertLedgerUsable,
  busyRefusalFor,
  classifyLedger,
  inspectDatabase,
  planMigrations,
  type DatabaseInspection,
  type MigrationPlan,
  type PresentInspection,
} from "./ledger-guard.js";
import {
  createMigrationBackup,
  pruneMigrationBackups,
  type MigrationBackupSpaceOptions,
} from "./migration-backup.js";
import {
  getMigrationCatalogue,
  migrationsFolderForDrizzle,
  type MigrationCatalogue,
} from "./migration-catalogue.js";
import { DatabaseStartupRefusal, rootCauseMessage } from "./startup-refusal.js";
import {
  applySQLiteConnectionPolicy,
  optimizeSQLiteConnection,
  SQLITE_BUSY_TIMEOUT_MS,
} from "./sqlite-connection-policy.js";

function hasSubagentIdentityMigration(migrationsDir: string | undefined): boolean {
  if (!migrationsDir || !NodeFS.existsSync(migrationsDir)) return false;
  return NodeFS.readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .some((name) => NodeFS.readFileSync(NodePath.join(migrationsDir, name), "utf8").includes("subagent_identity_key"));
}

/**
 * Adds columns that were retrofitted into migration 0000 after some databases
 * were already created. `bootstrapDrizzle` marks 0000 as done for any DB that
 * has the `workspaces` sentinel table, so these columns are never applied via
 * the normal migration path on pre-existing installs.
 *
 * Safe to run on fresh databases: the PRAGMA check is a no-op when the column
 * already exists. Safe under concurrent startup: if two processes both pass the
 * PRAGMA check and race to ALTER TABLE, the second will receive a
 * "duplicate column name" error which is swallowed — any other error is
 * rethrown. The optional migration directory lets a staged migration apply
 * through Drizzle before the legacy fallback runs.
 */
export function applySchemaPatches(db: Database, migrationsDir?: string): void {
  applyWorkspaceSchemaPatches(db);
  applyToolCallSchemaPatches(db, migrationsDir);
  applyMessageSchemaPatches(db);
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function addColumn(db: Database, table: string, columnSql: string): void {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
  }
}

function applyWorkspaceSchemaPatches(db: Database): void {
  const columns = tableColumns(db, "workspaces");
  if (columns.length === 0) return;
  if (!columns.includes("sort_order")) {
    addColumn(db, "workspaces", "sort_order INTEGER DEFAULT 0 NOT NULL");
  }
  normalizeWorkspaceSortOrder(db);
}

function normalizeWorkspaceSortOrder(db: Database): void {
  const distinctCount = (db.prepare("SELECT COUNT(DISTINCT sort_order) AS cnt FROM workspaces").get() as { cnt: number }).cnt;
  const totalCount = (db.prepare("SELECT COUNT(*) AS cnt FROM workspaces").get() as { cnt: number }).cnt;
  if (totalCount <= 1 || distinctCount >= totalCount) return;
  const ids = (db.prepare("SELECT id FROM workspaces ORDER BY sort_order ASC, created_at DESC, id ASC").all() as Array<{ id: string }>).map((row) => row.id);
  const statement = db.prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id, index) => statement.run(index, id)))();
}

function applyToolCallSchemaPatches(db: Database, migrationsDir: string | undefined): void {
  const columns = tableColumns(db, "tool_call_records");
  if (columns.length === 0) return;
  const patches = [
    ["output_truncated", "output_truncated INTEGER DEFAULT 0 NOT NULL"],
    ["output_total_bytes", "output_total_bytes INTEGER"],
    ["output_artifact_path", "output_artifact_path TEXT"],
    ["exit_code", "exit_code INTEGER"],
    ["display_name", "display_name TEXT"],
    ["provider_agent_key", "provider_agent_key TEXT"],
    ["model", "model TEXT"],
    ["reasoning_effort", "reasoning_effort TEXT"],
  ] as const;
  for (const [name, sql] of patches) {
    if (!columns.includes(name)) addColumn(db, "tool_call_records", sql);
  }
  if (!columns.includes("subagent_identity_key") && !hasSubagentIdentityMigration(migrationsDir)) {
    addColumn(db, "tool_call_records", "subagent_identity_key TEXT");
  }
}

function applyMessageSchemaPatches(db: Database): void {
  const columns = tableColumns(db, "messages");
  if (columns.length > 0 && !columns.includes("mentions")) {
    addColumn(db, "messages", "mentions TEXT");
  }
}

function readSchemaVersion(db: Database): number {
  const version = (db.query("PRAGMA schema_version").get() as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version !== "number") {
    throw new Error(`PRAGMA schema_version returned ${typeof version}, expected number.`);
  }
  return version;
}

/** How long a second launcher waits for another process's migration before reporting the database busy. */
const WRITE_LOCK_WAIT_MS = 30_000;

/** Options for a file-backed application database connection. */
export interface OpenDatabaseOptions {
  dbPath?: string;
  migrationBackupSpace?: MigrationBackupSpaceOptions;
  /** How long to wait for another connection's write transaction before refusing as busy. Tests shorten it. */
  writeLockWaitMs?: number;
  /**
   * Called after the read-only inspection and before the writable open. Tests change the file here
   * to stand in for another process, because a single thread cannot interleave two opens.
   */
  afterInspection?: () => void;
}

type ExecutablePlan = Exclude<MigrationPlan, { kind: "refuse" }>;

/**
 * Applies the migrations newer than the ledger's watermark exactly as Drizzle's own migrator does
 * (same table, same watermark rule, same statements), but without the migrator's private
 * BEGIN/COMMIT. That lets the caller put the repair, the migrations and the final checks in one
 * transaction, which the migrator cannot join.
 */
function applyPendingMigrations(db: Database, migrationsDir: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS \"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  const last = db.prepare("SELECT created_at FROM \"__drizzle_migrations\" ORDER BY created_at DESC LIMIT 1")
    .get() as { created_at: number } | null;
  const record = db.prepare("INSERT INTO \"__drizzle_migrations\" (\"hash\", \"created_at\") VALUES (?, ?)");
  for (const migration of readMigrationFiles({ migrationsFolder: migrationsFolderForDrizzle(migrationsDir) })) {
    if (last && Number(last.created_at) >= migration.folderMillis) continue;
    for (const statement of migration.sql) db.prepare(statement).run();
    record.run(migration.hash, migration.folderMillis);
  }
}

/** The steps of a plan. The caller supplies the transaction: nothing restores the file, so a failure at any step must leave the ledger as it was. */
function applyPlanSteps(db: Database, plan: ExecutablePlan, catalogue: MigrationCatalogue, databasePath: string): void {
  const dir = catalogue.directory;
  if (plan.kind === "migrate") {
    if (plan.baseline) bootstrapDrizzle(db, dir);
    if (plan.repair) {
      applyRepair(db, plan.repair, catalogue, databasePath);
      assertLedgerMigratable(db, catalogue, databasePath);
    }
    applyPendingMigrations(db, dir);
  }
  applySchemaPatches(db, dir);
  if (plan.kind === "migrate") assertLedgerUsable(db, catalogue, databasePath);
}

function applyPlan(db: Database, plan: ExecutablePlan, catalogue: MigrationCatalogue, databasePath: string): void {
  db.transaction(() => applyPlanSteps(db, plan, catalogue, databasePath)).immediate();
}

function planFor(inspection: DatabaseInspection, catalogue: MigrationCatalogue, databasePath: string): ExecutablePlan {
  const evidence = inspection.kind === "present" ? { inspection, catalogue } : undefined;
  const plan = planMigrations(classifyLedger(inspection, catalogue), databasePath, evidence);
  if (plan.kind === "refuse") throw new DatabaseStartupRefusal(plan.refusal);
  return plan;
}

/** What the write transaction reached, for turning its failure into the right refusal. */
interface WriteTransactionProgress {
  /** False while `BEGIN IMMEDIATE` is still waiting for another connection's write lock. */
  began: boolean;
  /** True once the backup is taken and migration steps may have run. */
  migrating: boolean;
  backupPath: string | null;
  /** The schema version after the pre-migration optimize, to tell whether the migration changed the schema. */
  schemaVersionBeforeMigrations: number;
}

/** An empty file has nothing worth recovering, so a first run takes no backup. */
function hasApplicationTables(inspection: PresentInspection): boolean {
  return inspection.schema.tables.size > 0;
}

/**
 * Runs inside the write transaction. SQLite's own write lock is the only cross-process lock: the
 * inspection is repeated here because the earlier read-only one may be stale by the time the lock
 * is won. The backup is a separate read-only connection, which in WAL mode reads the last
 * committed state, so it holds the pre-migration database even though this transaction is open.
 */
function applyUnderWriteLock(
  db: Database,
  catalogue: MigrationCatalogue,
  databasePath: string,
  opts: OpenDatabaseOptions | undefined,
  progress: WriteTransactionProgress,
): void {
  progress.began = true;
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  // Optimize can write statistics, so outside the transaction it would wait on another process's migration for only the short timeout.
  optimizeSQLiteConnection(db);
  progress.schemaVersionBeforeMigrations = readSchemaVersion(db);
  const inspection = inspectDatabase(db);
  const plan = planFor(inspection, catalogue, databasePath);
  if (plan.kind === "migrate" && hasApplicationTables(inspection)) {
    progress.backupPath = createMigrationBackup(databasePath, opts?.migrationBackupSpace);
  }
  progress.migrating = plan.kind === "migrate";
  applyPlanSteps(db, plan, catalogue, databasePath);
}

/** Only a failure of the migration itself is `migration-failed`: the file is as it was, and the backup is the way back. */
function writeTransactionFailure(error: unknown, progress: WriteTransactionProgress, databasePath: string): unknown {
  if (error instanceof DatabaseStartupRefusal) return error;
  if (!progress.began) return busyRefusalFor(error, databasePath) ?? error;
  if (!progress.migrating) return error;
  return new DatabaseStartupRefusal(
    { kind: "migration-failed", databasePath, sqliteMessage: rootCauseMessage(error), backupPath: progress.backupPath },
    { cause: error },
  );
}

/**
 * Takes SQLite's write lock, waiting for another connection to finish, then inspects, backs up and
 * migrates inside that one transaction. The long wait applies to `BEGIN IMMEDIATE` only: the body
 * restores the normal busy timeout as its first step.
 *
 * @returns The backup path (null when none was needed) and the schema version before the migration.
 */
function migrateUnderWriteLock(
  db: Database,
  catalogue: MigrationCatalogue,
  databasePath: string,
  opts: OpenDatabaseOptions | undefined,
): WriteTransactionProgress {
  const progress: WriteTransactionProgress = {
    began: false,
    migrating: false,
    backupPath: null,
    schemaVersionBeforeMigrations: 0,
  };
  db.run(`PRAGMA busy_timeout = ${opts?.writeLockWaitMs ?? WRITE_LOCK_WAIT_MS}`);
  try {
    db.transaction(() => applyUnderWriteLock(db, catalogue, databasePath, opts, progress)).immediate();
  } catch (error) {
    throw writeTransactionFailure(error, progress, databasePath);
  }
  return progress;
}

/** A leftover backup is clutter, not a reason to refuse a database that has already migrated. */
function pruneBackupsAfterMigration(databasePath: string): void {
  try {
    pruneMigrationBackups(databasePath);
  } catch (error) {
    logger.warn("Could not remove old migration backups", { databasePath, error: rootCauseMessage(error) });
  }
}

function closeAfterFailure(db: Database): void {
  try {
    db.close(true);
  } catch {
    // The original failure is the one worth reporting; the connection may already be unusable.
  }
}

function openAndMigrate(databasePath: string, catalogue: MigrationCatalogue, opts: OpenDatabaseOptions | undefined): Database {
  const db = new Database(databasePath, { strict: true });
  try {
    applySQLiteConnectionPolicy(db, true);
    const { backupPath, schemaVersionBeforeMigrations } = migrateUnderWriteLock(db, catalogue, databasePath, opts);
    if (readSchemaVersion(db) !== schemaVersionBeforeMigrations) optimizeSQLiteConnection(db);
    if (backupPath) pruneBackupsAfterMigration(databasePath);
  } catch (error) {
    closeAfterFailure(db);
    throw error;
  }
  return db;
}

/**
 * Open (or create) a SQLite database with WAL mode and foreign keys enabled,
 * then bring it to the current migration ledger.
 *
 * The file is inspected read-only first. A ledger this build cannot vouch for throws a
 * `DatabaseStartupRefusal` before any backup or writable open. Then a writable connection takes
 * SQLite's write lock (`BEGIN IMMEDIATE`), inspects again under it, and in the same transaction
 * backs up (when migrating) and applies the plan. A concurrent writer past the wait makes the
 * open refuse as `database-busy`. A database that needs no migration, including one a newer build
 * migrated whose compatibility floor allows this build, is opened with no backup and no ledger change.
 *
 * The path comes from `resolveDatabasePath`.
 */
export function openDatabase(opts?: OpenDatabaseOptions): Database {
  const resolvedPath = resolveDatabasePath(opts);
  const dir = NodePath.dirname(resolvedPath);
  if (!NodeFS.existsSync(dir)) NodeFS.mkdirSync(dir, { recursive: true });
  const catalogue = getMigrationCatalogue();
  planFor(inspectDatabase(resolvedPath), catalogue, resolvedPath);
  opts?.afterInspection?.();
  return openAndMigrate(resolvedPath, catalogue, opts);
}

/**
 * Resolve the application database filename without opening a writable connection:
 * the explicit option, then `MCODE_DB_PATH`, then `mcode.db` in the data directory.
 */
export function resolveDatabasePath(opts?: OpenDatabaseOptions): string {
  return opts?.dbPath ?? process.env.MCODE_DB_PATH ?? NodePath.join(getMcodeDir(), "mcode.db");
}

/**
 * Open an in-memory database for testing. Applies the same foreign keys
 * and migrations as a file-backed database.
 */
export function openMemoryDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  applySQLiteConnectionPolicy(db, false);
  try {
    const catalogue = getMigrationCatalogue();
    applyPlan(db, planFor(inspectDatabase(db), catalogue, ":memory:"), catalogue, ":memory:");
  } catch (err) {
    db.close(true);
    throw err;
  }
  return db;
}
