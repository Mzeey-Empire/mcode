import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { lazySchema } from "@mcode/contracts/utils/lazySchema";
import { z } from "zod";
import {
  ADD_COLUMN,
  CREATE_INDEX,
  CREATE_TABLE,
  DROP_COLUMN,
  DROP_OBJECT,
  IDENTIFIER,
  LEGACY_EXCEPTIONS,
  RECREATE_PREFIX,
  RENAME_COLUMN,
  RENAME_TABLE,
  journalSchema,
  loadMigrationCatalogue,
  unquote,
  type CatalogueMigration,
  type MigrationCatalogue,
} from "./migration-catalogue.js";
import {
  COMPATIBLE_STEPS,
  CONTRACT_STEPS,
  FLOOR_MIGRATION_TAG,
  FLOOR_TABLE_NAME,
  floorUpsertStatement,
  type CompatibleStep,
  type ContractStep,
} from "./migration-contract-steps.js";

const snapshotSchema = lazySchema(() => z.object({
  id: z.string(),
  prevId: z.string(),
  tables: z.record(z.string(), z.object({ columns: z.record(z.string(), z.unknown()) })).optional(),
}));

/** The parts of a drizzle-kit snapshot the lint reads. */
export type SchemaSnapshot = z.infer<ReturnType<typeof snapshotSchema>>;

/** Which reviewed lists and floor migration the lint holds the catalogue to. */
export type LintPolicy = Readonly<{
  /** Tag of the migration that created the floor table. `null` skips every floor and allowlist rule. */
  floorTag: string | null;
  contractSteps: Readonly<Record<string, ContractStep>>;
  compatibleSteps: Readonly<Record<string, CompatibleStep>>;
}>;

const RELEASE_POLICY: LintPolicy = {
  floorTag: FLOOR_MIGRATION_TAG,
  contractSteps: CONTRACT_STEPS,
  compatibleSteps: COMPATIBLE_STEPS,
};

type CatalogueEntry = Readonly<{ idx: number; tag: string; when: number; number: number }>;

function numberOf(tag: string): number {
  return Number(tag.slice(0, 4));
}

function snapshotName(number: number): string {
  return `${String(number).padStart(4, "0")}_snapshot.json`;
}

function readJson(path: string, problems: string[]): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    // Unresolved merge markers are the usual cause, and name the file to fix.
    const reason = error instanceof Error ? error.message : String(error);
    problems.push(`${NodePath.basename(path)} could not be read as JSON: ${reason}`);
    return undefined;
  }
}

function readEntries(directory: string, problems: string[]): CatalogueEntry[] {
  const raw = readJson(NodePath.join(directory, "meta", "_journal.json"), problems);
  if (raw === undefined) return [];
  return journalSchema().parse(raw).entries.map((entry) => ({ ...entry, number: numberOf(entry.tag) }));
}

function lintSqlFiles(directory: string, entries: readonly CatalogueEntry[], problems: string[]): void {
  const tags = new Set<string>();
  for (const entry of entries) {
    if (tags.has(entry.tag)) problems.push(`${entry.tag} is listed twice in the journal`);
    tags.add(entry.tag);
  }
  const files = NodeFS.readdirSync(directory);
  for (const tag of tags) {
    if (!files.includes(`${tag}.sql`)) problems.push(`${tag} is in the journal but ${tag}.sql is missing`);
  }
  for (const file of files.filter((name) => name.endsWith(".sql"))) {
    if (!tags.has(file.slice(0, -".sql".length))) problems.push(`${file} has no journal entry`);
  }
}

function lintSnapshotFiles(directory: string, entries: readonly CatalogueEntry[], problems: string[]): void {
  const snapshots = new Set(NodeFS.readdirSync(NodePath.join(directory, "meta")));
  const numbers = new Set(entries.map((entry) => entry.number));
  for (const name of snapshots) {
    const match = /^(\d{4})_snapshot\.json$/.exec(name);
    if (match && !numbers.has(Number(match[1]))) problems.push(`${name} has no journal entry`);
  }
  for (const entry of entries) {
    if (!snapshots.has(snapshotName(entry.number)) && !LEGACY_EXCEPTIONS.missingSnapshots.has(entry.tag)) {
      problems.push(`${entry.tag} has no ${snapshotName(entry.number)}; generate migrations with drizzle-kit`);
    }
  }
}

function lintSequence(entries: readonly CatalogueEntry[], problems: string[]): void {
  let previousNumber = -1;
  let latestWhen = 0;
  for (const entry of entries) {
    const tagNumber = entry.tag.slice(0, 4);
    const repeatsLegacyNumber = entry.number === previousNumber && LEGACY_EXCEPTIONS.repeatedNumbers.has(tagNumber);
    if (entry.number !== previousNumber + 1 && !repeatsLegacyNumber) {
      problems.push(`${entry.tag} follows number ${previousNumber}; numbers must rise by one with no repeats or gaps`);
    }
    if (entry.idx !== entry.number) problems.push(`${entry.tag} has journal idx ${entry.idx}, expected ${entry.number}`);
    // Drizzle skips any migration whose timestamp is older than the newest one a database applied.
    if (entry.when <= latestWhen && !LEGACY_EXCEPTIONS.outOfOrderWhen.has(entry.tag)) {
      problems.push(`${entry.tag} has a timestamp not newer than an earlier migration, so installs that applied the later one would skip it`);
    }
    previousNumber = entry.number;
    latestWhen = Math.max(latestWhen, entry.when);
  }
}

function readSnapshots(directory: string, entries: readonly CatalogueEntry[], problems: string[]): Map<number, SchemaSnapshot> {
  const snapshots = new Map<number, SchemaSnapshot>();
  for (const number of new Set(entries.map((entry) => entry.number))) {
    const path = NodePath.join(directory, "meta", snapshotName(number));
    if (!NodeFS.existsSync(path)) continue;
    const raw = readJson(path, problems);
    if (raw !== undefined) snapshots.set(number, snapshotSchema().parse(raw));
  }
  return snapshots;
}

function lintSnapshotChain(snapshots: ReadonlyMap<number, SchemaSnapshot>, problems: string[]): void {
  let previousId: string | undefined;
  for (const [number, snapshot] of snapshots) {
    const excused = LEGACY_EXCEPTIONS.brokenSnapshotChain.has(String(number).padStart(4, "0"));
    if (previousId !== undefined && snapshot.prevId !== previousId && !excused) {
      problems.push(`${snapshotName(number)} was generated from a different parent than the snapshot before it`);
    }
    previousId = snapshot.id;
  }
}

function snapshotBreaks(previous: SchemaSnapshot, current: SchemaSnapshot): string[] {
  const before = previous.tables ?? {};
  const after = current.tables ?? {};
  const found: string[] = [];
  for (const [table, definition] of Object.entries(before)) {
    const kept = after[table];
    if (!kept) {
      found.push(`drop-table ${table.toLowerCase()}`);
      continue;
    }
    for (const column of Object.keys(definition.columns)) {
      if (!(column in kept.columns)) found.push(`drop-column ${table.toLowerCase()}.${column.toLowerCase()}`);
    }
  }
  return found;
}

const CREATE_TEMP_TABLE = new RegExp(String.raw`^CREATE\s+TEMP(?:ORARY)?\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, "i");

function createdTable(statement: string): string | null {
  const create = CREATE_TABLE.exec(statement) ?? CREATE_TEMP_TABLE.exec(statement);
  return create?.[1] ? unquote(create[1]) : null;
}

function droppedTable(statement: string): string | null {
  const drop = DROP_OBJECT.exec(statement);
  return drop?.[1]?.toUpperCase() === "TABLE" && drop[2] ? unquote(drop[2]) : null;
}

function droppedColumn(statement: string): string | null {
  const drop = DROP_COLUMN.exec(statement);
  return drop?.[1] && drop[2] ? `drop-column ${unquote(drop[1])}.${unquote(drop[2])}` : null;
}

function renameEffect(statement: string): { found: string | null; recreated: string | null } {
  const renameTable = RENAME_TABLE.exec(statement);
  if (renameTable?.[1] && renameTable[2]) {
    const [from, to] = [unquote(renameTable[1]), unquote(renameTable[2])];
    return from.startsWith(RECREATE_PREFIX) ? { found: null, recreated: to } : { found: `rename-table ${from}->${to}`, recreated: null };
  }
  const renameColumn = RENAME_COLUMN.exec(statement);
  if (renameColumn?.[1] && renameColumn[2] && renameColumn[3]) {
    const [table, from, to] = [unquote(renameColumn[1]), unquote(renameColumn[2]), unquote(renameColumn[3])];
    return { found: `rename-column ${table}.${from}->${to}`, recreated: null };
  }
  return { found: null, recreated: null };
}

function sqlBreaks(statements: readonly string[]): string[] {
  const found: string[] = [];
  const recreated = new Set<string>();
  const dropped: string[] = [];
  for (const statement of statements) {
    const created = createdTable(statement);
    if (created) recreated.add(created);
    const table = droppedTable(statement);
    if (table) dropped.push(table);
    const column = droppedColumn(statement);
    if (column) found.push(column);
    const rename = renameEffect(statement);
    if (rename.found) found.push(rename.found);
    if (rename.recreated) recreated.add(rename.recreated);
  }
  const lost = dropped.filter((table) => !table.startsWith(RECREATE_PREFIX) && !recreated.has(table));
  return [...found, ...lost.map((table) => `drop-table ${table}`)];
}

function withoutRenamedDrops(found: ReadonlySet<string>): string[] {
  const renamedFrom = new Set<string>();
  for (const entry of found) {
    const rename = /^rename-(table|column) (.+?)->/.exec(entry);
    if (rename) renamedFrom.add(`${rename[1] === "table" ? "drop-table" : "drop-column"} ${rename[2]}`);
  }
  return [...found].filter((entry) => !renamedFrom.has(entry)).sort();
}

/**
 * The ways a migration removes or renames something an older build still reads: dropped tables and
 * columns, and renamed tables and columns. The snapshot diff sees table rebuilds the SQL hides; the
 * SQL scan covers entries whose snapshot is missing or unrelated.
 *
 * @param previous Snapshot of the migration before this one, when it exists and follows it directly.
 * @param current Snapshot this migration produced, when it exists.
 * @returns Sorted, de-duplicated descriptions such as `drop-column tool_call_records.copilot_agent`.
 */
export function detectSchemaBreaks(
  migration: Pick<CatalogueMigration, "statements">,
  previous: SchemaSnapshot | undefined,
  current: SchemaSnapshot | undefined,
): string[] {
  const found = new Set(sqlBreaks(migration.statements));
  if (previous?.tables && current?.tables) {
    for (const entry of snapshotBreaks(previous, current)) found.add(entry);
  }
  return withoutRenamedDrops(found);
}

function previousSnapshot(
  entries: readonly CatalogueMigration[],
  ordinal: number,
  snapshots: ReadonlyMap<number, SchemaSnapshot>,
): SchemaSnapshot | undefined {
  const number = numberOf(entries[ordinal]?.tag ?? "");
  const before = entries[ordinal - 1];
  return before && numberOf(before.tag) === number - 1 ? snapshots.get(number - 1) : undefined;
}

function lintBreaks(
  catalogue: MigrationCatalogue,
  snapshots: ReadonlyMap<number, SchemaSnapshot>,
  policy: LintPolicy,
  problems: string[],
): void {
  catalogue.entries.forEach((migration, ordinal) => {
    const detected = detectSchemaBreaks(migration, previousSnapshot(catalogue.entries, ordinal, snapshots), snapshots.get(numberOf(migration.tag)));
    const step = policy.contractSteps[migration.tag];
    if (!step) {
      if (detected.length > 0) {
        problems.push(`${migration.tag} breaks older builds (${detected.join(", ")}) but has no CONTRACT_STEPS entry`);
      }
      return;
    }
    const declared = [...step.breaks].sort();
    if (declared.join("\n") !== detected.join("\n")) {
      problems.push(`${migration.tag} CONTRACT_STEPS lists [${declared.join(", ")}] but the migration breaks [${detected.join(", ")}]`);
    }
  });
}

function lintContractStepEntries(order: ReadonlyMap<string, number>, policy: LintPolicy, problems: string[]): void {
  for (const [tag, step] of Object.entries(policy.contractSteps)) {
    const ordinal = order.get(tag);
    if (ordinal === undefined) problems.push(`CONTRACT_STEPS names ${tag}, which is not in the journal`);
    if (step.reason.trim() === "") problems.push(`CONTRACT_STEPS entry ${tag} has no reason`);
    if (tag in policy.compatibleSteps) problems.push(`${tag} is in both CONTRACT_STEPS and COMPATIBLE_STEPS`);
    const expanded = step.expandedIn;
    if (expanded !== undefined && (order.get(expanded) ?? Infinity) >= (ordinal ?? -1)) {
      problems.push(`CONTRACT_STEPS entry ${tag} says it was expanded in ${expanded}, which is not an earlier migration`);
    }
  }
}

function lintCompatibleStepEntries(order: ReadonlyMap<string, number>, policy: LintPolicy, problems: string[]): void {
  const floorOrdinal = policy.floorTag === null ? -1 : (order.get(policy.floorTag) ?? -1);
  for (const [tag, step] of Object.entries(policy.compatibleSteps)) {
    const ordinal = order.get(tag);
    if (ordinal === undefined) problems.push(`COMPATIBLE_STEPS names ${tag}, which is not in the journal`);
    if (step.reason.trim() === "") problems.push(`COMPATIBLE_STEPS entry ${tag} has no reason`);
    if (ordinal !== undefined && ordinal <= floorOrdinal) {
      problems.push(`COMPATIBLE_STEPS entry ${tag} is not after the floor migration, where only new migrations are held to the allowlist`);
    }
  }
}

function lintStepTables(catalogue: MigrationCatalogue, policy: LintPolicy, problems: string[]): void {
  const order = new Map(catalogue.entries.map((entry, ordinal) => [entry.tag, ordinal]));
  lintContractStepEntries(order, policy, problems);
  lintCompatibleStepEntries(order, policy, problems);
}

/** A column constraint rejects rows an older build still writes, so adding one needs review. */
const COLUMN_CONSTRAINT = /\b(?:CHECK|REFERENCES|UNIQUE|COLLATE|GENERATED)\b/i;
const RELEASING_DELETE_ACTION = /\bON\s+DELETE\s+(?:CASCADE|SET\s+NULL)\b/i;

/**
 * A foreign key with the default delete action blocks deleting a parent row that an older build
 * still deletes. Each `REFERENCES` clause owns the `ON DELETE` before the next one, because an
 * action cannot appear without its own `REFERENCES`.
 */
function hasRestrictingForeignKey(statement: string): boolean {
  return statement.split(/\bREFERENCES\b/i).slice(1).some((clause) => !RELEASING_DELETE_ACTION.test(clause));
}

function isAutoAdditive(statement: string): boolean {
  if (CREATE_TABLE.test(statement)) return !hasRestrictingForeignKey(statement);
  if (CREATE_INDEX.test(statement)) return !/^CREATE\s+UNIQUE/i.test(statement);
  if (!ADD_COLUMN.test(statement) || COLUMN_CONSTRAINT.test(statement)) return false;
  return !/\bNOT\s+NULL\b/i.test(statement) || /\bDEFAULT\b/i.test(statement);
}

function lintAllowlist(migration: CatalogueMigration, policy: LintPolicy, problems: string[]): void {
  if (migration.tag in policy.contractSteps || migration.tag in policy.compatibleSteps) return;
  const unreviewed = migration.statements.filter((statement) => !isAutoAdditive(statement));
  if (unreviewed.length === 0) return;
  problems.push(
    `${migration.tag} has statements older builds may not tolerate and no CONTRACT_STEPS or COMPATIBLE_STEPS entry: ${unreviewed.map(summarize).join("; ")}`,
  );
}

function summarize(statement: string): string {
  const flat = statement.replace(/\s+/g, " ");
  return flat.length > 70 ? `${flat.slice(0, 70)}...` : flat;
}

function normalizeSql(statement: string): string {
  return statement.replace(/[`"]/g, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
}

function writesFloorTable(statement: string): boolean {
  return normalizeSql(statement).includes(FLOOR_TABLE_NAME);
}

function hasFloorUpsert(migration: CatalogueMigration, floorWhen: number): boolean {
  const canonical = normalizeSql(floorUpsertStatement(floorWhen, migration.tag));
  return migration.statements.some((statement) => normalizeSql(statement) === canonical);
}

function lintFloorWrites(migration: CatalogueMigration, allowedUpsert: string | null, problems: string[]): void {
  for (const statement of migration.statements.filter(writesFloorTable)) {
    if (allowedUpsert !== null && normalizeSql(statement) === allowedUpsert) continue;
    const owner = allowedUpsert === null
      ? "only the floor migration and contract steps may write it"
      : "a contract step may only write it with the floor upsert for its expandedIn migration";
    problems.push(`${migration.tag} touches ${FLOOR_TABLE_NAME} (${summarize(statement)}); ${owner}`);
  }
}

function expectedFloorWhen(catalogue: MigrationCatalogue, migration: CatalogueMigration, step: ContractStep, problems: string[]): number | null {
  if (step.expandedIn === undefined) {
    problems.push(
      `${migration.tag} is a contract step after the floor migration and must set expandedIn to the newest migration of the release that stopped using what it removes`,
    );
    return null;
  }
  return catalogue.entries.find((entry) => entry.tag === step.expandedIn)?.when ?? null;
}

function lintFloorMigration(
  catalogue: MigrationCatalogue,
  floor: CatalogueMigration,
  policy: LintPolicy,
  problems: string[],
): void {
  const seeded = catalogue.entries.filter((entry) => entry.tag in policy.contractSteps && entry.when < floor.when).at(-1);
  const seed = seeded ? normalizeSql(floorUpsertStatement(seeded.when, seeded.tag)) : null;
  if (seed !== null && !floor.statements.some((statement) => normalizeSql(statement) === seed)) {
    problems.push(`${floor.tag} must seed the floor with ${seeded?.tag}, the newest contract step before it`);
  }
  for (const statement of floor.statements) {
    const createsFloorTable = CREATE_TABLE.exec(statement)?.[1];
    const isFloorTable = createsFloorTable !== undefined && unquote(createsFloorTable) === FLOOR_TABLE_NAME;
    if (!isFloorTable && normalizeSql(statement) !== seed) {
      problems.push(`${floor.tag} may only create ${FLOOR_TABLE_NAME} and seed it: ${summarize(statement)}`);
    }
  }
}

function lintRerunnableStatements(migration: CatalogueMigration, problems: string[]): void {
  for (const statement of migration.statements) {
    const create = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF\s+NOT\s+EXISTS)/i.exec(statement);
    if (create) problems.push(`${migration.tag} needs IF NOT EXISTS so a replay is harmless: ${summarize(statement)}`);
    const drop = /^DROP\s+(TABLE|INDEX)\s+(?!IF\s+EXISTS)/i.exec(statement);
    if (drop) problems.push(`${migration.tag} needs IF EXISTS so a replay is harmless: ${summarize(statement)}`);
  }
}

function lintFloorUpsert(
  catalogue: MigrationCatalogue,
  migration: CatalogueMigration,
  step: ContractStep | undefined,
  problems: string[],
): void {
  if (!step) {
    lintFloorWrites(migration, null, problems);
    return;
  }
  const floorWhen = expectedFloorWhen(catalogue, migration, step, problems);
  if (floorWhen === null) return;
  if (!hasFloorUpsert(migration, floorWhen)) {
    problems.push(
      `${migration.tag} is a contract step and must raise the floor with floorUpsertStatement(${floorWhen}, "${migration.tag}"), the when of ${step.expandedIn}`,
    );
  }
  lintFloorWrites(migration, normalizeSql(floorUpsertStatement(floorWhen, migration.tag)), problems);
}

function lintFloorRules(catalogue: MigrationCatalogue, policy: LintPolicy, problems: string[]): void {
  const floorOrdinal = catalogue.entries.findIndex((entry) => entry.tag === policy.floorTag);
  const floor = catalogue.entries[floorOrdinal];
  if (!floor) {
    problems.push(`The floor migration ${policy.floorTag} is not in the journal`);
    return;
  }
  lintFloorMigration(catalogue, floor, policy, problems);
  lintRerunnableStatements(floor, problems);
  catalogue.entries.forEach((migration, ordinal) => {
    if (ordinal === floorOrdinal) return;
    const step = ordinal > floorOrdinal ? policy.contractSteps[migration.tag] : undefined;
    lintFloorUpsert(catalogue, migration, step, problems);
    if (ordinal > floorOrdinal) {
      lintAllowlist(migration, policy, problems);
      lintRerunnableStatements(migration, problems);
    }
  });
}

/**
 * Statically checks the generated Drizzle catalogue for the damage parallel branches do to it:
 * repeated or skipped migration numbers, timestamps that go backwards, and snapshots that
 * do not chain. It also holds each migration to the compatibility contract: a migration that
 * drops or renames something needs a reviewed `CONTRACT_STEPS` entry, and after the floor
 * migration only additive statements pass without one, contract steps must raise the floor to the
 * `when` of their `expandedIn` migration, and nothing else may write it. Returns one message per problem and an empty list when the
 * catalogue is sound.
 *
 * @param directory Path to `apps/server/drizzle`.
 * @param policy The reviewed lists and floor migration to check against.
 */
export function lintMigrationCatalogue(directory: string, policy: LintPolicy = RELEASE_POLICY): string[] {
  const problems: string[] = [];
  const entries = readEntries(directory, problems);
  // Without a readable journal every file would also be reported as unlisted, burying the real cause.
  if (problems.length > 0) return problems;
  lintSqlFiles(directory, entries, problems);
  lintSnapshotFiles(directory, entries, problems);
  lintSequence(entries, problems);
  const snapshots = readSnapshots(directory, entries, problems);
  lintSnapshotChain(snapshots, problems);
  if (problems.length > 0) return problems;
  const catalogue = loadMigrationCatalogue(directory);
  lintBreaks(catalogue, snapshots, policy, problems);
  lintStepTables(catalogue, policy, problems);
  if (policy.floorTag !== null) lintFloorRules(catalogue, policy, problems);
  return problems;
}
