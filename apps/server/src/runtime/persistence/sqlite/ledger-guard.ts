import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import { lazySchema } from "@mcode/contracts/utils/lazySchema";
import { type StartupRefusal } from "@mcode/contracts/startup-failure";
import { z } from "zod";
import {
  reconcileSubagentIdentityMigration,
  SUBAGENT_IDENTITY_MIGRATION_TAG,
} from "./bootstrap-drizzle.js";
import type { MigrationCatalogue, SchemaObjectRef } from "./migration-catalogue.js";
import {
  hasConversationWriterAnchor,
  repairLostConversationWriterReceipts,
  REVIEWED_MIGRATION_TAGS,
} from "./migration-history-repair.js";
import { DatabaseStartupRefusal } from "./startup-refusal.js";

/** One row of `__drizzle_migrations`. `createdAt` is null when the stored value is not a number. */
export type LedgerReceipt = Readonly<{ hash: string; createdAt: number | null }>;

/** The compatibility floor a database records: the `when` of the newest migration a build must ship to open the database. */
export type LedgerFloor = Readonly<{ floorWhen: number; raisedBy: string }>;

/** A database that exists, read without writing. Names are lower-cased. */
export type PresentInspection = {
  kind: "present";
  receipts: readonly LedgerReceipt[];
  hasLedgerTable: boolean;
  /** Null when the database has no floor table, or the table holds no usable row. */
  floor: LedgerFloor | null;
  /** Application objects only: SQLite internals, the Drizzle ledger, and `_migrations` are left out. */
  schema: Readonly<{ tables: ReadonlySet<string>; indexes: ReadonlySet<string>; columns: ReadonlySet<string> }>;
};

/** What a database path holds. */
export type DatabaseInspection = { kind: "missing" } | PresentInspection;

/** How a database's ledger relates to the catalogue this build ships. */
export type LedgerVerdict =
  | { kind: "fresh" }
  | { kind: "legacy-unledgered" }
  | { kind: "current" }
  | { kind: "behind"; pending: string[] }
  /** Newer receipts this build does not know, and the database's floor allows this build to open it. */
  | { kind: "compatible-ahead"; unknownCount: number }
  /** A floor above this build, or newer receipts and no floor. `raisedBy` names the migration that raised the floor. */
  | { kind: "ahead"; unknownCount: number; raisedBy: string | null }
  | { kind: "unknown-history"; detail: string }
  | { kind: "hash-mismatch"; tag: string }
  | { kind: "gap"; missing: string[] }
  | { kind: "schema-ahead-of-ledger"; tags: string[] };

/** What a repair reads to decide that it covers a ledger: the inspection the verdict came from. */
export type RepairEvidence = Readonly<{ inspection: PresentInspection; catalogue: MigrationCatalogue }>;

/** A one-off fix for a ledger shape that shipped before this guard. */
export type LedgerRepair = Readonly<{
  name: string;
  /** True only for the exact verdict and evidence the repair certifies. */
  covers: (verdict: LedgerVerdict, evidence: RepairEvidence) => boolean;
  /** Runs inside {@link applyRepair}'s transaction, after the shape has been checked again. */
  apply: (db: Database, migrationsDir: string) => void;
}>;

/** What `openDatabase` does about a verdict. */
export type MigrationPlan =
  | { kind: "none" }
  | { kind: "migrate"; baseline: boolean; repair: LedgerRepair | null }
  | { kind: "refuse"; refusal: StartupRefusal };

const SYSTEM_TABLES: ReadonlySet<string> = new Set(["__drizzle_migrations", "_migrations"]);
const LEDGER_TABLE = "__drizzle_migrations";
const FLOOR_TABLE = "mcode_schema_compatibility";
/** A writer may hold the file briefly while it checkpoints or closes. */
const INSPECTION_BUSY_TIMEOUT_MS = 5000;

const masterRowsSchema = lazySchema(() => z.array(z.object({ type: z.string(), name: z.string() })));
const columnRowsSchema = lazySchema(() => z.array(z.object({ tbl: z.string(), col: z.string() })));
const receiptRowsSchema = lazySchema(() => z.array(z.object({
  hash: z.string(),
  created_at: z.union([z.number(), z.string(), z.null()]),
})));
const floorRowSchema = lazySchema(() => z.object({ floor_when: z.number(), raised_by: z.string() }));

function isApplicationTable(name: string): boolean {
  return !name.startsWith("sqlite_") && !SYSTEM_TABLES.has(name);
}

function readSchema(db: Database): { tables: Set<string>; indexes: Set<string>; columns: Set<string>; hasLedgerTable: boolean } {
  const objects = masterRowsSchema().parse(db.query("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')").all());
  const names = (type: string): string[] => objects.filter((row) => row.type === type).map((row) => row.name.toLowerCase());
  const tables = new Set(names("table").filter(isApplicationTable));
  const columnRows = columnRowsSchema().parse(db.query(
    "SELECT m.name AS tbl, p.name AS col FROM sqlite_master AS m, pragma_table_info(m.name) AS p WHERE m.type = 'table'",
  ).all());
  const columns = new Set(columnRows.filter((row) => tables.has(row.tbl.toLowerCase()))
    .map((row) => `${row.tbl.toLowerCase()}.${row.col.toLowerCase()}`));
  return { tables, indexes: new Set(names("index")), columns, hasLedgerTable: names("table").includes(LEDGER_TABLE) };
}

function readReceipts(db: Database): LedgerReceipt[] {
  return receiptRowsSchema().parse(db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all())
    .map((row) => ({ hash: row.hash, createdAt: typeof row.created_at === "number" ? row.created_at : null }));
}

/** An unusable floor row counts as no floor, so a newer database is refused rather than trusted. */
function readFloor(db: Database, tables: ReadonlySet<string>): LedgerFloor | null {
  if (!tables.has(FLOOR_TABLE)) return null;
  const row = floorRowSchema().safeParse(db.query(`SELECT floor_when, raised_by FROM ${FLOOR_TABLE} LIMIT 1`).get());
  return row.success ? { floorWhen: row.data.floor_when, raisedBy: row.data.raised_by } : null;
}

function inspectConnection(db: Database): PresentInspection {
  const { hasLedgerTable, ...schema } = readSchema(db);
  return {
    kind: "present",
    receipts: hasLedgerTable ? readReceipts(db) : [],
    hasLedgerTable,
    floor: readFloor(db, schema.tables),
    schema,
  };
}

function sqliteCodeOf(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" && error.code.startsWith("SQLITE_") ? error.code : null;
}

/**
 * `database-busy` when another connection held the database past the busy timeout, else null.
 * `SQLITE_LOCKED` counts too: it is the same "someone else is using it right now" for a caller.
 */
export function busyRefusalFor(error: unknown, databasePath: string): DatabaseStartupRefusal | null {
  const code = sqliteCodeOf(error);
  if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") return null;
  return new DatabaseStartupRefusal({ kind: "database-busy", databasePath }, { cause: error });
}

function refusalForReadFailure(error: unknown, databasePath: string): DatabaseStartupRefusal | null {
  const busy = busyRefusalFor(error, databasePath);
  if (busy) return busy;
  const code = sqliteCodeOf(error);
  if (code === null || !(error instanceof Error)) return null;
  return new DatabaseStartupRefusal(
    { kind: "database-unreadable", databasePath, detail: `${error.message} (${code}).` },
    { cause: error },
  );
}

/**
 * Read a database's ledger, floor and schema without writing to it.
 *
 * @param source A database file path, or an open connection (for example an in-memory database).
 * A path is opened read-only and closed again; a connection is only read.
 * @throws DatabaseStartupRefusal `database-unreadable` when the file cannot be opened or read as a
 * database, `database-busy` when another connection held it past the busy timeout.
 */
export function inspectDatabase(source: Database): PresentInspection;
export function inspectDatabase(source: string): DatabaseInspection;
export function inspectDatabase(source: string | Database): DatabaseInspection {
  if (typeof source !== "string") return inspectConnection(source);
  if (!NodeFS.existsSync(source)) return { kind: "missing" };
  try {
    const db = new Database(source, { readonly: true, strict: true });
    try {
      db.run(`PRAGMA busy_timeout = ${INSPECTION_BUSY_TIMEOUT_MS}`);
      return inspectConnection(db);
    } finally {
      db.close(true);
    }
  } catch (error) {
    throw refusalForReadFailure(error, source) ?? error;
  }
}

function objectExists(schema: PresentInspection["schema"], ref: SchemaObjectRef): boolean {
  if (ref.kind === "table") return schema.tables.has(ref.name);
  if (ref.kind === "index") return schema.indexes.has(ref.name);
  return schema.columns.has(`${ref.table}.${ref.column}`);
}

/** `bootstrapDrizzle` records only the first migration, so any other shape would be replayed over tables that already exist. */
function isPreLedgerShape(schema: PresentInspection["schema"], catalogue: MigrationCatalogue): boolean {
  const [baseline, ...later] = catalogue.entries;
  if (!baseline || baseline.creates.length === 0) return false;
  return baseline.creates.every((ref) => objectExists(schema, ref))
    && !later.some((entry) => entry.creates.some((ref) => objectExists(schema, ref)));
}

function classifyUnledgered(inspection: PresentInspection, catalogue: MigrationCatalogue): LedgerVerdict {
  if (inspection.schema.tables.size === 0) return { kind: "fresh" };
  return isPreLedgerShape(inspection.schema, catalogue)
    ? { kind: "legacy-unledgered" }
    : { kind: "unknown-history", detail: "It has tables but no record of which migrations created them." };
}

function knownReceipts(receipts: readonly LedgerReceipt[], catalogue: MigrationCatalogue): LedgerReceipt[] {
  return receipts.filter((receipt) => receipt.createdAt !== null && catalogue.byWhen.has(receipt.createdAt));
}

function classifyKnownPrefix(
  receipts: readonly LedgerReceipt[],
  catalogue: MigrationCatalogue,
): Extract<LedgerVerdict, { kind: "unknown-history" | "hash-mismatch" }> | null {
  const known = knownReceipts(receipts, catalogue);
  const seen = new Set<number | null>();
  for (const receipt of known) {
    if (seen.has(receipt.createdAt)) {
      return { kind: "unknown-history", detail: `Two records claim the same migration (timestamp ${receipt.createdAt}).` };
    }
    seen.add(receipt.createdAt);
  }
  const mismatched = known.map((receipt) => ({ receipt, entry: catalogue.byWhen.get(receipt.createdAt ?? -1) }))
    .find(({ receipt, entry }) => entry && !entry.hashes.has(receipt.hash));
  return mismatched?.entry ? { kind: "hash-mismatch", tag: mismatched.entry.tag } : null;
}

function unrecordedEntries(receipts: readonly LedgerReceipt[], catalogue: MigrationCatalogue) {
  const recorded = new Set(receipts.map((receipt) => receipt.createdAt));
  return catalogue.entries.filter((entry) => !recorded.has(entry.when));
}

function classifyGap(receipts: readonly LedgerReceipt[], catalogue: MigrationCatalogue): Extract<LedgerVerdict, { kind: "gap" }> | null {
  const newestRecorded = receipts.reduce((newest, receipt) => Math.max(newest, receipt.createdAt ?? 0), 0);
  const missing = unrecordedEntries(receipts, catalogue).filter((entry) => entry.when < newestRecorded);
  return missing.length > 0 ? { kind: "gap", missing: missing.map((entry) => entry.tag) } : null;
}

function unknownReceipts(receipts: readonly LedgerReceipt[], catalogue: MigrationCatalogue): LedgerReceipt[] {
  const known = new Set(knownReceipts(receipts, catalogue));
  return receipts.filter((receipt) => !known.has(receipt));
}

/**
 * A floor above this build's newest migration means a newer build broke something this build
 * reads. It holds whether or not the newer build's receipts are present: a ledger that lost them
 * must not turn the floor into a pass.
 */
function classifyRaisedFloor(
  inspection: PresentInspection,
  catalogue: MigrationCatalogue,
): Extract<LedgerVerdict, { kind: "ahead" }> | null {
  const { floor } = inspection;
  if (!floor || floor.floorWhen <= catalogue.newestWhen) return null;
  return { kind: "ahead", unknownCount: unknownReceipts(inspection.receipts, catalogue).length, raisedBy: floor.raisedBy };
}

function classifyUnknownReceipts(
  inspection: PresentInspection,
  catalogue: MigrationCatalogue,
): Extract<LedgerVerdict, { kind: "compatible-ahead" | "ahead" | "unknown-history" }> | null {
  const unknown = unknownReceipts(inspection.receipts, catalogue);
  if (unknown.length === 0) return null;
  const allNewer = unknown.every((receipt) => receipt.createdAt !== null && receipt.createdAt > catalogue.newestWhen);
  if (!allNewer) {
    return { kind: "unknown-history", detail: `${unknown.length} recorded migration(s) are not part of this version, and some are older than its newest migration.` };
  }
  const { floor } = inspection;
  return floor && floor.floorWhen <= catalogue.newestWhen
    ? { kind: "compatible-ahead", unknownCount: unknown.length }
    : { kind: "ahead", unknownCount: unknown.length, raisedBy: floor?.raisedBy ?? null };
}

function classifyAgainstCatalogue(inspection: PresentInspection, catalogue: MigrationCatalogue): LedgerVerdict {
  const unrecorded = unrecordedEntries(inspection.receipts, catalogue);
  const alreadyThere = unrecorded.filter((entry) => entry.creates.some((ref) => objectExists(inspection.schema, ref)));
  if (alreadyThere.length > 0) return { kind: "schema-ahead-of-ledger", tags: alreadyThere.map((entry) => entry.tag) };
  return unrecorded.length > 0 ? { kind: "behind", pending: unrecorded.map((entry) => entry.tag) } : { kind: "current" };
}

/**
 * Compare a database with the catalogue. Pure: the first matching rule wins, in the order
 * missing or empty, unledgered, then the receipts this build knows (duplicates, hash mismatch),
 * gap, a floor above this build, receipts it does not know (inside the range, or newer and
 * decided by the floor), schema ahead of the ledger, behind, current. Damage to the known prefix
 * is therefore always reported ahead of a newer receipt or floor.
 */
export function classifyLedger(inspection: DatabaseInspection, catalogue: MigrationCatalogue): LedgerVerdict {
  if (inspection.kind === "missing") return { kind: "fresh" };
  if (inspection.receipts.length === 0) return classifyUnledgered(inspection, catalogue);
  return classifyKnownPrefix(inspection.receipts, catalogue)
    ?? classifyGap(inspection.receipts, catalogue)
    ?? classifyRaisedFloor(inspection, catalogue)
    ?? classifyUnknownReceipts(inspection, catalogue)
    ?? classifyAgainstCatalogue(inspection, catalogue);
}

function sameTags(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((tag) => actual.includes(tag));
}

function isSubset(tags: readonly string[], allowed: readonly string[]): boolean {
  return tags.length > 0 && tags.every((tag) => allowed.includes(tag));
}

function hasAllCreatedObjects(evidence: RepairEvidence, tag: string): boolean {
  const entry = evidence.catalogue.entries.find((candidate) => candidate.tag === tag);
  return entry !== undefined && entry.creates.length > 0
    && entry.creates.every((ref) => objectExists(evidence.inspection.schema, ref));
}

/**
 * The only repairs this build trusts. Each one covers exactly the verdict and evidence it
 * certifies; a new damaged-ledger shape is refused until someone reviews it and adds a row here.
 */
export const LEDGER_REPAIRS: readonly LedgerRepair[] = [
  {
    name: "0042 subagent identity receipt",
    covers: (verdict, evidence) => verdict.kind === "schema-ahead-of-ledger"
      && sameTags(verdict.tags, [SUBAGENT_IDENTITY_MIGRATION_TAG])
      && hasAllCreatedObjects(evidence, SUBAGENT_IDENTITY_MIGRATION_TAG),
    apply: reconcileSubagentIdentityMigration,
  },
  {
    name: "0061-0066 conversation writer receipts",
    covers: (verdict, evidence) => hasConversationWriterAnchor(evidence.inspection.receipts)
      && ((verdict.kind === "schema-ahead-of-ledger" && sameTags(verdict.tags, REVIEWED_MIGRATION_TAGS))
        || (verdict.kind === "gap" && isSubset(verdict.missing, REVIEWED_MIGRATION_TAGS))),
    apply: repairLostConversationWriterReceipts,
  },
];

function damagedTags(verdict: LedgerVerdict): string[] | null {
  switch (verdict.kind) {
    case "gap":
      return verdict.missing;
    case "schema-ahead-of-ledger":
      return verdict.tags;
    case "behind":
      return verdict.pending;
    default:
      return null;
  }
}

function refusalFor(verdict: LedgerVerdict, databasePath: string): StartupRefusal {
  switch (verdict.kind) {
    case "ahead":
      return { kind: "database-newer", databasePath, raisedBy: verdict.raisedBy };
    case "unknown-history":
      return { kind: "database-unknown-history", databasePath, detail: verdict.detail };
    case "hash-mismatch":
      return { kind: "migration-mismatch", databasePath, tag: verdict.tag };
    default: {
      const tags = damagedTags(verdict);
      return tags
        ? { kind: "ledger-damaged", databasePath, tags }
        : { kind: "database-unknown-history", databasePath, detail: `The update history still looked ${verdict.kind} after Mcode updated it.` };
    }
  }
}

/**
 * The plan for a verdict. One row per verdict kind; a damaged ledger migrates only when a
 * registered repair covers it.
 *
 * @param evidence What the verdict was computed from. Without it no repair can cover a damaged ledger.
 * @param repairs Injectable for tests. Production uses {@link LEDGER_REPAIRS}.
 */
export function planMigrations(
  verdict: LedgerVerdict,
  databasePath: string,
  evidence?: RepairEvidence,
  repairs: readonly LedgerRepair[] = LEDGER_REPAIRS,
): MigrationPlan {
  switch (verdict.kind) {
    case "current":
    case "compatible-ahead":
      return { kind: "none" };
    case "fresh":
    case "behind":
      return { kind: "migrate", baseline: false, repair: null };
    case "legacy-unledgered":
      return { kind: "migrate", baseline: true, repair: null };
    case "gap":
    case "schema-ahead-of-ledger":
      return planRepair(verdict, databasePath, evidence, repairs);
    default:
      return { kind: "refuse", refusal: refusalFor(verdict, databasePath) };
  }
}

function planRepair(
  verdict: LedgerVerdict,
  databasePath: string,
  evidence: RepairEvidence | undefined,
  repairs: readonly LedgerRepair[],
): MigrationPlan {
  const repair = evidence ? repairs.find((candidate) => candidate.covers(verdict, evidence)) : undefined;
  return repair
    ? { kind: "migrate", baseline: false, repair }
    : { kind: "refuse", refusal: refusalFor(verdict, databasePath) };
}

/**
 * Run a repair in its own write transaction after proving, inside that transaction, that the
 * repair still covers the database. The plan was made from a read-only inspection; another
 * process may have changed the ledger since, and a repair must not run on a shape it never saw.
 *
 * @throws DatabaseStartupRefusal `database-unknown-history` when the shape changed; nothing is written.
 */
export function applyRepair(db: Database, repair: LedgerRepair, catalogue: MigrationCatalogue, databasePath: string): void {
  db.transaction(() => {
    const inspection = inspectDatabase(db);
    if (!repair.covers(classifyLedger(inspection, catalogue), { inspection, catalogue })) {
      throw new DatabaseStartupRefusal({
        kind: "database-unknown-history",
        databasePath,
        detail: "The update history changed while Mcode was about to repair it, so nothing was changed.",
      });
    }
    repair.apply(db, catalogue.directory);
  }).immediate();
}

function assertVerdictIn(
  db: Database,
  catalogue: MigrationCatalogue,
  databasePath: string,
  accepted: readonly LedgerVerdict["kind"][],
): void {
  const verdict = classifyLedger(inspectDatabase(db), catalogue);
  if (!accepted.includes(verdict.kind)) throw new DatabaseStartupRefusal(refusalFor(verdict, databasePath));
}

/**
 * Re-classify an open database and refuse unless this build may run on it: every migration is
 * recorded, or newer receipts are recorded and the floor permits this build. After a migrate,
 * anything else means the guard and the migrator disagree, which is a bug to surface.
 */
export function assertLedgerUsable(db: Database, catalogue: MigrationCatalogue, databasePath: string): void {
  assertVerdictIn(db, catalogue, databasePath, ["current", "compatible-ahead"]);
}

/**
 * Refuse unless the ledger can be migrated forward by Drizzle. Run after a repair so a repair that
 * did not produce the shape it certified stops before the migrator runs on a damaged ledger.
 */
export function assertLedgerMigratable(db: Database, catalogue: MigrationCatalogue, databasePath: string): void {
  assertVerdictIn(db, catalogue, databasePath, ["behind", "current"]);
}
