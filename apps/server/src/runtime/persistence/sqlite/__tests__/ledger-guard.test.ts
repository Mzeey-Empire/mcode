import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyRepair,
  classifyLedger,
  inspectDatabase,
  LEDGER_REPAIRS,
  planMigrations,
  type LedgerFloor,
  type LedgerReceipt,
  type PresentInspection,
  type RepairEvidence,
} from "../ledger-guard.js";
import {
  loadMigrationCatalogue,
  migrationsFolderForDrizzle,
  type CatalogueMigration,
  type MigrationCatalogue,
} from "../migration-catalogue.js";
import { DatabaseStartupRefusal } from "../startup-refusal.js";

const sourceCatalogue = NodePath.join(process.cwd(), "drizzle");
const catalogue = loadMigrationCatalogue(sourceCatalogue);
const lastIndex = catalogue.entries.at(-1)?.index ?? 0;

function entryAt(index: number): CatalogueMigration {
  const entry = catalogue.entries.find((candidate) => candidate.index === index);
  if (!entry) throw new Error(`No catalogue entry ${index}`);
  return entry;
}

function receiptFor(entry: CatalogueMigration): LedgerReceipt {
  return { hash: entry.hash, createdAt: entry.when };
}

type SchemaNames = { tables: string[]; indexes: string[]; columns: string[] };

function schemaCreatedBy(...entries: CatalogueMigration[]): SchemaNames {
  const refs = entries.flatMap((entry) => entry.creates);
  return {
    tables: refs.flatMap((ref) => (ref.kind === "table" ? [ref.name] : [])),
    indexes: refs.flatMap((ref) => (ref.kind === "index" ? [ref.name] : [])),
    columns: refs.flatMap((ref) => (ref.kind === "column" ? [`${ref.table}.${ref.column}`] : [])),
  };
}

function present(
  receipts: readonly LedgerReceipt[],
  options: Partial<SchemaNames> & { floor?: LedgerFloor } = {},
): PresentInspection {
  return {
    kind: "present",
    receipts,
    hasLedgerTable: receipts.length > 0,
    floor: options.floor ?? null,
    schema: {
      tables: new Set(options.tables ?? ["threads"]),
      indexes: new Set(options.indexes ?? []),
      columns: new Set(options.columns ?? []),
    },
  };
}

function receiptsUpTo(lastReceiptIndex: number): LedgerReceipt[] {
  return catalogue.entries.filter((entry) => entry.index <= lastReceiptIndex).map(receiptFor);
}

function tamperedAt(receipts: readonly LedgerReceipt[], entry: CatalogueMigration): LedgerReceipt[] {
  return receipts.map((receipt) => (receipt.createdAt === entry.when ? { ...receipt, hash: "edited" } : receipt));
}

const newerReceipt: LedgerReceipt = { hash: "later-build", createdAt: catalogue.newestWhen + 1 };
const anchorReceipt: LedgerReceipt = {
  hash: "8bfd22072f8ab59b8faa2e8812fba89d9b3a999054f84bb1ae425b7453e94277",
  createdAt: 1789133181264,
};

describe("classifyLedger", () => {
  it("treats a missing file and an empty database as fresh", () => {
    expect(classifyLedger({ kind: "missing" }, catalogue)).toEqual({ kind: "fresh" });
    expect(classifyLedger(present([], { tables: [] }), catalogue)).toEqual({ kind: "fresh" });
  });

  it("baselines only the exact shape that existed before the ledger", () => {
    const baseline = entryAt(0);
    const legacy = schemaCreatedBy(baseline);
    expect(legacy.tables).toContain("workspaces");
    expect(classifyLedger(present([], legacy), catalogue)).toEqual({ kind: "legacy-unledgered" });
    expect(classifyLedger(present([], { tables: ["records"] }), catalogue)).toMatchObject({ kind: "unknown-history" });
  });

  it("refuses an unledgered database that holds a later migration's table, or lacks a baseline table", () => {
    const legacy = schemaCreatedBy(entryAt(0));
    const laterTable = catalogue.entries.slice(1).flatMap((entry) => entry.creates).find((ref) => ref.kind === "table");
    if (laterTable?.kind !== "table") throw new Error("Expected a later migration that creates a table");
    const withLaterTable = { ...legacy, tables: [...legacy.tables, laterTable.name] };
    expect(classifyLedger(present([], withLaterTable), catalogue)).toMatchObject({ kind: "unknown-history" });
    const withoutWorkspaces = { ...legacy, tables: legacy.tables.filter((table) => table !== "workspaces") };
    expect(classifyLedger(present([], withoutWorkspaces), catalogue)).toMatchObject({ kind: "unknown-history" });
  });

  it("refuses two receipts for the same migration", () => {
    const first = receiptFor(entryAt(3));
    expect(classifyLedger(present([...receiptsUpTo(5), first]), catalogue))
      .toMatchObject({ kind: "unknown-history", detail: expect.stringContaining("same migration") });
  });

  it("refuses an unknown receipt inside the range this build knows", () => {
    const inside: LedgerReceipt = { hash: "other-build", createdAt: entryAt(30).when + 1 };
    expect(classifyLedger(present([...receiptsUpTo(40), inside]), catalogue))
      .toMatchObject({ kind: "unknown-history" });
    expect(classifyLedger(present([...receiptsUpTo(40), { hash: "no-time", createdAt: null }]), catalogue))
      .toMatchObject({ kind: "unknown-history" });
  });

  it("opens a newer database only when its floor is at or below this build", () => {
    const receipts = [...receiptsUpTo(lastIndex), newerReceipt];
    const atBuild: LedgerFloor = { floorWhen: catalogue.newestWhen, raisedBy: entryAt(lastIndex).tag };
    expect(classifyLedger(present(receipts, { floor: atBuild }), catalogue))
      .toEqual({ kind: "compatible-ahead", unknownCount: 1 });
    expect(classifyLedger(present(receipts), catalogue))
      .toEqual({ kind: "ahead", unknownCount: 1, raisedBy: null });
    const aboveBuild: LedgerFloor = { floorWhen: catalogue.newestWhen + 1, raisedBy: "9999_future_contract" };
    expect(classifyLedger(present(receipts, { floor: aboveBuild }), catalogue))
      .toEqual({ kind: "ahead", unknownCount: 1, raisedBy: "9999_future_contract" });
  });

  it("refuses a floor above this build even when the newer receipts are gone", () => {
    const aboveBuild: LedgerFloor = { floorWhen: catalogue.newestWhen + 1, raisedBy: "9999_future_contract" };
    expect(classifyLedger(present(receiptsUpTo(lastIndex), { floor: aboveBuild }), catalogue))
      .toEqual({ kind: "ahead", unknownCount: 0, raisedBy: "9999_future_contract" });
    const withHole = receiptsUpTo(lastIndex).filter((receipt) => receipt.createdAt !== entryAt(55).when);
    expect(classifyLedger(present(withHole, { floor: aboveBuild }), catalogue))
      .toEqual({ kind: "gap", missing: [entryAt(55).tag] });
  });

  it("reports damage to the receipts it knows before a newer receipt", () => {
    const tampered = tamperedAt(receiptsUpTo(60), entryAt(50));
    expect(classifyLedger(present([...tampered, newerReceipt]), catalogue))
      .toEqual({ kind: "hash-mismatch", tag: entryAt(50).tag });
    expect(classifyLedger(present([...receiptsUpTo(5), receiptFor(entryAt(3)), newerReceipt]), catalogue))
      .toMatchObject({ kind: "unknown-history", detail: expect.stringContaining("same migration") });
    const withHole = receiptsUpTo(lastIndex).filter((receipt) => receipt.createdAt !== entryAt(55).when);
    expect(classifyLedger(present([...withHole, newerReceipt]), catalogue))
      .toEqual({ kind: "gap", missing: [entryAt(55).tag] });
  });

  it("refuses an unknown receipt inside the range even when a newer one is also there", () => {
    const inside: LedgerReceipt = { hash: "other-build", createdAt: entryAt(30).when + 1 };
    expect(classifyLedger(present([...receiptsUpTo(lastIndex), inside, newerReceipt]), catalogue))
      .toMatchObject({ kind: "unknown-history" });
  });

  it("names the migration whose recorded SQL differs", () => {
    expect(classifyLedger(present(tamperedAt(receiptsUpTo(60), entryAt(50))), catalogue))
      .toEqual({ kind: "hash-mismatch", tag: entryAt(50).tag });
  });

  it("accepts the LF and CRLF spellings of a recorded migration", () => {
    const multiLine = catalogue.entries.find((entry) => entry.hashes.size > 1);
    if (!multiLine) throw new Error("Expected a migration whose LF and CRLF spellings differ");
    const otherSpelling = [...multiLine.hashes].find((hash) => hash !== multiLine.hash) ?? "";
    const respelled = receiptsUpTo(lastIndex).map((receipt) => receipt.createdAt === multiLine.when ? { ...receipt, hash: otherSpelling } : receipt);
    expect(classifyLedger(present(respelled), catalogue)).toEqual({ kind: "current" });
  });

  it("reports an interior migration without a receipt as a gap, whatever the schema holds", () => {
    const withoutOne = receiptsUpTo(lastIndex).filter((receipt) => receipt.createdAt !== entryAt(55).when);
    expect(classifyLedger(present(withoutOne), catalogue)).toEqual({ kind: "gap", missing: [entryAt(55).tag] });
  });

  it("reports pending migrations whose objects already exist as schema ahead of the ledger", () => {
    const tail = [entryAt(90), entryAt(91)];
    const schema = { columns: ["project_action_runs.port_json", "workspace_environment_automatic_setup_attempts.failed_action_id"] };
    expect(classifyLedger(present(receiptsUpTo(89), schema), catalogue))
      .toEqual({ kind: "schema-ahead-of-ledger", tags: tail.map((entry) => entry.tag) });
  });

  it("is behind, not damaged, when pending migrations have not touched the schema", () => {
    const pending = catalogue.entries.filter((entry) => entry.index >= 89).map((entry) => entry.tag);
    expect(classifyLedger(present(receiptsUpTo(88)), catalogue)).toEqual({ kind: "behind", pending });
  });

  it("is current when every migration is recorded", () => {
    expect(classifyLedger(present(receiptsUpTo(lastIndex)), catalogue)).toEqual({ kind: "current" });
  });
});

describe("planMigrations", () => {
  const path = "/data/mcode.db";
  const tagsOf = (first: number, last: number): string[] =>
    catalogue.entries.filter((entry) => entry.index >= first && entry.index <= last).map((entry) => entry.tag);
  const evidenceWith = (receipts: readonly LedgerReceipt[], schema: Partial<SchemaNames> = {}): RepairEvidence =>
    ({ inspection: present(receipts, schema), catalogue });

  it("migrates what is provably old and leaves a current or compatible database alone", () => {
    expect(planMigrations({ kind: "current" }, path)).toEqual({ kind: "none" });
    expect(planMigrations({ kind: "compatible-ahead", unknownCount: 2 }, path)).toEqual({ kind: "none" });
    expect(planMigrations({ kind: "fresh" }, path)).toEqual({ kind: "migrate", baseline: false, repair: null });
    expect(planMigrations({ kind: "behind", pending: [] }, path)).toEqual({ kind: "migrate", baseline: false, repair: null });
    expect(planMigrations({ kind: "legacy-unledgered" }, path)).toEqual({ kind: "migrate", baseline: true, repair: null });
  });

  it("refuses a newer, unknown, or mismatched database with the matching reason", () => {
    expect(planMigrations({ kind: "ahead", unknownCount: 2, raisedBy: "0099_x" }, path))
      .toEqual({ kind: "refuse", refusal: { kind: "database-newer", databasePath: path, raisedBy: "0099_x" } });
    expect(planMigrations({ kind: "ahead", unknownCount: 2, raisedBy: null }, path))
      .toEqual({ kind: "refuse", refusal: { kind: "database-newer", databasePath: path, raisedBy: null } });
    expect(planMigrations({ kind: "unknown-history", detail: "why" }, path))
      .toEqual({ kind: "refuse", refusal: { kind: "database-unknown-history", databasePath: path, detail: "why" } });
    expect(planMigrations({ kind: "hash-mismatch", tag: "0050_x" }, path))
      .toEqual({ kind: "refuse", refusal: { kind: "migration-mismatch", databasePath: path, tag: "0050_x" } });
  });

  it("repairs only the exact ledger shapes it has reviewed", () => {
    const anchored = evidenceWith([anchorReceipt]);
    const lostWindow = planMigrations({ kind: "schema-ahead-of-ledger", tags: tagsOf(61, 66) }, path, anchored);
    expect(lostWindow).toMatchObject({ kind: "migrate", repair: { name: expect.stringContaining("0061") } });
    expect(planMigrations({ kind: "gap", missing: tagsOf(63, 64) }, path, anchored)).toMatchObject({ kind: "migrate" });
    const subagent = evidenceWith(receiptsUpTo(41), schemaCreatedBy(entryAt(42)));
    expect(planMigrations({ kind: "schema-ahead-of-ledger", tags: [entryAt(42).tag] }, path, subagent))
      .toMatchObject({ kind: "migrate", repair: { name: expect.stringContaining("0042") } });
    expect(LEDGER_REPAIRS).toHaveLength(2);
  });

  it("does not repair a shape whose evidence the repair does not certify", () => {
    const window = { kind: "schema-ahead-of-ledger", tags: tagsOf(61, 66) } as const;
    expect(planMigrations(window, path)).toMatchObject({ kind: "refuse", refusal: { kind: "ledger-damaged" } });
    expect(planMigrations(window, path, evidenceWith(receiptsUpTo(40)))).toMatchObject({ kind: "refuse" });
    expect(planMigrations({ kind: "schema-ahead-of-ledger", tags: [entryAt(42).tag] }, path, evidenceWith(receiptsUpTo(41))))
      .toMatchObject({ kind: "refuse", refusal: { kind: "ledger-damaged" } });
  });

  it("refuses the incident, where the lost receipts reach past the reviewed window", () => {
    const incident = tagsOf(61, 68);
    const anchored = evidenceWith([anchorReceipt]);
    expect(planMigrations({ kind: "gap", missing: incident }, path, anchored))
      .toEqual({ kind: "refuse", refusal: { kind: "ledger-damaged", databasePath: path, tags: incident } });
    expect(planMigrations({ kind: "schema-ahead-of-ledger", tags: tagsOf(61, 67) }, path, anchored))
      .toMatchObject({ kind: "refuse", refusal: { kind: "ledger-damaged" } });
    expect(planMigrations({ kind: "gap", missing: [entryAt(55).tag] }, path, anchored))
      .toMatchObject({ kind: "refuse", refusal: { kind: "ledger-damaged" } });
  });
});

describe("applyRepair", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
  });

  function databaseMissingThe0042Receipt(): { db: Database; truncated: MigrationCatalogue } {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-apply-repair-"));
    roots.push(root);
    NodeFS.mkdirSync(NodePath.join(root, "meta"));
    const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
      NodeFS.readFileSync(NodePath.join(sourceCatalogue, "meta", "_journal.json"), "utf8"),
    );
    const kept = journal.entries.filter((entry) => entry.idx <= 42);
    for (const entry of kept) NodeFS.copyFileSync(NodePath.join(sourceCatalogue, `${entry.tag}.sql`), NodePath.join(root, `${entry.tag}.sql`));
    NodeFS.writeFileSync(NodePath.join(root, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
    const db = new Database(":memory:", { strict: true });
    migrate(drizzle(db), { migrationsFolder: migrationsFolderForDrizzle(root) });
    db.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(entryAt(42).when);
    return { db, truncated: loadMigrationCatalogue(root) };
  }

  const ledgerOf = (db: Database): unknown[] => db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all();

  function plannedRepair(db: Database, truncated: MigrationCatalogue) {
    const inspection = inspectDatabase(db);
    const plan = planMigrations(classifyLedger(inspection, truncated), "/data/mcode.db", { inspection, catalogue: truncated });
    if (plan.kind !== "migrate" || !plan.repair) throw new Error(`Expected a repair, got ${plan.kind}`);
    return plan.repair;
  }

  it("restores the receipt when the shape is still the one that was planned", () => {
    const { db, truncated } = databaseMissingThe0042Receipt();
    try {
      applyRepair(db, plannedRepair(db, truncated), truncated, "/data/mcode.db");
      expect(classifyLedger(inspectDatabase(db), truncated)).toEqual({ kind: "current" });
    } finally {
      db.close(true);
    }
  });

  it("refuses and writes nothing when the shape changed after it was planned", () => {
    const { db, truncated } = databaseMissingThe0042Receipt();
    try {
      const repair = plannedRepair(db, truncated);
      db.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(entryAt(30).when);
      const before = ledgerOf(db);
      expect(() => applyRepair(db, repair, truncated, "/data/mcode.db")).toThrow(DatabaseStartupRefusal);
      expect(ledgerOf(db)).toEqual(before);
    } finally {
      db.close(true);
    }
  });
});

describe("catalogue against real migration history", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
  });

  function journalEntries(): { raw: Record<string, unknown>; tag: string }[] {
    const journal: { entries: { tag: string }[] } = JSON.parse(NodeFS.readFileSync(NodePath.join(sourceCatalogue, "meta", "_journal.json"), "utf8"));
    return journal.entries.map((raw) => ({ raw: { ...raw }, tag: raw.tag }));
  }

  it("classifies every historical ledger as behind, never as schema ahead of the ledger", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-prefix-"));
    roots.push(root);
    NodeFS.mkdirSync(NodePath.join(root, "meta"));
    for (const file of NodeFS.readdirSync(sourceCatalogue).filter((name) => name.endsWith(".sql"))) {
      NodeFS.copyFileSync(NodePath.join(sourceCatalogue, file), NodePath.join(root, file));
    }
    const entries = journalEntries();
    // 0009_fancy_ben_urich is dated before 0008. Drizzle skips a migration older than its newest receipt,
    // so a ledger that ends at 0008 can never gain that receipt, and the pair must land in one run on a
    // fresh database, as it does for a new install. Those two states are not histories a build produces.
    const unreachable = new Set(["0008_brave_big_bertha", "0009_fancy_ben_urich"]);
    const steps = entries.map((_, index) => index + 1).filter((count) => !unreachable.has(entries[count - 1]?.tag ?? ""));
    let db = new Database(":memory:", { strict: true });
    try {
      for (const count of steps) {
        if (entries[count - 1]?.tag === "0009_plain_loki") {
          db.close(true);
          db = new Database(":memory:", { strict: true });
        }
        NodeFS.writeFileSync(NodePath.join(root, "meta", "_journal.json"), JSON.stringify({
          version: "7", dialect: "sqlite", entries: entries.slice(0, count).map((entry) => entry.raw),
        }));
        migrate(drizzle(db), { migrationsFolder: migrationsFolderForDrizzle(root) });
        const verdict = classifyLedger(inspectDatabase(db), catalogue);
        const pending = entries.slice(count).map((entry) => entry.tag);
        expect(verdict).toEqual(pending.length > 0 ? { kind: "behind", pending } : { kind: "current" });
      }
    } finally {
      db.close(true);
    }
  });
});
